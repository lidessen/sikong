use serde::Serialize;
use serde_json::Value;

use crate::{
    AssistantTask, AssistantTaskEvent, AssistantTaskStatus, NodeId, NodeOperation, TaskStore,
};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TaskSummaryView {
    pub id: String,
    pub title: String,
    pub request: String,
    pub created_at_ms: u64,
    pub status: AssistantTaskStatus,
    pub root_node: Option<NodeId>,
    pub task_event_count: usize,
    pub agent_event_count: usize,
    pub has_artifact: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TaskArtifactView {
    pub artifact_id: Option<u64>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct TaskEventCursor {
    pub task_seq: u64,
    pub agent_event_ordinal: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TaskInspectView {
    pub task: AssistantTask,
    pub events: Vec<TaskTimelineRecord>,
    pub timeline: Vec<TaskTimelineItem>,
    pub artifact: Option<TaskArtifactView>,
    pub cursor: TaskEventCursor,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskTimelineRecord {
    TaskEvent {
        task_id: String,
        event: AssistantTaskEvent,
    },
    AgentEvent {
        task_id: String,
        ordinal: usize,
        event: AgentEventEntry,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TaskTimelineItem {
    pub id: String,
    pub timestamp_ms: Option<u64>,
    pub category: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub status: String,
    pub severity: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_event_seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_event_ordinal: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct AgentEventFilter {
    pub operation: Option<NodeOperation>,
    pub event: Option<String>,
    pub tool: Option<String>,
    pub source: Option<String>,
    pub query: Option<String>,
}

impl AgentEventFilter {
    pub fn try_new(
        operation: Option<String>,
        event: Option<String>,
        tool: Option<String>,
        source: Option<String>,
        query: Option<String>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            operation: operation.as_deref().map(parse_node_operation).transpose()?,
            event,
            tool,
            source,
            query,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.operation.is_none()
            && self.event.is_none()
            && self.tool.is_none()
            && self.source.is_none()
            && self.query.is_none()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AgentEventEntry {
    pub task_id: String,
    pub run_index: usize,
    pub event_index: usize,
    pub node_id: crate::NodeId,
    pub operation: NodeOperation,
    pub source: Option<String>,
    pub event: Option<String>,
    pub name: Option<String>,
    pub elapsed_ms: Option<u64>,
    pub objective: Option<String>,
    pub record: Value,
}

pub fn resolve_task_ref<S: TaskStore>(store: &S, task_ref: &str) -> Result<AssistantTask, String> {
    if let Some(task) = store.get_task(task_ref) {
        return Ok(task.clone());
    }

    let matches = store
        .list_tasks()
        .into_iter()
        .filter(|task| task.id.starts_with(task_ref))
        .collect::<Vec<_>>();

    match matches.len() {
        0 => Err(format!("unknown task id {task_ref}")),
        1 => Ok(matches[0].clone()),
        _ => {
            let ids = matches
                .iter()
                .map(|task| task.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Err(format!(
                "ambiguous task id prefix {task_ref}; matches: {ids}"
            ))
        }
    }
}

pub fn task_summary(task: &AssistantTask) -> TaskSummaryView {
    let agent_event_count = assistant_agent_events(task, &AgentEventFilter::default()).len();
    TaskSummaryView {
        id: task.id.clone(),
        title: task.title.clone(),
        request: task.request.clone(),
        created_at_ms: task.created_at_ms,
        status: task.status.clone(),
        root_node: task.root_node,
        task_event_count: task.events.len(),
        agent_event_count,
        has_artifact: task_artifact(task).is_some(),
    }
}

pub fn task_artifact(task: &AssistantTask) -> Option<TaskArtifactView> {
    let report = task.last_report.as_ref()?;
    Some(TaskArtifactView {
        artifact_id: report.artifact,
        text: report.artifact_text.clone()?,
    })
}

pub fn inspect_task_view(task: &AssistantTask, after: TaskEventCursor) -> TaskInspectView {
    let agent_entries = assistant_agent_events(task, &AgentEventFilter::default());
    let mut records = Vec::new();
    for event in &task.events {
        if event.seq > after.task_seq {
            records.push(TaskTimelineRecord::TaskEvent {
                task_id: task.id.clone(),
                event: event.clone(),
            });
        }
    }
    for (index, entry) in agent_entries.iter().enumerate() {
        let ordinal = index + 1;
        if ordinal > after.agent_event_ordinal {
            records.push(TaskTimelineRecord::AgentEvent {
                task_id: task.id.clone(),
                ordinal,
                event: entry.clone(),
            });
        }
    }
    let has_durable_agent_events = task.events.iter().any(|event| {
        matches!(
            event.kind.as_str(),
            "agent.run.event" | "agent.branch.run.event"
        )
    });
    let timeline = records
        .iter()
        .filter(|record| {
            !(has_durable_agent_events && matches!(record, TaskTimelineRecord::AgentEvent { .. }))
        })
        .map(timeline_item)
        .collect();

    TaskInspectView {
        task: task.clone(),
        events: records,
        timeline,
        artifact: task_artifact(task),
        cursor: TaskEventCursor {
            task_seq: task.events.iter().map(|event| event.seq).max().unwrap_or(0),
            agent_event_ordinal: agent_entries.len(),
        },
    }
}

pub fn task_timeline_items(task: &AssistantTask, after: TaskEventCursor) -> Vec<TaskTimelineItem> {
    inspect_task_view(task, after).timeline
}

pub fn task_list_id(task_id: &str) -> String {
    if task_id.chars().count() <= 16 {
        return task_id.to_string();
    }
    task_id.chars().take(12).collect()
}

pub fn sort_tasks_newest_first(tasks: &mut [AssistantTask]) {
    tasks.sort_by(|a, b| {
        task_created_sort_key(b)
            .cmp(&task_created_sort_key(a))
            .then_with(|| b.id.cmp(&a.id))
    });
}

fn task_created_sort_key(task: &AssistantTask) -> u64 {
    if task.created_at_ms != 0 {
        return task.created_at_ms;
    }
    legacy_uuid_v7_timestamp_ms(&task.id).unwrap_or_default()
}

pub fn legacy_uuid_v7_timestamp_ms(id: &str) -> Option<u64> {
    let hex = id
        .chars()
        .filter(|ch| *ch != '-')
        .take(12)
        .collect::<String>();
    if hex.len() != 12 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(&hex, 16).ok()
}

pub fn assistant_agent_events(
    task: &AssistantTask,
    filter: &AgentEventFilter,
) -> Vec<AgentEventEntry> {
    let Some(report) = &task.last_report else {
        return Vec::new();
    };

    report
        .agent_runs
        .iter()
        .enumerate()
        .flat_map(|(run_index, run)| {
            run.events
                .iter()
                .enumerate()
                .map(move |(event_index, record)| AgentEventEntry {
                    task_id: task.id.clone(),
                    run_index: run_index + 1,
                    event_index: event_index + 1,
                    node_id: run.node_id,
                    operation: run.operation,
                    source: json_string(record, "source"),
                    event: json_string(record, "event"),
                    name: json_string(record, "name"),
                    elapsed_ms: json_u64(record, "elapsedMs"),
                    objective: json_string(record, "objective"),
                    record: record.clone(),
                })
        })
        .filter(|entry| agent_event_matches(entry, filter))
        .collect()
}

pub fn parse_node_operation(input: &str) -> Result<NodeOperation, Box<dyn std::error::Error>> {
    match input.trim().to_ascii_lowercase().as_str() {
        "specify" => Ok(NodeOperation::Specify),
        "plan" => Ok(NodeOperation::Plan),
        "execute" => Ok(NodeOperation::Execute),
        "combine" => Ok(NodeOperation::Combine),
        "verify" => Ok(NodeOperation::Verify),
        "commit" => Ok(NodeOperation::Commit),
        other => Err(format!("unknown operation '{other}'; expected one of: specify, plan, execute, combine, verify, commit").into()),
    }
}

fn agent_event_matches(entry: &AgentEventEntry, filter: &AgentEventFilter) -> bool {
    if filter
        .operation
        .is_some_and(|operation| entry.operation != operation)
    {
        return false;
    }
    if !optional_eq(filter.event.as_deref(), entry.event.as_deref()) {
        return false;
    }
    if !optional_eq(filter.tool.as_deref(), entry.name.as_deref()) {
        return false;
    }
    if !optional_eq(filter.source.as_deref(), entry.source.as_deref()) {
        return false;
    }
    if let Some(query) = &filter.query {
        let haystack = compact_json(&entry.record).to_lowercase();
        if !haystack.contains(&query.to_lowercase()) {
            return false;
        }
    }
    true
}

fn optional_eq(expected: Option<&str>, actual: Option<&str>) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    actual.is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "<invalid-json>".to_string())
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

fn json_u64(value: &Value, key: &str) -> Option<u64> {
    value.get(key)?.as_u64()
}

fn timeline_item(record: &TaskTimelineRecord) -> TaskTimelineItem {
    match record {
        TaskTimelineRecord::TaskEvent { event, .. } => task_event_timeline_item(event),
        TaskTimelineRecord::AgentEvent { ordinal, event, .. } => {
            agent_event_timeline_item(*ordinal, event)
        }
    }
}

fn task_event_timeline_item(event: &AssistantTaskEvent) -> TaskTimelineItem {
    TaskTimelineItem {
        id: format!("task:{}", event.seq),
        timestamp_ms: Some(event.timestamp_ms),
        category: task_event_category(&event.kind).to_string(),
        title: task_event_title(event).to_string(),
        detail: task_event_detail(event),
        status: task_event_status(&event.kind).to_string(),
        severity: task_event_severity(event).to_string(),
        source: event.source.clone(),
        duration_ms: json_u64(&event.payload, "duration_ms"),
        task_event_seq: Some(event.seq),
        agent_event_ordinal: None,
    }
}

fn agent_event_timeline_item(ordinal: usize, event: &AgentEventEntry) -> TaskTimelineItem {
    let title = match event.event.as_deref() {
        Some("tool_call_start") => "tool call started",
        Some("tool_call_end") => "tool call finished",
        Some("tool_call_error") => "tool call failed",
        Some("usage") => "usage recorded",
        Some("step") => "agent step",
        Some("result") => "agent result",
        Some("error") => "agent error",
        Some(other) => other,
        None => "agent event",
    };
    let mut detail_parts = vec![format!("{:?}", event.operation)];
    if let Some(name) = event.name.as_deref() {
        detail_parts.push(name.to_string());
    }
    if let Some(source) = event.source.as_deref() {
        detail_parts.push(format!("source={source}"));
    }
    if let Some(objective) = event.objective.as_deref() {
        detail_parts.push(objective.to_string());
    }
    let is_error = matches!(
        event.event.as_deref(),
        Some("error") | Some("tool_call_error")
    );
    TaskTimelineItem {
        id: format!("agent:{ordinal}"),
        timestamp_ms: None,
        category: "agent".to_string(),
        title: title.to_string(),
        detail: Some(detail_parts.join(" ")),
        status: if is_error { "failed" } else { "running" }.to_string(),
        severity: if is_error { "error" } else { "info" }.to_string(),
        source: event.source.clone().unwrap_or_else(|| "agent".to_string()),
        duration_ms: event.elapsed_ms,
        task_event_seq: None,
        agent_event_ordinal: Some(ordinal),
    }
}

fn task_event_category(kind: &str) -> &'static str {
    if kind.starts_with("task.") {
        return "task";
    }
    if kind.starts_with("engine.") {
        return "engine";
    }
    if kind.starts_with("agent.") {
        return "agent";
    }
    "event"
}

fn task_event_title(event: &AssistantTaskEvent) -> &str {
    match event.kind.as_str() {
        "task.created" => "task created",
        "task.queued" => "task queued",
        "task.started" => "task started",
        "task.completed" => "task completed",
        "task.failed" => "task failed",
        "task.cancel.requested" => "task cancel requested",
        "task.cancelled" => "task cancelled",
        "task.recovered" => "task recovered",
        "task.waiting_for_input" => "task waiting for input",
        "task.finished" => "task finished",
        "engine.completed" => "engine completed",
        "engine.failed" => "engine failed",
        "engine.operation" => "engine operation",
        "engine.branch.operation" => "branch operation",
        "agent.run.started" => "agent run started",
        "agent.run" => "agent run finished",
        "agent.run.event" => "agent run event",
        "agent.branch.run.started" => "branch agent run started",
        "agent.branch.run" => "branch agent run finished",
        "agent.branch.run.event" => "branch agent run event",
        _ => event.message.as_str(),
    }
}

fn task_event_status(kind: &str) -> &'static str {
    match kind {
        "task.completed" | "engine.completed" | "agent.run" | "agent.branch.run" => "completed",
        "task.failed" | "engine.failed" => "failed",
        "task.cancel.requested" | "task.cancelled" => "cancelled",
        "task.waiting_for_input" => "waiting",
        "task.queued" | "task.created" => "pending",
        "task.started" | "agent.run.started" | "agent.branch.run.started" => "running",
        _ => "info",
    }
}

fn task_event_severity(event: &AssistantTaskEvent) -> &'static str {
    if event.level.eq_ignore_ascii_case("ERROR") || task_event_status(&event.kind) == "failed" {
        "error"
    } else if event.level.eq_ignore_ascii_case("WARN") {
        "warning"
    } else {
        "info"
    }
}

fn task_event_detail(event: &AssistantTaskEvent) -> Option<String> {
    let payload = &event.payload;
    match event.kind.as_str() {
        "task.created" => {
            let client = json_string(payload, "client")?;
            let route = json_string(payload, "route")
                .or_else(|| json_string(payload, "source"))
                .unwrap_or_else(|| "unknown".to_string());
            Some(format!("client={client} route={route}"))
        }
        "task.queued" => Some(format!(
            "running={} queued={} max={}",
            json_u64(payload, "running_tasks").unwrap_or_default(),
            json_u64(payload, "queued_tasks").unwrap_or_default(),
            json_u64(payload, "max_parallel_tasks").unwrap_or_default()
        )),
        "task.completed" | "task.failed" | "task.waiting_for_input" | "task.finished" => {
            let mut parts = Vec::new();
            if let Some(status) = json_string(payload, "status") {
                parts.push(format!("status={status}"));
            }
            if let Some(duration_ms) = json_u64(payload, "duration_ms") {
                parts.push(format!("duration_ms={duration_ms}"));
            }
            if payload
                .get("artifact_available")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                parts.push("artifact_available=true".to_string());
            }
            if let Some(error) = json_string(payload, "error") {
                parts.push(format!("error={error}"));
            }
            (!parts.is_empty()).then(|| parts.join(" "))
        }
        "engine.completed" => Some(format!(
            "status={} agent_runs={} events={}",
            json_string(payload, "status").unwrap_or_else(|| "unknown".to_string()),
            json_u64(payload, "agent_run_count").unwrap_or_default(),
            json_u64(payload, "event_count").unwrap_or_default()
        )),
        "engine.failed" => json_string(payload, "error").map(|error| format!("error={error}")),
        "agent.run.started" | "agent.branch.run.started" => {
            let tools = payload
                .get("terminal_tools")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            Some(format!("operation={:?} tools={tools}", event.operation))
        }
        "agent.run" | "agent.branch.run" => {
            let tool = json_string(payload, "terminal_tool").unwrap_or_else(|| "-".to_string());
            let duration = json_u64(payload, "duration_ms")
                .map(|duration_ms| format!(" duration_ms={duration_ms}"))
                .unwrap_or_default();
            Some(format!("terminal_tool={tool}{duration}"))
        }
        _ if !event.message.is_empty() => Some(event.message.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AgentRunRecord, AssistantTaskEventRecord, EngineReport, MemoryTaskStore, NodeOperation,
        NodeStatus, TaskStore,
    };
    use serde_json::json;
    use tracing::Level;

    #[test]
    fn inspect_view_projects_task_events_to_ui_timeline_items() {
        let mut store = MemoryTaskStore::new();
        let task_id = store.create_task("show timeline".to_string());
        store.record_task_event(
            &task_id,
            AssistantTaskEventRecord {
                level: Level::INFO,
                kind: "task.created".to_string(),
                source: "assistant.session".to_string(),
                message: "created from direct task intake".to_string(),
                node_id: None,
                operation: None,
                payload: json!({
                    "source": "direct_intake",
                    "route": "direct_intake",
                    "client": "acp",
                }),
            },
        );
        store.record_task_event(
            &task_id,
            AssistantTaskEventRecord {
                level: Level::INFO,
                kind: "task.completed".to_string(),
                source: "task.board".to_string(),
                message: "task completed".to_string(),
                node_id: Some(1),
                operation: None,
                payload: json!({
                    "status": "Committed",
                    "duration_ms": 42,
                    "artifact_available": true,
                }),
            },
        );

        let task = store.get_task(&task_id).expect("task");
        let view = inspect_task_view(task, TaskEventCursor::default());

        assert_eq!(view.timeline.len(), 2);
        assert_eq!(view.timeline[0].title, "task created");
        assert_eq!(view.timeline[0].category, "task");
        assert_eq!(view.timeline[0].status, "pending");
        assert_eq!(
            view.timeline[0].detail.as_deref(),
            Some("client=acp route=direct_intake")
        );
        assert_eq!(view.timeline[1].title, "task completed");
        assert_eq!(view.timeline[1].status, "completed");
        assert_eq!(view.timeline[1].duration_ms, Some(42));
    }

    #[test]
    fn inspect_view_keeps_raw_events_and_timeline_cursor_aligned() {
        let mut store = MemoryTaskStore::new();
        let task_id = store.create_task("cursor timeline".to_string());
        for kind in ["task.created", "task.queued", "task.started"] {
            store.record_task_event(
                &task_id,
                AssistantTaskEventRecord {
                    level: Level::INFO,
                    kind: kind.to_string(),
                    source: "task.board".to_string(),
                    message: kind.to_string(),
                    node_id: None,
                    operation: None,
                    payload: serde_json::Value::Null,
                },
            );
        }

        let task = store.get_task(&task_id).expect("task");
        let view = inspect_task_view(
            task,
            TaskEventCursor {
                task_seq: 1,
                agent_event_ordinal: 0,
            },
        );

        assert_eq!(view.events.len(), 2);
        assert_eq!(view.timeline.len(), 2);
        assert_eq!(view.timeline[0].task_event_seq, Some(2));
        assert_eq!(view.cursor.task_seq, 3);
    }

    #[test]
    fn timeline_avoids_duplicate_report_agent_events_when_durable_events_exist() {
        let mut store = MemoryTaskStore::new();
        let task_id = store.create_task("dedupe agent events".to_string());
        store.record_task_event(
            &task_id,
            AssistantTaskEventRecord {
                level: Level::INFO,
                kind: "agent.run.event".to_string(),
                source: "agent".to_string(),
                message: "tool_call_start".to_string(),
                node_id: Some(1),
                operation: Some(NodeOperation::Execute),
                payload: json!({
                    "node_id": 1,
                    "operation": "Execute",
                    "event": { "event": "tool_call_start", "name": "Read" },
                }),
            },
        );
        store.apply_task_report(
            &task_id,
            1,
            EngineReport {
                root: 1,
                status: NodeStatus::Committed,
                artifact: None,
                artifact_text: None,
                events: Vec::new(),
                agent_runs: vec![AgentRunRecord {
                    node_id: 1,
                    operation: NodeOperation::Execute,
                    report: "done".to_string(),
                    terminal_tool: Some("submit_work".to_string()),
                    terminal_payload: None,
                    duration_ms: 10,
                    usage: None,
                    events: vec![json!({
                        "event": "tool_call_start",
                        "name": "Read",
                    })],
                }],
            },
        );

        let task = store.get_task(&task_id).expect("task");
        let view = inspect_task_view(task, TaskEventCursor::default());

        assert!(
            view.events
                .iter()
                .any(|record| matches!(record, TaskTimelineRecord::AgentEvent { .. }))
        );
        assert_eq!(view.timeline.len(), 1);
        assert_eq!(view.timeline[0].task_event_seq, Some(1));
        assert_eq!(view.timeline[0].agent_event_ordinal, None);
    }
}
