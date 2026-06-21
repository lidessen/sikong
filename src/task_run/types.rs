use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_run::AgentTokenUsage;
use crate::workspace::WorkspaceError;

pub type NodeId = u64;
pub type ArtifactId = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum NodeOperation {
    Specify,
    Plan,
    Execute,
    Combine,
    Verify,
    Commit,
}

impl NodeOperation {
    pub fn governance_layer(self) -> Option<GovernanceLayer> {
        match self {
            Self::Specify | Self::Plan => Some(GovernanceLayer::Plan),
            Self::Execute | Self::Combine => Some(GovernanceLayer::Execute),
            Self::Verify => Some(GovernanceLayer::Verify),
            Self::Commit => None,
        }
    }

    pub fn active_hard_gates(self) -> &'static [GovernanceGate] {
        match self {
            Self::Specify => &[],
            Self::Plan => &[
                GovernanceGate::ArchEscape,
                GovernanceGate::ParallelDependency,
                GovernanceGate::SynthesisChild,
                GovernanceGate::ScopeWiden,
                GovernanceGate::Protocol,
            ],
            Self::Execute => &[
                GovernanceGate::ArchEscape,
                GovernanceGate::ScopeWiden,
                GovernanceGate::Protocol,
                GovernanceGate::CheckFail,
            ],
            Self::Combine => &[
                GovernanceGate::UnsupportedFact,
                GovernanceGate::Protocol,
                GovernanceGate::CheckFail,
            ],
            Self::Verify => &[
                GovernanceGate::PassWithHardViolation,
                GovernanceGate::Protocol,
                GovernanceGate::CheckFail,
            ],
            Self::Commit => &[],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum GovernanceLayer {
    Arch,
    Plan,
    Execute,
    Verify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum GovernanceGate {
    #[serde(rename = "G-ARCH-ESCAPE")]
    #[schemars(rename = "G-ARCH-ESCAPE")]
    ArchEscape,
    #[serde(rename = "G-SCOPE-WIDEN")]
    #[schemars(rename = "G-SCOPE-WIDEN")]
    ScopeWiden,
    #[serde(rename = "G-PARALLEL-DEPENDENCY")]
    #[schemars(rename = "G-PARALLEL-DEPENDENCY")]
    ParallelDependency,
    #[serde(rename = "G-SYNTHESIS-CHILD")]
    #[schemars(rename = "G-SYNTHESIS-CHILD")]
    SynthesisChild,
    #[serde(rename = "G-UNSUPPORTED-FACT")]
    #[schemars(rename = "G-UNSUPPORTED-FACT")]
    UnsupportedFact,
    #[serde(rename = "G-PASS-WITH-HARD-VIOLATION")]
    #[schemars(rename = "G-PASS-WITH-HARD-VIOLATION")]
    PassWithHardViolation,
    #[serde(rename = "G-PROTOCOL")]
    #[schemars(rename = "G-PROTOCOL")]
    Protocol,
    #[serde(rename = "G-CHECK-FAIL")]
    #[schemars(rename = "G-CHECK-FAIL")]
    CheckFail,
}

impl GovernanceGate {
    pub fn id(self) -> &'static str {
        match self {
            Self::ArchEscape => "G-ARCH-ESCAPE",
            Self::ScopeWiden => "G-SCOPE-WIDEN",
            Self::ParallelDependency => "G-PARALLEL-DEPENDENCY",
            Self::SynthesisChild => "G-SYNTHESIS-CHILD",
            Self::UnsupportedFact => "G-UNSUPPORTED-FACT",
            Self::PassWithHardViolation => "G-PASS-WITH-HARD-VIOLATION",
            Self::Protocol => "G-PROTOCOL",
            Self::CheckFail => "G-CHECK-FAIL",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::ArchEscape => {
                "Local work modifies Arch-owned contracts without explicit authority."
            }
            Self::ScopeWiden => "A child workspace scope widens beyond the parent scope.",
            Self::ParallelDependency => {
                "A parallel plan item depends on sibling output; ordered dependencies must be staged."
            }
            Self::SynthesisChild => {
                "A parallel plan creates a child only to synthesize sibling findings; parent Combine owns synthesis."
            }
            Self::UnsupportedFact => {
                "Combine introduces facts not present in accepted child artifacts or parent context."
            }
            Self::PassWithHardViolation => {
                "Verify returns accept while listing a hard gate violation."
            }
            Self::Protocol => "The agent run violates the terminal tool or payload protocol.",
            Self::CheckFail => "A deterministic check required for acceptance failed.",
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
    fn all_governance_gates_have_non_empty_ids_and_descriptions() {
        let gates = [
            GovernanceGate::ArchEscape,
            GovernanceGate::ScopeWiden,
            GovernanceGate::ParallelDependency,
            GovernanceGate::SynthesisChild,
            GovernanceGate::UnsupportedFact,
            GovernanceGate::PassWithHardViolation,
            GovernanceGate::Protocol,
            GovernanceGate::CheckFail,
        ];
        for gate in gates {
            let id = gate.id();
            let desc = gate.description();
            assert!(!id.is_empty(), "gate {:?} has empty id", gate);
            assert!(
                id.starts_with("G-"),
                "gate {:?} id '{}' does not start with G-",
                gate,
                id
            );
            assert!(!desc.is_empty(), "gate {:?} id={} has empty description", gate, id);
            assert!(
                desc.len() > 10,
                "gate {:?} id={} description too short: '{}'",
                gate,
                id,
                desc
            );
        }
    }

    #[test]
    fn governance_layer_is_some_for_all_agent_operations() {
        for op in [
            NodeOperation::Specify,
            NodeOperation::Plan,
            NodeOperation::Execute,
            NodeOperation::Combine,
            NodeOperation::Verify,
        ] {
            assert!(
                op.governance_layer().is_some(),
                "operation {:?} has no governance layer",
                op
            );
        }
    }

    #[test]
    fn commit_has_no_governance_layer() {
        assert_eq!(NodeOperation::Commit.governance_layer(), None);
    }
}
