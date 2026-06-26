use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::{
    AgentPromptSection, AgentRunRequest, AgentRunScheduler, AgentToolCall, AssistantHarness,
    AssistantTaskEventRecord, AssistantTaskStatus, CancellationToken, TaskBoard, TaskBoardSnapshot,
    TaskId, TaskStore, TaskWorkerFactory, WorkspaceRequirement,
};

use super::context::{AssistantContext, AssistantConversationMessage, AssistantConversationRole};
use super::tools::{
    CancelTaskArgs, CreateTaskArgs, FinishTurnArgs, InspectTaskArgs, RetrieveEvalTranscriptArgs,
};

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

    if terminal_call.name != "finish_turn" {
        return Err(AssistantTurnError {
            message: format!(
                "expected finish_turn terminal tool, got {}",
                terminal_call.name
            ),
        });
    }

    let finish = serde_json::from_value::<FinishTurnArgs>(terminal_call.arguments.clone())
        .map_err(|error| AssistantTurnError {
            message: format!("invalid finish_turn arguments: {error}"),
        })?;
    if finish.response.trim().is_empty() {
        return Err(AssistantTurnError {
            message: "finish_turn response must not be empty".to_string(),
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
            "Your previous assistant tool sequence was rejected by the protocol validator: {error}. Use the provided assistant tools with valid arguments, then finish with finish_turn. Do not guess outside the provided context."
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
    pub task_board_enabled: bool,
    pub conversation_message_limit: usize,
    pub root_workspace: WorkspaceRequirement,
    pub root_capabilities: crate::CapabilityProfile,
}

impl Default for AssistantSessionConfig {
    fn default() -> Self {
        Self {
            max_parallel_tasks: 2,
            task_board_enabled: true,
            conversation_message_limit: 200,
            root_workspace: WorkspaceRequirement::memory(),
            root_capabilities: crate::CapabilityProfile::read_only(),
        }
    }
}

pub struct AssistantSession<L: AssistantLoop> {
    focus_task: Option<TaskId>,
    conversation: Vec<AssistantConversationMessage>,
    conversation_message_limit: usize,
    loop_agent: L,
    task_board: TaskBoard,
    task_board_enabled: bool,
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
        let task_board = TaskBoard::new_with_root(
            config.max_parallel_tasks,
            worker_factory,
            config.root_workspace.clone(),
            config.root_capabilities.clone(),
        );
        Self {
            focus_task: None,
            conversation: Vec::new(),
            conversation_message_limit: config.conversation_message_limit,
            loop_agent,
            task_board,
            task_board_enabled: config.task_board_enabled,
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

    pub fn set_task_root(
        &mut self,
        workspace: WorkspaceRequirement,
        capabilities: crate::CapabilityProfile,
    ) {
        self.task_board.set_default_root(workspace, capabilities);
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
        let message = message.into();
        if self.task_board_enabled {
            self.task_board.drain(store).await;
        }
        let context = if self.task_board_enabled {
            AssistantContext::build_with_task_board(store, message.clone(), true)
        } else {
            AssistantContext::message_only(message.clone())
        }
        .with_conversation(self.conversation.clone());
        let turn = match self.loop_agent.run_turn(&context).await {
            Ok(turn) => turn,
            Err(error) => {
                let reply = SessionReply {
                    text: format!("Assistant turn failed: {}", error.message),
                    task_id: None,
                };
                self.record_turn(message, &reply);
                return reply;
            }
        };
        let reply = self.apply_turn(store, turn).await;
        self.record_turn(message, &reply);
        reply
    }

    pub async fn handle_task_message(
        &mut self,
        store: &mut impl TaskStore,
        message: impl Into<String>,
    ) -> SessionReply {
        let message = message.into();
        let request = message.trim().to_string();
        if request.is_empty() {
            let reply = SessionReply {
                text: "Please provide a task request.".to_string(),
                task_id: None,
            };
            self.record_turn(message, &reply);
            return reply;
        }
        if !self.task_board_enabled {
            let reply = SessionReply {
                text: "Task board is disabled; cannot create a durable task.".to_string(),
                task_id: None,
            };
            self.record_turn(message, &reply);
            return reply;
        }

        self.task_board.drain(store).await;
        let reply = self
            .create_task_with_source(store, request, TaskCreationSource::DirectIntake)
            .await;
        self.record_turn(message, &reply);
        reply
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
                "query_messages" => {}
                "list_tasks" if self.task_board_enabled => {}
                "inspect_task" => {
                    if !self.task_board_enabled {
                        return unsupported_task_board_tool("inspect_task");
                    }
                    let args = match decode_tool_args::<InspectTaskArgs>(&call) {
                        Ok(args) => args,
                        Err(error) => return tool_sequence_error(error),
                    };
                    let task_id = match required_non_empty(args.task_id, "task_id") {
                        Ok(task_id) => task_id,
                        Err(error) => return tool_sequence_error(error),
                    };
                    if store.get_task(&task_id).is_none() {
                        if !touched_task_ids.is_empty() {
                            continue;
                        }
                        return SessionReply {
                            text: format!("Task {task_id} was not found."),
                            task_id: None,
                        };
                    }
                    push_unique(&mut touched_task_ids, task_id);
                }
                "create_task" => {
                    if !self.task_board_enabled {
                        return unsupported_task_board_tool("create_task");
                    }
                    let args = match decode_tool_args::<CreateTaskArgs>(&call) {
                        Ok(args) => args,
                        Err(error) => return tool_sequence_error(error),
                    };
                    let request = match required_non_empty(args.request, "request") {
                        Ok(request) => request,
                        Err(error) => return tool_sequence_error(error),
                    };
                    if let Some(task_id) = self
                        .create_task_with_source(store, request, TaskCreationSource::AssistantTool)
                        .await
                        .task_id
                    {
                        push_unique(&mut touched_task_ids, task_id);
                    }
                }
                "cancel_task" => {
                    if !self.task_board_enabled {
                        return unsupported_task_board_tool("cancel_task");
                    }
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
                "query_dogfood_tasks" => {
                    let tasks = store.list_tasks();
                    let lines: Vec<String> = tasks
                        .iter()
                        .map(|t| format!("{}: {} — {:?}", t.id, t.title, t.status))
                        .collect();
                    return SessionReply {
                        text: if lines.is_empty() {
                            "No tasks found.".to_string()
                        } else {
                            lines.join("\n")
                        },
                        task_id: None,
                    };
                }
                "retrieve_eval_transcript" => {
                    let args = match decode_tool_args::<RetrieveEvalTranscriptArgs>(&call) {
                        Ok(args) => args,
                        Err(error) => return tool_sequence_error(error),
                    };
                    let path = std::path::Path::new(&args.artifact_dir);
                    let entries = match std::fs::read_dir(path) {
                        Ok(entries) => entries,
                        Err(e) => {
                            return SessionReply {
                                text: format!(
                                    "Cannot read artifact dir {}: {e}",
                                    args.artifact_dir
                                ),
                                task_id: None,
                            };
                        }
                    };
                    let mut results = Vec::new();
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();

                        // Skip entries that don't match task_id or scenario filters
                        if args
                            .task_id
                            .as_ref()
                            .is_some_and(|tid| !name.contains(tid.as_str()))
                            || args
                                .scenario
                                .as_ref()
                                .is_some_and(|sc| !name.contains(sc.as_str()))
                        {
                            continue;
                        }
                        if let Ok(content) = std::fs::read_to_string(entry.path()) {
                            results.push(format!("--- {name} ---\n{content}"));
                        }
                    }
                    return SessionReply {
                        text: if results.is_empty() {
                            format!("No matching artifacts found in {}", args.artifact_dir)
                        } else {
                            results.join("\n")
                        },
                        task_id: None,
                    };
                }
                "finish_turn" => {
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
                text: "Assistant tool sequence failed: missing finish_turn.".to_string(),
                task_id: None,
            };
        }

        let task_id = touched_task_ids.first().cloned().or_else(|| {
            turn.task_ids
                .iter()
                .find(|task_id| !task_id.trim().is_empty() && store.get_task(task_id).is_some())
                .cloned()
        });
        SessionReply {
            text: turn.response,
            task_id,
        }
    }

    async fn create_task_with_source(
        &mut self,
        store: &mut impl TaskStore,
        request: String,
        source: TaskCreationSource,
    ) -> SessionReply {
        let task_id = store.create_task(request.clone());
        store.record_task_event(
            &task_id,
            AssistantTaskEventRecord {
                level: tracing::Level::INFO,
                kind: "task.created".to_string(),
                source: "assistant.session".to_string(),
                message: source.message().to_string(),
                node_id: None,
                operation: None,
                payload: json!({
                    "source": source.payload_source(),
                }),
            },
        );
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

    fn record_turn(&mut self, message: String, reply: &SessionReply) {
        self.conversation.push(AssistantConversationMessage {
            role: AssistantConversationRole::User,
            content: message,
            task_id: reply.task_id.clone(),
        });
        self.conversation.push(AssistantConversationMessage {
            role: AssistantConversationRole::Assistant,
            content: reply.text.clone(),
            task_id: reply.task_id.clone(),
        });
        if self.conversation.len() > self.conversation_message_limit {
            let overflow = self.conversation.len() - self.conversation_message_limit;
            self.conversation.drain(0..overflow);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskCreationSource {
    AssistantTool,
    DirectIntake,
}

impl TaskCreationSource {
    fn message(self) -> &'static str {
        match self {
            Self::AssistantTool => "created from assistant tool",
            Self::DirectIntake => "created from direct task intake",
        }
    }

    fn payload_source(self) -> &'static str {
        match self {
            Self::AssistantTool => "assistant_tool",
            Self::DirectIntake => "direct_intake",
        }
    }
}

fn unsupported_task_board_tool(tool_name: &str) -> SessionReply {
    SessionReply {
        text: format!("Assistant tool sequence failed: task board tool {tool_name} is disabled."),
        task_id: None,
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
