use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    time::Duration,
};

use super::session::{AssistantLoop, AssistantSession};
use crate::{
    TaskStore,
    task_board::view::{
        TaskEventCursor, inspect_task_view, resolve_task_ref, sort_tasks_newest_first,
        task_artifact, task_summary,
    },
};

const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Deserialize)]
pub struct AcpRequest {
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AcpResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpServerConfig {
    pub agent_name: String,
    pub protocol_version: u32,
}

impl Default for AcpServerConfig {
    fn default() -> Self {
        Self {
            agent_name: "siko".to_string(),
            protocol_version: 1,
        }
    }
}

pub struct AcpServer<S: TaskStore, L: AssistantLoop> {
    store: S,
    session: AssistantSession<L>,
    config: AcpServerConfig,
    initialized: bool,
    session_id: Option<String>,
}

impl<S: TaskStore, L: AssistantLoop> AcpServer<S, L> {
    pub fn new(store: S, session: AssistantSession<L>) -> Self {
        Self {
            store,
            session,
            config: AcpServerConfig::default(),
            initialized: false,
            session_id: None,
        }
    }

    pub fn with_config(store: S, session: AssistantSession<L>, config: AcpServerConfig) -> Self {
        Self {
            store,
            session,
            config,
            initialized: false,
            session_id: None,
        }
    }

    pub async fn shutdown(&mut self) {
        self.session
            .wait_for_all(&mut self.store, SHUTDOWN_DRAIN_TIMEOUT)
            .await;
    }

    pub async fn handle_request(&mut self, request: AcpRequest) -> AcpResponse {
        if request.jsonrpc != "2.0" {
            return error(request.id, -32600, "jsonrpc must be 2.0");
        }

        match request.method.as_str() {
            "initialize" => {
                self.initialized = true;
                ok(
                    request.id,
                    json!({
                        "protocolVersion": self.config.protocol_version,
                        "agent": { "name": self.config.agent_name },
                        "capabilities": {
                            "sessions": true,
                            "prompt": true,
                            "cancel": true,
                            "tasks": true,
                        },
                    }),
                )
            }
            "session/new" => {
                if !self.initialized {
                    return error(request.id, -32002, "server is not initialized");
                }
                let session_id = "session_1".to_string();
                self.session_id = Some(session_id.clone());
                ok(request.id, json!({ "sessionId": session_id }))
            }
            "session/prompt" => {
                if let Err(message) = self.require_session(&request.params) {
                    return error(request.id, -32001, message);
                }
                let Some(prompt) = prompt_text(&request.params) else {
                    return error(request.id, -32602, "prompt text is required");
                };
                let reply = self
                    .session
                    .handle_task_message(&mut self.store, prompt)
                    .await;
                ok(
                    request.id,
                    json!({
                        "stopReason": "end_turn",
                        "content": [
                            { "type": "text", "text": reply.text }
                        ],
                        "metadata": {
                            "taskId": reply.task_id,
                        },
                    }),
                )
            }
            "session/cancel" => {
                if let Err(message) = self.require_session(&request.params) {
                    return error(request.id, -32001, message);
                }
                let reply = self.session.cancel(&mut self.store).await;
                ok(
                    request.id,
                    json!({
                        "cancelled": true,
                        "content": [
                            { "type": "text", "text": reply.text }
                        ],
                    }),
                )
            }
            "task/list" => {
                if let Err(message) = self.require_initialized() {
                    return error(request.id, -32002, message);
                }
                let limit = request
                    .params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(20) as usize;
                let mut tasks = self.store.list_tasks();
                sort_tasks_newest_first(&mut tasks);
                tasks.truncate(limit);
                let summaries = tasks.iter().map(task_summary).collect::<Vec<_>>();
                ok(request.id, json!({ "tasks": summaries }))
            }
            "task/inspect" => {
                if let Err(message) = self.require_initialized() {
                    return error(request.id, -32002, message);
                }
                let Some(task_ref) = task_ref_param(&request.params) else {
                    return error(request.id, -32602, "taskId is required");
                };
                let cursor = task_event_cursor(&request.params);
                match resolve_task_ref(&self.store, &task_ref) {
                    Ok(task) => ok(request.id, json!(inspect_task_view(&task, cursor))),
                    Err(message) => error(request.id, -32004, message),
                }
            }
            "task/events" => {
                if let Err(message) = self.require_initialized() {
                    return error(request.id, -32002, message);
                }
                let Some(task_ref) = task_ref_param(&request.params) else {
                    return error(request.id, -32602, "taskId is required");
                };
                let cursor = task_event_cursor(&request.params);
                match resolve_task_ref(&self.store, &task_ref) {
                    Ok(task) => {
                        let view = inspect_task_view(&task, cursor);
                        ok(
                            request.id,
                            json!({
                                "taskId": task.id,
                                "status": task.status,
                                "events": view.events,
                                "cursor": view.cursor,
                            }),
                        )
                    }
                    Err(message) => error(request.id, -32004, message),
                }
            }
            "task/artifact" => {
                if let Err(message) = self.require_initialized() {
                    return error(request.id, -32002, message);
                }
                let Some(task_ref) = task_ref_param(&request.params) else {
                    return error(request.id, -32602, "taskId is required");
                };
                match resolve_task_ref(&self.store, &task_ref) {
                    Ok(task) => ok(
                        request.id,
                        json!({
                            "taskId": task.id,
                            "status": task.status,
                            "artifact": task_artifact(&task),
                        }),
                    ),
                    Err(message) => error(request.id, -32004, message),
                }
            }
            _ => error(request.id, -32601, "method not found"),
        }
    }

