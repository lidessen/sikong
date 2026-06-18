use serde_json::json;
use siko::*;

mod support;
use support::TestAgentWorker;

#[tokio::test]
async fn test_agent_worker_selects_required_terminal_tool_from_run_config() {
    let mut worker = TestAgentWorker;
    let result = worker
        .run(
            AgentRunRequest {
                protocol_version: 1,
                kind: AgentRunKind::EngineOperation,
                objective: "generic agent turn".to_string(),
                prompt: vec![AgentPromptSection {
                    title: "Completion".to_string(),
                    content: "Call submit_work when the test turn is complete.".to_string(),
                }],
                input: json!({ "kind": "test" }),
                tools: vec![
                    AgentToolSpec {
                        name: "read_context".to_string(),
                        description: "Read context.".to_string(),
                        input_schema: json!({}),
                    },
                    AgentToolSpec {
                        name: "submit_work".to_string(),
                        description: "Submit work.".to_string(),
                        input_schema: json!({}),
                    },
                ],
                terminal_tool_set: vec!["submit_work".to_string()],
                tool_choice: AgentToolChoice::Tool {
                    name: "submit_work".to_string(),
                },
            },
            CancellationToken::new(),
        )
        .await;

    assert_eq!(
        result.terminal_call,
        Some(AgentTerminalToolCall {
            name: "submit_work".to_string(),
            arguments: json!({
                "output": "mock output",
                "changed_paths": [],
                "side_effects": [],
            }),
        })
    );
}
