use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{AgentToolSpec, AssistantContext};

pub(crate) fn specs_for_context(_context: &AssistantContext) -> Vec<AgentToolSpec> {
    AssistantTool::ALL.iter().map(|tool| tool.spec()).collect()
}

pub(crate) fn terminal_tool_names() -> Vec<String> {
    vec![AssistantTool::FinishAssistantTurn.name().to_string()]
}

#[siko_macros::toolset(enum_name = "AssistantTool")]
#[allow(dead_code)]
pub(crate) trait AssistantTools {
    #[tool(description = "Read the current assistant turn context packet.")]
    fn read_assistant_context(&self, args: ReadAssistantContextArgs);

    #[tool(description = "List the tasks visible to the assistant.")]
    fn list_tasks(&self, args: ListTasksArgs);

    #[tool(description = "Inspect one task and its current status.")]
    fn inspect_task(&self, args: InspectTaskArgs);

    #[tool(description = "Create a durable task for the recursive engine runtime.")]
    fn create_task(&self, args: CreateTaskArgs);

    #[tool(
        description = "Cancel a task. If task_id is omitted, cancel the focused or first active task."
    )]
    fn cancel_task(&self, args: CancelTaskArgs);

    #[tool(
        description = "Finish the assistant turn with the response that should be shown to the user."
    )]
    fn finish_assistant_turn(&self, args: FinishAssistantTurnArgs);
}

#[derive(Deserialize, JsonSchema)]
pub(crate) struct ReadAssistantContextArgs {}

#[derive(Deserialize, JsonSchema)]
pub(crate) struct ListTasksArgs {}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub(crate) struct InspectTaskArgs {
    pub task_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub(crate) struct CreateTaskArgs {
    pub request: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub(crate) struct CancelTaskArgs {
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub(crate) struct FinishAssistantTurnArgs {
    pub response: String,
    #[serde(default)]
    pub task_ids: Vec<String>,
}
