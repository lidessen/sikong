use crate::{EngineReport, NodeId, NodeStatus};
use serde::{Deserialize, Serialize};

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
    pub message: String,
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

    pub fn push_event(&mut self, message: impl Into<String>) {
        self.events.push(AssistantTaskEvent {
            message: message.into(),
        });
    }
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
