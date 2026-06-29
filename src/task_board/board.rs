use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tracing::{Level, error, info};

use crate::{
    AgentRunRequest, AgentRunResponse, AgentRunScheduler, AssistantTaskEventRecord,
    AssistantTaskStatus, BranchProgressEvent, Budget, CancellationToken, CapabilityProfile, Engine,
    EngineError, EngineProgressEvent, EngineReport, NodeId, NodePlan, NodePolicy, NodeStatus,
    NodeTemplate, ProblemKey, TaskId, TaskStore, TaskType, WorkSize, Workspaces,
};

type WorkerFactory = dyn Fn() -> Box<dyn AgentRunScheduler + Send> + Send + Sync;
type EngineRunnerFactory = dyn Fn() -> Box<dyn TaskEngineRunner + Send> + Send + Sync;

#[derive(Clone)]
pub struct TaskWorkerFactory {
    make_worker: Arc<WorkerFactory>,
}

impl TaskWorkerFactory {
    pub fn new(
        make_worker: impl Fn() -> Box<dyn AgentRunScheduler + Send> + Send + Sync + 'static,
    ) -> Self {
        Self {
            make_worker: Arc::new(make_worker),
        }
    }

    fn make(&self) -> Box<dyn AgentRunScheduler + Send> {
        (self.make_worker)()
    }
}

#[async_trait]
pub trait TaskEngineRunner: Send {
    async fn run_task(
        &mut self,
        task_id: &str,
        request: &str,
        workspace: crate::WorkspaceRequirement,
        capabilities: CapabilityProfile,
        cancellation: CancellationToken,
        progress: TaskEngineProgressSink,
    ) -> Result<(NodeId, EngineReport), EngineError>;
}

#[derive(Clone)]
pub struct TaskEngineRunnerFactory {
    make_runner: Arc<EngineRunnerFactory>,
}

impl TaskEngineRunnerFactory {
    pub fn new(
        make_runner: impl Fn() -> Box<dyn TaskEngineRunner + Send> + Send + Sync + 'static,
    ) -> Self {
        Self {
            make_runner: Arc::new(make_runner),
        }
    }

    fn make(&self) -> Box<dyn TaskEngineRunner + Send> {
        (self.make_runner)()
    }
}

struct RecursiveTaskEngineRunner {
    worker_factory: TaskWorkerFactory,
}

impl RecursiveTaskEngineRunner {
    fn new(worker_factory: TaskWorkerFactory) -> Self {
        Self { worker_factory }
    }
}

struct FactoryAgentRunScheduler {
    worker_factory: TaskWorkerFactory,
    worker: Option<Box<dyn AgentRunScheduler + Send>>,
}

impl FactoryAgentRunScheduler {
    fn new(worker_factory: TaskWorkerFactory) -> Self {
        Self {
            worker_factory,
            worker: None,
        }
    }
}

impl Clone for FactoryAgentRunScheduler {
    fn clone(&self) -> Self {
        Self::new(self.worker_factory.clone())
    }
}

#[async_trait]
impl TaskEngineRunner for RecursiveTaskEngineRunner {
    async fn run_task(
        &mut self,
        task_id: &str,
        request: &str,
        workspace: crate::WorkspaceRequirement,
        capabilities: CapabilityProfile,
        cancellation: CancellationToken,
        progress: TaskEngineProgressSink,
    ) -> Result<(NodeId, EngineReport), EngineError> {
        let root_template = task_request_to_root(task_id, request, workspace, capabilities);
        let worker = FactoryAgentRunScheduler::new(self.worker_factory.clone());
        let mut engine = Engine::new(Workspaces::default(), worker)
            .with_progress_sink(move |event| progress.emit(event));
        let root = engine.insert_root(root_template);
        let report = engine.run_with_cancel(root, cancellation).await?;
        Ok((root, report))
    }
}

#[async_trait]
impl AgentRunScheduler for FactoryAgentRunScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse {
        let worker = self
            .worker
            .get_or_insert_with(|| self.worker_factory.make());
        worker.run(input, cancellation).await
    }
}

