use async_trait::async_trait;
use nanoid::nanoid;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{
    UnixStream,
    unix::{OwnedReadHalf, OwnedWriteHalf},
};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout};
use tracing::{debug, info, warn};

use super::run::{AgentRunEventSink, AgentRunRequest, AgentRunResponse, CancellationToken};

const AGENT_HOST_CONNECT_ATTEMPTS: usize = 300;
const AGENT_HOST_CONNECT_INTERVAL: Duration = Duration::from_millis(50);
const AGENT_HOST_STDERR_TAIL_BYTES: usize = 4096;

#[async_trait]
pub trait AgentRunScheduler: Send {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse;

    async fn run_with_event_sink(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
        _event_sink: Option<AgentRunEventSink>,
    ) -> AgentRunResponse {
        self.run(input, cancellation).await
    }
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

#[allow(dead_code)]
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
    #[error("failed to spawn agent host {command} {args:?}: {source}")]
    Spawn {
        command: String,
        args: Vec<String>,
        source: std::io::Error,
    },
    #[error("failed to create agent host stderr log {path}: {source}")]
    StderrLog {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error(transparent)]
    Startup(Box<AgentHostStartupFailure>),
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

#[derive(Debug, thiserror::Error)]
#[error(
    "agent host did not become ready after launch: command={command} args={args:?} socket={socket_path}; {source}; process_status={status}; stderr_tail={stderr_tail}"
)]
pub struct AgentHostStartupFailure {
    command: String,
    args: Vec<String>,
    socket_path: PathBuf,
    status: String,
    stderr_tail: String,
    source: Box<ProcessAgentRunSchedulerError>,
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
    Event {
        id: String,
        event: Value,
    },
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
        let stderr_path = self.socket_path.with_extension("stderr.log");
        let stderr_log = fs::File::create(&stderr_path).map_err(|source| {
            ProcessAgentRunSchedulerError::StderrLog {
                path: stderr_path.clone(),
                source,
            }
        })?;

