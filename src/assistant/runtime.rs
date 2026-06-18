use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use crate::{
    AgentRunRequest, AgentWorker, AgentWorkerResult, Budget, CancellationToken, CapabilityProfile,
    Engine, EngineError, EngineReport, MemoryWorkspace, NodeScript, NodeTemplate, ProblemKey,
    VerificationVerdict,
};

use super::{
    store::TaskStore,
    task::{AssistantTaskStatus, TaskId},
};

type WorkerFactory = dyn Fn() -> Box<dyn AgentWorker + Send> + Send + Sync;

#[derive(Clone)]
pub struct AssistantWorkerFactory {
    make_worker: Arc<WorkerFactory>,
}

impl AssistantWorkerFactory {
    pub fn new(
        make_worker: impl Fn() -> Box<dyn AgentWorker + Send> + Send + Sync + 'static,
    ) -> Self {
        Self {
            make_worker: Arc::new(make_worker),
        }
    }

    fn make(&self) -> Box<dyn AgentWorker + Send> {
        (self.make_worker)()
    }
}

pub struct TaskRuntime {
    max_parallel_tasks: usize,
    worker_factory: AssistantWorkerFactory,
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
        root: crate::NodeId,
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
pub struct TaskRuntimeSnapshot {
    pub running_tasks: usize,
    pub queued_tasks: usize,
}

impl TaskRuntime {
    pub fn new(max_parallel_tasks: usize, worker_factory: AssistantWorkerFactory) -> Self {
        let max_parallel_tasks = max_parallel_tasks.max(1);
        let (tx, rx) = unbounded_channel();
        Self {
            max_parallel_tasks,
            worker_factory,
            queued: VecDeque::new(),
            running: HashMap::new(),
            tx,
            rx,
        }
    }

    pub fn snapshot(&self) -> TaskRuntimeSnapshot {
        TaskRuntimeSnapshot {
            running_tasks: self.running.len(),
            queued_tasks: self.queued.len(),
        }
    }

    pub async fn enqueue(
        &mut self,
        store: &mut impl TaskStore,
        task_id: TaskId,
        request: String,
    ) -> TaskRuntimeSnapshot {
        store.set_task_status(&task_id, AssistantTaskStatus::Queued);
        store.push_task_event(&task_id, "queued for assistant runtime");
        self.queued.push_back(QueuedTask { task_id, request });
        self.start_ready(store);
        self.snapshot()
    }

    pub async fn drain(&mut self, store: &mut impl TaskStore) -> TaskRuntimeSnapshot {
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
            store.push_task_event(task_id, "cancel requested");
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
    ) -> TaskRuntimeSnapshot {
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
            store.push_task_event(&queued.task_id, "assistant runtime started task");
            self.spawn(queued);
        }
    }

    fn spawn(&mut self, queued: QueuedTask) {
        let tx = self.tx.clone();
        let worker_factory = self.worker_factory.clone();
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

            let worker = worker_factory.make();
            let root_template = task_request_to_root(&queued.task_id, &queued.request);
            let mut engine = Engine::new(MemoryWorkspace::default(), worker);
            let root = engine.insert_root(root_template);
            let event = match engine.run_with_cancel(root, cancellation.clone()).await {
                Ok(_) if cancellation.is_cancelled() => TaskRunEvent::Cancelled {
                    task_id: queued.task_id,
                },
                Ok(report) => TaskRunEvent::Completed {
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
                store.apply_task_report(&task_id, root, report);
                store.push_task_event(&task_id, "engine run completed");
            }
            TaskRunEvent::Failed { task_id, error } => {
                self.running.remove(&task_id);
                store.set_task_status(&task_id, AssistantTaskStatus::Failed);
                store.push_task_event(&task_id, format!("engine error: {error:?}"));
            }
            TaskRunEvent::Cancelled { task_id } => {
                self.running.remove(&task_id);
                mark_cancelled(store, &task_id, "cancelled by assistant runtime");
            }
        }
    }
}

#[async_trait]
impl<T: AgentWorker + ?Sized> AgentWorker for Box<T> {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentWorkerResult {
        (**self).run(input, cancellation).await
    }
}

fn mark_cancelled(store: &mut impl TaskStore, task_id: &str, message: &str) {
    store.set_task_status(task_id, AssistantTaskStatus::Cancelled);
    store.push_task_event(task_id, message);
}

fn task_request_to_root(task_id: &str, request: &str) -> NodeTemplate {
    NodeTemplate {
        key: ProblemKey(task_id.to_string()),
        intent: request.to_string(),
        workspace: crate::WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        script: NodeScript::Leaf {
            output: request.to_string(),
            changed_paths: Vec::new(),
            side_effects: Vec::new(),
            verdicts: vec![VerificationVerdict::Accept],
        },
    }
}
