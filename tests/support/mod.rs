use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use siko::*;

#[derive(Debug, Clone, Default)]
pub struct TestAgentWorker;

#[async_trait::async_trait]
impl AgentWorker for TestAgentWorker {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        _cancellation: CancellationToken,
    ) -> AgentWorkerResult {
        let terminal_tool = match &input.tool_choice {
            AgentToolChoice::Tool { name } => input
                .tools
                .iter()
                .find(|tool| input.terminal_tool_set.contains(&tool.name) && tool.name == *name),
            AgentToolChoice::Required => input
                .tools
                .iter()
                .find(|tool| input.terminal_tool_set.contains(&tool.name)),
        };

        let terminal_call = match &input.tool_choice {
            AgentToolChoice::Required => terminal_tool,
            AgentToolChoice::Tool { name }
                if terminal_tool.is_some_and(|tool| tool.name == *name) =>
            {
                terminal_tool
            }
            AgentToolChoice::Tool { .. } => None,
        }
        .map(|tool| AgentTerminalToolCall {
            name: tool.name.clone(),
            arguments: mock_terminal_arguments(&input, &tool.name),
        });

        AgentWorkerResult {
            report: format!("test agent worker completed {}", input.objective),
            terminal_call,
        }
    }
}

fn mock_terminal_arguments(input: &AgentRunRequest, tool_name: &str) -> Value {
    let script = input
        .input
        .get("script")
        .cloned()
        .and_then(|value| serde_json::from_value::<NodeScript>(value).ok());

    match tool_name {
        "submit_specification" => json!({ "report": format!("specified {}", input.objective) }),
        "submit_evidence" => match script {
            Some(NodeScript::NeedsInfo {
                need,
                acquired,
                then,
            }) => json!({
                "need": need,
                "evidence": acquired,
                "next_script": *then,
            }),
            _ => json!({
                "need": "missing_information",
                "evidence": "mock evidence",
                "next_script": NodeScript::Leaf {
                    output: "mock acquired output".to_string(),
                    changed_paths: Vec::new(),
                    side_effects: Vec::new(),
                    verdicts: vec![VerificationVerdict::Accept],
                },
            }),
        },
        "submit_division" => match script {
            Some(NodeScript::Divide { children, .. }) => json!({ "children": children }),
            _ => json!({ "children": Vec::<NodeTemplate>::new() }),
        },
        "submit_work" => match script {
            Some(NodeScript::Leaf {
                output,
                changed_paths,
                side_effects,
                ..
            }) => json!({
                "output": output,
                "changed_paths": changed_paths,
                "side_effects": side_effects,
            }),
            _ => json!({
                "output": "mock output",
                "changed_paths": [],
                "side_effects": [],
            }),
        },
        "submit_combination" => match script {
            Some(NodeScript::Divide { combine_output, .. }) => json!({
                "output": combine_output,
                "resolved_conflicts": string_array_at(&input.input, &["workspace_integration", "conflicts"]),
            }),
            _ => json!({
                "output": "mock combined output",
                "resolved_conflicts": [],
            }),
        },
        "submit_verdict" => {
            let attempt = input
                .input
                .pointer("/node/verification_attempts")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize;
            let verdict = match script {
                Some(NodeScript::Leaf { verdicts, .. })
                | Some(NodeScript::Divide { verdicts, .. }) => verdicts
                    .get(attempt)
                    .cloned()
                    .unwrap_or(VerificationVerdict::Accept),
                Some(NodeScript::NeedsInfo { .. }) | None => VerificationVerdict::Accept,
            };
            verdict_arguments(verdict)
        }
        "submit_commit" => json!({ "report": format!("committed {}", input.objective) }),
        _ => json!({}),
    }
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

fn string_array_at(value: &Value, path: &[&str]) -> Vec<String> {
    let mut current = value;
    for segment in path {
        let Some(next) = current.get(*segment) else {
            return Vec::new();
        };
        current = next;
    }
    current
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub struct RecordingAgentWorker {
    requests: Arc<Mutex<Vec<AgentRunRequest>>>,
}

#[allow(dead_code)]
impl RecordingAgentWorker {
    pub fn requests(&self) -> Vec<AgentRunRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl AgentWorker for RecordingAgentWorker {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentWorkerResult {
        self.requests.lock().unwrap().push(input.clone());
        TestAgentWorker.run(input, cancellation).await
    }
}
