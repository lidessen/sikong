use crate::{AgentRunRequest, AssistantContext};

use super::pack::AssistantPackSet;

#[derive(Debug, Clone)]
pub struct AssistantHarness {
    context: AssistantContext,
}

impl AssistantHarness {
    pub fn new(context: AssistantContext) -> Self {
        Self { context }
    }

    fn context(&self) -> &AssistantContext {
        &self.context
    }
}

impl AssistantHarness {
    pub fn build_agent_run(&self) -> AgentRunRequest {
        let packs = AssistantPackSet::for_context(self.context().clone());
        AgentRunRequest::new(
            "Assistant turn".to_string(),
            packs.prompt_sections(),
            packs.input(),
            packs.tool_specs(),
            packs.terminal_tool_names(),
        )
    }
}
