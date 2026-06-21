use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Notify;

#[derive(Debug)]
struct CancellationState {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Default for CancellationState {
    fn default() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    state: Arc<CancellationState>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        if !self.state.cancelled.swap(true, Ordering::SeqCst) {
            self.state.notify.notify_waiters();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        loop {
            let notified = self.state.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
            if self.is_cancelled() {
                return;
            }
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
    #[serde(default)]
    pub events: Vec<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentEffort {
    Low,
    Medium,
    High,
    Max,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AgentRuntimeProfile {
    #[default]
    General,
    Code,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AgentTokenUsage {
    #[serde(rename = "inputTokens", default)]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens", default)]
    pub output_tokens: u64,
    #[serde(rename = "activeTokens", default)]
    pub active_tokens: u64,
    #[serde(rename = "totalTokens", default)]
    pub total_tokens: u64,
    #[serde(rename = "cacheReadTokens", default)]
    pub cache_read_tokens: u64,
    #[serde(rename = "cacheCreationTokens", default)]
    pub cache_creation_tokens: u64,
}

impl AgentTokenUsage {
    pub fn active_tokens(&self) -> u64 {
        if self.active_tokens > 0 || self.total_tokens == 0 {
            self.active_tokens
        } else {
            self.input_tokens + self.output_tokens + self.cache_creation_tokens
        }
    }

    pub fn cached_tokens(&self) -> u64 {
        self.cache_read_tokens + self.cache_creation_tokens
    }
}

impl std::ops::Add for AgentTokenUsage {
    type Output = Self;

    fn add(self, rhs: Self) -> Self {
        Self {
            input_tokens: self.input_tokens + rhs.input_tokens,
            output_tokens: self.output_tokens + rhs.output_tokens,
            active_tokens: self.active_tokens + rhs.active_tokens,
            total_tokens: self.total_tokens + rhs.total_tokens,
            cache_read_tokens: self.cache_read_tokens + rhs.cache_read_tokens,
            cache_creation_tokens: self.cache_creation_tokens + rhs.cache_creation_tokens,
        }
    }
}

impl std::iter::Sum for AgentTokenUsage {
    fn sum<I: Iterator<Item = Self>>(iter: I) -> Self {
        iter.fold(AgentTokenUsage::default(), |a, b| a + b)
    }
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
    #[serde(rename = "runtimeProfile")]
    pub runtime_profile: AgentRuntimeProfile,
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
            runtime_profile: AgentRuntimeProfile::General,
            effort: None,
        }
    }

    pub(crate) fn with_runtime_profile(mut self, runtime_profile: AgentRuntimeProfile) -> Self {
        self.runtime_profile = runtime_profile;
        self
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