pub struct TaskBoard {
    max_parallel_tasks: usize,
    engine_runner_factory: TaskEngineRunnerFactory,
    default_workspace: crate::WorkspaceRequirement,
    default_capabilities: CapabilityProfile,
    queued: VecDeque<QueuedTask>,
    running: HashMap<TaskId, RunningTask>,
    tx: UnboundedSender<TaskRunEvent>,
    rx: UnboundedReceiver<TaskRunEvent>,
}

#[derive(Debug, Clone)]
struct QueuedTask {
    task_id: TaskId,
    request: String,
    workspace: crate::WorkspaceRequirement,
    capabilities: CapabilityProfile,
}

#[derive(Debug, Clone)]
struct RunningTask {
    cancellation: CancellationToken,
}

#[derive(Clone)]
pub struct TaskEngineProgressSink {
    task_id: TaskId,
    tx: UnboundedSender<TaskRunEvent>,
}

impl TaskEngineProgressSink {
    pub fn emit(&self, event: EngineProgressEvent) {
        let _ = self.tx.send(TaskRunEvent::Progress {
            task_id: self.task_id.clone(),
            event,
        });
    }
}

#[derive(Debug)]
enum TaskRunEvent {
    Progress {
        task_id: TaskId,
        event: EngineProgressEvent,
    },
    Completed {
        task_id: TaskId,
        root: NodeId,
        report: EngineReport,
    },
    Failed {
        task_id: TaskId,
        error: EngineError,
    },
    Cancelled {
        task_id: TaskId,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskBoardSnapshot {
    pub running_tasks: usize,
    pub queued_tasks: usize,
}

impl TaskBoard {
    pub fn new(max_parallel_tasks: usize, worker_factory: TaskWorkerFactory) -> Self {
        Self::new_with_root(
            max_parallel_tasks,
            worker_factory,
            crate::WorkspaceRequirement::memory(),
            CapabilityProfile::read_only(),
        )
    }

    pub fn new_with_root(
        max_parallel_tasks: usize,
        worker_factory: TaskWorkerFactory,
        root_workspace: crate::WorkspaceRequirement,
        root_capabilities: CapabilityProfile,
    ) -> Self {
        let engine_runner_factory = TaskEngineRunnerFactory::new(move || {
            Box::new(RecursiveTaskEngineRunner::new(worker_factory.clone()))
        });
        Self::with_engine_runner_and_root(
            max_parallel_tasks,
            engine_runner_factory,
            root_workspace,
            root_capabilities,
        )
    }

    pub fn with_engine_runner(
        max_parallel_tasks: usize,
        engine_runner_factory: TaskEngineRunnerFactory,
    ) -> Self {
        Self::with_engine_runner_and_root(
            max_parallel_tasks,
            engine_runner_factory,
            crate::WorkspaceRequirement::memory(),
            CapabilityProfile::read_only(),
        )
    }

    pub fn with_engine_runner_and_root(
        max_parallel_tasks: usize,
        engine_runner_factory: TaskEngineRunnerFactory,
        default_workspace: crate::WorkspaceRequirement,
        default_capabilities: CapabilityProfile,
    ) -> Self {
        let max_parallel_tasks = max_parallel_tasks.max(1);
        let (tx, rx) = unbounded_channel();
        Self {
            max_parallel_tasks,
            engine_runner_factory,
            default_workspace,
            default_capabilities,
            queued: VecDeque::new(),
            running: HashMap::new(),
            tx,
            rx,
        }
    }

    pub fn snapshot(&self) -> TaskBoardSnapshot {
        TaskBoardSnapshot {
            running_tasks: self.running.len(),
            queued_tasks: self.queued.len(),
        }
    }

    pub fn set_default_root(
        &mut self,
        workspace: crate::WorkspaceRequirement,
        capabilities: CapabilityProfile,
    ) {
        self.default_workspace = workspace;
        self.default_capabilities = capabilities;
    }

    pub async fn enqueue(
        &mut self,
        store: &mut impl TaskStore,
        task_id: TaskId,
        request: String,
    ) -> TaskBoardSnapshot {
        self.enqueue_with_root(
            store,
            task_id,
            request,
            self.default_workspace.clone(),
            self.default_capabilities.clone(),
        )
        .await
    }

    pub async fn enqueue_with_root(
        &mut self,
        store: &mut impl TaskStore,
        task_id: TaskId,
        request: String,
        workspace: crate::WorkspaceRequirement,
        capabilities: CapabilityProfile,
    ) -> TaskBoardSnapshot {
        store.set_task_status(&task_id, AssistantTaskStatus::Queued);
        let payload = json!({
            "max_parallel_tasks": self.max_parallel_tasks,
            "running_tasks": self.running.len(),
            "queued_tasks": self.queued.len(),
        });
        info!(
            target: "siko.task",
            task_id = %task_id,
            max_parallel_tasks = self.max_parallel_tasks,
            running_tasks = self.running.len(),
            queued_tasks = self.queued.len(),
            "queued on task board"
        );
        store.record_task_event(
            &task_id,
            AssistantTaskEventRecord {
                level: Level::INFO,
                kind: "task.queued".to_string(),
                source: "task.board".to_string(),
                message: "queued on task board".to_string(),
                node_id: None,
                operation: None,
                payload,
            },
        );
        self.queued.push_back(QueuedTask {
            task_id,
            request,
            workspace,
            capabilities,
        });
        self.start_ready(store);
        self.snapshot()
    }

    pub async fn drain(&mut self, store: &mut impl TaskStore) -> TaskBoardSnapshot {
        while let Ok(event) = self.rx.try_recv() {
            self.apply_event(store, event);
        }
        self.start_ready(store);
        self.snapshot()
    }

    pub async fn cancel_task(&mut self, store: &mut impl TaskStore, task_id: &str) -> bool {
        if let Some(index) = self
            .queued
            .iter()
            .position(|queued| queued.task_id == task_id)
        {
            self.queued.remove(index);
            mark_cancelled(store, task_id, "cancelled while queued");
            return true;
        }

        if let Some(running) = self.running.get(task_id) {
            running.cancellation.cancel();
            store.set_task_status(task_id, AssistantTaskStatus::Cancelled);
            info!(target: "siko.task", task_id = %task_id, "cancel requested");
            store.record_task_event(
                task_id,
                AssistantTaskEventRecord {
                    level: Level::INFO,
                    kind: "task.cancel.requested".to_string(),
                    source: "task.board".to_string(),
                    message: "cancel requested".to_string(),
                    node_id: None,
                    operation: None,
                    payload: serde_json::Value::Null,
                },
            );
            return true;
        }

        false
    }

    pub async fn cancel_first_active(&mut self, store: &mut impl TaskStore) -> Option<TaskId> {
        let task_id = self
            .running
            .keys()
            .next()
            .cloned()
            .or_else(|| self.queued.front().map(|task| task.task_id.clone()))?;
        self.cancel_task(store, &task_id).await;
        Some(task_id)
    }

    pub async fn wait_for_all(
        &mut self,
        store: &mut impl TaskStore,
        timeout: Duration,
    ) -> TaskBoardSnapshot {
        let deadline = Instant::now() + timeout;
        loop {
            let snapshot = self.drain(store).await;
            if snapshot.running_tasks == 0 && snapshot.queued_tasks == 0 {
                return snapshot;
            }
            if Instant::now() >= deadline {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn start_ready(&mut self, store: &mut impl TaskStore) {
        while self.running.len() < self.max_parallel_tasks {
            let Some(queued) = self.queued.pop_front() else {
                return;
            };
            store.set_task_status(&queued.task_id, AssistantTaskStatus::Running);
            let payload = json!({
                "running_tasks_before_start": self.running.len(),
            });
            info!(
                target: "siko.task",
                task_id = %queued.task_id,
                running_tasks_before_start = self.running.len(),
                "task board started task"
            );
            store.record_task_event(
                &queued.task_id,
                AssistantTaskEventRecord {
                    level: Level::INFO,
                    kind: "task.started".to_string(),
                    source: "task.board".to_string(),
                    message: "task board started task".to_string(),
                    node_id: None,
                    operation: None,
                    payload,
                },
            );
            self.spawn(queued);
        }
    }

    fn spawn(&mut self, queued: QueuedTask) {
        let tx = self.tx.clone();
        let engine_runner_factory = self.engine_runner_factory.clone();
        let cancellation = CancellationToken::new();
        self.running.insert(
            queued.task_id.clone(),
            RunningTask {
                cancellation: cancellation.clone(),
            },
        );

        tokio::spawn(async move {
            // Guard sends a Failed event if the future is dropped (panic,
            // cancellation, or runtime shutdown) without completing normally.
            struct SpawnGuard {
                task_id: String,
                tx: UnboundedSender<TaskRunEvent>,
                sent_event: bool,
            }

            impl Drop for SpawnGuard {
                fn drop(&mut self) {
                    if !self.sent_event {
                        let _ = self.tx.send(TaskRunEvent::Failed {
                            task_id: self.task_id.clone(),
                            error: EngineError::AgentProtocol(
                                "task panicked or was cancelled".into(),
                            ),
                        });
                    }
                }
            }

            let mut guard = SpawnGuard {
                task_id: queued.task_id.clone(),
                tx: tx.clone(),
                sent_event: false,
            };

            if cancellation.is_cancelled() {
                let _ = tx.send(TaskRunEvent::Cancelled {
                    task_id: queued.task_id,
                });
                guard.sent_event = true;
                return;
            }

            let mut engine_runner = engine_runner_factory.make();
            let progress = TaskEngineProgressSink {
                task_id: queued.task_id.clone(),
                tx: tx.clone(),
            };
            let event = match engine_runner
                .run_task(
                    &queued.task_id,
                    &queued.request,
                    queued.workspace,
                    queued.capabilities,
                    cancellation.clone(),
                    progress,
                )
                .await
            {
                Ok(_) if cancellation.is_cancelled() => TaskRunEvent::Cancelled {
                    task_id: queued.task_id,
                },
                Ok((root, report)) => TaskRunEvent::Completed {
                    task_id: queued.task_id,
                    root,
                    report,
                },
                Err(EngineError::Cancelled) => TaskRunEvent::Cancelled {
                    task_id: queued.task_id,
                },
                Err(error) => TaskRunEvent::Failed {
                    task_id: queued.task_id,
                    error,
                },
            };
            let _ = tx.send(event);
            guard.sent_event = true;
        });
    }

    fn apply_event(&mut self, store: &mut impl TaskStore, event: TaskRunEvent) {
        match event {
            TaskRunEvent::Progress { task_id, event } => {
                record_engine_progress_event(store, &task_id, event);
            }
            TaskRunEvent::Completed {
                task_id,
                root,
                report,
            } => {
                self.running.remove(&task_id);
                record_engine_report_logs(store, &task_id, root, &report);
                let terminal_status = report.status;
                let artifact = report.artifact;
                let artifact_available = report.artifact_text.is_some();
                store.apply_task_report(&task_id, root, report);
                record_task_finished_event(
                    store,
                    &task_id,
                    root,
                    terminal_status,
                    artifact,
                    artifact_available,
                );
            }
            TaskRunEvent::Failed { task_id, error } => {
                self.running.remove(&task_id);
                store.set_task_status(&task_id, AssistantTaskStatus::Failed);
                error!(target: "siko.task", task_id = %task_id, ?error, "engine error");
                let payload = json!({
                    "error": format!("{error:?}"),
                });
                store.record_task_event(
                    &task_id,
                    AssistantTaskEventRecord {
                        level: Level::ERROR,
                        kind: "engine.failed".to_string(),
                        source: "engine".to_string(),
                        message: format!("engine error: {error:?}"),
                        node_id: None,
                        operation: None,
                        payload,
                    },
                );
                record_task_failed_event(store, &task_id, format!("{error:?}"));
            }
            TaskRunEvent::Cancelled { task_id } => {
                self.running.remove(&task_id);
                mark_cancelled(store, &task_id, "cancelled by task board");
            }
        }
    }
}

#[async_trait]
impl<T: AgentRunScheduler + ?Sized> AgentRunScheduler for Box<T> {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse {
        (**self).run(input, cancellation).await
    }
}

fn mark_cancelled(store: &mut impl TaskStore, task_id: &str, message: &str) {
    store.set_task_status(task_id, AssistantTaskStatus::Cancelled);
    info!(target: "siko.task", task_id = %task_id, message = %message, "task cancelled");
    store.record_task_event(
        task_id,
        AssistantTaskEventRecord {
            level: Level::INFO,
            kind: "task.cancelled".to_string(),
            source: "task.board".to_string(),
            message: message.to_string(),
            node_id: None,
            operation: None,
            payload: serde_json::Value::Null,
        },
    );
}

fn record_task_finished_event(
    store: &mut impl TaskStore,
    task_id: &str,
    root: NodeId,
    status: NodeStatus,
    artifact: Option<u64>,
    artifact_available: bool,
) {
    let (kind, message, level) = match status {
        NodeStatus::Committed => ("task.completed", "task completed", Level::INFO),
        NodeStatus::WaitingForInfo => (
            "task.waiting_for_input",
            "task is waiting for input",
            Level::INFO,
        ),
        NodeStatus::Rejected | NodeStatus::Pruned => ("task.failed", "task failed", Level::ERROR),
        _ => ("task.finished", "task finished", Level::INFO),
    };
    store.record_task_event(
        task_id,
        AssistantTaskEventRecord {
            level,
            kind: kind.to_string(),
            source: "task.board".to_string(),
            message: message.to_string(),
            node_id: Some(root),
            operation: None,
            payload: json!({
                "root": root,
                "status": status,
                "artifact": artifact,
                "artifact_available": artifact_available,
                "duration_ms": task_duration_ms(store, task_id),
            }),
        },
    );
}

fn record_task_failed_event(store: &mut impl TaskStore, task_id: &str, error: String) {
    store.record_task_event(
        task_id,
        AssistantTaskEventRecord {
            level: Level::ERROR,
            kind: "task.failed".to_string(),
            source: "task.board".to_string(),
            message: "task failed".to_string(),
            node_id: None,
            operation: None,
            payload: json!({
                "error": error,
                "duration_ms": task_duration_ms(store, task_id),
            }),
        },
    );
}

fn task_duration_ms(store: &impl TaskStore, task_id: &str) -> Option<u64> {
    let created_at_ms = store.get_task(task_id)?.created_at_ms;
    if created_at_ms == 0 {
        return None;
    }
    Some(now_ms().saturating_sub(created_at_ms))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn record_engine_report_logs(
    store: &mut impl TaskStore,
    task_id: &str,
    root: NodeId,
    report: &EngineReport,
) {
    info!(
        target: "siko.task",
        task_id = %task_id,
        root = root,
        status = ?report.status,
        artifact = ?report.artifact,
        event_count = report.events.len(),
        agent_run_count = report.agent_runs.len(),
        "engine run completed"
    );
    store.record_task_event(
        task_id,
        AssistantTaskEventRecord {
            level: Level::INFO,
            kind: "engine.completed".to_string(),
            source: "engine".to_string(),
            message: "engine run completed".to_string(),
            node_id: None,
            operation: None,
            payload: json!({
                "root": root,
                "status": report.status,
                "artifact": report.artifact,
                "event_count": report.events.len(),
                "agent_run_count": report.agent_runs.len(),
            }),
        },
    );

    for event in &report.events {
        if has_engine_operation_event(store, task_id, event) {
            continue;
        }
        info!(
            target: "siko.task",
            task_id = %task_id,
            node_id = event.node_id,
            operation = ?event.operation,
            "{}", event.note
        );
        store.record_task_event(
            task_id,
            AssistantTaskEventRecord {
                level: Level::INFO,
                kind: "engine.operation".to_string(),
                source: "engine".to_string(),
                message: event.note.clone(),
                node_id: Some(event.node_id),
                operation: Some(event.operation),
                payload: json!({
                    "node_id": event.node_id,
                    "operation": event.operation,
                    "note": event.note,
                }),
            },
        );
    }

    for run in &report.agent_runs {
        if has_agent_run_event(store, task_id, run) {
            continue;
        }
        info!(
            target: "siko.task",
            task_id = %task_id,
            node_id = run.node_id,
            operation = ?run.operation,
            terminal_tool = ?run.terminal_tool,
            duration_ms = run.duration_ms,
            "{}", run.report
        );
        store.record_task_event(
            task_id,
            AssistantTaskEventRecord {
                level: Level::INFO,
                kind: "agent.run".to_string(),
                source: "agent".to_string(),
                message: run.report.clone(),
                node_id: Some(run.node_id),
                operation: Some(run.operation),
                payload: json!({
                    "node_id": run.node_id,
                    "operation": run.operation,
                    "terminal_tool": run.terminal_tool,
                    "duration_ms": run.duration_ms,
                    "report": run.report,
                }),
            },
        );
    }
}

fn record_engine_progress_event(
    store: &mut impl TaskStore,
    task_id: &str,
    event: EngineProgressEvent,
) {
    match event {
        EngineProgressEvent::Operation { event } => {
            if has_engine_operation_event(store, task_id, &event) {
                return;
            }
            store.record_task_event(
                task_id,
                AssistantTaskEventRecord {
                    level: Level::INFO,
                    kind: "engine.operation".to_string(),
                    source: "engine".to_string(),
                    message: event.note.clone(),
                    node_id: Some(event.node_id),
                    operation: Some(event.operation),
                    payload: json!({
                        "node_id": event.node_id,
                        "operation": event.operation,
                        "note": event.note,
                    }),
                },
            );
        }
        EngineProgressEvent::AgentRunStarted {
            node_id,
            operation,
            objective,
            terminal_tools,
        } => {
            store.record_task_event(
                task_id,
                AssistantTaskEventRecord {
                    level: Level::INFO,
                    kind: "agent.run.started".to_string(),
                    source: "agent".to_string(),
                    message: "agent run started".to_string(),
                    node_id: Some(node_id),
                    operation: Some(operation),
                    payload: json!({
                        "node_id": node_id,
                        "operation": operation,
                        "objective": objective,
                        "terminal_tools": terminal_tools,
                    }),
                },
            );
        }
        EngineProgressEvent::AgentRun { run } => {
            if has_agent_run_event(store, task_id, &run) {
                return;
            }
            store.record_task_event(
                task_id,
                AssistantTaskEventRecord {
                    level: Level::INFO,
                    kind: "agent.run".to_string(),
                    source: "agent".to_string(),
                    message: run.report.clone(),
                    node_id: Some(run.node_id),
                    operation: Some(run.operation),
                    payload: json!({
                        "node_id": run.node_id,
                        "operation": run.operation,
                        "terminal_tool": run.terminal_tool,
                        "duration_ms": run.duration_ms,
                        "report": run.report,
                    }),
                },
            );
        }
        EngineProgressEvent::AgentRunEvent {
            node_id,
            operation,
            event,
        } => {
            store.record_task_event(
                task_id,
                AssistantTaskEventRecord {
                    level: Level::INFO,
                    kind: "agent.run.event".to_string(),
                    source: "agent".to_string(),
                    message: agent_run_event_message(&event),
                    node_id: Some(node_id),
                    operation: Some(operation),
                    payload: json!({
                        "node_id": node_id,
                        "operation": operation,
                        "event": event,
                    }),
                },
            );
        }
        EngineProgressEvent::BranchLocal {
            branch_root_node_id,
            local_node_id,
            event,
        } => match event {
            BranchProgressEvent::Operation { operation, note } => {
                store.record_task_event(
                    task_id,
                    AssistantTaskEventRecord {
                        level: Level::INFO,
                        kind: "engine.branch.operation".to_string(),
                        source: "engine".to_string(),
                        message: note.clone(),
                        node_id: Some(branch_root_node_id),
                        operation: Some(operation),
                        payload: json!({
                            "branch_root_node_id": branch_root_node_id,
                            "local_node_id": local_node_id,
                            "operation": operation,
                            "note": note,
                        }),
                    },
                );
            }
            BranchProgressEvent::AgentRunStarted {
                operation,
                objective,
                terminal_tools,
            } => {
                store.record_task_event(
                    task_id,
                    AssistantTaskEventRecord {
                        level: Level::INFO,
                        kind: "agent.branch.run.started".to_string(),
                        source: "agent".to_string(),
                        message: "branch agent run started".to_string(),
                        node_id: Some(branch_root_node_id),
                        operation: Some(operation),
                        payload: json!({
                            "branch_root_node_id": branch_root_node_id,
                            "local_node_id": local_node_id,
                            "operation": operation,
                            "objective": objective,
                            "terminal_tools": terminal_tools,
                        }),
                    },
                );
            }
            BranchProgressEvent::AgentRun {
                operation,
                report,
                terminal_tool,
                terminal_payload,
                duration_ms,
                usage,
                events,
            } => {
                store.record_task_event(
                    task_id,
                    AssistantTaskEventRecord {
                        level: Level::INFO,
                        kind: "agent.branch.run".to_string(),
                        source: "agent".to_string(),
                        message: report.clone(),
                        node_id: Some(branch_root_node_id),
                        operation: Some(operation),
                        payload: json!({
                            "branch_root_node_id": branch_root_node_id,
                            "local_node_id": local_node_id,
                            "operation": operation,
                            "terminal_tool": terminal_tool,
                            "terminal_payload": terminal_payload,
                            "duration_ms": duration_ms,
                            "usage": usage,
                            "events": events,
                            "report": report,
                        }),
                    },
                );
            }
            BranchProgressEvent::AgentRunEvent { operation, event } => {
                store.record_task_event(
                    task_id,
                    AssistantTaskEventRecord {
                        level: Level::INFO,
                        kind: "agent.branch.run.event".to_string(),
                        source: "agent".to_string(),
                        message: agent_run_event_message(&event),
                        node_id: Some(branch_root_node_id),
                        operation: Some(operation),
                        payload: json!({
                            "branch_root_node_id": branch_root_node_id,
                            "local_node_id": local_node_id,
                            "operation": operation,
                            "event": event,
                        }),
                    },
                );
            }
        },
    }
}

fn agent_run_event_message(event: &serde_json::Value) -> String {
    event
        .get("event")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("agent run event")
        .to_string()
}

fn has_engine_operation_event(
    store: &impl TaskStore,
    task_id: &str,
    event: &crate::OperationEvent,
) -> bool {
    store.get_task(task_id).is_some_and(|task| {
        task.events.iter().any(|existing| {
            existing.kind == "engine.operation"
                && existing.node_id == Some(event.node_id)
                && existing.operation == Some(event.operation)
                && existing.message == event.note
        })
    })
}

fn has_agent_run_event(store: &impl TaskStore, task_id: &str, run: &crate::AgentRunRecord) -> bool {
    store.get_task(task_id).is_some_and(|task| {
        task.events.iter().any(|existing| {
            existing.kind == "agent.run"
                && existing.node_id == Some(run.node_id)
                && existing.operation == Some(run.operation)
                && existing.message == run.report
                && existing
                    .payload
                    .get("terminal_tool")
                    .and_then(serde_json::Value::as_str)
                    == run.terminal_tool.as_deref()
        })
    })
}

fn task_request_to_root(
    task_id: &str,
    request: &str,
    workspace: crate::WorkspaceRequirement,
    capabilities: CapabilityProfile,
) -> NodeTemplate {
    NodeTemplate {
        policy: NodePolicy::Explore,
        task_type: TaskType::Explore,
        key: ProblemKey(task_id.to_string()),
        intent: request.to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace,
        capabilities,
        budget: Budget::default(),
        plan: NodePlan::Execute,
    }
}
