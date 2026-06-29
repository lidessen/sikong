use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::{
    AcpRequest, AcpResponse, AgentAssistantLoop, AssistantSession, AssistantSessionConfig,
    AssistantTaskStatus, CapabilityProfile, DebugConfig, FileTaskStore, JsonRpcError,
    ProcessAgentRunScheduler, SikoConfig, TaskStore, WorkspaceRequirement,
};
use clap::{Subcommand, ValueEnum};
use serde::Serialize;

use super::launch;
use super::task;
use crate::interface::assistant::{acp_initialize_result, acp_prompt_text};
use crate::interface::daemon;

/// Assistant command subcommands.
#[derive(Debug, Subcommand)]
pub enum AssistantCommand {
    /// Send one assistant message, run queued work in this process, and print the result.
    Prompt {
        /// Milliseconds to keep this process alive while queued tasks run. Set 0 to only enqueue.
        #[arg(long, default_value_t = 300_000)]
        wait_ms: u64,

        /// Root workspace used by tasks created from this prompt.
        #[arg(long, value_enum, default_value_t = AssistantPromptWorkspace::Memory)]
        workspace: AssistantPromptWorkspace,

        /// Allow created tasks to write within --write-scope.
        #[arg(long)]
        allow_write: bool,

        /// Coarse writable glob for --workspace current-git. Repeatable.
        #[arg(long = "write-scope")]
        write_scope: Vec<String>,

        /// Print structured JSON output.
        #[arg(long)]
        json: bool,

        /// Message to send to the assistant.
        #[arg(required = true, trailing_var_arg = true)]
        message: Vec<String>,
    },
    /// Print persisted task logs in chronological order.
    Logs {
        /// Task id to inspect.
        task_id: String,

        /// Print the raw structured log JSON.
        #[arg(long)]
        json: bool,

        /// Print the full persisted task record, including engine report and agent-loop events.
        #[arg(long)]
        full: bool,
    },
    /// Query persisted agent-run events for a task.
    Events {
        /// Task id to inspect.
        task_id: String,

        /// Filter by task-run operation, such as Specify, Execute, Verify, or Combine.
        #[arg(long)]
        operation: Option<String>,

        /// Filter by event kind, such as tool_call_start, usage, error, or step.
        #[arg(long)]
        event: Option<String>,

        /// Filter by tool/event name, such as Read, Grep, WebFetch, or submit_work.
        #[arg(long)]
        tool: Option<String>,

        /// Filter by event source, such as agent-loop.
        #[arg(long)]
        source: Option<String>,

        /// Case-insensitive substring search over the event JSON.
        #[arg(long)]
        query: Option<String>,

        /// Print matching events as structured JSON.
        #[arg(long)]
        json: bool,
    },
    /// List all persisted tasks, showing ID (first 12 chars), status, and first line.
    List {
        /// Print structured JSON output.
        #[arg(long)]
        json: bool,
    },
}

/// Workspace selection for assistant prompts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum AssistantPromptWorkspace {
    /// In-memory workspace (no file access).
    Memory,
    /// Current file system (read files directly, no git worktree).
    CurrentFileSystem,
    /// Git worktree workspace (isolated, writable).
    CurrentGit,
}

impl AssistantPromptWorkspace {
    pub fn as_daemon_value(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::CurrentFileSystem => "current-file-system",
            Self::CurrentGit => "current-git",
        }
    }

    pub fn from_daemon_value(value: &str) -> Option<Self> {
        match value {
            "memory" => Some(Self::Memory),
            "current-file-system" => Some(Self::CurrentFileSystem),
            "current-git" => Some(Self::CurrentGit),
            _ => None,
        }
    }
}

/// Output from a completed assistant prompt.
#[derive(Debug, Serialize)]
pub struct AssistantPromptOutput {
    pub response: String,
    pub task_id: Option<String>,
    pub status: Option<AssistantTaskStatus>,
    pub final_artifact: Option<String>,
    pub running_tasks: usize,
    pub queued_tasks: usize,
    pub persist_error: Option<String>,
}

