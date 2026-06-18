use crate::types::{ArtifactId, Budget, CapabilityProfile, NodeId, NodeStatus, ProblemKey};
use crate::workspace::{WorkspaceDelta, WorkspaceRequirement};

use crate::types::VerificationVerdict;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum NodeScript {
    Leaf {
        output: String,
        changed_paths: Vec<String>,
        side_effects: Vec<String>,
        verdicts: Vec<VerificationVerdict>,
    },
    NeedsInfo {
        need: String,
        acquired: String,
        then: Box<NodeScript>,
    },
    Divide {
        children: Vec<NodeTemplate>,
        combine_output: String,
        verdicts: Vec<VerificationVerdict>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NodeTemplate {
    pub key: ProblemKey,
    pub intent: String,
    pub workspace: WorkspaceRequirement,
    pub capabilities: CapabilityProfile,
    pub budget: Budget,
    pub script: NodeScript,
}

impl NodeTemplate {
    pub fn memory_leaf(key: &str, output: &str) -> Self {
        Self {
            key: ProblemKey(key.to_string()),
            intent: key.to_string(),
            workspace: WorkspaceRequirement::memory(),
            capabilities: CapabilityProfile::read_only(),
            budget: Budget::default(),
            script: NodeScript::Leaf {
                output: output.to_string(),
                changed_paths: Vec::new(),
                side_effects: Vec::new(),
                verdicts: vec![VerificationVerdict::Accept],
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProblemNode {
    pub id: NodeId,
    pub key: ProblemKey,
    pub parent: Option<NodeId>,
    pub intent: String,
    pub workspace: WorkspaceRequirement,
    pub capabilities: CapabilityProfile,
    pub budget: Budget,
    pub dependencies: Vec<NodeId>,
    pub children: Vec<NodeId>,
    pub status: NodeStatus,
    pub script: NodeScript,
    pub acquired: Vec<String>,
    pub candidate: Option<ArtifactId>,
    pub accepted_artifact: Option<ArtifactId>,
    pub execution_attempts: u32,
    pub verification_attempts: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactKind {
    Evidence,
    Work,
    Combined,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact {
    pub id: ArtifactId,
    pub node_id: NodeId,
    pub kind: ArtifactKind,
    pub text: String,
    pub workspace_delta: Option<WorkspaceDelta>,
    pub children: Vec<ArtifactId>,
}
