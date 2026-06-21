use crate::workspace::{WorkspaceChange, WorkspaceRequirement};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{ArtifactId, Budget, CapabilityProfile, NodeId, NodeStatus, ProblemKey};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum WorkSize {
    Tiny,
    #[default]
    Small,
    Medium,
    Large,
    XLarge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ScopeAssessment {
    pub next: String,
    pub size: WorkSize,
    pub reason: String,
}

impl ScopeAssessment {
    pub fn new(next: impl Into<String>, size: WorkSize, reason: impl Into<String>) -> Self {
        Self {
            next: next.into(),
            size,
            reason: reason.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum NodePlan {
    Execute,
    Split,
    Group(PlanGroup),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PlanGroup {
    pub mode: PlanGroupMode,
    pub items: Vec<NodeTemplate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum PlanGroupMode {
    Stage,
    Parallel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NodeTemplate {
    pub key: ProblemKey,
    pub intent: String,
    pub size: WorkSize,
    pub scope_assessment: Option<ScopeAssessment>,
    pub workspace: WorkspaceRequirement,
    pub capabilities: CapabilityProfile,
    pub budget: Budget,
    pub plan: NodePlan,
}

impl NodeTemplate {
    pub fn memory_leaf(key: &str, output: &str) -> Self {
        Self {
            key: ProblemKey(key.to_string()),
            intent: output.to_string(),
            size: WorkSize::Small,
            scope_assessment: None,
            workspace: WorkspaceRequirement::memory(),
            capabilities: CapabilityProfile::read_only(),
            budget: Budget::default(),
            plan: NodePlan::Execute,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProblemNode {
    pub id: NodeId,
    pub key: ProblemKey,
    pub parent: Option<NodeId>,
    pub intent: String,
    pub size: WorkSize,
    pub scope_assessment: Option<ScopeAssessment>,
    pub workspace: WorkspaceRequirement,
    pub capabilities: CapabilityProfile,
    pub budget: Budget,
    pub children: Vec<NodeId>,
    pub status: NodeStatus,
    pub plan: NodePlan,
    pub candidate: Option<ArtifactId>,
    pub accepted_artifact: Option<ArtifactId>,
    pub execution_attempts: u32,
    pub verification_attempts: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactContentKind {
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact {
    pub id: ArtifactId,
    pub node_id: NodeId,
    pub content_kind: ArtifactContentKind,
    pub text: String,
    pub workspace_change: Option<WorkspaceChange>,
    pub children: Vec<ArtifactId>,
}
