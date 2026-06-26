use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

use crate::agent_run::AgentTokenUsage;
pub use crate::common::types::{ArtifactId, NodeId};
use crate::workspace::WorkspaceError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum NodeOperation {
    Specify,
    Plan,
    Execute,
    Combine,
    Verify,
    Commit,
}

impl fmt::Display for NodeOperation {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match self {
            Self::Specify => "Specify",
            Self::Plan => "Plan",
            Self::Execute => "Execute",
            Self::Combine => "Combine",
            Self::Verify => "Verify",
            Self::Commit => "Commit",
        })
    }
}

impl fmt::Display for VerificationVerdict {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::Accept => f.write_str("Accept"),
            Self::Reject {
                failure_class,
                reason,
            } => {
                write!(f, "Reject({}): {}", failure_class, reason)
            }
            Self::Uncertain {
                missing_info,
                reason,
            } => {
                write!(f, "Uncertain(missing: {}): {}", missing_info, reason)
            }
        }
    }
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

impl fmt::Display for ProblemKey {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(&self.0)
    }
}

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

impl fmt::Display for NodeStatus {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match self {
            Self::New => "New",
            Self::Specified => "Specified",
            Self::WaitingForInfo => "WaitingForInfo",
            Self::Planned => "Planned",
            Self::Running => "Running",
            Self::Combining => "Combining",
            Self::Verifying => "Verifying",
            Self::Accepted => "Accepted",
            Self::Rejected => "Rejected",
            Self::Pruned => "Pruned",
            Self::Committed => "Committed",
        })
    }
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
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    MissingInfo,
    SpecAmbiguity,
    IncompleteOutput,
    BadOutput,
    UnsafeSideEffect,
    MergeConflict,
    BudgetExhausted,
}

impl fmt::Display for FailureClass {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match self {
            Self::MissingInfo => "missing_info",
            Self::SpecAmbiguity => "spec_ambiguity",
            Self::IncompleteOutput => "incomplete_output",
            Self::BadOutput => "bad_output",
            Self::UnsafeSideEffect => "unsafe_side_effect",
            Self::MergeConflict => "merge_conflict",
            Self::BudgetExhausted => "budget_exhausted",
        })
    }
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
    pub terminal_payload: Option<Value>,
    pub duration_ms: u128,
    pub usage: Option<AgentTokenUsage>,
    #[serde(default)]
    pub events: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BranchProgressEvent {
    Operation {
        operation: NodeOperation,
        note: String,
    },
    AgentRunStarted {
        operation: NodeOperation,
        objective: String,
        terminal_tools: Vec<String>,
    },
    AgentRun {
        operation: NodeOperation,
        report: String,
        terminal_tool: Option<String>,
        terminal_payload: Option<Value>,
        duration_ms: u128,
        usage: Option<AgentTokenUsage>,
        #[serde(default)]
        events: Vec<Value>,
    },
    AgentRunEvent {
        operation: NodeOperation,
        event: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineProgressEvent {
    Operation {
        event: OperationEvent,
    },
    AgentRunStarted {
        node_id: NodeId,
        operation: NodeOperation,
        objective: String,
        terminal_tools: Vec<String>,
    },
    AgentRun {
        run: AgentRunRecord,
    },
    AgentRunEvent {
        node_id: NodeId,
        operation: NodeOperation,
        event: Value,
    },
    BranchLocal {
        branch_root_node_id: NodeId,
        local_node_id: NodeId,
        event: BranchProgressEvent,
    },
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
    pub artifact_text: Option<String>,
    pub events: Vec<OperationEvent>,
    pub agent_runs: Vec<AgentRunRecord>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_implementations_are_readable() {
        // NodeOperation
        assert_eq!(format!("{}", NodeOperation::Specify), "Specify");
        assert_eq!(format!("{}", NodeOperation::Plan), "Plan");
        assert_eq!(format!("{}", NodeOperation::Execute), "Execute");
        assert_eq!(format!("{}", NodeOperation::Combine), "Combine");
        assert_eq!(format!("{}", NodeOperation::Verify), "Verify");
        assert_eq!(format!("{}", NodeOperation::Commit), "Commit");

        // NodeStatus
        assert_eq!(format!("{}", NodeStatus::New), "New");
        assert_eq!(format!("{}", NodeStatus::Specified), "Specified");
        assert_eq!(format!("{}", NodeStatus::WaitingForInfo), "WaitingForInfo");
        assert_eq!(format!("{}", NodeStatus::Planned), "Planned");
        assert_eq!(format!("{}", NodeStatus::Running), "Running");
        assert_eq!(format!("{}", NodeStatus::Combining), "Combining");
        assert_eq!(format!("{}", NodeStatus::Verifying), "Verifying");
        assert_eq!(format!("{}", NodeStatus::Accepted), "Accepted");
        assert_eq!(format!("{}", NodeStatus::Rejected), "Rejected");
        assert_eq!(format!("{}", NodeStatus::Pruned), "Pruned");
        assert_eq!(format!("{}", NodeStatus::Committed), "Committed");

        // FailureClass
        assert_eq!(format!("{}", FailureClass::MissingInfo), "missing_info");
        assert_eq!(format!("{}", FailureClass::SpecAmbiguity), "spec_ambiguity");
        assert_eq!(
            format!("{}", FailureClass::IncompleteOutput),
            "incomplete_output"
        );
        assert_eq!(format!("{}", FailureClass::BadOutput), "bad_output");
        assert_eq!(
            format!("{}", FailureClass::UnsafeSideEffect),
            "unsafe_side_effect"
        );
        assert_eq!(format!("{}", FailureClass::MergeConflict), "merge_conflict");
        assert_eq!(
            format!("{}", FailureClass::BudgetExhausted),
            "budget_exhausted"
        );

        // ProblemKey
        assert_eq!(format!("{}", ProblemKey("hello".to_string())), "hello");
        assert_eq!(
            format!("{}", ProblemKey("task-run-split-eval".to_string())),
            "task-run-split-eval"
        );

        // VerificationVerdict
        assert_eq!(format!("{}", VerificationVerdict::Accept), "Accept");
        assert_eq!(
            format!(
                "{}",
                VerificationVerdict::Reject {
                    failure_class: FailureClass::BadOutput,
                    reason: "wrong format".to_string(),
                }
            ),
            "Reject(bad_output): wrong format"
        );
        assert_eq!(
            format!(
                "{}",
                VerificationVerdict::Uncertain {
                    missing_info: "schema version".to_string(),
                    reason: "need more data".to_string(),
                }
            ),
            "Uncertain(missing: schema version): need more data"
        );
    }

    // ── CapabilityProfile tests ──────────────────────────────────────────

    #[test]
    fn capability_profile_read_only_does_not_allow_write() {
        let profile = CapabilityProfile::read_only();
        assert!(!profile.allow_write);
    }

    #[test]
    fn capability_profile_writable_allows_write() {
        let profile = CapabilityProfile::writable();
        assert!(profile.allow_write);
    }

    // ── Budget tests ─────────────────────────────────────────────────────

    #[test]
    fn budget_default_max_attempts_is_two() {
        let budget = Budget::default();
        assert_eq!(budget.max_attempts, 2);
    }
}
