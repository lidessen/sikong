use std::time::{SystemTime, UNIX_EPOCH};

use crate::{EngineReport, NodeId, NodeOperation, NodeStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::Level;

mod board;
mod store;

pub use board::{
    TaskBoard, TaskBoardSnapshot, TaskEngineRunner, TaskEngineRunnerFactory, TaskWorkerFactory,
};
pub use store::{FileTaskStore, MemoryTaskStore, TaskStore};

pub type TaskId = String;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssistantTaskStatus {
    Created,
    Queued,
    Running,
    WaitingForInput,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantTask {
    pub id: TaskId,
    pub title: String,
    pub request: String,
    pub status: AssistantTaskStatus,
    pub root_node: Option<NodeId>,
    pub last_report: Option<EngineReport>,
    pub events: Vec<AssistantTaskEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantTaskEvent {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub level: String,
    pub kind: String,
    pub source: String,
    pub message: String,
    pub node_id: Option<NodeId>,
    pub operation: Option<NodeOperation>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantTaskEventRecord {
    pub level: Level,
    pub kind: String,
    pub source: String,
    pub message: String,
    pub node_id: Option<NodeId>,
    pub operation: Option<NodeOperation>,
    pub payload: Value,
}

impl AssistantTask {
    pub fn new(id: TaskId, request: String) -> Self {
        Self {
            id,
            title: title_from_request(&request),
            request,
            status: AssistantTaskStatus::Created,
            root_node: None,
            last_report: None,
            events: Vec::new(),
        }
    }

    pub fn apply_report(&mut self, root: NodeId, report: EngineReport) {
        self.root_node = Some(root);
        self.status = status_from_node(report.status);
        self.last_report = Some(report);
    }

    pub fn record_event(&mut self, record: AssistantTaskEventRecord) {
        self.events.push(AssistantTaskEvent::from_record(
            self.events.len() as u64 + 1,
            record,
        ));
    }
}

impl AssistantTaskEvent {
    fn from_record(seq: u64, record: AssistantTaskEventRecord) -> Self {
        Self {
            seq,
            timestamp_ms: timestamp_ms(),
            level: record.level.to_string(),
            kind: record.kind,
            source: record.source,
            message: record.message,
            node_id: record.node_id,
            operation: record.operation,
            payload: record.payload,
        }
    }
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn title_from_request(request: &str) -> String {
    let normalized = request.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.len() <= 64 {
        return normalized;
    }
    format!("{}...", &normalized[..61])
}

fn status_from_node(status: NodeStatus) -> AssistantTaskStatus {
    match status {
        NodeStatus::Committed => AssistantTaskStatus::Completed,
        NodeStatus::WaitingForInfo => AssistantTaskStatus::WaitingForInput,
        NodeStatus::Rejected | NodeStatus::Pruned => AssistantTaskStatus::Failed,
        _ => AssistantTaskStatus::Running,
    }
}
