use serde_json::json;
use siko::*;
use std::process::Command;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_run_scheduler_reuses_one_host_for_multiple_runs() {
    if Command::new("bun").arg("--version").output().is_err() {
        eprintln!("skipping agent_run_scheduler_reuses_one_host_for_multiple_runs: bun not found");
        return;
    }

    let mut worker =
        ProcessAgentRunScheduler::new("bun", ["packages/agent-host/src/runtime-host.ts"]);

    let first = worker
        .run(request("submit_specification"), CancellationToken::new())
        .await;
    let second = worker
        .run(request("submit_work"), CancellationToken::new())
        .await;

    assert_eq!(
        first.terminal_call.as_ref().map(|call| call.name.as_str()),
        Some("submit_specification")
    );
    assert_eq!(
        first.terminal_call.as_ref().map(|call| &call.arguments),
        Some(&json!({
            "size": "small",
            "shape": "atomic",
            "reference_match": "This is closest to Small because the mock agent mirrors one local node and one terminal path.",
            "scope_signals": ["one local problem", "one verification path"],
            "missing_info": null
        }))
    );
    assert_eq!(
        second.terminal_call.as_ref().map(|call| call.name.as_str()),
        Some("submit_work")
    );
    assert_eq!(
        second
            .terminal_call
            .as_ref()
            .and_then(|call| call.arguments.get("output"))
            .and_then(serde_json::Value::as_str),
        Some("mock output")
    );
    worker.shutdown().await.unwrap();
    worker.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_run_scheduler_cancels_running_host() {
    if Command::new("bun").arg("--version").output().is_err() {
        eprintln!("skipping agent_run_scheduler_cancels_running_host: bun not found");
        return;
    }

    let mut worker =
        ProcessAgentRunScheduler::new("bun", ["packages/agent-host/src/runtime-host.ts"]);
    let cancellation = CancellationToken::new();
    let cancel_from_task = cancellation.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        cancel_from_task.cancel();
    });

    let result = worker
        .run(delayed_request("submit_work", 500), cancellation)
        .await;

    assert!(result.report.contains("cancelled"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compiled_agent_host_binary_speaks_socket_protocol_when_configured() {
    let Ok(command) = std::env::var("SIKONG_AGENT_HOST_COMMAND") else {
        eprintln!(
            "skipping compiled_agent_host_binary_speaks_socket_protocol_when_configured: SIKONG_AGENT_HOST_COMMAND not set"
        );
        return;
    };

    let mut worker = ProcessAgentRunScheduler::new(command, Vec::<String>::new());
    let result = worker
        .run(request("submit_work"), CancellationToken::new())
        .await;

    assert_eq!(
        result.terminal_call,
        Some(AgentToolCall {
            name: "submit_work".to_string(),
            arguments: json!({}),
        })
    );
}

fn request(terminal_tool: &str) -> AgentRunRequest {
    AgentRunRequest {
        protocol_version: 1,
        objective: format!("run with {terminal_tool}"),
        prompt: vec![AgentPromptSection {
            title: "Completion".to_string(),
            content: format!("Call {terminal_tool} when the mock run is complete."),
        }],
        input: json!({
            "kind": "test",
            "intent": "test",
        }),
        tools: vec![
            AgentToolSpec {
                name: "read_operation_context".to_string(),
                description: "Read context.".to_string(),
                input_schema: empty_schema(),
            },
            AgentToolSpec {
                name: terminal_tool.to_string(),
                description: "Submit result.".to_string(),
                input_schema: empty_schema(),
            },
        ],
        terminal_tool_set: vec![terminal_tool.to_string()],
        effort: None,
    }
}

fn delayed_request(terminal_tool: &str, delay_ms: u64) -> AgentRunRequest {
    let mut request = request(terminal_tool);
    request.input["mockDelayMs"] = json!(delay_ms);
    request
}

fn empty_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false,
    })
}
