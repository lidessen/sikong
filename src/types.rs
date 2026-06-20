use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use crate::workspace::WorkspaceError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub type NodeId = u64;
pub type ArtifactId = u64;
pub type WorkspaceSnapshotId = u64;
pub type WorkspaceResourceId = u64;

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        while !self.is_cancelled() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum NodeOperation {
    Specify,
    Acquire,
    Plan,
    Execute,
    Combine,
    Verify,
    Commit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CapabilityProfile {
    pub allow_write: bool,
}

impl CapabilityProfile {
    pub fn read_only() -> Self {
        Self { allow_write: false }
    }

    pub fn writable() -> Self {
        Self { allow_write: true }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Budget {
    pub max_attempts: u32,
}

impl Default for Budget {
    fn default() -> Self {
        Self { max_attempts: 2 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct ProblemKey(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum NodeStatus {
    New,
    Specified,
    WaitingForInfo,
    Planned,
    Running,
    Combining,
    Verifying,
    Accepted,
    Rejected,
    Pruned,
    Committed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum VerificationVerdict {
    Accept,
    Reject {
        failure_class: FailureClass,
        reason: String,
    },
    Uncertain {
        missing_info: String,
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum FailureClass {
    MissingInfo,
    SpecAmbiguity,
    BadOutput,
    UnsafeSideEffect,
    MergeConflict,
    BudgetExhausted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationEvent {
    pub node_id: NodeId,
    pub operation: NodeOperation,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRunRecord {
    pub node_id: NodeId,
    pub operation: NodeOperation,
    pub report: String,
    pub terminal_tool: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttemptRecord {
    pub node_id: NodeId,
    pub operation: NodeOperation,
    pub verdict: Option<VerificationVerdict>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    MissingNode(NodeId),
    MissingArtifact(ArtifactId),
    NoCandidate(NodeId),
    Cancelled,
    AgentProtocol(String),
    Workspace(WorkspaceError),
}

impl From<WorkspaceError> for EngineError {
    fn from(error: WorkspaceError) -> Self {
        Self::Workspace(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineReport {
    pub root: NodeId,
    pub status: NodeStatus,
    pub artifact: Option<ArtifactId>,
    pub events: Vec<OperationEvent>,
    pub agent_runs: Vec<AgentRunRecord>,
}