    fn require_initialized(&self) -> Result<(), String> {
        if !self.initialized {
            return Err("server is not initialized".to_string());
        }
        Ok(())
    }

    fn require_session(&self, params: &Value) -> Result<(), String> {
        self.require_initialized()?;
        let Some(expected) = &self.session_id else {
            return Err("session has not been created".to_string());
        };
        let actual = params
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| "sessionId is required".to_string())?;
        if actual != expected {
            return Err("unknown sessionId".to_string());
        }
        Ok(())
    }
}

fn task_ref_param(params: &Value) -> Option<String> {
    params
        .get("taskId")
        .or_else(|| params.get("task_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn task_event_cursor(params: &Value) -> TaskEventCursor {
    let cursor = params.get("cursor").unwrap_or(params);
    TaskEventCursor {
        task_seq: cursor
            .get("taskSeq")
            .or_else(|| cursor.get("task_seq"))
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        agent_event_ordinal: cursor
            .get("agentEventOrdinal")
            .or_else(|| cursor.get("agent_event_ordinal"))
            .and_then(Value::as_u64)
            .unwrap_or_default() as usize,
    }
}

pub async fn run_acp_stdio_server<S, L>(
    mut server: AcpServer<S, L>,
    input: impl BufRead,
    mut output: impl Write,
) -> std::io::Result<()>
where
    S: TaskStore,
    L: AssistantLoop,
{
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<AcpRequest>(&line) {
            Ok(request) => server.handle_request(request).await,
            Err(err) => error(None, -32700, format!("parse error: {err}")),
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    server.shutdown().await;
    Ok(())
}

fn prompt_text(params: &Value) -> Option<String> {
    if let Some(text) = params.get("prompt").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    params
        .get("content")
        .and_then(Value::as_array)
        .and_then(|content| {
            content.iter().find_map(|part| {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    part.get("text")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                } else {
                    None
                }
            })
        })
}

fn ok(id: Option<Value>, result: Value) -> AcpResponse {
    AcpResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: Some(result),
        error: None,
    }
}

fn error(id: Option<Value>, code: i64, message: impl Into<String>) -> AcpResponse {
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
