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

    TaskInspectView {
        task: task.clone(),
        events: records,
        artifact: task_artifact(task),
        cursor: TaskEventCursor {
            task_seq: task.events.iter().map(|event| event.seq).max().unwrap_or(0),
            agent_event_ordinal: agent_entries.len(),
        },
    }
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
