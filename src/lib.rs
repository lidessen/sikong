mod agent_worker;
mod assistant;
mod cancel;
mod config;
mod engine;
mod harness;
mod node;
mod tools;
mod types;
mod workspace;

pub use agent_worker::{
    AgentHarness, AgentHostClient, AgentOperationContext, AgentPromptSection, AgentRunKind,
    AgentRunRecord, AgentRunRequest, AgentRunResult, AgentTerminalToolCall, AgentToolChoice,
    AgentToolSpec, AgentWorker, AgentWorkerResult, NodeOperationOutput,
};
pub use assistant::{
    AcpRequest, AcpResponse, AcpServer, AcpServerConfig, AgentAssistantLoop, AssistantContext,
    AssistantContextTask, AssistantDecision, AssistantDecisionError, AssistantLoop,
    AssistantSession, AssistantSessionConfig, AssistantTask, AssistantTaskEvent,
    AssistantTaskStatus, AssistantWorkerFactory, FileTaskStore, JsonRpcError, MemoryTaskStore,
    SessionReply, SessionState, TaskId, TaskRuntime, TaskRuntimeSnapshot, TaskStore,
    run_acp_stdio_server,
};
pub use cancel::CancellationToken;
pub use config::{AssistantConfig, DebugConfig, SikoConfig, default_config_path};
pub use engine::Engine;
pub use harness::{
    AgentRunHarness, AssistantHarness, AssistantTurnContextPacket, EngineAgentArtifactPacket,
    EngineAgentContextPacket, EngineAgentGitRequirementPacket, EngineAgentHarness,
    EngineAgentNodePacket, EngineAgentWorkspaceIntegrationPacket,
    EngineAgentWorkspaceRequirementPacket, OperationHarness,
};
pub use node::{Artifact, ArtifactKind, NodeScript, NodeTemplate, ProblemNode};
pub use types::{
    ArtifactId, AttemptRecord, Budget, CapabilityProfile, EngineError, EngineReport, FailureClass,
    NodeId, NodeOperation, NodeStatus, OperationEvent, ProblemKey, VerificationResult,
    VerificationVerdict, WorkspaceDeltaId, WorkspaceInstanceId, WorkspaceSnapshotId,
};
pub use workspace::{
    FileSystemWorkspace, GitFileSystemWorkspace, GitWorkspaceDelta, GitWorkspaceInstance,
    GitWorkspaceIntegration, GitWorkspaceRequirement, GitWorkspaceSnapshot, MemoryWorkspace,
    Workspace, WorkspaceDelta, WorkspaceError, WorkspaceInstance, WorkspaceIntegration,
    WorkspaceProvider, WorkspaceRequirement, WorkspaceResult, WorkspaceSnapshot, Workspaces,
};
