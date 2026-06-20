mod engine;
mod harness;
mod node;
mod resources;
mod tools;
mod types;

use crate::workspace::WorkspaceSurface;

pub use engine::Engine;
pub use harness::{
    EngineAgentArtifactPacket, EngineAgentContextPacket, EngineAgentGitRequirementPacket,
    EngineAgentNodePacket, EngineAgentWorkspaceRequirementPacket,
    EngineAgentWorkspaceSurfacePacket, OperationHarness,
};
pub use node::{
    Artifact, ArtifactContentKind, NodePlan, NodeTemplate, PlanGroup, PlanGroupMode, ProblemNode,
    ScopeAssessment, WorkShape, WorkSize,
};
pub use types::{
    AgentRunRecord, ArtifactId, AttemptRecord, Budget, CapabilityProfile, EngineError,
    EngineReport, FailureClass, NodeId, NodeOperation, NodeStatus, OperationEvent, ProblemKey,
    VerificationVerdict,
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
    Specified {
        scope_assessment: ScopeAssessment,
        missing_info: Option<String>,
    },
    Acquired {
        need: String,
        evidence: String,
    },
    Planned {
        group: PlanGroup,
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
}