/// Run the assistant as an ACP server over stdio.
pub fn run_assistant_acp() -> Result<(), Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    daemon::ensure_daemon_running(&debug)?;
    run_daemon_acp_proxy(&debug, BufReader::new(io::stdin()), io::stdout())?;
    Ok(())
}

pub fn run_daemon_acp_proxy(
    debug: &DebugConfig,
    input: impl BufRead,
    mut output: impl Write,
) -> std::io::Result<()> {
    let mut initialized = false;
    let mut session_id: Option<String> = None;

    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let messages = match serde_json::from_str::<AcpRequest>(&line) {
            Ok(request) => {
                handle_daemon_acp_request(debug, request, &mut initialized, &mut session_id)
            }
            Err(err) => acp_messages(acp_error(None, -32700, format!("parse error: {err}"))),
        };
        for message in messages {
            serde_json::to_writer(&mut output, &message)?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
    }
    Ok(())
}

fn handle_daemon_acp_request(
    debug: &DebugConfig,
    request: AcpRequest,
    initialized: &mut bool,
    session_id: &mut Option<String>,
) -> Vec<serde_json::Value> {
    if request.jsonrpc != "2.0" {
        return acp_messages(acp_error(request.id, -32600, "jsonrpc must be 2.0"));
    }

    match request.method.as_str() {
        "initialize" => {
            *initialized = true;
            acp_messages(acp_ok(request.id, acp_initialize_result("siko", 1)))
        }
        "session/new" => {
            if !*initialized {
                return acp_messages(acp_error(request.id, -32002, "server is not initialized"));
            }
            let id = "session_1".to_string();
            *session_id = Some(id.clone());
            acp_messages(acp_ok(request.id, serde_json::json!({ "sessionId": id })))
        }
        "session/prompt" => {
            if let Err(message) = require_acp_session(*initialized, session_id, &request.params) {
                return acp_messages(acp_error(request.id, -32001, message));
            }
            let active_session_id = session_id.as_deref().unwrap_or("session_1");
            let Some(prompt) = acp_prompt_text(&request.params) else {
                return acp_messages(acp_error(request.id, -32602, "prompt text is required"));
            };
            let turn_request = daemon_assistant_turn_request_from_acp(&request.params, prompt);
            match daemon::send_json_to_daemon(debug, turn_request) {
                Ok(value) => {
                    let mut messages = vec![acp_session_update_text(
                        active_session_id,
                        acp_session_prompt_response_text(&value),
                        value.get("task_id").and_then(serde_json::Value::as_str),
                    )];
                    messages.extend(acp_messages(acp_ok(
                        request.id,
                        serde_json::json!({
                            "stopReason": "end_turn",
                            "_meta": {
                                "siko": {
                                    "taskId": value.get("task_id").cloned().unwrap_or(serde_json::Value::Null),
                                    "status": value.get("status").cloned().unwrap_or(serde_json::Value::Null),
                                    "runningTasks": value.get("running_tasks").cloned().unwrap_or(serde_json::json!(0)),
                                    "queuedTasks": value.get("queued_tasks").cloned().unwrap_or(serde_json::json!(0)),
                                }
                            },
                        }),
                    )));
                    messages
                }
                Err(error) => {
                    let message = error.to_string();
                    let mut messages = vec![acp_session_update_text(
                        active_session_id,
                        &format!("Sikong failed to submit this prompt: {message}"),
                        None,
                    )];
                    messages.extend(acp_messages(acp_error(request.id, -32003, message)));
                    messages
                }
            }
        }
        "session/cancel" => {
            if let Err(message) = require_acp_session(*initialized, session_id, &request.params) {
                return acp_messages(acp_error(request.id, -32001, message));
            }
            match daemon::send_json_to_daemon(
                debug,
                serde_json::json!({"kind": "cancel", "id": "acp-cancel"}),
            ) {
                Ok(value) => acp_messages(acp_ok(
                    request.id,
                    serde_json::json!({
                        "cancelled": true,
                        "content": [
                            { "type": "text", "text": value.get("text").and_then(serde_json::Value::as_str).unwrap_or_default() }
                        ],
                    }),
                )),
                Err(error) => acp_messages(acp_error(request.id, -32003, error.to_string())),
            }
        }
        "task/list" => {
            if !*initialized {
                return acp_messages(acp_error(request.id, -32002, "server is not initialized"));
            }
            match daemon::send_json_to_daemon(
                debug,
                serde_json::json!({
                    "kind": "task_list_view",
                    "id": "acp-task-list",
                    "limit": request.params.get("limit").and_then(serde_json::Value::as_u64).unwrap_or(20),
                }),
            ) {
                Ok(value) => acp_messages(acp_ok(
                    request.id,
                    serde_json::json!({ "tasks": value.get("tasks").cloned().unwrap_or_else(|| serde_json::json!([])) }),
                )),
                Err(error) => acp_messages(acp_error(request.id, -32003, error.to_string())),
            }
        }
        "task/inspect" | "task/events" | "task/artifact" => {
            if !*initialized {
                return acp_messages(acp_error(request.id, -32002, "server is not initialized"));
            }
            let Some(task_id) = acp_task_ref(&request.params) else {
                return acp_messages(acp_error(request.id, -32602, "taskId is required"));
            };
            let kind = match request.method.as_str() {
                "task/inspect" => "task_inspect",
                "task/events" => "task_events",
                _ => "task_artifact",
            };
            let daemon_request = serde_json::json!({
                "kind": kind,
                "id": "acp-task",
                "task_id": task_id,
                "cursor": request.params.get("cursor").cloned().unwrap_or(serde_json::Value::Null),
            });
            match daemon::send_json_to_daemon(debug, daemon_request) {
                Ok(value)
                    if value.get("kind").and_then(serde_json::Value::as_str) == Some("error") =>
                {
                    acp_messages(acp_error(
                        request.id,
                        -32004,
                        value
                            .get("error")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("task request failed"),
                    ))
                }
                Ok(value) if request.method == "task/inspect" => acp_messages(acp_ok(
                    request.id,
                    value
                        .get("view")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                )),
                Ok(value) if request.method == "task/events" => acp_messages(acp_ok(
                    request.id,
                    serde_json::json!({
                        "taskId": value.get("task_id").cloned().unwrap_or(serde_json::Value::Null),
                        "status": value.get("status").cloned().unwrap_or(serde_json::Value::Null),
                        "events": value.get("events").cloned().unwrap_or_else(|| serde_json::json!([])),
                        "cursor": value.get("cursor").cloned().unwrap_or(serde_json::Value::Null),
                    }),
                )),
                Ok(value) => acp_messages(acp_ok(
                    request.id,
                    serde_json::json!({
                        "taskId": value.get("task_id").cloned().unwrap_or(serde_json::Value::Null),
                        "status": value.get("status").cloned().unwrap_or(serde_json::Value::Null),
                        "artifact": value.get("artifact").cloned().unwrap_or(serde_json::Value::Null),
                    }),
                )),
                Err(error) => acp_messages(acp_error(request.id, -32003, error.to_string())),
            }
        }
        _ => acp_messages(acp_error(request.id, -32601, "method not found")),
    }
}