        let mut child = Command::new(&self.command)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr_log))
            .spawn()
            .map_err(|source| ProcessAgentRunSchedulerError::Spawn {
                command: self.command.clone(),
                args: args.clone(),
                source,
            })?;
        debug!(
            command = %self.command,
            socket = %self.socket_path.display(),
            "spawned agent host"
        );

        let mut early_status = None;
        let stream = match self
            .connect_socket(Some(&mut child), &mut early_status)
            .await
        {
            Ok(stream) => stream,
            Err(source) => {
                let status = match early_status {
                    Some(status) => status,
                    None => stop_unready_child(&mut child).await,
                };
                let stderr_tail = read_file_tail(&stderr_path, AGENT_HOST_STDERR_TAIL_BYTES);
                return Err(ProcessAgentRunSchedulerError::Startup(Box::new(
                    AgentHostStartupFailure {
                        command: self.command.clone(),
                        args,
                        socket_path: self.socket_path.clone(),
                        status,
                        stderr_tail,
                        source: Box::new(source),
                    },
                )));
            }
        };
        let (reader, writer) = stream.into_split();

        self.child = Some(child);
        self.writer = Some(writer);
        self.reader = Some(BufReader::new(reader));
        Ok(())
    }

    async fn connect_socket(
        &self,
        mut child: Option<&mut Child>,
        early_status: &mut Option<String>,
    ) -> Result<UnixStream, ProcessAgentRunSchedulerError> {
        let mut last_error = None;
        for _ in 0..AGENT_HOST_CONNECT_ATTEMPTS {
            match UnixStream::connect(&self.socket_path).await {
                Ok(stream) => {
                    debug!(socket = %self.socket_path.display(), "connected agent host socket");
                    return Ok(stream);
                }
                Err(error) => {
                    last_error = Some(error);
                    if let Some(child) = child.as_deref_mut() {
                        match child.try_wait() {
                            Ok(Some(status)) => {
                                *early_status = Some(status.to_string());
                                break;
                            }
                            Ok(None) => {}
                            Err(error) => {
                                *early_status =
                                    Some(format!("failed to inspect process status: {error}"));
                                break;
                            }
                        }
                    }
                    sleep(AGENT_HOST_CONNECT_INTERVAL).await;
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
                ProcessAgentRunSchedulerHostMessage::Event { .. } => {}
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
        event_sink: Option<AgentRunEventSink>,
    ) -> Result<AgentRunResponse, ProcessAgentRunSchedulerError> {
        let reader = self
            .reader
            .as_mut()
            .ok_or(ProcessAgentRunSchedulerError::MissingReader)?;

        let mut line = String::new();
        let mut streamed_events = Vec::new();
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
                        ProcessAgentRunSchedulerHostMessage::Event { id, event } if id == expected_id => {
                            if let Some(sink) = &event_sink {
                                sink(event.clone());
                            }
                            streamed_events.push(event);
                        }
                        ProcessAgentRunSchedulerHostMessage::Result { id, mut result } if id == expected_id => {
                            result.events = merge_streamed_events(streamed_events, result.events);
                            return Ok(result);
                        }
                        ProcessAgentRunSchedulerHostMessage::Error { id, message } if id == expected_id => {
                            return Err(ProcessAgentRunSchedulerError::Host(message));
                        }
                        ProcessAgentRunSchedulerHostMessage::Result { .. }
                        | ProcessAgentRunSchedulerHostMessage::Error { .. } => {}
                        ProcessAgentRunSchedulerHostMessage::Event { .. } => {}
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

    fn error_result(error: ProcessAgentRunSchedulerError) -> AgentRunResponse {
        let class = error.failure_class();
        let message = error.to_string();
        AgentRunResponse {
            report: format!("agent host failure ({class}): {message}"),
            tool_calls: Vec::new(),
            terminal_call: None,
            usage: None,
            events: vec![json!({
                "event": "agent_run_failure",
                "source": "siko.agent_host",
                "class": class,
                "message": message,
            })],
        }
    }
}

impl ProcessAgentRunSchedulerError {
    fn failure_class(&self) -> &'static str {
        match self {
            Self::TempDir(_) => "startup",
            Self::Unavailable(_) => "startup",
            Self::RemoveSocket { .. } => "startup",
            Self::Spawn { .. } => "startup",
            Self::StderrLog { .. } => "startup",
            Self::Startup { .. } => "startup",
            Self::Connect { .. } => "startup",
            Self::ConnectTimeout { .. } => "startup",
            Self::CloneSocket(_) => "transport",
            Self::MissingWriter => "transport",
            Self::MissingReader => "transport",
            Self::Encode(_) => "protocol",
            Self::Write(_) => "transport",
            Self::Flush(_) => "transport",
            Self::Read(_) => "transport",
            Self::Closed => "transport",
            Self::Decode(_) => "protocol",
            Self::Host(_) => "host",
            Self::Cancelled => "cancelled",
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
        self.run_with_event_sink(input, cancellation, None).await
    }

    async fn run_with_event_sink(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
        event_sink: Option<AgentRunEventSink>,
    ) -> AgentRunResponse {
        if cancellation.is_cancelled() {
            return Self::error_result(ProcessAgentRunSchedulerError::Cancelled);
        }

        if let Err(error) = self.ensure_started().await {
            return Self::error_result(error);
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
            return Self::error_result(error);
        }

        match self
            .read_response_or_cancel(&run_id, &cancellation, event_sink)
            .await
        {
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
                Self::error_result(ProcessAgentRunSchedulerError::Cancelled)
            }
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    duration_ms = started_at.elapsed().as_millis(),
                    error = %error,
                    "agent host run failed"
                );
                Self::error_result(error)
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
        }
        self.cleanup_socket();
    }
}

/// Shared scheduler — shares the same agent-host connection across
/// the assistant loop and task execution. Prevents spawning duplicate
/// agent-host processes.
#[async_trait]
impl AgentRunScheduler for Arc<Mutex<ProcessAgentRunScheduler>> {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse {
        self.lock().await.run(input, cancellation).await
    }

    async fn run_with_event_sink(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
        event_sink: Option<AgentRunEventSink>,
    ) -> AgentRunResponse {
        self.lock()
            .await
            .run_with_event_sink(input, cancellation, event_sink)
            .await
    }
}

fn merge_streamed_events(mut streamed: Vec<Value>, result_events: Vec<Value>) -> Vec<Value> {
    for event in result_events {
        if !streamed.contains(&event) {
            streamed.push(event);
        }
    }
    streamed
}

async fn stop_unready_child(child: &mut Child) -> String {
    match child.try_wait() {
        Ok(Some(status)) => status.to_string(),
        Ok(None) => {
            let _ = child.start_kill();
            match child.wait().await {
                Ok(status) => format!("killed after readiness timeout: {status}"),
                Err(error) => format!("failed to wait after readiness timeout: {error}"),
            }
        }
        Err(error) => format!("failed to inspect process status: {error}"),
    }
}

fn read_file_tail(path: &Path, max_bytes: usize) -> String {
    match fs::read(path) {
        Ok(bytes) if bytes.is_empty() => "<empty>".to_string(),
        Ok(bytes) => {
            let start = bytes.len().saturating_sub(max_bytes);
            String::from_utf8_lossy(&bytes[start..]).trim().to_string()
        }
        Err(error) => format!("<failed to read log: {error}>"),
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
