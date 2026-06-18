use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{AgentToolSpec, AssistantContext};

pub(crate) fn specs_for_context(_context: &AssistantContext) -> Vec<AgentToolSpec> {
    AssistantTool::ALL.iter().map(|tool| tool.spec()).collect()
}

pub(crate) fn terminal_tool_names() -> Vec<String> {
    vec![AssistantTool::SubmitAssistantDecision.name().to_string()]
}

#[siko_macros::toolset(enum_name = "AssistantTool")]
#[allow(dead_code)]
pub(crate) trait AssistantTools {
    #[tool(description = "Read the current assistant turn context packet.")]
    fn read_assistant_context(&self, args: ReadAssistantContextArgs);

    #[tool(description = "Submit the assistant-level decision for this turn.")]
    fn submit_assistant_decision(&self, args: SubmitAssistantDecisionArgs);
}

#[derive(Deserialize, JsonSchema)]
pub(crate) struct ReadAssistantContextArgs {}

#[derive(Deserialize, Serialize, JsonSchema)]
#[allow(dead_code)]
pub(crate) struct SubmitAssistantDecisionArgs {
    pub(crate) decision: AssistantDecisionKind,
    pub(crate) request: Option<String>,
    pub(crate) task_id: Option<String>,
    pub(crate) response: String,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub(crate) enum AssistantDecisionKind {
    CreateTask,
    ListTasks,
    InspectTask,
    CancelActiveTask,
    Reply,
}