/// Run one assistant prompt (blocking).
pub fn run_assistant_prompt(
    message: Vec<String>,
    wait_ms: u64,
    workspace: AssistantPromptWorkspace,
    allow_write: bool,
    write_scope: Vec<String>,
    json_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let message = message.join(" ").trim().to_string();
    if message.is_empty() {
        return Err("assistant prompt message must not be empty".into());
    }

    let debug = DebugConfig::from_env();

    match daemon::ensure_daemon_running(&debug) {
        Ok(started) => {
            if !json_output {
                let action = if started {
                    "started daemon"
                } else {
                    "using daemon"
                };
                eprintln!(
                    "→ {action} at {}",
                    daemon::daemon_socket_path(&debug).display()
                );
            }
        }
        Err(error)
            if std::env::var("SIKONG_DEV").as_deref() == Ok("1")
                && std::env::var("SIKONG_INLINE").as_deref() == Ok("1") =>
        {
            if !json_output {
                eprintln!("daemon unavailable ({error}), running inline because SIKONG_INLINE=1");
            }
            return fallback_run_inline(
                message,
                wait_ms,
                workspace,
                allow_write,
                write_scope,
                json_output,
            );
        }
        Err(error) => return Err(error),
    }

    let response = daemon::send_via_daemon(
        &debug,
        &message,
        wait_ms,
        workspace,
        allow_write,
        write_scope,
    )?;
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&response) {
        let output = daemon_value_to_prompt_output(&val);
        if json_output {
            serde_json::to_writer_pretty(std::io::stdout(), &output)?;
            println!();
        } else {
            let artifact = output.final_artifact.as_deref().unwrap_or("");
            if !artifact.is_empty() {
                println!("{}", artifact);
            }
            println!("── Result ─────────────────────────────────────────");
            if let Some(task_id) = output.task_id.as_deref() {
                println!("  task:   {}", task_id);
            }
            if let Some(status) = output.status.as_ref() {
                println!("  status: {:?}", status);
            }
            if output.running_tasks > 0 || output.queued_tasks > 0 {
                println!(
                    "  task board: {} running, {} queued",
                    output.running_tasks, output.queued_tasks
                );
            }
        }
    } else {
        println!("{}", response);
    }
    Ok(())
}

