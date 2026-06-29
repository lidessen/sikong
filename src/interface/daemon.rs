use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::Mutex;
use tracing::{error, info};

use crate::{
    AssistantSession, AssistantSessionConfig, CapabilityProfile, DebugConfig, FileTaskStore,
    ProcessAgentRunScheduler, SikoConfig, TaskStore, WorkspaceProvider, WorkspaceRequirement,
    task_board::view::{
        TaskEventCursor, inspect_task_view, resolve_task_ref, sort_tasks_newest_first,
        task_artifact, task_summary,
    },
};

use super::cli::assistant::{self, AssistantPromptWorkspace};
use super::cli::launch;
use super::cli::task;

pub fn daemon_socket_path(debug: &DebugConfig) -> PathBuf {
    debug.data_dir().join("daemon.sock")
}

pub fn send_json_to_daemon(
    debug: &DebugConfig,
    request: serde_json::Value,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let socket_path = daemon_socket_path(debug);
    let mut stream = UnixStream::connect(&socket_path)?;

    use std::io::{Read, Write};
    writeln!(stream, "{}", request)?;
    stream.shutdown(std::net::Shutdown::Write)?;

    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(serde_json::from_str(response.trim())?)
}

/// Send a message to an already-running daemon and return the response.
/// Synchronous (blocking) — uses std::os::unix::net::UnixStream.
pub fn send_via_daemon(
    debug: &DebugConfig,
    message: &str,
    wait_ms: u64,
    workspace: AssistantPromptWorkspace,
    allow_write: bool,
    write_scope: Vec<String>,
) -> Result<String, Box<dyn std::error::Error>> {
    let request = serde_json::json!({
        "kind": "send",
        "id": "cli-send",
        "client": "cli",
        "message": message,
        "wait_ms": wait_ms,
        "workspace": workspace.as_daemon_value(),
        "allow_write": allow_write,
        "write_scope": write_scope,
    });
    send_json_to_daemon(debug, request).map(|response| response.to_string())
}

/// Returns true if a daemon socket exists and is accepting connections.
pub fn daemon_is_running(debug: &DebugConfig) -> bool {
    let socket_path = daemon_socket_path(debug);
    if !socket_path.exists() {
        return false;
    }
    UnixStream::connect(&socket_path).is_ok()
}

