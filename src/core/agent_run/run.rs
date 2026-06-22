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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::time::{Duration, timeout};

    // ── CancellationToken ──────────────────────────────────────────────

    #[test]
    fn cancellation_token_new_is_not_cancelled() {
        let token = CancellationToken::new();
        assert!(!token.is_cancelled());
    }

    #[test]
    fn cancellation_token_cancel_sets_cancelled() {
        let token = CancellationToken::new();
        token.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancellation_token_cancel_is_idempotent() {
        let token = CancellationToken::new();
        token.cancel();
        token.cancel(); // second cancel should not panic
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancellation_token_cloned_shares_state() {
        let token_a = CancellationToken::new();
        let token_b = token_a.clone();
        token_a.cancel();
        assert!(token_b.is_cancelled());
    }

    #[tokio::test]
    async fn cancellation_token_cancelled_returns_immediately_if_already_cancelled() {
        let token = CancellationToken::new();
        token.cancel();
        // cancelled() should return immediately without blocking
        timeout(Duration::from_millis(50), token.cancelled())
            .await
            .expect("cancelled() should return immediately when already cancelled");
    }

    #[tokio::test]
    async fn cancellation_token_notifies_waiters() {
        let token = CancellationToken::new();
        let waiter = {
            let token = token.clone();
            tokio::spawn(async move {
                token.cancelled().await;
            })
        };

        token.cancel();

        timeout(Duration::from_millis(50), waiter)
            .await
            .expect("waiter should be notified within timeout")
            .expect("waiter task should complete");
    }

    // ── AgentEffort ────────────────────────────────────────────────────

    #[test]
    fn agent_effort_all_variants_serde_roundtrip() {
        for (variant, expected_json) in [
            (AgentEffort::Low, "\"low\""),
            (AgentEffort::Medium, "\"medium\""),
            (AgentEffort::High, "\"high\""),
            (AgentEffort::Max, "\"max\""),
        ] {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, expected_json, "serialization for {variant:?}");
            let deserialized: AgentEffort = serde_json::from_str(expected_json).unwrap();
            assert_eq!(deserialized, variant, "deserialization for {variant:?}");
        }
    }

    // ── AgentRuntimeProfile ────────────────────────────────────────────

    #[test]
    fn agent_runtime_profile_default_is_general() {
        assert_eq!(AgentRuntimeProfile::default(), AgentRuntimeProfile::General);
    }

    #[test]
    fn agent_runtime_profile_all_variants_serde_roundtrip() {
        for (variant, expected_json) in [
            (AgentRuntimeProfile::General, "\"general\""),
            (AgentRuntimeProfile::Code, "\"code\""),
        ] {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, expected_json, "serialization for {variant:?}");
            let deserialized: AgentRuntimeProfile = serde_json::from_str(expected_json).unwrap();
            assert_eq!(deserialized, variant, "deserialization for {variant:?}");
        }
    }

    // ── AgentTokenUsage ────────────────────────────────────────────────

    #[test]
    fn agent_token_usage_active_tokens_uses_active_field_when_set() {
        let usage = AgentTokenUsage {
            active_tokens: 500,
            input_tokens: 100,
            output_tokens: 200,
            cache_creation_tokens: 50,
            total_tokens: 1000,
            ..Default::default()
        };
        assert_eq!(usage.active_tokens(), 500);
    }

    #[test]
    fn agent_token_usage_active_tokens_fallback_when_active_zero_and_total_nonzero() {
        let usage = AgentTokenUsage {
            active_tokens: 0,
            input_tokens: 100,
            output_tokens: 200,
            cache_creation_tokens: 50,
            total_tokens: 1000,
            ..Default::default()
        };
        // fallback = input + output + cache_creation = 100 + 200 + 50 = 350
        assert_eq!(usage.active_tokens(), 350);
    }

    #[test]
    fn agent_token_usage_active_tokens_returns_active_when_total_zero() {
        let usage = AgentTokenUsage {
            active_tokens: 0,
            input_tokens: 100,
            total_tokens: 0,
            ..Default::default()
        };
        // total_tokens == 0 triggers early return of active_tokens (which is 0)
        assert_eq!(usage.active_tokens(), 0);
    }

    #[test]
    fn agent_token_usage_cached_tokens_sum() {
        let usage = AgentTokenUsage {
            cache_read_tokens: 300,
            cache_creation_tokens: 50,
            ..Default::default()
        };
        assert_eq!(usage.cached_tokens(), 350);
    }

    #[test]
    fn agent_token_usage_add_sums_fields() {
        let a = AgentTokenUsage {
            input_tokens: 10,
            output_tokens: 20,
            active_tokens: 30,
            total_tokens: 60,
            cache_read_tokens: 5,
            cache_creation_tokens: 3,
        };
        let b = AgentTokenUsage {
            input_tokens: 100,
            output_tokens: 200,
            active_tokens: 300,
            total_tokens: 600,
            cache_read_tokens: 50,
            cache_creation_tokens: 30,
        };
        let sum = a + b;
        assert_eq!(sum.input_tokens, 110);
        assert_eq!(sum.output_tokens, 220);
        assert_eq!(sum.active_tokens, 330);
        assert_eq!(sum.total_tokens, 660);
        assert_eq!(sum.cache_read_tokens, 55);
        assert_eq!(sum.cache_creation_tokens, 33);
    }

    #[test]
    fn agent_token_usage_sum_iterator() {
        let usages = vec![
            AgentTokenUsage {
                input_tokens: 10,
                output_tokens: 20,
                ..Default::default()
            },
            AgentTokenUsage {
                input_tokens: 100,
                output_tokens: 200,
                ..Default::default()
            },
            AgentTokenUsage {
                input_tokens: 1000,
                output_tokens: 2000,
                ..Default::default()
            },
        ];
        let total: AgentTokenUsage = usages.into_iter().sum();
        assert_eq!(total.input_tokens, 1110);
        assert_eq!(total.output_tokens, 2220);
    }

    #[test]
    fn agent_token_usage_default_is_zero() {
        let usage = AgentTokenUsage::default();
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.active_tokens, 0);
        assert_eq!(usage.total_tokens, 0);
        assert_eq!(usage.cache_read_tokens, 0);
        assert_eq!(usage.cache_creation_tokens, 0);
    }

    #[test]
    fn agent_token_usage_serde_roundtrip() {
        let usage = AgentTokenUsage {
            input_tokens: 100,
            output_tokens: 200,
            active_tokens: 300,
            total_tokens: 600,
            cache_read_tokens: 50,
            cache_creation_tokens: 30,
        };
        let json = serde_json::to_value(&usage).unwrap();
        assert_eq!(json["inputTokens"], 100);
        assert_eq!(json["outputTokens"], 200);
        assert_eq!(json["activeTokens"], 300);
        assert_eq!(json["totalTokens"], 600);
        assert_eq!(json["cacheReadTokens"], 50);
        assert_eq!(json["cacheCreationTokens"], 30);

        let deserialized: AgentTokenUsage = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized, usage);
    }

    // ── AgentToolSpec ──────────────────────────────────────────────────

    #[test]
    fn agent_tool_spec_serde_roundtrip() {
        let spec = AgentToolSpec {
            name: "read_file".to_string(),
            description: "Read contents of a file.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                }
            }),
        };
        let json = serde_json::to_value(&spec).unwrap();
        assert_eq!(json["name"], "read_file");
        assert_eq!(json["description"], "Read contents of a file.");
        assert_eq!(json["inputSchema"]["properties"]["path"]["type"], "string");

        let deserialized: AgentToolSpec = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized, spec);
    }

    // ── AgentToolCall ──────────────────────────────────────────────────

    #[test]
    fn agent_tool_call_serde_roundtrip() {
        let call = AgentToolCall {
            name: "submit_work".to_string(),
            arguments: json!({ "output": "done" }),
        };
        let json = serde_json::to_value(&call).unwrap();
        assert_eq!(json["name"], "submit_work");
        assert_eq!(json["arguments"]["output"], "done");

        let deserialized: AgentToolCall = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized, call);
    }

    // ── AgentPromptSection ─────────────────────────────────────────────

    #[test]
    fn agent_prompt_section_serializes_with_title_and_content() {
        let section = AgentPromptSection {
            title: "Task".to_string(),
            content: "Do the thing.".to_string(),
        };
        let json = serde_json::to_value(&section).unwrap();
        assert_eq!(json["title"], "Task");
        assert_eq!(json["content"], "Do the thing.");
    }

    // ── AgentRunRequest ────────────────────────────────────────────────

    #[test]
    fn agent_run_request_new_sets_protocol_version_one() {
        let req = AgentRunRequest::new(
            "test objective".to_string(),
            vec![],
            json!({}),
            vec![],
            vec![],
        );
        assert_eq!(req.protocol_version, 1);
        assert_eq!(req.objective, "test objective");
        assert_eq!(req.runtime_profile, AgentRuntimeProfile::General);
        assert_eq!(req.effort, None);
    }

    #[test]
    fn agent_run_request_with_runtime_profile_chains() {
        let req = AgentRunRequest::new("test".to_string(), vec![], json!({}), vec![], vec![])
            .with_runtime_profile(AgentRuntimeProfile::Code);
        assert_eq!(req.runtime_profile, AgentRuntimeProfile::Code);
    }

    #[test]
    fn agent_run_request_with_effort_chains() {
        let req = AgentRunRequest::new("test".to_string(), vec![], json!({}), vec![], vec![])
            .with_effort(AgentEffort::High);
        assert_eq!(req.effort, Some(AgentEffort::High));
    }

    #[test]
    fn agent_run_request_serializes_with_camel_case_fields() {
        let req = AgentRunRequest::new(
            "objective".to_string(),
            vec![AgentPromptSection {
                title: "Guidance".to_string(),
                content: "Be thorough.".to_string(),
            }],
            json!({ "kind": "test" }),
            vec![AgentToolSpec {
                name: "tool".to_string(),
                description: "A tool.".to_string(),
                input_schema: json!({}),
            }],
            vec!["terminal_tool".to_string()],
        )
        .with_effort(AgentEffort::Max);

        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["protocolVersion"], 1);
        assert_eq!(json["objective"], "objective");
        assert_eq!(json["runtimeProfile"], "general");
        assert_eq!(json["effort"], "max");
        assert_eq!(json["terminalToolSet"][0], "terminal_tool");
        assert_eq!(json["prompt"][0]["title"], "Guidance");
        assert_eq!(json["tools"][0]["name"], "tool");
        assert_eq!(json["input"]["kind"], "test");
    }

    #[test]
    fn agent_run_request_serialize_skips_effort_when_none() {
        let req = AgentRunRequest::new("test".to_string(), vec![], json!({}), vec![], vec![]);
        let json = serde_json::to_value(&req).unwrap();
        assert!(
            json.get("effort").is_none(),
            "effort should be skipped when None"
        );
    }

    // ── AgentRunResponse ───────────────────────────────────────────────

    #[test]
    fn agent_run_response_serde_roundtrip_with_all_fields() {
        let response = AgentRunResponse {
            report: "Done.".to_string(),
            tool_calls: vec![AgentToolCall {
                name: "read_file".to_string(),
                arguments: json!({ "path": "/tmp/test" }),
            }],
            terminal_call: Some(AgentToolCall {
                name: "submit_work".to_string(),
                arguments: json!({ "output": "ok" }),
            }),
            usage: Some(AgentTokenUsage {
                input_tokens: 50,
                output_tokens: 100,
                ..Default::default()
            }),
            events: vec![json!({ "event": "started" })],
        };

        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["report"], "Done.");
        assert_eq!(json["toolCalls"][0]["name"], "read_file");
        assert_eq!(json["terminalCall"]["name"], "submit_work");
        assert_eq!(json["usage"]["inputTokens"], 50);
        assert_eq!(json["events"][0]["event"], "started");

        let deserialized: AgentRunResponse = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.report, response.report);
        assert_eq!(deserialized.tool_calls, response.tool_calls);
        assert_eq!(deserialized.terminal_call, response.terminal_call);
        assert_eq!(deserialized.usage, response.usage);
        assert_eq!(deserialized.events, response.events);
    }

    #[test]
    fn agent_run_response_serde_with_optional_fields_missing() {
        let json = json!({
            "report": "Done."
        });
        let response: AgentRunResponse = serde_json::from_value(json).unwrap();
        assert_eq!(response.report, "Done.");
        assert!(response.tool_calls.is_empty());
        assert!(response.terminal_call.is_none());
        assert!(response.usage.is_none());
        assert!(response.events.is_empty());
    }

    // ── schema_for ─────────────────────────────────────────────────────

    #[test]
    fn schema_for_returns_valid_json_schema() {
        let schema = schema_for::<String>();
        assert!(
            schema.get("type").is_some(),
            "schema should have a type field"
        );
        assert_eq!(schema["type"], "string");
    }
}