fn daemon_value_to_prompt_output(value: &serde_json::Value) -> AssistantPromptOutput {
    AssistantPromptOutput {
        response: value
            .get("text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        task_id: value
            .get("task_id")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string),
        status: value
            .get("status")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
        final_artifact: value
            .get("artifact")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string),
        running_tasks: value
            .get("running_tasks")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default() as usize,
        queued_tasks: value
            .get("queued_tasks")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default() as usize,
        persist_error: value
            .get("persist_error")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string),
    }
}

fn require_acp_session(
    initialized: bool,
    expected: &Option<String>,
    params: &serde_json::Value,
) -> Result<(), String> {
    if !initialized {
        return Err("server is not initialized".to_string());
    }
    let Some(expected) = expected else {
        return Err("session has not been created".to_string());
    };
    let actual = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "sessionId is required".to_string())?;
    if actual != expected {
        return Err("unknown sessionId".to_string());
    }
    Ok(())
}

fn acp_task_ref(params: &serde_json::Value) -> Option<String> {
    params
        .get("taskId")
        .or_else(|| params.get("task_id"))
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
}

fn daemon_assistant_turn_request_from_acp(
    params: &serde_json::Value,
    prompt: String,
) -> serde_json::Value {
    let wait_ms = params
        .get("waitMs")
        .or_else(|| params.get("wait_ms"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let workspace = params
        .get("workspace")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("current-file-system");
    let allow_write = params
        .get("allowWrite")
        .or_else(|| params.get("allow_write"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let mut write_scope = params
        .get("writeScope")
        .or_else(|| params.get("write_scope"))
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if allow_write && write_scope.is_empty() {
        write_scope.push("**/*".to_string());
    }
    serde_json::json!({
        "kind": "assistant_turn",
        "id": "acp-assistant-turn",
        "client": "acp",
        "message": prompt,
        "wait_ms": wait_ms,
        "workspace": workspace,
        "allow_write": allow_write,
        "write_scope": write_scope,
    })
}

fn acp_session_prompt_response_text(value: &serde_json::Value) -> &str {
    value
        .get("artifact")
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            value
                .get("final_artifact")
                .and_then(serde_json::Value::as_str)
                .filter(|text| !text.is_empty())
        })
        .or_else(|| value.get("text").and_then(serde_json::Value::as_str))
        .unwrap_or_default()
}

fn acp_messages(response: AcpResponse) -> Vec<serde_json::Value> {
    if response.id.is_none() {
        return Vec::new();
    }
    vec![serde_json::to_value(response).unwrap_or_else(|_| serde_json::json!({}))]
}

fn acp_session_update_text(
    session_id: &str,
    text: &str,
    task_id: Option<&str>,
) -> serde_json::Value {
    let message_id = task_id
        .map(|task_id| format!("siko_{task_id}"))
        .unwrap_or_else(|| "siko_message".to_string());
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "messageId": message_id,
                "content": {
                    "type": "text",
                    "text": text,
                },
            },
        },
    })
}

