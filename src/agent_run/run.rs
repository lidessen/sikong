use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRunResponse {
    pub report: String,
    #[serde(rename = "toolCalls", default)]
    pub tool_calls: Vec<AgentToolCall>,
    #[serde(rename = "terminalCall")]
    pub terminal_call: Option<AgentToolCall>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolSpec {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentPromptSection {
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolCall {
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentRunRequest {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub objective: String,
    pub prompt: Vec<AgentPromptSection>,
    pub input: Value,
    pub tools: Vec<AgentToolSpec>,
    #[serde(rename = "terminalToolSet")]
    pub terminal_tool_set: Vec<String>,
}

impl AgentRunRequest {
    pub(crate) fn new(
        objective: String,
        prompt: Vec<AgentPromptSection>,
        input: Value,
        tools: Vec<AgentToolSpec>,
        terminal_tool_set: Vec<String>,
    ) -> Self {
        Self {
            protocol_version: 1,
            objective,
            prompt,
            input,
            tools,
            terminal_tool_set,
        }
    }
}

pub(crate) fn schema_for<T: JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).unwrap_or_else(|_| {
        json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        })
    })
}
