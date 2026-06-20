use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::{
    AgentPromptSection, AgentRunRequest, AgentRunScheduler, AgentToolCall, AssistantHarness,
    AssistantTaskStatus, CancellationToken, TaskBoard, TaskBoardSnapshot, TaskId, TaskStore,
    TaskWorkerFactory,
};

use super::context::AssistantContext;
use super::tools::{CancelTaskArgs, CreateTaskArgs, FinishAssistantTurnArgs, InspectTaskArgs};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionState {
    pub focus_task: Option<TaskId>,
    pub running_tasks: usize,
    pub queued_tasks: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantTurn {
    pub tool_calls: Vec<AgentToolCall>,
    pub response: String,
    pub task_ids: Vec<TaskId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantTurnError {
    pub message: String,
}

#[async_trait]
pub trait AssistantLoop: Send {
    async fn run_turn(
        &mut self,
        context: &AssistantContext,
    ) -> Result<AssistantTurn, AssistantTurnError>;
}

pub struct AgentAssistantLoop<W: AgentRunScheduler> {
    worker: W,
}

impl<W: AgentRunScheduler> AgentAssistantLoop<W> {
    pub fn new(worker: W) -> Self {
        Self { worker }
    }
}

#[async_trait]
impl<W> AssistantLoop for AgentAssistantLoop<W>
where
    W: AgentRunScheduler + Send,
{
    async fn run_turn(
        &mut self,
        context: &AssistantContext,
    ) -> Result<AssistantTurn, AssistantTurnError> {
        let mut request = AssistantHarness::new(context.clone()).build_agent_run();
        let mut last_error: Option<String> = None;

        for attempt in 0..2 {
            if let Some(error) = &last_error {
                request = retry_request(&request, error);
            }

            let result = self
                .worker
                .run(request.clone(), CancellationToken::new())
                .await;
            match decode_assistant_turn(result.tool_calls, result.terminal_call) {
                Ok(turn) => return Ok(turn),
                Err(error) => {
                    last_error = Some(format!(
                        "attempt {} failed: {}; report: {}",
                        attempt + 1,
                        error.message,
                        result.report
                    ));
                }
            }
        }

        Err(AssistantTurnError {
            message: last_error.unwrap_or_else(|| "assistant agent did not finish".to_string()),
        })
    }
}

fn decode_assistant_turn(
    mut tool_calls: Vec<AgentToolCall>,
    terminal_call: Option<AgentToolCall>,
) -> Result<AssistantTurn, AssistantTurnError> {
    if tool_calls.is_empty()
        && let Some(call) = terminal_call.clone()
    {
        tool_calls.push(call);
    }

    let terminal_call = terminal_call
        .or_else(|| tool_calls.last().cloned())
        .ok_or_else(|| AssistantTurnError {
            message: "assistant turn did not call a terminal tool".to_string(),
        })?;

    if terminal_call.name != "finish_assistant_turn" {
        return Err(AssistantTurnError {
            message: format!(
                "expected finish_assistant_turn terminal tool, got {}",
                terminal_call.name
            ),
        });
    }

    let finish = serde_json::from_value::<FinishAssistantTurnArgs>(terminal_call.arguments.clone())
        .map_err(|error| AssistantTurnError {
            message: format!("invalid finish_assistant_turn arguments: {error}"),
        })?;
    if finish.response.trim().is_empty() {
        return Err(AssistantTurnError {
            message: "finish_assistant_turn response must not be empty".to_string(),
        });
    }

    Ok(AssistantTurn {
        tool_calls,
        response: finish.response,
        task_ids: finish.task_ids,
    })
}

fn retry_request(request: &AgentRunRequest, error: &str) -> AgentRunRequest {
    let mut retry = request.clone();
    retry.prompt.push(AgentPromptSection {
        title: "Tool Repair".to_string(),
        content: format!(
            "Your previous assistant tool sequence was rejected by the protocol validator: {error}. Use the provided assistant tools with valid arguments, then finish with finish_assistant_turn. Do not guess outside the provided context."
        ),
    });
    retry.input = with_tool_error(&retry.input, error);
    retry
}

fn with_tool_error(input: &Value, error: &str) -> Value {
    match input {
        Value::Object(object) => {
            let mut object = object.clone();
            object.insert(
                "assistant_tool_error".to_string(),
                Value::String(error.to_string()),
            );
            Value::Object(object)
        }
        _ => json!({
            "assistant_tool_error": error,
            "previous_input": input,
        }),
    }
}

fn decode_tool_args<T: serde::de::DeserializeOwned>(
    call: &AgentToolCall,
) -> Result<T, AssistantTurnError> {
    serde_json::from_value::<T>(call.arguments.clone()).map_err(|error| AssistantTurnError {
        message: format!("invalid {} arguments: {error}", call.name),
    })
}

fn required_non_empty(value: String, field: &'static str) -> Result<String, AssistantTurnError> {
    if value.trim().is_empty() {
        return Err(AssistantTurnError {
            message: format!("assistant tool missing required field {field}"),
        });
    }
    Ok(value)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionReply {
    pub text: String,
    pub task_id: Option<TaskId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantSessionConfig {
    pub max_parallel_tasks: usize,
}

impl Default for AssistantSessionConfig {
    fn default() -> Self {
        Self {
            max_parallel_tasks: 2,
        }
    }
}

pub struct AssistantSession<L: AssistantLoop> {
    focus_task: Option<TaskId>,
    loop_agent: L,
    task_board: TaskBoard,
}

impl<L: AssistantLoop> AssistantSession<L> {
    pub fn new<W>(loop_agent: L, engine_worker: W) -> Self
    where
        W: AgentRunScheduler + Clone + Send + Sync + 'static,
    {
        Self::with_config(loop_agent, engine_worker, AssistantSessionConfig::default())
    }

    pub fn with_config<W>(loop_agent: L, engine_worker: W, config: AssistantSessionConfig) -> Self
    where
        W: AgentRunScheduler + Clone + Send + Sync + 'static,
    {
        let engine_worker = Arc::new(engine_worker);
        Self::with_worker_factory(
            loop_agent,
            {
                let engine_worker = engine_worker.clone();
                move || Box::new((*engine_worker).clone())
            },
            config,
        )
    }

    pub fn with_worker_factory<W>(
        loop_agent: L,
        make_worker: impl Fn() -> W + Send + Sync + 'static,
        config: AssistantSessionConfig,
    ) -> Self
    where
        W: AgentRunScheduler + Send + 'static,
    {
        let worker_factory = TaskWorkerFactory::new(move || Box::new(make_worker()));
        let task_board = TaskBoard::new(config.max_parallel_tasks, worker_factory);
        Self {
            focus_task: None,
            loop_agent,
            task_board,
        }
    }

    pub fn state(&self) -> SessionState {
        let snapshot = self.task_board.snapshot();
        SessionState {
            focus_task: self.focus_task.clone(),
            running_tasks: snapshot.running_tasks,
            queued_tasks: snapshot.queued_tasks,
        }
    }

    pub async fn drain(&mut self, store: &mut impl TaskStore) -> TaskBoardSnapshot {
        self.task_board.drain(store).await
    }

    pub async fn wait_for_all(
        &mut self,
        store: &mut impl TaskStore,
        timeout: Duration,
    ) -> TaskBoardSnapshot {
        self.task_board.wait_for_all(store, timeout).await
    }

    pub async fn cancel(&mut self, store: &mut impl TaskStore) -> SessionReply {
        self.task_board.drain(store).await;
        let task_id = if let Some(task_id) = self.focus_task.clone() {
            if self.task_board.cancel_task(store, &task_id).await {
                Some(task_id)
            } else {
                self.task_board.cancel_first_active(store).await
            }
        } else {
            self.task_board.cancel_first_active(store).await
        };

        let Some(task_id) = task_id else {
            return SessionReply {
                text: "No task is currently running.".to_string(),
                task_id: None,
            };
        };

        if self.focus_task.as_deref() == Some(task_id.as_str()) {
            self.focus_task = None;
        }

        SessionReply {
            text: format!("Cancelled task {task_id}."),
            task_id: Some(task_id),
        }
    }

    pub async fn handle_message(
        &mut self,
        store: &mut impl TaskStore,
        message: impl Into<String>,
    ) -> SessionReply {
        self.task_board.drain(store).await;
        let context = AssistantContext::build(store, message);
        let turn = match self.loop_agent.run_turn(&context).await {
            Ok(turn) => turn,
            Err(error) => {
                return SessionReply {
                    text: format!("Assistant turn failed: {}", error.message),
                    task_id: None,
                };
            }
        };
        self.apply_turn(store, turn).await
    }

    async fn apply_turn(
        &mut self,
        store: &mut impl TaskStore,
        turn: AssistantTurn,
    ) -> SessionReply {
        let mut touched_task_ids = Vec::new();
        let mut saw_terminal = false;

        for call in turn.tool_calls {
            match call.name.as_str() {
                "read_assistant_context" | "list_tasks" => {}
                "inspect_task" => {
                    let args = match decode_tool_args::<InspectTaskArgs>(&call) {
                        Ok(args) => args,
                        Err(error) => return tool_sequence_error(error),
                    };
                    let task_id = match required_non_empty(args.task_id, "task_id") {
                        Ok(task_id) => task_id,
                        Err(error) => return tool_sequence_error(error),
                    };
                    if store.get_task(&task_id).is_none() {
                        return SessionReply {
                            text: format!("Task {task_id} was not found."),
                            task_id: None,
                        };
                    }
                    push_unique(&mut touched_task_ids, task_id);
                }
                "create_task" => {
                    let args = match decode_tool_args::<CreateTaskArgs>(&call) {
                        Ok(args) => args,
                        Err(error) => return tool_sequence_error(error),
                    };
                    let request = match required_non_empty(args.request, "request") {
                        Ok(request) => request,
                        Err(error) => return tool_sequence_error(error),
                    };
                    if let Some(task_id) = self.create_task(store, request).await.task_id {
                        push_unique(&mut touched_task_ids, task_id);
                    }
                }
                "cancel_task" => {
                    let args = match decode_tool_args::<CancelTaskArgs>(&call) {
                        Ok(args) => args,
                        Err(error) => return tool_sequence_error(error),
                    };
                    let reply = match args.task_id.filter(|task_id| !task_id.trim().is_empty()) {
                        Some(task_id) => self.cancel_specific_task(store, task_id).await,
                        None => self.cancel(store).await,
                    };
                    if let Some(task_id) = reply.task_id {
                        push_unique(&mut touched_task_ids, task_id);
                    }
                }
                "finish_assistant_turn" => {
                    saw_terminal = true;
                    break;
                }
                other => {
                    return SessionReply {
                        text: format!("Assistant tool sequence failed: unsupported tool {other}"),
                        task_id: None,
                    };
                }
            }
        }

        if !saw_terminal {
            return SessionReply {
                text: "Assistant tool sequence failed: missing finish_assistant_turn.".to_string(),
                task_id: None,
            };
        }

        let task_id = turn
            .task_ids
            .iter()
            .find(|task_id| !task_id.trim().is_empty())
            .cloned()
            .or_else(|| touched_task_ids.first().cloned());
        SessionReply {
            text: turn.response,
            task_id,
        }
    }

    async fn create_task(&mut self, store: &mut impl TaskStore, request: String) -> SessionReply {
        let task_id = store.create_task(request.clone());
        store.push_task_event(&task_id, "created from assistant message");
        self.focus_task = Some(task_id.clone());
        let snapshot = self
            .task_board
            .enqueue(store, task_id.clone(), request)
            .await;
        let status = store
            .get_task(&task_id)
            .map(|task| task.status.clone())
            .unwrap_or(AssistantTaskStatus::Queued);

        SessionReply {
            text: format!(
                "Task {task_id} {:?}. {} running, {} queued.",
                status, snapshot.running_tasks, snapshot.queued_tasks
            ),
            task_id: Some(task_id),
        }
    }

    async fn cancel_specific_task(
        &mut self,
        store: &mut impl TaskStore,
        task_id: TaskId,
    ) -> SessionReply {
        self.task_board.drain(store).await;
        if store.get_task(&task_id).is_none() {
            return SessionReply {
                text: format!("Task {task_id} was not found."),
                task_id: None,
            };
        }
        if !self.task_board.cancel_task(store, &task_id).await {
            return SessionReply {
                text: format!("Task {task_id} is not active."),
                task_id: Some(task_id),
            };
        }
        if self.focus_task.as_deref() == Some(task_id.as_str()) {
            self.focus_task = None;
        }
        SessionReply {
            text: format!("Cancelled task {task_id}."),
            task_id: Some(task_id),
        }
    }
}

fn push_unique(task_ids: &mut Vec<TaskId>, task_id: TaskId) {
    if !task_ids.iter().any(|existing| existing == &task_id) {
        task_ids.push(task_id);
    }
}

fn tool_sequence_error(error: AssistantTurnError) -> SessionReply {
    SessionReply {
        text: format!("Assistant tool sequence failed: {}", error.message),
        task_id: None,
    }
}