fn acp_ok(id: Option<serde_json::Value>, result: serde_json::Value) -> AcpResponse {
    AcpResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: Some(result),
        error: None,
    }
}

fn acp_error(id: Option<serde_json::Value>, code: i64, message: impl Into<String>) -> AcpResponse {
    AcpResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: None,
        error: Some(JsonRpcError {
            code,
            message: message.into(),
        }),
    }
}

fn fallback_run_inline(
    message: String,
    wait_ms: u64,
    workspace: AssistantPromptWorkspace,
    allow_write: bool,
    write_scope: Vec<String>,
    json_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .thread_name("siko-assistant-prompt")
        .enable_all()
        .build()?;
    runtime.block_on(run_assistant_prompt_async(
        message,
        wait_ms,
        workspace,
        allow_write,
        write_scope,
        json_output,
    ))
}

async fn run_assistant_prompt_async(
    message: String,
    wait_ms: u64,
    workspace: AssistantPromptWorkspace,
    allow_write: bool,
    write_scope: Vec<String>,
    json_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let config = SikoConfig::load()?;
    let debug = DebugConfig::from_env();
    let root_workspace = resolve_assistant_prompt_workspace(&debug, workspace, &write_scope)?;
    let root_capabilities = if allow_write {
        CapabilityProfile::writable()
    } else {
        CapabilityProfile::read_only()
    };
    let mut store = FileTaskStore::open(task::assistant_store_path(&debug))?;
    store.mark_interrupted_active_tasks();
    let worker_launch = launch::resolve_agent_loop_launch(&debug, 0);
    let shared_scheduler = Arc::new(Mutex::new(ProcessAgentRunScheduler::new(
        worker_launch.command.clone(),
        worker_launch.args.clone(),
    )));
    let assistant_loop = AgentAssistantLoop::new(shared_scheduler.clone());
    let mut session = AssistantSession::with_worker_factory(
        assistant_loop,
        {
            let sched = shared_scheduler.clone();
            move || Box::new(sched.clone())
        },
        AssistantSessionConfig {
            max_parallel_tasks: config.assistant.max_parallel_tasks,
            task_board_enabled: true,
            conversation_message_limit: 200,
            root_workspace,
            root_capabilities,
        },
    );

    let started_at = Instant::now();

    let assistant_progress = if json_output {
        None
    } else {
        Some(send_spinner("creating task"))
    };
    let reply = session.handle_task_message(&mut store, message).await;
    if let Some(ref pb) = assistant_progress {
        pb.finish_with_message("task created");
    }

    let snapshot = if reply.task_id.is_some() {
        let task_progress = if json_output {
            None
        } else {
            Some(send_spinner("task running"))
        };
        let snapshot = if wait_ms == 0 {
            session.drain(&mut store).await
        } else {
            session
                .wait_for_all(&mut store, Duration::from_millis(wait_ms))
                .await
        };
        if wait_ms == 0 && (snapshot.running_tasks > 0 || snapshot.queued_tasks > 0) {
            return Err(
                "wait-ms 0 requires a running siko daemon for background task execution; start `siko daemon` or use a positive --wait-ms"
                    .into(),
            );
        }
        // Keep the tokio runtime alive while background engine tasks are still
        // running. Without this, the runtime drops when the CLI returns and
        // spawned tasks are cancelled silently.
        let snapshot = if snapshot.running_tasks > 0 || snapshot.queued_tasks > 0 {
            // Poll with short timeout until the task board is idle.
            // Use 1s intervals so the CLI stays responsive to cancellation.
            let poll_interval = Duration::from_millis(1000);
            loop {
                let s = session.wait_for_all(&mut store, poll_interval).await;
                if s.running_tasks == 0 && s.queued_tasks == 0 {
                    break s;
                }
                if let Some(ref pb) = task_progress {
                    pb.set_message(format!(
                        "task board: {} running, {} queued",
                        s.running_tasks, s.queued_tasks
                    ));
                }
            }
        } else {
            snapshot
        };
        if let Some(ref pb) = task_progress {
            if snapshot.running_tasks == 0 && snapshot.queued_tasks == 0 {
                pb.finish_with_message("task board idle");
            } else {
                pb.finish_with_message(format!(
                    "task board: {} running, {} queued",
                    snapshot.running_tasks, snapshot.queued_tasks
                ));
            }
        }
        snapshot
    } else {
        session.drain(&mut store).await
    };

    let task_status = reply
        .task_id
        .as_deref()
        .and_then(|task_id| store.get_task(task_id))
        .map(|task| task.status.clone());
    let final_artifact = reply
        .task_id
        .as_deref()
        .and_then(|task_id| store.get_task(task_id))
        .and_then(|task| task.last_report.as_ref())
        .and_then(|report| report.artifact_text.clone());
    let output = AssistantPromptOutput {
        response: reply.text,
        task_id: reply.task_id,
        status: task_status,
        final_artifact,
        running_tasks: snapshot.running_tasks,
        queued_tasks: snapshot.queued_tasks,
        persist_error: store.last_persist_error().map(ToString::to_string),
    };

    if json_output {
        serde_json::to_writer_pretty(std::io::stdout(), &output)?;
        println!();
        return Ok(());
    }

    let elapsed = started_at.elapsed();

    // ── Response ──
    println!(
        "{}",
        console::style("── Response ──────────────────────────────────────").dim()
    );
    let skin = termimad::MadSkin::default();
    skin.print_text(&output.response);

    // ── Result ──
    println!(
        "{}",
        console::style("── Result ─────────────────────────────────────────").dim()
    );
    if let Some(task_id) = &output.task_id {
        println!("  task:   {task_id}");
    }
    if let Some(status) = &output.status {
        let status_label = match status {
            AssistantTaskStatus::Completed => {
                console::style("✓ Completed").green().bold().to_string()
            }
            AssistantTaskStatus::Failed => console::style("✗ Failed").red().bold().to_string(),
            AssistantTaskStatus::Cancelled => {
                console::style("− Cancelled").yellow().bold().to_string()
            }
            AssistantTaskStatus::WaitingForInput => console::style("? Waiting for input")
                .blue()
                .bold()
                .to_string(),
            AssistantTaskStatus::Running => console::style("◌ Running").cyan().bold().to_string(),
            other => console::style(format!("{other:?}")).dim().to_string(),
        };
        println!("  status: {status_label}");
    }
    println!(
        "  {} {}",
        console::style("⚡").dim(),
        console::style(format_duration(elapsed)).dim()
    );
    if let Some(artifact) = &output.final_artifact {
        println!();
        println!("{artifact}");
    }
    if output.running_tasks > 0 || output.queued_tasks > 0 {
        println!(
            "  task board: {} running, {} queued",
            output.running_tasks, output.queued_tasks
        );
    }
    if let Some(task_id) = &output.task_id {
        println!(
            "{}",
            console::style("── Inspect ────────────────────────────────────────").dim()
        );
        println!("  live:   siko task inspect {task_id}");
        println!("  logs:   siko task logs {task_id}");
        println!("  result: siko task show {task_id}");
        println!("  events: siko task events {task_id}");
    }
    if let Some(error) = &output.persist_error {
        eprintln!(
            "{} failed to persist assistant task store: {error}",
            console::style("[WARN]").yellow().bold()
        );
    }
    Ok(())
}

