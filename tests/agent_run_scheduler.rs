use serde_json::json;
use siko::*;
use std::process::Command;
use std::sync::{Arc, Mutex};

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
            "next": "mock work",
            "size": "small",
            "reason": "This is closest to Small because the mock agent mirrors one local node and one terminal path."
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
async fn agent_run_scheduler_reports_structured_startup_failure() {
    let mut worker =
        ProcessAgentRunScheduler::new("__siko_missing_agent_host_command__", Vec::<String>::new());

    let result = worker
        .run(request("submit_work"), CancellationToken::new())
        .await;

    assert!(result.terminal_call.is_none());
    assert!(result.report.contains("agent host failure (startup)"));
    assert!(result.events.iter().any(|event| {
        event.get("event").and_then(serde_json::Value::as_str) == Some("agent_run_failure")
            && event.get("class").and_then(serde_json::Value::as_str) == Some("startup")
    }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_run_scheduler_streams_host_events_before_result() {
    if Command::new("bun").arg("--version").output().is_err() {
        eprintln!("skipping agent_run_scheduler_streams_host_events_before_result: bun not found");
        return;
    }

    let events = Arc::new(Mutex::new(Vec::new()));
    let events_for_sink = events.clone();
    let mut worker =
        ProcessAgentRunScheduler::new("bun", ["packages/agent-host/src/runtime-host.ts"]);

    let result = worker
        .run_with_event_sink(
            request("submit_work"),
            CancellationToken::new(),
            Some(Arc::new(move |event| {
                events_for_sink.lock().unwrap().push(event);
            })),
        )
        .await;

    assert!(
        events.lock().unwrap().iter().any(|event| {
            event.get("event").and_then(serde_json::Value::as_str) == Some("tool_call_start")
        }),
        "expected streamed host event; events: {:?}",
        events.lock().unwrap()
    );
    assert_eq!(
        result
            .events
            .iter()
            .filter(|event| {
                event.get("event").and_then(serde_json::Value::as_str) == Some("tool_call_start")
            })
            .count(),
        1
    );
    worker.shutdown().await.unwrap();
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
            arguments: json!({"output": "mock output"}),
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
        tools: vec![AgentToolSpec {
            name: terminal_tool.to_string(),
            description: "Submit result.".to_string(),
            input_schema: empty_schema(),
        }],
        terminal_tool_set: vec![terminal_tool.to_string()],
        runtime_profile: AgentRuntimeProfile::General,
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
