use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::Mutex;
use tracing::{error, info};

use crate::{
    AssistantSession, AssistantSessionConfig, CapabilityProfile, DebugConfig, FileTaskStore,
    ProcessAgentRunScheduler, SikoConfig, TaskStore, WorkspaceProvider, WorkspaceRequirement,
};

use super::cli::launch;
use super::cli::task;

pub fn daemon_socket_path(debug: &DebugConfig) -> PathBuf {
    debug.data_dir().join("daemon.sock")
}

/// Send a message to an already-running daemon and return the response.
/// Synchronous (blocking) — uses std::os::unix::net::UnixStream.
pub fn send_via_daemon(debug: &DebugConfig, message: &str) -> Result<String, Box<dyn std::error::Error>> {
    let socket_path = daemon_socket_path(debug);
    let mut stream = UnixStream::connect(&socket_path)?;

    let request = serde_json::json!({
        "kind": "send",
        "id": "cli-send",
        "message": message,
    });

    use std::io::{Read, Write};
    writeln!(stream, "{}", request)?;
    // Signal EOF so the daemon's read loop ends and sends the response back
    stream.shutdown(std::net::Shutdown::Write)?;

    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

/// Returns true if a daemon socket exists and is accepting connections.
pub fn daemon_is_running(debug: &DebugConfig) -> bool {
    let socket_path = daemon_socket_path(debug);
    if !socket_path.exists() {
        return false;
    }
    UnixStream::connect(&socket_path).is_ok()
}

pub async fn run_daemon(debug: DebugConfig, json_output: bool) -> Result<(), Box<dyn std::error::Error>> {
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
    let store = Arc::new(Mutex::new(FileTaskStore::open(&store_path)?));

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
                                format!("{}\n", serde_json::json!({"error": format!("invalid request: {}", e)})).as_bytes(),
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
                            let _ = writeresp(&mut reader, &req_id, "error", "message is required").await;
                            continue;
                        }

                        let mut session = session.lock().await;
                        let mut store = store.lock().await;

                        let reply = session.handle_message(&mut *store, message).await;
                        session.drain(&mut *store).await;

                        // Wait for all tasks to complete
                        loop {
                            let snapshot = session
                                .wait_for_all(&mut *store, Duration::from_millis(1000))
                                .await;
                            if snapshot.running_tasks == 0 && snapshot.queued_tasks == 0 {
                                break;
                            }
                        }

                        let task_info = reply.task_id.as_deref().and_then(|tid| {
                            store.get_task(tid).map(|t| {
                                (
                                    tid.to_string(),
                                    t.status.clone(),
                                    t.last_report.as_ref().and_then(|r| r.artifact_text.clone()),
                                )
                            })
                        });
                        drop(store);
                        drop(session);

                        let resp = if let Some((tid, status, artifact)) = task_info {
                            serde_json::json!({
                                "kind": "result",
                                "id": req_id,
                                "text": reply.text,
                                "task_id": tid,
                                "status": status,
                                "artifact": artifact,
                            }).to_string()
                        } else {
                            serde_json::json!({
                                "kind": "result",
                                "id": req_id,
                                "text": reply.text,
                            }).to_string()
                        };

                        let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                        let _ = reader.get_mut().write_all(b"\n").await;
                    }

                    "task_list" => {
                        let store_guard = store.lock().await;
                        let tasks = store_guard.list_tasks();
                        let tasks_json = serde_json::to_value(&tasks).unwrap_or(serde_json::Value::Array(vec![]));
                        let resp = format!(
                            "{}\n",
                            serde_json::json!({"kind": "task_list", "id": req_id, "tasks": tasks_json})
                        );
                        let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                    }

                    "ping" => {
                        let resp = format!(
                            "{}\n",
                            serde_json::json!({"kind": "pong", "id": req_id})
                        );
                        let _ = reader.get_mut().write_all(resp.as_bytes()).await;
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
