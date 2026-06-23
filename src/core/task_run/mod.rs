mod engine;
mod harness;
mod node;
mod resources;
mod tools;
mod types;

use crate::common::workspace::WorkspaceSurface;

pub use engine::Engine;
pub use harness::{
    EngineAgentArtifactPacket, EngineAgentContextPacket, EngineAgentGitRequirementPacket,
    EngineAgentGovernanceGatePacket, EngineAgentGovernancePacket, EngineAgentNodePacket,
    EngineAgentWorkspaceRequirementPacket, EngineAgentWorkspaceSurfacePacket, OperationHarness,
};
pub use node::{
    Artifact, ArtifactContentKind, NodePlan, NodePolicy, NodeTemplate, PlanGroup, PlanGroupMode,
    ProblemNode, ScopeAssessment, WorkSize,
};
pub use types::{
    AgentRunRecord, ArtifactId, AttemptRecord, Budget, CapabilityProfile, EngineError,
    EngineReport, FailureClass, GovernanceGate, GovernanceLayer, NodeId, NodeOperation, NodeStatus,
    OperationEvent, ProblemKey, VerificationVerdict,
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
    },
    Planned {
        group: PlanGroup,
    },
    InvalidPlan {
        gate: Option<GovernanceGate>,
        reason: String,
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
