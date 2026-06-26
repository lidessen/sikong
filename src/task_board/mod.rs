use std::time::{SystemTime, UNIX_EPOCH};

use crate::{EngineReport, NodeId, NodeOperation, NodeStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::Level;

mod board;
mod store;
pub mod view;

pub use board::{
    TaskBoard, TaskBoardSnapshot, TaskEngineProgressSink, TaskEngineRunner,
    TaskEngineRunnerFactory, TaskWorkerFactory,
};
pub use store::{FileTaskStore, MemoryTaskStore, TaskStore};
pub use view::{
    AgentEventEntry, AgentEventFilter, TaskArtifactView, TaskEventCursor, TaskInspectView,
    TaskSummaryView, TaskTimelineRecord, assistant_agent_events, inspect_task_view,
    legacy_uuid_v7_timestamp_ms, parse_node_operation, resolve_task_ref, sort_tasks_newest_first,
    task_artifact, task_list_id, task_summary,
};

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
    #[serde(default)]
    pub created_at_ms: u64,
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
            created_at_ms: timestamp_ms(),
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
    if normalized.chars().count() <= 64 {
        return normalized;
    }
    format!("{}...", normalized.chars().take(61).collect::<String>())
}

fn status_from_node(status: NodeStatus) -> AssistantTaskStatus {
    match status {
        NodeStatus::Committed => AssistantTaskStatus::Completed,
        NodeStatus::WaitingForInfo => AssistantTaskStatus::WaitingForInput,
        NodeStatus::Rejected | NodeStatus::Pruned => AssistantTaskStatus::Failed,
        _ => AssistantTaskStatus::Running,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_title_truncates_utf8_safely() {
        let request = "继续推进 Sikong 自我迭代，请不要直接实现代码，优先创建 bounded dogfood roadmap task，要求产出 reviewable artifact。";
        let task = AssistantTask::new("task_1".to_string(), request.to_string());

        assert!(task.title.ends_with("..."));
        assert!(task.title.chars().count() <= 64);
        assert!(task.title.contains("Sikong"));
    }
    #[test]
    fn title_from_request_preserves_short_text() {
        let request = "short task description";
        let title = title_from_request(request);
        assert_eq!(title, "short task description");
    }

    #[test]
    fn title_from_request_normalizes_whitespace() {
        let request = "fix   the   spacing	and
newlines";
        let title = title_from_request(request);
        assert_eq!(title, "fix the spacing and newlines");
    }

    #[test]
    fn title_from_request_truncates_long_text() {
        let request = "a very long task description that exceeds the sixty four character limit for task titles and should be truncated properly";
        let title = title_from_request(request);
        assert!(title.ends_with("..."));
        assert!(title.chars().count() <= 64);
        assert!(title.starts_with("a very long task description that exceeds the sixty four"));
    }

    #[test]
    fn title_from_request_exact_sixty_four_chars_is_not_truncated() {
        let request = "1234567890".repeat(6) + "1234";
        assert_eq!(request.chars().count(), 64);
        let title = title_from_request(&request);
        assert_eq!(title, request);
        assert!(!title.ends_with("..."));
    }

    #[test]
    fn title_from_request_empty_returns_empty() {
        let title = title_from_request("");
        assert_eq!(title, "");
    }

    #[test]
    fn title_from_request_only_whitespace_returns_empty() {
        let title = title_from_request(
            "   	
   ",
        );
        assert_eq!(title, "");
    }

    #[test]
    fn status_from_node_committed() {
        assert_eq!(
            status_from_node(NodeStatus::Committed),
            AssistantTaskStatus::Completed
        );
    }

    #[test]
    fn status_from_node_waiting_for_info() {
        assert_eq!(
            status_from_node(NodeStatus::WaitingForInfo),
            AssistantTaskStatus::WaitingForInput
        );
    }

    #[test]
    fn status_from_node_rejected() {
        assert_eq!(
            status_from_node(NodeStatus::Rejected),
            AssistantTaskStatus::Failed
        );
    }

    #[test]
    fn status_from_node_pruned() {
        assert_eq!(
            status_from_node(NodeStatus::Pruned),
            AssistantTaskStatus::Failed
        );
    }

    #[test]
    fn status_from_node_new_or_running_is_running() {
        for status in &[
            NodeStatus::New,
            NodeStatus::Specified,
            NodeStatus::Planned,
            NodeStatus::Running,
            NodeStatus::Combining,
            NodeStatus::Verifying,
            NodeStatus::Accepted,
        ] {
            assert_eq!(
                status_from_node(*status),
                AssistantTaskStatus::Running,
                "expected {:?} to map to Running",
                status,
            );
        }
    }
}
