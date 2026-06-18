mod assistant;
mod engine;

use schemars::JsonSchema;
use serde_json::{Value, json};

pub(crate) use assistant::{
    AssistantDecisionKind, SubmitAssistantDecisionArgs, specs_for_context as assistant_tool_specs,
    terminal_tool_names as assistant_terminal_tool_names,
};
pub(crate) use engine::{EngineTool, EngineTools, read_operation_context_spec};

pub(crate) fn schema_for<T: JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).unwrap_or_else(|_| {
        json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        })
    })
}
