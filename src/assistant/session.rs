use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::{
    AgentPromptSection, AgentRunHarness, AgentRunRequest, AgentWorker, AssistantHarness,
    CancellationToken,
    tools::{AssistantDecisionKind, SubmitAssistantDecisionArgs},
};

use super::context::AssistantContext;
use super::runtime::{AssistantWorkerFactory, TaskRuntime, TaskRuntimeSnapshot};
use super::store::TaskStore;
use super::task::{AssistantTaskStatus, TaskId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionState {
    pub focus_task: Option<TaskId>,
    pub running_tasks: usize,
    pub queued_tasks: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssistantDecision {
    CreateTask { request: String },
    ListTasks,
    InspectTask { task_id: TaskId },
    CancelActiveTask,
    Reply { response: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantDecisionError {
    pub message: String,
}

#[async_trait]
pub trait AssistantLoop: Send {
    async fn decide(
        &mut self,
        context: &AssistantContext,
    ) -> Result<AssistantDecision, AssistantDecisionError>;
}

pub struct AgentAssistantLoop<W: AgentWorker> {
    worker: W,
}

impl<W: AgentWorker> AgentAssistantLoop<W> {
    pub fn new(worker: W) -> Self {
        Self { worker }
    }
}

#[async_trait]
impl<W> AssistantLoop for AgentAssistantLoop<W>
where
    W: AgentWorker + Send,
{
    async fn decide(
        &mut self,
        context: &AssistantContext,
    ) -> Result<AssistantDecision, AssistantDecisionError> {
        let mut request = AssistantHarness::new(context.clone()).build_agent_run();
        let mut last_error: Option<String> = None;

        for attempt in 0..2 {
            if let Some(error) = &last_error {
                request = decision_retry_request(&request, error);
            }

            let result = self
                .worker
                .run(request.clone(), CancellationToken::new())
                .await;
            match decode_assistant_decision(
                result.terminal_call.as_ref().map(|call| call.name.as_str()),
                result.terminal_call.as_ref().map(|call| &call.arguments),
            ) {
                Ok(decision) => return Ok(decision),
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

        Err(AssistantDecisionError {
            message: last_error.unwrap_or_else(|| "assistant agent did not decide".to_string()),
        })
    }
}

fn decode_assistant_decision(
    terminal_tool: Option<&str>,
    arguments: Option<&serde_json::Value>,
) -> Result<AssistantDecision, AssistantDecisionError> {
    if terminal_tool != Some("submit_assistant_decision") {
        return Err(AssistantDecisionError {
            message: format!(
                "expected submit_assistant_decision terminal tool, got {}",
                terminal_tool.unwrap_or("<none>")
            ),
        });
    }

    let arguments = arguments.ok_or_else(|| AssistantDecisionError {
        message: "missing assistant decision arguments".to_string(),
    })?;
    let args = serde_json::from_value::<SubmitAssistantDecisionArgs>(arguments.clone()).map_err(
        |error| AssistantDecisionError {
            message: format!("invalid assistant decision arguments: {error}"),
        },
    )?;

    match args.decision {
        AssistantDecisionKind::CreateTask => Ok(AssistantDecision::CreateTask {
            request: required_non_empty(args.request, "request")?,
        }),
        AssistantDecisionKind::ListTasks => Ok(AssistantDecision::ListTasks),
        AssistantDecisionKind::InspectTask => Ok(AssistantDecision::InspectTask {
            task_id: required_non_empty(args.task_id, "task_id")?,
        }),
        AssistantDecisionKind::CancelActiveTask => Ok(AssistantDecision::CancelActiveTask),
        AssistantDecisionKind::Reply => Ok(AssistantDecision::Reply {
            response: required_non_empty(Some(args.response), "response")?,
        }),
    }
}

fn required_non_empty(
    value: Option<String>,
    field: &'static str,
) -> Result<String, AssistantDecisionError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AssistantDecisionError {
            message: format!("assistant decision missing required field {field}"),
        })
}

fn decision_retry_request(request: &AgentRunRequest, error: &str) -> AgentRunRequest {
    let mut retry = request.clone();
    retry.prompt.push(AgentPromptSection {
        title: "Decision Repair".to_string(),
        content: format!(
            "Your previous assistant decision was rejected by the protocol validator: {error}. Call submit_assistant_decision with a valid payload that satisfies the tool schema. Do not guess outside the provided context."
        ),
    });
    retry.input = with_decision_error(&retry.input, error);
    retry
}

fn with_decision_error(input: &Value, error: &str) -> Value {
    match input {
        Value::Object(object) => {
            let mut object = object.clone();
            object.insert(
                "assistant_decision_error".to_string(),
                Value::String(error.to_string()),
            );
            Value::Object(object)
        }
        _ => json!({
            "assistant_decision_error": error,
            "previous_input": input,
        }),
    }
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
    runtime: TaskRuntime,
}

impl<L: AssistantLoop> AssistantSession<L> {
    pub fn new<W>(loop_agent: L, engine_worker: W) -> Self
    where
        W: AgentWorker + Clone + Send + Sync + 'static,
    {
        Self::with_config(loop_agent, engine_worker, AssistantSessionConfig::default())
    }

    pub fn with_config<W>(loop_agent: L, engine_worker: W, config: AssistantSessionConfig) -> Self
    where
        W: AgentWorker + Clone + Send + Sync + 'static,
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
        W: AgentWorker + Send + 'static,
    {
        let worker_factory = AssistantWorkerFactory::new(move || Box::new(make_worker()));
        let runtime = TaskRuntime::new(config.max_parallel_tasks, worker_factory);
        Self {
            focus_task: None,
            loop_agent,
            runtime,
        }
    }

    pub fn state(&self) -> SessionState {
        let snapshot = self.runtime.snapshot();
        SessionState {
            focus_task: self.focus_task.clone(),
            running_tasks: snapshot.running_tasks,
            queued_tasks: snapshot.queued_tasks,
        }
    }

    pub async fn drain(&mut self, store: &mut impl TaskStore) -> TaskRuntimeSnapshot {
        self.runtime.drain(store).await
    }

    pub async fn wait_for_all(
        &mut self,
        store: &mut impl TaskStore,
        timeout: Duration,
    ) -> TaskRuntimeSnapshot {
        self.runtime.wait_for_all(store, timeout).await
    }

    pub async fn cancel(&mut self, store: &mut impl TaskStore) -> SessionReply {
        self.runtime.drain(store).await;
        let task_id = if let Some(task_id) = self.focus_task.clone() {
            if self.runtime.cancel_task(store, &task_id).await {
                Some(task_id)
            } else {
                self.runtime.cancel_first_active(store).await
            }
        } else {
            self.runtime.cancel_first_active(store).await
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
        self.runtime.drain(store).await;
        let context = AssistantContext::build(store, message);
        let decision = match self.loop_agent.decide(&context).await {
            Ok(decision) => decision,
            Err(error) => {
                return SessionReply {
                    text: format!("Assistant decision failed: {}", error.message),
                    task_id: None,
                };
            }
        };
        match decision {
            AssistantDecision::CreateTask { request } => self.create_task(store, request).await,
            AssistantDecision::ListTasks => list_tasks(store),
            AssistantDecision::InspectTask { task_id } => inspect_task(store, task_id),
            AssistantDecision::CancelActiveTask => self.cancel(store).await,
            AssistantDecision::Reply { response } => SessionReply {
                text: response,
                task_id: None,
            },
        }
    }

    async fn create_task(&mut self, store: &mut impl TaskStore, request: String) -> SessionReply {
        let task_id = store.create_task(request.clone());
        store.push_task_event(&task_id, "created from assistant message");
        self.focus_task = Some(task_id.clone());
        let snapshot = self.runtime.enqueue(store, task_id.clone(), request).await;
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
}

fn list_tasks(store: &impl TaskStore) -> SessionReply {
    let tasks = store.list_tasks();
    if tasks.is_empty() {
        return SessionReply {
            text: "No tasks yet.".to_string(),
            task_id: None,
        };
    }

    SessionReply {
        text: tasks
            .iter()
            .map(|task| format!("{} {:?}: {}", task.id, task.status, task.title))
            .collect::<Vec<_>>()
            .join("\n"),
        task_id: None,
    }
}

fn inspect_task(store: &impl TaskStore, task_id: TaskId) -> SessionReply {
    match store.get_task(&task_id) {
        Some(task) => SessionReply {
            text: format!("{} {:?}: {}", task.id, task.status, task.title),
            task_id: Some(task.id.clone()),
        },
        None => SessionReply {
            text: format!("Task {task_id} was not found."),
            task_id: None,
        },
    }
}
