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
use support::TestAgentRunScheduler;

#[derive(Debug, Default)]
struct TestAssistantLoop;

#[async_trait::async_trait]
impl AssistantLoop for TestAssistantLoop {
    async fn run_turn(
        &mut self,
        context: &AssistantContext,
    ) -> Result<AssistantTurn, AssistantTurnError> {
        let text = context.current_message.trim();
        if text.eq_ignore_ascii_case("list") || text.eq_ignore_ascii_case("tasks") {
            return Ok(assistant_turn(
                vec![tool_call("list_tasks", serde_json::json!({}))],
                "Listing tasks.",
                vec![],
            ));
        }
        if text.eq_ignore_ascii_case("cancel") {
            return Ok(assistant_turn(
                vec![tool_call("cancel_task", serde_json::json!({}))],
                "Cancelling active task.",
                vec![],
            ));
        }
        if let Some(rest) = text.strip_prefix("status ") {
            let task_id = rest.trim().to_string();
            return Ok(assistant_turn(
                vec![tool_call(
                    "inspect_task",
                    serde_json::json!({ "task_id": task_id }),
                )],
                "Inspecting task.",
                vec![rest.trim().to_string()],
            ));
        }
        Ok(assistant_turn(
            vec![tool_call(
                "create_task",
                serde_json::json!({ "request": text }),
            )],
            "Creating task.",
            vec![],
        ))
    }
}

#[derive(Debug, Default)]
struct DirectReplyAssistantLoop;

#[async_trait::async_trait]
impl AssistantLoop for DirectReplyAssistantLoop {
    async fn run_turn(
        &mut self,
        _context: &AssistantContext,
    ) -> Result<AssistantTurn, AssistantTurnError> {
        Ok(assistant_turn(
            Vec::new(),
            "Direct assistant reply.",
            Vec::new(),
        ))
    }
}

#[derive(Debug, Default)]
struct RecordingConversationAssistantLoop {
    contexts: Arc<Mutex<Vec<AssistantContext>>>,
}

#[async_trait::async_trait]
impl AssistantLoop for RecordingConversationAssistantLoop {
    async fn run_turn(
        &mut self,
        context: &AssistantContext,
    ) -> Result<AssistantTurn, AssistantTurnError> {
        self.contexts.lock().unwrap().push(context.clone());
        Ok(assistant_turn(
            Vec::new(),
            &format!("ack {}", context.current_message.trim()),
            Vec::new(),
        ))
    }
}

#[derive(Debug, Default)]
struct SteeringConversationAssistantLoop;

#[async_trait::async_trait]
impl AssistantLoop for SteeringConversationAssistantLoop {
    async fn run_turn(
        &mut self,
        context: &AssistantContext,
    ) -> Result<AssistantTurn, AssistantTurnError> {
        if let Some(previous_task_id) = context
            .conversation
            .iter()
            .rev()
            .find_map(|entry| entry.task_id.clone())
        {
            return Ok(assistant_turn(
                vec![tool_call(
                    "create_task",
                    serde_json::json!({
                        "request": format!(
                            "Follow up on {previous_task_id}: {}",
                            context.current_message.trim()
                        ),
                    }),
                )],
                "Creating follow-up task.",
                Vec::new(),
            ));
        }

        Ok(assistant_turn(
            vec![tool_call(
                "create_task",
                serde_json::json!({ "request": context.current_message.trim() }),
            )],
            "Creating task.",
            Vec::new(),
        ))
    }
}

fn assistant_turn(
    mut calls: Vec<AgentToolCall>,
    response: &str,
    task_ids: Vec<String>,
) -> AssistantTurn {
    calls.push(tool_call(
        "finish_turn",
        serde_json::json!({
            "response": response,
            "task_ids": task_ids,
        }),
    ));
    AssistantTurn {
        tool_calls: calls,
        response: response.to_string(),
        task_ids,
    }
}

