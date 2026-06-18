use crate::CancellationToken;
use crate::node::{Artifact, NodeScript, NodeTemplate, ProblemNode};
use crate::types::{NodeId, NodeOperation, VerificationVerdict};
use crate::workspace::WorkspaceIntegration;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{
    UnixStream,
    unix::{OwnedReadHalf, OwnedWriteHalf},
};
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout};
use tracing::debug;

#[derive(Debug, Clone)]
pub struct AgentOperationContext {
    pub node: ProblemNode,
    pub operation: NodeOperation,
    pub candidate: Option<Artifact>,
    pub child_artifacts: Vec<Artifact>,
    pub workspace_integration: Option<WorkspaceIntegration>,
}

impl AgentOperationContext {
    pub fn node_id(&self) -> NodeId {
        self.node.id
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRunRecord {
    pub node_id: NodeId,
    pub operation: NodeOperation,
    pub report: String,
    pub terminal_tool: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRunResult {
    pub report: String,
    pub terminal_tool: Option<String>,
    pub output: NodeOperationOutput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentWorkerResult {
    pub report: String,
    #[serde(rename = "terminalCall")]
    pub terminal_call: Option<AgentTerminalToolCall>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolSpec {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentPromptSection {
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunKind {
    EngineOperation,
    AssistantTurn,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentToolChoice {
    Required,
    Tool { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTerminalToolCall {
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeOperationOutput {
    Specified,
    Acquired {
        need: String,
        evidence: String,
        next_script: NodeScript,
    },
    Divided {
        children: Vec<NodeTemplate>,
    },
    Executed {
        output: String,
        changed_paths: Vec<String>,
        side_effects: Vec<String>,
    },
    Combined {
        output: String,
    },
    Verified {
        verdict: VerificationVerdict,
    },
    Committed,
    Noop,
}

#[async_trait]
pub trait AgentWorker: Send {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentWorkerResult;
}

pub trait AgentHarness {
    fn build_run(&mut self, context: AgentOperationContext) -> AgentRunRequest;
    fn decode_result(
        &mut self,
        context: &AgentOperationContext,
        result: AgentWorkerResult,
    ) -> AgentRunResult;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentRunRequest {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub kind: AgentRunKind,
    pub objective: String,
    pub prompt: Vec<AgentPromptSection>,
    pub input: Value,
    pub tools: Vec<AgentToolSpec>,
    #[serde(rename = "terminalToolSet")]
    pub terminal_tool_set: Vec<String>,
    #[serde(rename = "toolChoice")]
    pub tool_choice: AgentToolChoice,
}

pub struct AgentHostClient {
    command: String,
    args: Vec<String>,
    socket_path: PathBuf,
    socket_dir: Option<TempDir>,
    startup_error: Option<String>,
    next_run_id: u64,
    child: Option<Child>,
    writer: Option<OwnedWriteHalf>,
    reader: Option<BufReader<OwnedReadHalf>>,
}

#[derive(Debug, thiserror::Error)]
pub enum AgentHostError {
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
enum AgentHostClientMessage<'a> {
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
enum AgentHostMessage {
    Result {
        id: String,
        result: AgentWorkerResult,
    },
    Error {
        id: String,
        message: String,
    },
}

impl AgentHostClient {
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
    ) -> Result<Self, AgentHostError> {
        let socket_dir = tempfile::Builder::new()
            .prefix("siko-agent-host-")
            .tempdir()
            .map_err(AgentHostError::TempDir)?;
        let socket_path = socket_dir.path().join("agent-host.sock");
        Ok(Self::with_socket_dir(
            command,
            args,
            socket_path,
            Some(socket_dir),
        ))
    }

    pub fn with_socket_path(
        command: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
        socket_path: impl Into<PathBuf>,
    ) -> Self {
        Self::with_socket_dir(command, args, socket_path.into(), None)
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
            next_run_id: 0,
            child: None,
            writer: None,
            reader: None,
        }
    }

    fn unstarted_with_error_socket(command_error: AgentHostError) -> Self {
        let path = std::env::temp_dir().join("siko-agent-host-unavailable.sock");
        Self {
            command: "unavailable".to_string(),
            args: Vec::new(),
            socket_path: path,
            socket_dir: None,
            startup_error: Some(command_error.to_string()),
            next_run_id: 0,
            child: None,
            writer: None,
            reader: None,
        }
    }

    async fn ensure_started(&mut self) -> Result<(), AgentHostError> {
        if let Some(error) = &self.startup_error {
            return Err(AgentHostError::Unavailable(error.clone()));
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
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(AgentHostError::Spawn)?;
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

    async fn connect_socket(&self) -> Result<UnixStream, AgentHostError> {
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
            Some(source) => Err(AgentHostError::Connect {
                path: self.socket_path.clone(),
                source,
            }),
            None => Err(AgentHostError::ConnectTimeout {
                path: self.socket_path.clone(),
            }),
        }
    }

    async fn send_message(
        &mut self,
        message: &AgentHostClientMessage<'_>,
    ) -> Result<(), AgentHostError> {
        let writer = self.writer.as_mut().ok_or(AgentHostError::MissingWriter)?;
        let mut line = serde_json::to_vec(message).map_err(AgentHostError::Encode)?;
        line.push(b'\n');
        writer
            .write_all(&line)
            .await
            .map_err(AgentHostError::Write)?;
        writer.flush().await.map_err(AgentHostError::Flush)
    }

    async fn read_response(
        &mut self,
        expected_id: &str,
    ) -> Result<AgentWorkerResult, AgentHostError> {
        let reader = self.reader.as_mut().ok_or(AgentHostError::MissingReader)?;

        let mut line = String::new();
        loop {
            line.clear();
            let bytes = reader
                .read_line(&mut line)
                .await
                .map_err(AgentHostError::Read)?;
            if bytes == 0 {
                return Err(AgentHostError::Closed);
            }

            let response: AgentHostMessage =
                serde_json::from_str(line.trim_end()).map_err(AgentHostError::Decode)?;

            match response {
                AgentHostMessage::Result { id, result } if id == expected_id => {
                    return Ok(result);
                }
                AgentHostMessage::Error { id, message } if id == expected_id => {
                    return Err(AgentHostError::Host(message));
                }
                AgentHostMessage::Result { .. } | AgentHostMessage::Error { .. } => {
                    continue;
                }
            }
        }
    }

    async fn read_response_or_cancel(
        &mut self,
        expected_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<AgentWorkerResult, AgentHostError> {
        let reader = self.reader.as_mut().ok_or(AgentHostError::MissingReader)?;

        let mut line = String::new();
        loop {
            line.clear();
            tokio::select! {
                _ = cancellation.cancelled() => return Err(AgentHostError::Cancelled),
                read = reader.read_line(&mut line) => {
                    let bytes = read.map_err(AgentHostError::Read)?;
                    if bytes == 0 {
                        return Err(AgentHostError::Closed);
                    }

                    let response: AgentHostMessage =
                        serde_json::from_str(line.trim_end()).map_err(AgentHostError::Decode)?;

                    match response {
                        AgentHostMessage::Result { id, result } if id == expected_id => {
                            return Ok(result);
                        }
                        AgentHostMessage::Error { id, message } if id == expected_id => {
                            return Err(AgentHostError::Host(message));
                        }
                        AgentHostMessage::Result { .. } | AgentHostMessage::Error { .. } => {
                            continue;
                        }
                    }
                }
            }
        }
    }

    pub async fn shutdown(&mut self) -> Result<(), AgentHostError> {
        if self.child.is_none() {
            self.cleanup_socket();
            return Ok(());
        }

        self.next_run_id += 1;
        let shutdown_id = format!("shutdown_{}", self.next_run_id);
        let send_result = self
            .send_message(&AgentHostClientMessage::Shutdown {
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

    fn error_result(message: impl Into<String>) -> AgentWorkerResult {
        AgentWorkerResult {
            report: message.into(),
            terminal_call: None,
        }
    }
}

#[async_trait]
impl AgentWorker for AgentHostClient {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentWorkerResult {
        if cancellation.is_cancelled() {
            return Self::error_result(AgentHostError::Cancelled.to_string());
        }

        if let Err(error) = self.ensure_started().await {
            return Self::error_result(error.to_string());
        }

        self.next_run_id += 1;
        let run_id = format!("run_{}", self.next_run_id);
        if let Err(error) = self
            .send_message(&AgentHostClientMessage::Run {
                id: run_id.clone(),
                request: &input,
            })
            .await
        {
            return Self::error_result(error.to_string());
        }

        match self.read_response_or_cancel(&run_id, &cancellation).await {
            Ok(result) => result,
            Err(AgentHostError::Cancelled) => {
                self.terminate().await;
                Self::error_result(AgentHostError::Cancelled.to_string())
            }
            Err(error) => Self::error_result(error.to_string()),
        }
    }
}

impl Drop for AgentHostClient {
    fn drop(&mut self) {
        if self.child.is_none() {
            return;
        }

        let _ = self.child.as_mut().map(|child| child.start_kill());
        self.close_transport();
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
        }
        self.cleanup_socket();
    }
}

async fn remove_socket_if_exists(path: &Path) -> Result<(), AgentHostError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(AgentHostError::RemoveSocket {
            path: path.to_path_buf(),
            source,
        }),
    }
}
