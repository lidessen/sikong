use crate::workspace::WorkspaceError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub type NodeId = u64;
pub type ArtifactId = u64;
pub type WorkspaceSnapshotId = u64;
pub type WorkspaceInstanceId = u64;
pub type WorkspaceDeltaId = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum NodeOperation {
    Specify,
    Acquire,
    Divide,
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
    Divided,
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
pub struct VerificationResult {
    pub verdict: VerificationVerdict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationEvent {
    pub node_id: NodeId,
    pub operation: NodeOperation,
    pub note: String,
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
}
