use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tracing::{Level, error, info};

use crate::{
    AgentRunRequest, AgentRunResponse, AgentRunScheduler, AssistantTaskEventRecord,
    AssistantTaskStatus, Budget, CancellationToken, CapabilityProfile, Engine, EngineError,
    EngineReport, NodeId, NodePlan, NodePolicy, NodeTemplate, ProblemKey, TaskId, TaskStore,
    WorkSize, Workspaces,
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
        cancellation: CancellationToken,
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
    root_workspace: crate::WorkspaceRequirement,
    root_capabilities: CapabilityProfile,
}

impl RecursiveTaskEngineRunner {
    fn new(
        worker_factory: TaskWorkerFactory,
        root_workspace: crate::WorkspaceRequirement,
        root_capabilities: CapabilityProfile,
    ) -> Self {
        Self {
            worker_factory,
            root_workspace,
            root_capabilities,
        }
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
        cancellation: CancellationToken,
    ) -> Result<(NodeId, EngineReport), EngineError> {
        let root_template = task_request_to_root(
            task_id,
            request,
            self.root_workspace.clone(),
            self.root_capabilities.clone(),
        );
        let worker = FactoryAgentRunScheduler::new(self.worker_factory.clone());
        let mut engine = Engine::new(Workspaces::default(), worker);
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
    queued: VecDeque<QueuedTask>,
    running: HashMap<TaskId, RunningTask>,
    tx: UnboundedSender<TaskRunEvent>,
    rx: UnboundedReceiver<TaskRunEvent>,
}

#[derive(Debug, Clone)]
struct QueuedTask {
    task_id: TaskId,
    request: String,
}

#[derive(Debug, Clone)]
struct RunningTask {
    cancellation: CancellationToken,
}

#[derive(Debug)]
enum TaskRunEvent {
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
            Box::new(RecursiveTaskEngineRunner::new(
                worker_factory.clone(),
                root_workspace.clone(),
                root_capabilities.clone(),
            ))
        });
        Self::with_engine_runner(max_parallel_tasks, engine_runner_factory)
    }

    pub fn with_engine_runner(
        max_parallel_tasks: usize,
        engine_runner_factory: TaskEngineRunnerFactory,
    ) -> Self {
        let max_parallel_tasks = max_parallel_tasks.max(1);
        let (tx, rx) = unbounded_channel();
        Self {
            max_parallel_tasks,
            engine_runner_factory,
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

    pub async fn enqueue(
        &mut self,
        store: &mut impl TaskStore,
        task_id: TaskId,
        request: String,
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
        self.queued.push_back(QueuedTask { task_id, request });
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
            if cancellation.is_cancelled() {
                let _ = tx.send(TaskRunEvent::Cancelled {
                    task_id: queued.task_id,
                });
                return;
            }

            let mut engine_runner = engine_runner_factory.make();
            let event = match engine_runner
                .run_task(&queued.task_id, &queued.request, cancellation.clone())
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
        });
    }

    fn apply_event(&mut self, store: &mut impl TaskStore, event: TaskRunEvent) {
        match event {
            TaskRunEvent::Completed {
                task_id,
                root,
                report,
            } => {
                self.running.remove(&task_id);
                record_engine_report_logs(store, &task_id, root, &report);
                store.apply_task_report(&task_id, root, report);
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

fn task_request_to_root(
    task_id: &str,
    request: &str,
    workspace: crate::WorkspaceRequirement,
    capabilities: CapabilityProfile,
) -> NodeTemplate {
    NodeTemplate {
        policy: NodePolicy::Explore,
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
