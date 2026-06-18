use std::{
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use siko::*;

mod support;
use support::TestAgentWorker;

#[derive(Debug, Default)]
struct TestAssistantLoop;

#[async_trait::async_trait]
impl AssistantLoop for TestAssistantLoop {
    async fn decide(
        &mut self,
        context: &AssistantContext,
    ) -> Result<AssistantDecision, AssistantDecisionError> {
        let text = context.current_message.trim();
        if text.eq_ignore_ascii_case("list") || text.eq_ignore_ascii_case("tasks") {
            return Ok(AssistantDecision::ListTasks);
        }
        if text.eq_ignore_ascii_case("cancel") {
            return Ok(AssistantDecision::CancelActiveTask);
        }
        if let Some(rest) = text.strip_prefix("status ") {
            return Ok(AssistantDecision::InspectTask {
                task_id: rest.trim().to_string(),
            });
        }
        Ok(AssistantDecision::CreateTask {
            request: text.to_string(),
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_prompt_creates_task_and_runtime_completes_it() {
    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::new(TestAssistantLoop, TestAgentWorker);

    let reply = session
        .handle_message(&mut store, "write a concise design")
        .await;

    let task_id = reply.task_id.expect("task id");
    assert!(reply.text.contains("running") || reply.text.contains("queued"));
    session
        .wait_for_all(&mut store, Duration::from_secs(1))
        .await;
    let task = store.get_task(&task_id).expect("task");
    assert_eq!(task.status, AssistantTaskStatus::Completed);
    assert!(task.root_node.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_runtime_completes_task_through_agent_host() {
    if skip_without_bun("assistant_runtime_completes_task_through_agent_host") {
        return;
    }

    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::with_worker_factory(
        TestAssistantLoop,
        || AgentHostClient::new("bun", ["packages/agent-host/src/runtime-host.ts"]),
        AssistantSessionConfig::default(),
    );

    let reply = session
        .handle_message(&mut store, "host backed assistant task")
        .await;
    let task_id = reply.task_id.expect("task id");
    session
        .wait_for_all(&mut store, Duration::from_secs(3))
        .await;

    let task = store.get_task(&task_id).expect("task");
    assert_eq!(task.status, AssistantTaskStatus::Completed);
    assert!(task.root_node.is_some());
    let report = task.last_report.as_ref().expect("engine report");
    assert_eq!(report.status, NodeStatus::Committed);
    assert!(
        task.events
            .iter()
            .any(|event| event.message == "engine run completed")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_decision_repair_is_agent_driven() {
    let worker = RepairingAssistantWorker::default();
    let requests = worker.requests.clone();
    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::new(AgentAssistantLoop::new(worker), TestAgentWorker);

    let reply = session.handle_message(&mut store, "original request").await;

    let task_id = reply.task_id.expect("task id");
    let task = store.get_task(&task_id).expect("task");
    assert_eq!(task.request, "agent repaired request");
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].prompt.iter().any(|section| {
        section.title == "Decision Repair"
            && section
                .content
                .contains("invalid assistant decision arguments")
    }));
    assert!(requests[1].input.get("assistant_decision_error").is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_accepts_new_prompt_while_another_task_is_running() {
    let state = Arc::new(ConcurrentWorkerState::default());
    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::with_worker_factory(
        TestAssistantLoop,
        {
            let state = state.clone();
            move || SlowAgentWorker {
                state: state.clone(),
            }
        },
        AssistantSessionConfig {
            max_parallel_tasks: 2,
        },
    );

    let first = session.handle_message(&mut store, "first task").await;
    let second = session.handle_message(&mut store, "second task").await;

    assert!(first.task_id.is_some());
    assert!(second.task_id.is_some());
    assert_eq!(store.list_tasks().len(), 2);
    assert!(!second.text.contains("still running"));
    session
        .wait_for_all(&mut store, Duration::from_secs(2))
        .await;
    assert_eq!(state.max_seen.load(Ordering::SeqCst), 2);
    assert!(
        store
            .list_tasks()
            .iter()
            .all(|task| task.status == AssistantTaskStatus::Completed)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_cancel_marks_active_task_cancelled() {
    let state = Arc::new(ConcurrentWorkerState::default());
    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::with_worker_factory(
        TestAssistantLoop,
        {
            let state = state.clone();
            move || SlowAgentWorker {
                state: state.clone(),
            }
        },
        AssistantSessionConfig::default(),
    );

    let started = session.handle_message(&mut store, "existing work").await;
    let task_id = started.task_id.expect("task id");
    wait_until(Duration::from_secs(1), || {
        state.current.load(Ordering::SeqCst) > 0
    })
    .await;
    let reply = session.cancel(&mut store).await;

    assert_eq!(reply.task_id, Some(task_id.clone()));
    assert_eq!(
        store.get_task(&task_id).map(|task| &task.status),
        Some(&AssistantTaskStatus::Cancelled)
    );
    session
        .wait_for_all(&mut store, Duration::from_secs(1))
        .await;
    assert_eq!(state.cancelled_seen.load(Ordering::SeqCst), 1);
    assert_eq!(state.current.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn file_task_store_persists_task_status_and_report() {
    let temp_dir = tempfile::tempdir().unwrap();
    let store_path = temp_dir.path().join("tasks.json");
    let mut store = FileTaskStore::open(&store_path).unwrap();
    let mut session = AssistantSession::new(TestAssistantLoop, TestAgentWorker);

    let reply = session
        .handle_message(&mut store, "persist this assistant task")
        .await;
    let task_id = reply.task_id.expect("task id");
    session
        .wait_for_all(&mut store, Duration::from_secs(1))
        .await;

    let reopened = FileTaskStore::open(&store_path).unwrap();
    let task = reopened.get_task(&task_id).expect("persisted task");
    assert_eq!(task.status, AssistantTaskStatus::Completed);
    assert!(task.root_node.is_some());
    assert!(task.last_report.is_some());
    assert!(
        task.events
            .iter()
            .any(|event| event.message == "engine run completed")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acp_initialize_session_and_prompt_returns_started_task() {
    let store = MemoryTaskStore::new();
    let session = AssistantSession::new(TestAssistantLoop, TestAgentWorker);
    let mut server = AcpServer::new(store, session);

    let init = server
        .handle_request(request(1, "initialize", serde_json::json!({})))
        .await;
    assert!(init.error.is_none());
    assert_eq!(init.result.as_ref().unwrap()["agent"]["name"], "siko");

    let new_session = server
        .handle_request(request(2, "session/new", serde_json::json!({})))
        .await;
    let session_id = new_session.result.as_ref().unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = server
        .handle_request(request(
            3,
            "session/prompt",
            serde_json::json!({
                "sessionId": session_id,
                "prompt": "ship rust assistant"
            }),
        ))
        .await;

    assert!(prompt.error.is_none());
    assert_eq!(prompt.result.as_ref().unwrap()["stopReason"], "end_turn");
    assert!(
        prompt.result.as_ref().unwrap()["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Task")
    );
    assert!(prompt.result.as_ref().unwrap()["metadata"]["taskId"].is_string());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acp_stdio_server_processes_jsonl_requests() {
    let input = [
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}"#,
    ]
    .join("\n");
    let store = MemoryTaskStore::new();
    let session = AssistantSession::new(TestAssistantLoop, TestAgentWorker);
    let server = AcpServer::new(store, session);
    let mut output = Vec::new();

    run_acp_stdio_server(server, std::io::Cursor::new(input), &mut output)
        .await
        .unwrap();

    let text = String::from_utf8(output).unwrap();
    assert!(text.contains(r#""id":1"#));
    assert!(text.contains(r#""id":2"#));
    assert!(text.contains("sessionId"));
}

#[derive(Default)]
struct ConcurrentWorkerState {
    current: AtomicUsize,
    max_seen: AtomicUsize,
    cancelled_seen: AtomicUsize,
}

#[derive(Clone)]
struct SlowAgentWorker {
    state: Arc<ConcurrentWorkerState>,
}

#[async_trait::async_trait]
impl AgentWorker for SlowAgentWorker {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentWorkerResult {
        let current = self.state.current.fetch_add(1, Ordering::SeqCst) + 1;
        self.state.max_seen.fetch_max(current, Ordering::SeqCst);
        let cancelled = tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(30)) => false,
            _ = cancellation.cancelled() => true,
        };
        if cancelled {
            self.state.cancelled_seen.fetch_add(1, Ordering::SeqCst);
        }
        self.state.current.fetch_sub(1, Ordering::SeqCst);
        TestAgentWorker.run(input, cancellation).await
    }
}

#[derive(Default)]
struct RepairingAssistantWorker {
    calls: AtomicUsize,
    requests: Arc<Mutex<Vec<AgentRunRequest>>>,
}

#[async_trait::async_trait]
impl AgentWorker for RepairingAssistantWorker {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        _cancellation: CancellationToken,
    ) -> AgentWorkerResult {
        self.requests.lock().unwrap().push(input);
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            return AgentWorkerResult {
                report: "invalid assistant decision".to_string(),
                terminal_call: Some(AgentTerminalToolCall {
                    name: "submit_assistant_decision".to_string(),
                    arguments: serde_json::json!({}),
                }),
            };
        }

        AgentWorkerResult {
            report: "repaired assistant decision".to_string(),
            terminal_call: Some(AgentTerminalToolCall {
                name: "submit_assistant_decision".to_string(),
                arguments: serde_json::json!({
                    "decision": "create_task",
                    "request": "agent repaired request",
                    "response": "Creating repaired task."
                }),
            }),
        }
    }
}

fn request(id: u64, method: &str, params: serde_json::Value) -> AcpRequest {
    AcpRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(serde_json::json!(id)),
        method: method.to_string(),
        params,
    }
}

fn bun_available() -> bool {
    Command::new("bun").arg("--version").output().is_ok()
}

fn skip_without_bun(test_name: &str) -> bool {
    if bun_available() {
        return false;
    }
    eprintln!("skipping {test_name}: bun not found");
    true
}

async fn wait_until(timeout: Duration, condition: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
