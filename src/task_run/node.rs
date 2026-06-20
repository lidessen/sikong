use crate::workspace::{WorkspaceChange, WorkspaceRequirement};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{ArtifactId, Budget, CapabilityProfile, NodeId, NodeStatus, ProblemKey};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum WorkSize {
    Tiny,
    Small,
    Medium,
    Large,
    XLarge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum WorkShape {
    Atomic,
    Phased,
    IndependentAreas,
    Unknown,
}

impl Default for WorkShape {
    fn default() -> Self {
        Self::Unknown
    }
}

impl Default for WorkSize {
    fn default() -> Self {
        Self::Small
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ScopeAssessment {
    pub size: WorkSize,
    pub shape: WorkShape,
    pub reference_match: String,
    pub scope_signals: Vec<String>,
}

impl ScopeAssessment {
    pub fn new(
        size: WorkSize,
        shape: WorkShape,
        reference_match: impl Into<String>,
        scope_signals: Vec<String>,
    ) -> Self {
        Self {
            size,
            shape,
            reference_match: reference_match.into(),
            scope_signals,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum NodePlan {
    Execute,
    NeedsInfo { need: String, then: Box<NodePlan> },
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
    pub acquired: Vec<String>,
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
