use serde_json::json;
use siko::*;
use tokio::time::{Duration, timeout};

mod support;
use support::TestAgentRunScheduler;

#[tokio::test]
async fn test_agent_selects_terminal_tool_from_run_config() {
    let mut worker = TestAgentRunScheduler;
    let result = worker
        .run(
            AgentRunRequest {
                protocol_version: 1,
                objective: "generic agent turn".to_string(),
                prompt: vec![AgentPromptSection {
                    title: "Completion".to_string(),
                    content: "Call submit_work when the test turn is complete.".to_string(),
                }],
                input: json!({ "kind": "test" }),
                tools: vec![
                    AgentToolSpec {
                        name: "inspect_fixture".to_string(),
                        description: "Inspect fixture.".to_string(),
                        input_schema: json!({}),
                    },
                    AgentToolSpec {
                        name: "submit_work".to_string(),
                        description: "Submit work.".to_string(),
                        input_schema: json!({}),
                    },
                ],
                terminal_tool_set: vec!["submit_work".to_string()],
                runtime_profile: AgentRuntimeProfile::General,
                effort: None,
            },
            CancellationToken::new(),
        )
        .await;

    assert_eq!(
        result.terminal_call,
        Some(AgentToolCall {
            name: "submit_work".to_string(),
            arguments: json!({
                "output": "mock output",
            }),
        })
    );
}

#[tokio::test]
async fn cancellation_token_notifies_waiters_without_polling_delay() {
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
        .expect("cancel waiter should be notified")
        .expect("cancel waiter task should complete");
}
