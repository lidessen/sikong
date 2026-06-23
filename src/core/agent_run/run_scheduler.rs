use async_trait::async_trait;
use nanoid::nanoid;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{
    UnixStream,
    unix::{OwnedReadHalf, OwnedWriteHalf},
};
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout};
use tracing::{debug, info, warn};

use super::run::{AgentRunRequest, AgentRunResponse, CancellationToken};

#[async_trait]
pub trait AgentRunScheduler: Send {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse;
}

fn short_message_id(prefix: &str) -> String {
    format!("{prefix}_{}", nanoid!(10))
}

pub struct ProcessAgentRunScheduler {
    command: String,
    args: Vec<String>,
    socket_path: PathBuf,
    socket_dir: Option<TempDir>,
    startup_error: Option<String>,
    child: Option<Child>,
    writer: Option<OwnedWriteHalf>,
    reader: Option<BufReader<OwnedReadHalf>>,
}

fn create_temp_socket_dir() -> Result<(PathBuf, TempDir), ProcessAgentRunSchedulerError> {
    let dir = tempfile::Builder::new()
        .prefix("siko-agent-host-")
        .tempdir()
        .map_err(ProcessAgentRunSchedulerError::TempDir)?;
    let path = dir.path().join("agent-host.sock");
    Ok((path, dir))
}

