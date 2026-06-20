mod harness;
mod tools;

use crate::node::{Artifact, NodePlan, ProblemNode};
use crate::types::{NodeOperation, VerificationVerdict};
use crate::workspace::WorkspaceSurface;

pub use harness::{
    EngineAgentArtifactPacket, EngineAgentContextPacket, EngineAgentGitRequirementPacket,
    EngineAgentNodePacket, EngineAgentWorkspaceRequirementPacket,
    EngineAgentWorkspaceSurfacePacket, OperationHarness,
};

#[derive(Debug, Clone)]
pub struct AgentOperationContext {
    pub node: ProblemNode,
    pub operation: NodeOperation,
    pub candidate: Option<Artifact>,
    pub child_artifacts: Vec<Artifact>,
    pub workspace_surface: Option<WorkspaceSurface>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRunResult {
    pub report: String,
    pub terminal_tool: Option<String>,
    pub output: NodeOperationOutput,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct AgentRunDecodeError {
    pub message: String,
    pub terminal_tool: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeOperationOutput {
    Specified,
    Acquired {
        need: String,
        evidence: String,
        next_plan: NodePlan,
    },
    Planned {
        group: crate::PlanGroup,
    },
    Executed {
        output: String,
    },
    Combined {
        output: String,
    },
    Verified {
        verdict: VerificationVerdict,
    },
    Committed,
}