/// Print assistant task logs.
pub fn print_assistant_logs(
    task_id: &str,
    json_output: bool,
    full_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(task::assistant_store_path(&debug))?;
    let task = task::resolve_task_ref(&store, task_id)?;

    if full_output {
        serde_json::to_writer_pretty(std::io::stdout(), &task)?;
        println!();
        return Ok(());
    }

    if json_output {
        serde_json::to_writer_pretty(std::io::stdout(), &task.events)?;
        println!();
        return Ok(());
    }

    println!("task {} {} {:?}", task.id, task.title, task.status);
    for event in &task.events {
        println!("{}", task::format_task_log(event));
    }
    Ok(())
}

/// Print a list of assistant tasks.
pub fn print_assistant_list(json_output: bool) -> Result<(), Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(task::assistant_store_path(&debug))?;
    let mut tasks = store.list_tasks();
    task::sort_tasks_newest_first(&mut tasks);

    if json_output {
        serde_json::to_writer_pretty(std::io::stdout(), &tasks)?;
        println!();
        return Ok(());
    }

    for task in &tasks {
        let id_prefix = task::task_list_id(&task.id);
        let first_line = task.request.lines().next().unwrap_or("").to_string();
        println!("{}  {:?}  {}", id_prefix, task.status, first_line);
    }
    Ok(())
}