impl Clone for ProcessAgentRunScheduler {
    fn clone(&self) -> Self {
        Self::new(self.command.clone(), self.args.clone())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProcessAgentRunSchedulerError {
    #[error("failed to create agent host socket dir: {0}")]
    TempDir(#[source] std::io::Error),
    #[error("{0}")]
    Unavailable(String),
    #[error("failed to remove stale agent host socket {path}: {source}")]
    RemoveSocket {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to spawn agent host: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("failed to connect agent host socket {path}: {source}")]
    Connect {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("agent host socket {path} was not ready")]
    ConnectTimeout { path: PathBuf },
    #[error("failed to clone agent host socket: {0}")]
    CloneSocket(#[source] std::io::Error),
    #[error("agent host socket writer is not available")]
    MissingWriter,
    #[error("agent host socket reader is not available")]
    MissingReader,
    #[error("failed to encode agent host message: {0}")]
    Encode(#[source] serde_json::Error),
    #[error("failed to write agent host message: {0}")]
    Write(#[source] std::io::Error),
    #[error("failed to flush agent host message: {0}")]
    Flush(#[source] std::io::Error),
    #[error("failed to read agent host response: {0}")]
    Read(#[source] std::io::Error),
    #[error("agent host closed socket")]
    Closed,
    #[error("failed to decode agent host response: {0}")]
    Decode(#[source] serde_json::Error),
    #[error("agent host returned error: {0}")]
    Host(String),
    #[error("agent host run was cancelled")]
    Cancelled,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ProcessAgentRunSchedulerMessage<'a> {
    Run {
        id: String,
        request: &'a AgentRunRequest,
    },
    Shutdown {
        id: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ProcessAgentRunSchedulerHostMessage {
    Result {
        id: String,
        result: AgentRunResponse,
    },
    Error {
        id: String,
        message: String,
    },
}

impl ProcessAgentRunScheduler {
    pub fn new(
        command: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        match Self::try_new(command, args) {
            Ok(client) => client,
            Err(error) => Self::unstarted_with_error_socket(error),
        }
    }

    pub fn try_new(
        command: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Result<Self, ProcessAgentRunSchedulerError> {
        let socket_dir = tempfile::Builder::new()
            .prefix("siko-agent-host-")
            .tempdir()
            .map_err(ProcessAgentRunSchedulerError::TempDir)?;
        let socket_path = socket_dir.path().join("agent-host.sock");
        Ok(Self::with_socket_dir(
            command,
            args,
            socket_path,
            Some(socket_dir),
        ))
    }

    fn with_socket_dir(
        command: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
        socket_path: PathBuf,
        socket_dir: Option<TempDir>,
    ) -> Self {
        Self {
            command: command.into(),
            args: args.into_iter().map(Into::into).collect(),
            socket_path,
            socket_dir,
            startup_error: None,
            child: None,
            writer: None,
            reader: None,
        }
    }

    fn unstarted_with_error_socket(command_error: ProcessAgentRunSchedulerError) -> Self {
        let path = std::env::temp_dir().join("siko-agent-host-unavailable.sock");
        Self {
            command: "unavailable".to_string(),
            args: Vec::new(),
            socket_path: path,
            socket_dir: None,
            startup_error: Some(command_error.to_string()),
            child: None,
            writer: None,
            reader: None,
        }
    }

    async fn ensure_started(&mut self) -> Result<(), ProcessAgentRunSchedulerError> {
        if let Some(error) = &self.startup_error {
            return Err(ProcessAgentRunSchedulerError::Unavailable(error.clone()));
        }

        if self.child.is_some() {
            return Ok(());
        }

        remove_socket_if_exists(&self.socket_path).await?;
        let mut args = self.args.clone();
        args.push("--socket".to_string());
        args.push(self.socket_path.to_string_lossy().to_string());

        let child = Command::new(&self.command)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(ProcessAgentRunSchedulerError::Spawn)?;
        debug!(
            command = %self.command,
            socket = %self.socket_path.display(),
            "spawned agent host"
        );

        let stream = self.connect_socket().await?;
        let (reader, writer) = stream.into_split();

        self.child = Some(child);
        self.writer = Some(writer);
        self.reader = Some(BufReader::new(reader));
        Ok(())
    }

    async fn connect_socket(&self) -> Result<UnixStream, ProcessAgentRunSchedulerError> {
        let mut last_error = None;
        for _ in 0..100 {
            match UnixStream::connect(&self.socket_path).await {
                Ok(stream) => {
                    debug!(socket = %self.socket_path.display(), "connected agent host socket");
                    return Ok(stream);
                }
                Err(error) => {
                    last_error = Some(error);
                    sleep(Duration::from_millis(20)).await;
                }
            }
        }

        match last_error {
            Some(source) => Err(ProcessAgentRunSchedulerError::Connect {
                path: self.socket_path.clone(),
                source,
            }),
            None => Err(ProcessAgentRunSchedulerError::ConnectTimeout {
                path: self.socket_path.clone(),
            }),
        }
    }

    async fn send_message(
        &mut self,
        message: &ProcessAgentRunSchedulerMessage<'_>,
    ) -> Result<(), ProcessAgentRunSchedulerError> {
        let writer = self
            .writer
            .as_mut()
            .ok_or(ProcessAgentRunSchedulerError::MissingWriter)?;
        let mut line =
            serde_json::to_vec(message).map_err(ProcessAgentRunSchedulerError::Encode)?;
        line.push(b'\n');
        writer
            .write_all(&line)
            .await
            .map_err(ProcessAgentRunSchedulerError::Write)?;
        writer
            .flush()
            .await
            .map_err(ProcessAgentRunSchedulerError::Flush)
    }

    async fn read_response(
        &mut self,
        expected_id: &str,
    ) -> Result<AgentRunResponse, ProcessAgentRunSchedulerError> {
        let reader = self
            .reader
            .as_mut()
            .ok_or(ProcessAgentRunSchedulerError::MissingReader)?;

        let mut line = String::new();
        loop {
            line.clear();
            let bytes = reader
                .read_line(&mut line)
                .await
                .map_err(ProcessAgentRunSchedulerError::Read)?;
            if bytes == 0 {
                return Err(ProcessAgentRunSchedulerError::Closed);
            }

            let response: ProcessAgentRunSchedulerHostMessage =
                serde_json::from_str(line.trim_end())
                    .map_err(ProcessAgentRunSchedulerError::Decode)?;

            match response {
                ProcessAgentRunSchedulerHostMessage::Result { id, result } if id == expected_id => {
                    return Ok(result);
                }
                ProcessAgentRunSchedulerHostMessage::Error { id, message } if id == expected_id => {
                    return Err(ProcessAgentRunSchedulerError::Host(message));
                }
                ProcessAgentRunSchedulerHostMessage::Result { .. }
                | ProcessAgentRunSchedulerHostMessage::Error { .. } => {}
            }
        }
    }

    async fn read_response_or_cancel(
        &mut self,
        expected_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<AgentRunResponse, ProcessAgentRunSchedulerError> {
        let reader = self
            .reader
            .as_mut()
            .ok_or(ProcessAgentRunSchedulerError::MissingReader)?;

        let mut line = String::new();
        loop {
            line.clear();
            tokio::select! {
                _ = cancellation.cancelled() => return Err(ProcessAgentRunSchedulerError::Cancelled),
                read = reader.read_line(&mut line) => {
                    let bytes = read.map_err(ProcessAgentRunSchedulerError::Read)?;
                    if bytes == 0 {
                        return Err(ProcessAgentRunSchedulerError::Closed);
                    }

                    let response: ProcessAgentRunSchedulerHostMessage =
                        serde_json::from_str(line.trim_end()).map_err(ProcessAgentRunSchedulerError::Decode)?;

                    match response {
                        ProcessAgentRunSchedulerHostMessage::Result { id, result } if id == expected_id => {
                            return Ok(result);
                        }
                        ProcessAgentRunSchedulerHostMessage::Error { id, message } if id == expected_id => {
                            return Err(ProcessAgentRunSchedulerError::Host(message));
                        }
                        ProcessAgentRunSchedulerHostMessage::Result { .. } | ProcessAgentRunSchedulerHostMessage::Error { .. } => {}
                    }
                }
            }
        }
    }

    pub async fn shutdown(&mut self) -> Result<(), ProcessAgentRunSchedulerError> {
        if self.child.is_none() {
            self.cleanup_socket();
            return Ok(());
        }

        let shutdown_id = short_message_id("shutdown");
        let send_result = self
            .send_message(&ProcessAgentRunSchedulerMessage::Shutdown {
                id: shutdown_id.clone(),
            })
            .await;
        if send_result.is_ok() {
            let _ = self.read_response(&shutdown_id).await;
        }

        self.close_transport();
        self.wait_or_kill(Duration::from_millis(500)).await;
        self.cleanup_socket();
        Ok(())
    }

    async fn terminate(&mut self) {
        self.close_transport();
        self.kill_child().await;
        self.cleanup_socket();
    }

    fn close_transport(&mut self) {
        if let Some(writer) = self.writer.take() {
            drop(writer);
        }
        let _ = self.reader.take();
    }

    async fn wait_or_kill(&mut self, grace: Duration) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        if timeout(grace, child.wait()).await.is_err() {
            self.kill_child().await;
        } else {
            let _ = self.child.take();
        }
    }

    async fn kill_child(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        let _ = child.start_kill();
        let _ = child.wait().await;
        let _ = self.child.take();
    }

    fn cleanup_socket(&mut self) {
        let _ = fs::remove_file(&self.socket_path);
        let _ = self.socket_dir.take();
    }

    fn error_result(message: impl Into<String>) -> AgentRunResponse {
        AgentRunResponse {
            report: message.into(),
            tool_calls: Vec::new(),
            terminal_call: None,
            usage: None,
            events: Vec::new(),
        }
    }
}

#[async_trait]
impl AgentRunScheduler for ProcessAgentRunScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse {
        if cancellation.is_cancelled() {
            return Self::error_result(ProcessAgentRunSchedulerError::Cancelled.to_string());
        }

        if let Err(error) = self.ensure_started().await {
            return Self::error_result(error.to_string());
        }

        let run_id = short_message_id("run");
        let started_at = Instant::now();
        info!(
            run_id = %run_id,
            objective = %input.objective,
            terminal_tools = ?input.terminal_tool_set,
            "dispatching agent host run"
        );
        if let Err(error) = self
            .send_message(&ProcessAgentRunSchedulerMessage::Run {
                id: run_id.clone(),
                request: &input,
            })
            .await
        {
            warn!(
                run_id = %run_id,
                duration_ms = started_at.elapsed().as_millis(),
                error = %error,
                "failed to send agent host run"
            );
            return Self::error_result(error.to_string());
        }

        match self.read_response_or_cancel(&run_id, &cancellation).await {
            Ok(result) => {
                info!(
                    run_id = %run_id,
                    duration_ms = started_at.elapsed().as_millis(),
                    terminal_tool = ?result.terminal_call.as_ref().map(|call| call.name.as_str()),
                    tool_calls = result.tool_calls.len(),
                    "agent host run completed"
                );
                result
            }
            Err(ProcessAgentRunSchedulerError::Cancelled) => {
                warn!(
                    run_id = %run_id,
                    duration_ms = started_at.elapsed().as_millis(),
                    "agent host run cancelled"
                );
                self.terminate().await;
                Self::error_result(ProcessAgentRunSchedulerError::Cancelled.to_string())
            }
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    duration_ms = started_at.elapsed().as_millis(),
                    error = %error,
                    "agent host run failed"
                );
                Self::error_result(error.to_string())
            }
        }
    }
}

impl Drop for ProcessAgentRunScheduler {
    fn drop(&mut self) {
        if self.child.is_none() {
            return;
        }

        let _ = self.child.as_mut().map(|child| child.start_kill());
        self.close_transport();
        // Give the child a moment to exit before removing the socket
        std::thread::sleep(Duration::from_millis(100));
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            // Wait briefly for the process to exit (best-effort)
            let _ = std::thread::spawn(move || {
                let _ = std::thread::sleep(Duration::from_millis(500));
                let _ = child.kill();
            });
        }
        self.cleanup_socket();
    }
}

async fn remove_socket_if_exists(path: &Path) -> Result<(), ProcessAgentRunSchedulerError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            // Log but don't fail — the socket might be in a tricky state
            warn!(?path, ?error, "failed to remove stale agent host socket");
            Ok(())
        }
    }
}