pub fn ensure_daemon_running(debug: &DebugConfig) -> Result<bool, Box<dyn std::error::Error>> {
    if daemon_is_running(debug) {
        return Ok(false);
    }

    let executable = std::env::current_exe()?;
    Command::new(executable)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if daemon_is_running(debug) {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    Err(format!(
        "siko daemon did not become ready at {}",
        daemon_socket_path(debug).display()
    )
    .into())
}

pub async fn run_daemon(
    debug: DebugConfig,
    json_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let socket_path = daemon_socket_path(&debug);

    // Remove stale socket file
    let _ = tokio::fs::remove_file(&socket_path).await;

    // Ensure socket parent directory exists
    if let Some(parent) = socket_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let listener = UnixListener::bind(&socket_path)?;
    info!(path = ?socket_path, "daemon listening");

    // Print socket path for CLI to discover
    if json_output {
        println!(
            r#"{{"kind":"daemon_started","socket":"{}"}}"#,
            socket_path.display()
        );
    } else {
        eprintln!("daemon socket: {}", socket_path.display());
    }

    // Build shared session state
    let config = SikoConfig::load().unwrap_or_default();
    let root_workspace = WorkspaceRequirement {
        provider: WorkspaceProvider::FileSystem,
        read_scope: vec!["**/*".to_string()],
        write_scope: Vec::new(),
        git: None,
    };
    let root_capabilities = CapabilityProfile::read_only();

    let worker_launch = launch::resolve_agent_loop_launch(&debug, 0);
    let shared_scheduler = Arc::new(Mutex::new(ProcessAgentRunScheduler::new(
        worker_launch.command.clone(),
        worker_launch.args.clone(),
    )));

    let assistant_loop = crate::AgentAssistantLoop::new(shared_scheduler.clone());
    let store_path = task::assistant_store_path(&debug);
    let mut file_store = FileTaskStore::open(&store_path)?;
    file_store.mark_interrupted_active_tasks();
    let store = Arc::new(Mutex::new(file_store));

    let session = Arc::new(Mutex::new(AssistantSession::with_worker_factory(
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
    )));

    {
        let session = session.clone();
        let store = store.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(100));
            loop {
                interval.tick().await;
                let mut session = session.lock().await;
                let mut store = store.lock().await;
                session.drain(&mut *store).await;
            }
        });
    }

    // Accept connections concurrently — each connection gets its own tokio task.
    // If a client disconnects mid-request, only that task is cancelled; the
    // daemon keeps accepting new connections.
    loop {
        let (stream, _addr) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                error!(error = %e, "accept failed");
                continue;
            }
        };

        let session = session.clone();
        let store = store.clone();
        let debug = debug.clone();

        tokio::spawn(async move {
            let mut reader = BufReader::new(stream).lines();

            while let Ok(Some(line)) = reader.next_line().await {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }

                let request: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = reader
                            .get_mut()
                            .write_all(
                                format!(
                                    "{}\n",
                                    serde_json::json!({"error": format!("invalid request: {}", e)})
                                )
                                .as_bytes(),
                            )
                            .await;
                        continue;
                    }
                };

                let kind = request["kind"].as_str().unwrap_or("").to_string();
                let req_id = request["id"].as_str().unwrap_or("0").to_string();

                match kind.as_str() {
                    "send" => {
                        let message = request["message"].as_str().unwrap_or("").to_string();
                        if message.is_empty() {
                            let _ = writeresp(&mut reader, &req_id, "error", "message is required")
                                .await;
                            continue;
                        }
                        let send_config = match daemon_send_config(&debug, &request)
                            .map_err(|error| error.to_string())
                        {
                            Ok(config) => config,
                            Err(message) => {
                                let _ = writeresp(&mut reader, &req_id, "error", &message).await;
                                continue;
                            }
                        };

                        let (reply, mut snapshot) = {
                            let mut session = session.lock().await;
                            let mut store = store.lock().await;
                            session.set_task_root(send_config.workspace, send_config.capabilities);
                            let client = request
                                .get("client")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("cli");
                            let reply = session
                                .handle_task_message_with_client(&mut *store, message, client)
                                .await;
                            let snapshot = session.drain(&mut *store).await;
                            (reply, snapshot)
                        };

                        if send_config.wait_ms > 0 {
                            let deadline =
                                Instant::now() + Duration::from_millis(send_config.wait_ms);
                            loop {
                                if snapshot.running_tasks == 0 && snapshot.queued_tasks == 0 {
                                    break;
                                }
                                if Instant::now() >= deadline {
                                    let mut session = session.lock().await;
                                    let mut store = store.lock().await;
                                    snapshot = session.drain(&mut *store).await;
                                    break;
                                }
                                tokio::time::sleep(Duration::from_millis(10)).await;
                                let mut session = session.lock().await;
                                let mut store = store.lock().await;
                                snapshot = session.drain(&mut *store).await;
                            }
                        }

                        let (task_info, persist_error) = {
                            let store = store.lock().await;
                            let task_info = reply.task_id.as_deref().and_then(|tid| {
                                store.get_task(tid).map(|t| {
                                    (
                                        tid.to_string(),
                                        t.status.clone(),
                                        t.last_report
                                            .as_ref()
                                            .and_then(|r| r.artifact_text.clone()),
                                    )
                                })
                            });
                            let persist_error = store.last_persist_error().map(ToString::to_string);
                            (task_info, persist_error)
                        };

                        let resp = if let Some((tid, status, artifact)) = task_info {
                            serde_json::json!({
                                "kind": "result",
                                "id": req_id,
                                "text": reply.text,
                                "task_id": tid,
                                "status": status,
                                "artifact": artifact,
                                "running_tasks": snapshot.running_tasks,
                                "queued_tasks": snapshot.queued_tasks,
                                "persist_error": persist_error,
                            })
                            .to_string()
                        } else {
                            serde_json::json!({
                                "kind": "result",
                                "id": req_id,
                                "text": reply.text,
                                "running_tasks": snapshot.running_tasks,
                                "queued_tasks": snapshot.queued_tasks,
                                "persist_error": persist_error,
                            })
                            .to_string()
                        };

                        let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                        let _ = reader.get_mut().write_all(b"\n").await;
                    }

                    "assistant_turn" => {
                        let message = request["message"].as_str().unwrap_or("").to_string();
                        if message.is_empty() {
                            let _ = writeresp(&mut reader, &req_id, "error", "message is required")
                                .await;
                            continue;
                        }
                        let send_config = match daemon_send_config(&debug, &request)
                            .map_err(|error| error.to_string())
                        {
                            Ok(config) => config,
                            Err(message) => {
                                let _ = writeresp(&mut reader, &req_id, "error", &message).await;
                                continue;
                            }
                        };

                        let (reply, mut snapshot) = {
                            let mut session = session.lock().await;
                            let mut store = store.lock().await;
                            session.set_task_root(send_config.workspace, send_config.capabilities);
                            let client = request
                                .get("client")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("cli");
                            let reply = session
                                .handle_message_with_client(&mut *store, message, client)
                                .await;
                            let snapshot = session.drain(&mut *store).await;
                            (reply, snapshot)
                        };

                        if send_config.wait_ms > 0 {
                            let deadline =
                                Instant::now() + Duration::from_millis(send_config.wait_ms);
                            loop {
                                if snapshot.running_tasks == 0 && snapshot.queued_tasks == 0 {
                                    break;
                                }
                                if Instant::now() >= deadline {
                                    let mut session = session.lock().await;
                                    let mut store = store.lock().await;
                                    snapshot = session.drain(&mut *store).await;
                                    break;
                                }
                                tokio::time::sleep(Duration::from_millis(10)).await;
                                let mut session = session.lock().await;
                                let mut store = store.lock().await;
                                snapshot = session.drain(&mut *store).await;
                            }
                        }

                        let (task_info, persist_error) = {
                            let store = store.lock().await;
                            let task_info = reply.task_id.as_deref().and_then(|tid| {
                                store.get_task(tid).map(|t| {
                                    (
                                        tid.to_string(),
                                        t.status.clone(),
                                        t.last_report
                                            .as_ref()
                                            .and_then(|r| r.artifact_text.clone()),
                                    )
                                })
                            });
                            let persist_error = store.last_persist_error().map(ToString::to_string);
                            (task_info, persist_error)
                        };

                        let resp = if let Some((tid, status, artifact)) = task_info {
                            serde_json::json!({
                                "kind": "result",
                                "id": req_id,
                                "text": reply.text,
                                "task_id": tid,
                                "status": status,
                                "artifact": artifact,
                                "running_tasks": snapshot.running_tasks,
                                "queued_tasks": snapshot.queued_tasks,
                                "persist_error": persist_error,
                            })
                            .to_string()
                        } else {
                            serde_json::json!({
                                "kind": "result",
                                "id": req_id,
                                "text": reply.text,
                                "running_tasks": snapshot.running_tasks,
                                "queued_tasks": snapshot.queued_tasks,
                                "persist_error": persist_error,
                            })
                            .to_string()
                        };

                        let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                        let _ = reader.get_mut().write_all(b"\n").await;
                    }

                    "task_list" => {
                        let store_guard = store.lock().await;
                        let tasks = store_guard.list_tasks();
                        let tasks_json = serde_json::to_value(&tasks)
                            .unwrap_or(serde_json::Value::Array(vec![]));
                        let resp = format!(
                            "{}\n",
                            serde_json::json!({"kind": "task_list", "id": req_id, "tasks": tasks_json})
                        );
                        let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                    }

                    "task_list_view" => {
                        let limit = request
                            .get("limit")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(20) as usize;
                        let store_guard = store.lock().await;
                        let mut tasks = store_guard.list_tasks();
                        sort_tasks_newest_first(&mut tasks);
                        tasks.truncate(limit);
                        let summaries = tasks.iter().map(task_summary).collect::<Vec<_>>();
                        let resp = format!(
                            "{}\n",
                            serde_json::json!({"kind": "task_list_view", "id": req_id, "tasks": summaries})
                        );
                        let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                    }

                    "task_inspect" | "task_events" | "task_artifact" => {
                        let Some(task_ref) = request
                            .get("task_id")
                            .or_else(|| request.get("taskId"))
                            .and_then(serde_json::Value::as_str)
                        else {
                            let _ = writeresp(&mut reader, &req_id, "error", "task_id is required")
                                .await;
                            continue;
                        };
                        let cursor = daemon_task_cursor(&request);
                        let store_guard = store.lock().await;
                        let resp = match resolve_task_ref(&*store_guard, task_ref) {
                            Ok(task) if kind == "task_inspect" => serde_json::json!({
                                "kind": "task_inspect",
                                "id": req_id,
                                "view": inspect_task_view(&task, cursor),
                            }),
                            Ok(task) if kind == "task_events" => {
                                let view = inspect_task_view(&task, cursor);
                                serde_json::json!({
                                    "kind": "task_events",
                                    "id": req_id,
                                    "task_id": task.id,
                                    "status": task.status,
                                    "events": view.events,
                                    "timeline": view.timeline,
                                    "cursor": view.cursor,
                                })
                            }
                            Ok(task) => serde_json::json!({
                                "kind": "task_artifact",
                                "id": req_id,
                                "task_id": task.id,
                                "status": task.status,
                                "artifact": task_artifact(&task),
                            }),
                            Err(error) => {
                                serde_json::json!({"kind": "error", "id": req_id, "error": error})
                            }
                        };
                        let _ = reader
                            .get_mut()
                            .write_all(format!("{resp}\n").as_bytes())
                            .await;
                    }

                    "cancel" => {
                        let mut session = session.lock().await;
                        let mut store = store.lock().await;
                        let reply = session.cancel(&mut *store).await;
                        let resp = format!(
                            "{}\n",
                            serde_json::json!({
                                "kind": "cancelled",
                                "id": req_id,
                                "text": reply.text,
                            })
                        );
                        let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                    }

                    "ping" => {
                        let resp =
                            format!("{}\n", serde_json::json!({"kind": "pong", "id": req_id}));
                        let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                    }

                    "shutdown" => {
                        let resp = format!(
                            "{}\n",
                            serde_json::json!({"kind": "shutdown", "id": req_id})
                        );
                        let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                        let _ = reader.get_mut().flush().await;
                        std::process::exit(0);
                    }

                    other => {
                        let resp = format!(
                            "{}\n",
                            serde_json::json!({"kind": "error", "id": req_id, "error": format!("unknown request kind: {}", other)})
                        );
                        let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                    }
                }
            }
            // Client disconnected — the spawned task exits, daemon continues
        });
    }
}