fn send_spinner(message: &'static str) -> indicatif::ProgressBar {
    let pb = indicatif::ProgressBar::new_spinner();
    pb.set_style(
        indicatif::ProgressStyle::with_template("{spinner} {msg} ({elapsed})")
            .unwrap()
            .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"),
    );
    pb.set_message(message);
    pb.enable_steady_tick(Duration::from_millis(120));
    pb
}

fn format_duration(d: Duration) -> String {
    let secs = d.as_secs_f64();
    if secs > 60.0 {
        format!("{:.0}m {:2.0}s", secs / 60.0, secs % 60.0)
    } else {
        format!("{:6.1}s", secs)
    }
}

pub fn resolve_assistant_prompt_workspace(
    debug: &DebugConfig,
    workspace: AssistantPromptWorkspace,
    write_scope: &[String],
) -> Result<WorkspaceRequirement, Box<dyn std::error::Error>> {
    match workspace {
        AssistantPromptWorkspace::Memory => {
            if !write_scope.is_empty() {
                return Err(
                    "--write-scope requires --workspace current-git or current-file-system".into(),
                );
            }
            Ok(WorkspaceRequirement::memory())
        }
        AssistantPromptWorkspace::CurrentFileSystem => Ok(WorkspaceRequirement {
            provider: crate::WorkspaceProvider::FileSystem,
            read_scope: vec!["**/*".to_string()],
            write_scope: write_scope.to_vec(),
            git: None,
        }),
        AssistantPromptWorkspace::CurrentGit => {
            let repo_root = current_git_root()?;
            let worktree_root = debug.data_dir().join("worktrees").join("assistant");
            Ok(WorkspaceRequirement::git_repo(
                repo_root,
                worktree_root,
                "HEAD",
                write_scope.iter().cloned(),
            ))
        }
    }
}

fn current_git_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "current directory is not inside a git repository: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let root = String::from_utf8(output.stdout)?.trim().to_string();
    if root.is_empty() {
        return Err("git did not report a repository root".into());
    }
    Ok(PathBuf::from(root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn acp_assistant_turn_request_returns_immediately_by_default() {
        let request = daemon_assistant_turn_request_from_acp(&json!({}), "hi".to_string());

        assert_eq!(request["kind"], "assistant_turn");
        assert_eq!(request["wait_ms"], 0);
    }

    #[test]
    fn acp_assistant_turn_request_allows_explicit_wait_mode() {
        let request =
            daemon_assistant_turn_request_from_acp(&json!({"waitMs": 300_000}), "hi".to_string());

        assert_eq!(request["wait_ms"], 300_000);
    }

    #[test]
    fn acp_prompt_response_prefers_completed_artifact_over_start_text() {
        let response = json!({
            "text": "Task abc Running. 1 running, 0 queued.",
            "artifact": "Hello from the completed task.",
        });

        assert_eq!(
            acp_session_prompt_response_text(&response),
            "Hello from the completed task."
        );
    }
}