fn tool_call(name: &str, arguments: serde_json::Value) -> AgentToolCall {
    AgentToolCall {
        name: name.to_string(),
        arguments,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_session_injects_latest_message_and_recent_conversation() {
    let contexts = Arc::new(Mutex::new(Vec::new()));
    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::with_worker_factory(
        RecordingConversationAssistantLoop {
            contexts: contexts.clone(),
        },
        || TestAgentRunScheduler,
        AssistantSessionConfig {
            max_parallel_tasks: 2,
            task_board_enabled: false,
            conversation_message_limit: 12,
        },
    );

    session.handle_message(&mut store, "first message").await;
    session.handle_message(&mut store, "second message").await;

    let contexts = contexts.lock().unwrap();
    assert_eq!(contexts.len(), 2);
    assert_eq!(contexts[0].current_message, "first message");
    assert!(contexts[0].conversation.is_empty());
    assert_eq!(contexts[1].current_message, "second message");
    assert_eq!(contexts[1].conversation.len(), 2);
    assert_eq!(
        contexts[1].conversation[0].role,
        AssistantConversationRole::User
    );
    assert_eq!(contexts[1].conversation[0].content, "first message");
    assert_eq!(
        contexts[1].conversation[1].role,
        AssistantConversationRole::Assistant
    );
    assert_eq!(contexts[1].conversation[1].content, "ack first message");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_session_bounds_long_conversation_context() {
    let contexts = Arc::new(Mutex::new(Vec::new()));
    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::with_worker_factory(
        RecordingConversationAssistantLoop {
            contexts: contexts.clone(),
        },
        || TestAgentRunScheduler,
        AssistantSessionConfig {
            max_parallel_tasks: 2,
            task_board_enabled: false,
            conversation_message_limit: 3,
        },
    );

    for index in 0..6 {
        session
            .handle_message(&mut store, format!("turn {index}"))
            .await;
    }

    let contexts = contexts.lock().unwrap();
    let last = contexts.last().expect("last context");
    assert_eq!(last.current_message, "turn 5");
    assert_eq!(last.conversation.len(), 3);
    assert_eq!(last.conversation.last().unwrap().content, "ack turn 4");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_session_can_steer_from_previous_task_context() {
    let mut store = MemoryTaskStore::new();
    let mut session =
        AssistantSession::new(SteeringConversationAssistantLoop, TestAgentRunScheduler);

    let first = session.handle_message(&mut store, "draft a design").await;
    let first_task_id = first.task_id.expect("first task id");
    let second = session
        .handle_message(&mut store, "make that more concrete")
        .await;

    let second_task_id = second.task_id.expect("second task id");
    assert_ne!(first_task_id, second_task_id);
    let second_task = store.get_task(&second_task_id).expect("second task");
    assert!(second_task.request.contains(&first_task_id));
    assert!(second_task.request.contains("make that more concrete"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_prompt_creates_task_and_runtime_completes_it() {
    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::new(TestAssistantLoop, TestAgentRunScheduler);

    let reply = session
        .handle_message(&mut store, "write a concise design")
        .await;

    let task_id = reply.task_id.expect("task id");
    assert!(reply.text.contains("Creating task."));
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
        || ProcessAgentRunScheduler::new("bun", ["packages/agent-host/src/runtime-host.ts"]),
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
    assert!(task.events.iter().any(|event| event.kind == "agent.run"));
    assert!(task.events.iter().all(|event| event.seq > 0));
    assert!(task.events.iter().all(|event| event.timestamp_ms > 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_agent_host_loop_handles_create_status_list_and_reply() {
    if skip_without_bun("assistant_agent_host_loop_handles_create_status_list_and_reply") {
        return;
    }

    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::with_worker_factory(
        AgentAssistantLoop::new(ProcessAgentRunScheduler::new(
            "bun",
            ["packages/agent-host/src/runtime-host.ts"],
        )),
        || ProcessAgentRunScheduler::new("bun", ["packages/agent-host/src/runtime-host.ts"]),
        AssistantSessionConfig::default(),
    );

    let created = session.handle_message(&mut store, "host loop task").await;
    let task_id = created.task_id.expect("created task id");
    session
        .wait_for_all(&mut store, Duration::from_secs(3))
        .await;

    let inspected = session
        .handle_message(&mut store, format!("status {task_id}"))
        .await;
    assert_eq!(inspected.task_id.as_deref(), Some(task_id.as_str()));
    assert!(inspected.text.contains("Completed"));

    let listed = session.handle_message(&mut store, "list").await;
    assert!(listed.text.contains(&task_id));
    assert!(listed.text.contains("Completed"));

    let reply = session.handle_message(&mut store, "   ").await;
    assert!(reply.text.contains("Please provide a task request."));
    assert!(reply.task_id.is_none());
    assert_eq!(store.list_tasks().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_session_can_run_without_task_board() {
    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::with_worker_factory(
        DirectReplyAssistantLoop,
        || TestAgentRunScheduler,
        AssistantSessionConfig {
            max_parallel_tasks: 2,
            task_board_enabled: false,
            conversation_message_limit: 12,
        },
    );

    let reply = session
        .handle_message(&mut store, "summarize your role")
        .await;

    assert_eq!(reply.text, "Direct assistant reply.");
    assert!(reply.task_id.is_none());
    assert_eq!(store.list_tasks().len(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_real_kimi_loop_replies_without_task_board_when_enabled() {
    if std::env::var("SIKONG_RUN_LIVE_AGENT_TESTS").ok().as_deref() != Some("1")
        || std::env::var("KIMI_CODE_API_KEY").is_err()
    {
        eprintln!(
            "skipping assistant_real_kimi_loop_replies_without_task_board_when_enabled: set SIKONG_RUN_LIVE_AGENT_TESTS=1 and KIMI_CODE_API_KEY"
        );
        return;
    }
    if skip_without_bun("assistant_real_kimi_loop_replies_without_task_board_when_enabled") {
        return;
    }

    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::with_worker_factory(
        AgentAssistantLoop::new(ProcessAgentRunScheduler::new(
            "bun",
            [
                "packages/agent-host/src/runtime-host.ts",
                "--worker",
                "agent-loop",
                "--provider",
                "kimi",
                "--runtime",
                "claude-code",
                "--max-steps",
                "6",
            ],
        )),
        || TestAgentRunScheduler,
        AssistantSessionConfig {
            max_parallel_tasks: 2,
            task_board_enabled: false,
            conversation_message_limit: 12,
        },
    );

    let reply = session
        .handle_message(
            &mut store,
            "Reply exactly with assistant-live-ok. Do not create a task.",
        )
        .await;

    assert!(
        reply.text.to_lowercase().contains("assistant-live-ok"),
        "unexpected live assistant reply: {}",
        reply.text
    );
    assert!(reply.task_id.is_none());
    assert_eq!(store.list_tasks().len(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_tool_sequence_repair_is_agent_driven() {
    let worker = RepairingAssistantWorker::default();
    let requests = worker.requests.clone();
    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::new(AgentAssistantLoop::new(worker), TestAgentRunScheduler);

    let reply = session.handle_message(&mut store, "original request").await;

    let task_id = reply.task_id.expect("task id");
    let task = store.get_task(&task_id).expect("task");
    assert_eq!(task.request, "agent repaired request");
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].prompt.iter().any(|section| {
        section.title == "Tool Repair" && section.content.contains("invalid finish_turn arguments")
    }));
    assert!(requests[1].input.get("assistant_tool_error").is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assistant_accepts_new_prompt_while_another_task_is_running() {
    let state = Arc::new(ConcurrentWorkerState::default());
    let mut store = MemoryTaskStore::new();
    let mut session = AssistantSession::with_worker_factory(
        TestAssistantLoop,
        {
            let state = state.clone();
            move || SlowAgentRunScheduler {
                state: state.clone(),
            }
        },
        AssistantSessionConfig {
            max_parallel_tasks: 2,
            task_board_enabled: true,
            conversation_message_limit: 12,
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
async fn task_board_uses_injected_engine_runner() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let factory = TaskEngineRunnerFactory::new({
        let calls = calls.clone();
        move || {
            Box::new(RecordingTaskEngineRunner {
                calls: calls.clone(),
            })
        }
    });
    let mut task_board = TaskBoard::with_engine_runner(1, factory);
    let mut store = MemoryTaskStore::new();
    let task_id = store.create_task("injected runtime task".to_string());

    task_board
        .enqueue(
            &mut store,
            task_id.clone(),
            "injected runtime task".to_string(),
        )
        .await;
    task_board
        .wait_for_all(&mut store, Duration::from_secs(1))
        .await;

    let task = store.get_task(&task_id).expect("task");
    assert_eq!(task.status, AssistantTaskStatus::Completed);
    assert_eq!(task.root_node, Some(42));
    assert_eq!(
        calls.lock().unwrap().as_slice(),
        &[(task_id, "injected runtime task".to_string())]
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
            move || SlowAgentRunScheduler {
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
    let mut session = AssistantSession::new(TestAssistantLoop, TestAgentRunScheduler);

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
    assert!(
        task.events
            .iter()
            .any(|event| event.kind == "engine.operation")
    );
    assert!(task.events.iter().any(|event| event.kind == "agent.run"));
    assert!(
        task.events
            .iter()
            .any(|event| event.node_id.is_some() && event.operation.is_some())
    );
}

#[test]
fn file_task_store_records_persist_errors_without_panicking() {
    let temp_dir = tempfile::tempdir().unwrap();
    let blocker = temp_dir.path().join("not-a-directory");
    std::fs::write(&blocker, "blocks parent directory creation").unwrap();
    let store_path = blocker.join("tasks.json");
    let mut store = FileTaskStore::open(&store_path).unwrap();

    let task_id = store.create_task("persist failure should not panic".to_string());

    assert!(store.get_task(&task_id).is_some());
    assert!(store.last_persist_error().is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acp_initialize_session_and_prompt_returns_started_task() {
    let store = MemoryTaskStore::new();
    let session = AssistantSession::new(TestAssistantLoop, TestAgentRunScheduler);
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
            .contains("Creating task.")
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
    let session = AssistantSession::new(TestAssistantLoop, TestAgentRunScheduler);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acp_stdio_shutdown_flushes_completed_task_results() {
    let input = [
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"session_1","prompt":"继续推进 Sikong 自我迭代。请创建一个 bounded dogfood roadmap task。"}}"#,
    ]
    .join("\n");
    let temp_dir = tempfile::tempdir().unwrap();
    let store_path = temp_dir.path().join("tasks.json");
    let store = FileTaskStore::open(&store_path).unwrap();
    let session = AssistantSession::new(TestAssistantLoop, TestAgentRunScheduler);
    let server = AcpServer::new(store, session);
    let mut output = Vec::new();

    run_acp_stdio_server(server, std::io::Cursor::new(input), &mut output)
        .await
        .unwrap();

    let reopened = FileTaskStore::open(&store_path).unwrap();
    let tasks = reopened.list_tasks();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].status, AssistantTaskStatus::Completed);
    assert!(tasks[0].root_node.is_some());
    assert!(
        tasks[0]
            .events
            .iter()
            .any(|event| event.kind == "engine.completed")
    );
}

#[derive(Default)]
struct ConcurrentWorkerState {
    current: AtomicUsize,
    max_seen: AtomicUsize,
    cancelled_seen: AtomicUsize,
}

struct RecordingTaskEngineRunner {
    calls: Arc<Mutex<Vec<(String, String)>>>,
}

#[async_trait::async_trait]
impl TaskEngineRunner for RecordingTaskEngineRunner {
    async fn run_task(
        &mut self,
        task_id: &str,
        request: &str,
        _cancellation: CancellationToken,
    ) -> Result<(NodeId, EngineReport), EngineError> {
        self.calls
            .lock()
            .unwrap()
            .push((task_id.to_string(), request.to_string()));
        Ok((
            42,
            EngineReport {
                root: 42,
                status: NodeStatus::Committed,
                artifact: None,
                events: Vec::new(),
                agent_runs: Vec::new(),
            },
        ))
    }
}

#[derive(Clone)]
struct SlowAgentRunScheduler {
    state: Arc<ConcurrentWorkerState>,
}

#[async_trait::async_trait]
impl AgentRunScheduler for SlowAgentRunScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse {
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
        TestAgentRunScheduler.run(input, cancellation).await
    }
}

#[derive(Default)]
struct RepairingAssistantWorker {
    calls: AtomicUsize,
    requests: Arc<Mutex<Vec<AgentRunRequest>>>,
}

#[async_trait::async_trait]
impl AgentRunScheduler for RepairingAssistantWorker {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        _cancellation: CancellationToken,
    ) -> AgentRunResponse {
        self.requests.lock().unwrap().push(input);
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            return AgentRunResponse {
                report: "invalid assistant tool sequence".to_string(),
                tool_calls: vec![AgentToolCall {
                    name: "finish_turn".to_string(),
                    arguments: serde_json::json!({}),
                }],
                terminal_call: Some(AgentToolCall {
                    name: "finish_turn".to_string(),
                    arguments: serde_json::json!({}),
                }),
                usage: None,
                events: Vec::new(),
            };
        }

        let create = AgentToolCall {
            name: "create_task".to_string(),
            arguments: serde_json::json!({
                "request": "agent repaired request",
            }),
        };
        let finish = AgentToolCall {
            name: "finish_turn".to_string(),
            arguments: serde_json::json!({
                "response": "Creating repaired task.",
                "task_ids": [],
            }),
        };
        AgentRunResponse {
            report: "repaired assistant tool sequence".to_string(),
            tool_calls: vec![create, finish.clone()],
            terminal_call: Some(finish),
            usage: None,
            events: Vec::new(),
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