fn daemon_task_cursor(request: &serde_json::Value) -> TaskEventCursor {
    let cursor = request.get("cursor").unwrap_or(request);
    TaskEventCursor {
        task_seq: cursor
            .get("task_seq")
            .or_else(|| cursor.get("taskSeq"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
        agent_event_ordinal: cursor
            .get("agent_event_ordinal")
            .or_else(|| cursor.get("agentEventOrdinal"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default() as usize,
    }
}

struct DaemonSendConfig {
    wait_ms: u64,
    workspace: WorkspaceRequirement,
    capabilities: CapabilityProfile,
}

fn daemon_send_config(
    debug: &DebugConfig,
    request: &serde_json::Value,
) -> Result<DaemonSendConfig, Box<dyn std::error::Error>> {
    let wait_ms = request
        .get("wait_ms")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(30_000);
    let workspace = request
        .get("workspace")
        .and_then(serde_json::Value::as_str)
        .and_then(AssistantPromptWorkspace::from_daemon_value)
        .unwrap_or(AssistantPromptWorkspace::CurrentFileSystem);
    let allow_write = request
        .get("allow_write")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let write_scope = request
        .get("write_scope")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let workspace = assistant::resolve_assistant_prompt_workspace(debug, workspace, &write_scope)?;
    let capabilities = if allow_write {
        CapabilityProfile::writable()
    } else {
        CapabilityProfile::read_only()
    };
    Ok(DaemonSendConfig {
        wait_ms,
        workspace,
        capabilities,
    })
}

async fn writeresp(
    reader: &mut tokio::io::Lines<tokio::io::BufReader<tokio::net::UnixStream>>,
    req_id: &str,
    kind: &str,
    msg: &str,
) {
    let resp = format!(
        "{}\n",
        serde_json::json!({"kind": kind, "id": req_id, "error": msg})
    );
    let _ = reader.get_mut().write_all(resp.as_bytes()).await;
}
