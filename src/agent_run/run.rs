use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        while !self.is_cancelled() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRunResponse {
    pub report: String,
    #[serde(rename = "toolCalls", default)]
    pub tool_calls: Vec<AgentToolCall>,
    #[serde(rename = "terminalCall")]
    pub terminal_call: Option<AgentToolCall>,
    pub usage: Option<AgentTokenUsage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentEffort {
    Low,
    Medium,
    High,
    Max,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AgentTokenUsage {
    #[serde(rename = "inputTokens", default)]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens", default)]
    pub output_tokens: u64,
    #[serde(rename = "totalTokens", default)]
    pub total_tokens: u64,
    #[serde(rename = "cacheReadTokens", default)]
    pub cache_read_tokens: u64,
    #[serde(rename = "cacheCreationTokens", default)]
    pub cache_creation_tokens: u64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<AgentEffort>,
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
            effort: None,
        }
    }

    pub(crate) fn with_effort(mut self, effort: AgentEffort) -> Self {
        self.effort = Some(effort);
        self
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
