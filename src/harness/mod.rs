mod assistant;
mod operation;

use serde_json::Value;

use crate::{AgentPromptSection, AgentRunKind, AgentRunRequest, AgentToolChoice, AgentToolSpec};

pub use assistant::{AssistantHarness, AssistantTurnContextPacket};
pub use operation::{
    EngineAgentArtifactPacket, EngineAgentContextPacket, EngineAgentGitRequirementPacket,
    EngineAgentHarness, EngineAgentNodePacket, EngineAgentWorkspaceIntegrationPacket,
    EngineAgentWorkspaceRequirementPacket, OperationHarness,
};

#[derive(Debug, Clone)]
pub struct Harness<C> {
    context: C,
}

impl<C> Harness<C> {
    pub fn new(context: C) -> Self {
        Self { context }
    }

    pub fn context(&self) -> &C {
        &self.context
    }
}

pub trait AgentRunHarness {
    fn build_agent_run(&self) -> AgentRunRequest;
}

pub trait AgentRunContext {
    fn kind(&self) -> AgentRunKind;
    fn objective(&self) -> String;
    fn prompt(&self) -> Vec<AgentPromptSection>;
    fn input(&self) -> Value;
    fn tools(&self) -> Vec<AgentToolSpec>;
    fn terminal_tool_names(&self) -> Vec<String>;

    fn tool_choice(&self) -> AgentToolChoice {
        AgentToolChoice::Required
    }
}

impl<C> AgentRunHarness for Harness<C>
where
    C: AgentRunContext,
{
    fn build_agent_run(&self) -> AgentRunRequest {
        AgentRunRequest {
            protocol_version: 1,
            kind: self.context.kind(),
            objective: self.context.objective(),
            prompt: self.context.prompt(),
            input: self.context.input(),
            tools: self.context.tools(),
            terminal_tool_set: self.context.terminal_tool_names(),
            tool_choice: self.context.tool_choice(),
        }
    }
}
