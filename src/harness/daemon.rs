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

fn daemon_socket_path(debug: &DebugConfig) -> PathBuf {
    debug.data_dir().join("daemon.sock")
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
    let store = Arc::new(Mutex::new(FileTaskStore::open(&store_path)?));

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

    // Accept connections
    loop {
        let (stream, _addr) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                error!(error = %e, "accept failed");
                continue;
            }
        };

        let mut reader = BufReader::new(stream).lines();
        let store = store.clone();

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
                            format!(r#"{{"error":"invalid request: {}"}}{}"#, e, "\n").as_bytes(),
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
                        let _ =
                            writeresp(&mut reader, &req_id, "error", "message is required").await;
                        continue;
                    }

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

                    // Read task info while store lock is held
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

                    let resp = if let Some((tid, status, artifact)) = task_info {
                        format!(
                            r#"{{"kind":"result","id":"{}","text":"{}","task_id":"{}","status":"{:?}","artifact":{}}}"#,
                            req_id,
                            serde_json::to_string(&reply.text).unwrap_or_default(),
                            tid,
                            status,
                            serde_json::to_string(&artifact).unwrap_or("null".to_string()),
                        )
                    } else {
                        format!(
                            r#"{{"kind":"result","id":"{}","text":{}}}"#,
                            req_id,
                            serde_json::to_string(&reply.text).unwrap_or_default(),
                        )
                    };

                    let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                    let _ = reader.get_mut().write_all(b"\n").await;
                }

                "task_list" => {
                    let store_guard = store.lock().await;
                    let tasks = store_guard.list_tasks();
                    let json = serde_json::to_string(&tasks).unwrap_or_else(|_| "[]".to_string());
                    let resp = format!(
                        r#"{{"kind":"task_list","id":"{}","tasks":{}}}"#,
                        req_id, json
                    );
                    let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                    let _ = reader.get_mut().write_all(b"\n").await;
                }

                "ping" => {
                    let resp = format!(r#"{{"kind":"pong","id":"{}"}}"#, req_id);
                    let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                    let _ = reader.get_mut().write_all(b"\n").await;
                }

                other => {
                    let resp = format!(
                        r#"{{"kind":"error","id":"{}","error":"unknown request kind: {}"}}"#,
                        req_id, other
                    );
                    let _ = reader.get_mut().write_all(resp.as_bytes()).await;
                    let _ = reader.get_mut().write_all(b"\n").await;
                }
            }
        }
    }
}

async fn writeresp(
    reader: &mut tokio::io::Lines<tokio::io::BufReader<tokio::net::UnixStream>>,
    req_id: &str,
    kind: &str,
    msg: &str,
) {
    let resp = format!(
        r#"{{"kind":"{}","id":"{}","error":"{}"}}"#,
        kind, req_id, msg
    );
    let _ = reader.get_mut().write_all(resp.as_bytes()).await;
    let _ = reader.get_mut().write_all(b"\n").await;
}
