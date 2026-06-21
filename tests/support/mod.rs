use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use siko::*;

#[derive(Debug, Clone, Default)]
pub struct TestAgentRunScheduler;

#[async_trait::async_trait]
impl AgentRunScheduler for TestAgentRunScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        _cancellation: CancellationToken,
    ) -> AgentRunResponse {
        let terminal_call = input
            .tools
            .iter()
            .find(|tool| input.terminal_tool_set.contains(&tool.name))
            .map(|tool| AgentToolCall {
                name: tool.name.clone(),
                arguments: mock_terminal_arguments(&input, &tool.name),
            });

        AgentRunResponse {
            report: format!("test agent worker completed {}", input.objective),
            tool_calls: terminal_call.clone().into_iter().collect(),
            terminal_call,
            usage: None,
        }
    }
}

fn mock_terminal_arguments(input: &AgentRunRequest, tool_name: &str) -> Value {
    let plan = input
        .input
        .get("plan")
        .cloned()
        .and_then(|value| serde_json::from_value::<NodePlan>(value).ok());
    let node = input
        .input
        .get("node")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let intent = node
        .get("intent")
        .and_then(Value::as_str)
        .unwrap_or("mock output");

    match tool_name {
        "submit_specification" => mock_specification_args(intent, plan.as_ref()),
        "submit_plan_group" => match plan {
            Some(NodePlan::Group(group)) => json!({
                "mode": group.mode,
                "items": group.items.into_iter().map(|item| {
                    json!({
                        "key": item.key.0,
                        "intent": item.intent,
                        "size": item.size,
                        "reason": item.scope_assessment.as_ref().map(|assessment| assessment.reason.clone()),
                        "requires_prior_results": false,
                    })
                }).collect::<Vec<_>>(),
            }),
            _ => json!({
                "mode": PlanGroupMode::Parallel,
                "items": Vec::<NodeTemplate>::new(),
            }),
        },
        "submit_work" => json!({
            "output": intent,
        }),
        "submit_combination" => json!({
            "output": intent,
        }),
        "submit_verdict" => {
            let attempt = input
                .input
                .pointer("/node/verification_attempts")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize;
            verdict_arguments(verdict_for(intent, attempt))
        }
        _ => json!({}),
    }
}

fn mock_specification_args(intent: &str, plan: Option<&NodePlan>) -> Value {
    match plan {
        Some(NodePlan::Group(_)) | Some(NodePlan::Split) => json!({
            "next": intent,
            "size": "large",
            "reason": "This is closest to Large because the fixture already contains multiple child work items."
        }),
        _ => json!({
            "next": intent,
            "size": "small",
            "reason": "This is closest to Small because the test scheduler mirrors one local node with one terminal path."
        }),
    }
}

fn verdict_for(intent: &str, attempt: usize) -> VerificationVerdict {
    if intent.contains("always bad") {
        return VerificationVerdict::Reject {
            failure_class: FailureClass::BadOutput,
            reason: "bad output".to_string(),
        };
    }
    if intent.contains("missing-info reject") {
        return VerificationVerdict::Reject {
            failure_class: FailureClass::MissingInfo,
            reason: "missing source evidence".to_string(),
        };
    }
    if intent.contains("retry once") && attempt == 0 {
        return VerificationVerdict::Reject {
            failure_class: FailureClass::BadOutput,
            reason: "bad output".to_string(),
        };
    }
    if intent.contains("needs post-verify info") {
        return VerificationVerdict::Uncertain {
            missing_info: "missing citation".to_string(),
            reason: "needs source".to_string(),
        };
    }
    VerificationVerdict::Accept
}

fn verdict_arguments(verdict: VerificationVerdict) -> Value {
    match verdict {
        VerificationVerdict::Accept => json!({
            "verdict": "accept",
            "reason": "mock accepted",
        }),
        VerificationVerdict::Reject {
            failure_class,
            reason,
        } => json!({
            "verdict": "reject",
            "reason": reason,
            "failure_class": failure_class,
        }),
        VerificationVerdict::Uncertain {
            missing_info,
            reason,
        } => json!({
            "verdict": "need_information",
            "reason": reason,
            "missing_info": missing_info,
        }),
    }
}

#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub struct RecordingAgentRunScheduler {
    requests: Arc<Mutex<Vec<AgentRunRequest>>>,
}

#[allow(dead_code)]
impl RecordingAgentRunScheduler {
    pub fn requests(&self) -> Vec<AgentRunRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl AgentRunScheduler for RecordingAgentRunScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse {
        self.requests.lock().unwrap().push(input.clone());
        TestAgentRunScheduler.run(input, cancellation).await
    }
}
