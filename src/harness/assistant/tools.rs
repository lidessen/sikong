use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::AgentToolSpec;

pub(crate) fn specs_for_tools(tools: &[AssistantTool]) -> Vec<AgentToolSpec> {
    tools.iter().map(|tool| tool.spec()).collect()
}

pub(crate) fn terminal_tool_names() -> Vec<String> {
    vec![AssistantTool::FinishTurn.name().to_string()]
}

#[siko_macros::toolset(enum_name = "AssistantTool")]
#[allow(dead_code)]
pub(crate) trait AssistantTools {
    #[tool(
        description = "Query conversation messages. If query is omitted, returns recent messages. Offset starts from the end after filtering; limit defaults to 20."
    )]
    fn query_messages(&self, args: QueryMessagesArgs);

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
    fn finish_turn(&self, args: FinishTurnArgs);

    #[tool(
        description = "Query active self-development tasks from the task board. Returns task_id, title, and status for each active task."
    )]
    fn query_dogfood_tasks(&self, args: QueryDogfoodTasksArgs);

    #[tool(
        description = "Retrieve the eval transcript or artifact from an artifact directory. Provide the artifact_dir and an optional task_id or scenario name to narrow the search."
    )]
    fn retrieve_eval_transcript(&self, args: RetrieveEvalTranscriptArgs);
}

#[derive(Deserialize, JsonSchema)]
#[allow(dead_code)]
pub(crate) struct QueryMessagesArgs {
    pub query: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

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
pub(crate) struct FinishTurnArgs {
    pub response: String,
    #[serde(default)]
    pub task_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct QueryDogfoodTasksArgs {}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct RetrieveEvalTranscriptArgs {
    /// Path to the artifact directory.
    pub artifact_dir: String,
    /// Optional task id to narrow the search.
    pub task_id: Option<String>,
    /// Optional scenario name to narrow the search.
    pub scenario: Option<String>,
}
