use std::collections::BTreeSet;
use std::io::{self, Write};
use std::path::PathBuf;
use std::time::Duration;

use super::util;
use crate::{
    AssistantTask, AssistantTaskEvent, AssistantTaskStatus, DebugConfig, FileTaskStore,
    NodeOperation, TaskStore,
};
use clap::Subcommand;
use serde::Serialize;
use serde_json::{Value, json};

// ── TaskCommand ──────────────────────────────────────────────────────────

#[derive(Debug, Subcommand)]
pub enum TaskCommand {
    /// List persisted assistant tasks.
    List {
        /// Maximum number of tasks to display.
        #[arg(long, default_value_t = 20)]
        limit: usize,

        /// Print structured JSON output.
        #[arg(long)]
        json: bool,
    },
    /// Show one persisted assistant task summary and final result.
    Show {
        /// Task id to inspect.
        task_id: String,

        /// Print the full structured task JSON.
        #[arg(long)]
        json: bool,
    },
    /// Print persisted task lifecycle logs.
    Logs {
        /// Task id to inspect.
        task_id: String,

        /// Print the raw structured lifecycle event JSON.
        #[arg(long)]
        json: bool,

        /// Print the full persisted task record, including engine report and agent-loop events.
        #[arg(long)]
        full: bool,
    },
    /// Query persisted agent-run events for a task.
    Events {
        /// Task id to inspect.
        task_id: String,

        /// Filter by task-run operation, such as Specify, Execute, Verify, or Combine.
        #[arg(long)]
        operation: Option<String>,

        /// Filter by event kind, such as tool_call_start, usage, error, or step.
        #[arg(long)]
        event: Option<String>,

        /// Filter by tool/event name, such as Read, Grep, WebFetch, or submit_work.
        #[arg(long)]
        tool: Option<String>,

        /// Filter by event source, such as agent-loop.
        #[arg(long)]
        source: Option<String>,

        /// Case-insensitive substring search over the event JSON.
        #[arg(long)]
        query: Option<String>,

        /// Print matching events as structured JSON.
        #[arg(long)]
        json: bool,
    },
    /// Replay existing task events, then follow live updates until terminal status.
    Inspect {
        /// Task id to inspect.
        task_id: String,

        /// Poll interval in milliseconds.
        #[arg(long, default_value_t = 1_000)]
        interval_ms: u64,

        /// Print newline-delimited structured JSON records.
        #[arg(long)]
        json: bool,
    },
}

// ── Public entry point ───────────────────────────────────────────────────

pub fn run_task_command(command: TaskCommand) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        TaskCommand::List { limit, json } => print_task_list(limit, json),
        TaskCommand::Show { task_id, json } => print_task_show(&task_id, json),
        TaskCommand::Logs {
            task_id,
            json,
            full,
        } => print_assistant_logs(&task_id, json, full),
        TaskCommand::Events {
            task_id,
            operation,
            event,
            tool,
            source,
            query,
            json,
        } => print_assistant_events(
            &task_id,
            AgentEventFilter::try_new(operation, event, tool, source, query),
            json,
        ),
        TaskCommand::Inspect {
            task_id,
            interval_ms,
            json,
        } => inspect_task_stream(&task_id, interval_ms, json),
    }
}

// ── Log command (shows recent task execution records) ────────────────────

pub fn print_task_logs(limit: usize, json_output: bool) -> Result<(), Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(assistant_store_path(&debug))?;
    let mut tasks = store.list_tasks();
    sort_tasks_newest_first(&mut tasks);
    tasks.truncate(limit);

    if json_output {
        serde_json::to_writer_pretty(std::io::stdout(), &tasks)?;
        println!();
        return Ok(());
    }

    if tasks.is_empty() {
        println!("No task execution records found.");
        return Ok(());
    }

    println!("Recent task execution records (last {}):", limit);
    println!("{:-<80}", "");
    for task in &tasks {
        let id_prefix = task_list_id(&task.id);
        let first_line = task.request.lines().next().unwrap_or("").to_string();
        println!("{}  {:?}  {}", id_prefix, task.status, first_line);
    }
    println!("{:-<80}", "");
    println!("Total: {} tasks", tasks.len());
    Ok(())
}

// ── Task display helpers ─────────────────────────────────────────────────

fn print_task_list(limit: usize, json_output: bool) -> Result<(), Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(assistant_store_path(&debug))?;
    let mut tasks = store.list_tasks();
    sort_tasks_newest_first(&mut tasks);
    tasks.truncate(limit);

    if json_output {
        serde_json::to_writer_pretty(std::io::stdout(), &tasks)?;
        println!();
        return Ok(());
    }

    if tasks.is_empty() {
        println!("No task records found.");
        return Ok(());
    }

    println!("Tasks (newest first):");
    println!("{:-<80}", "");
    for task in &tasks {
        let id_prefix = task_list_id(&task.id);
        let first_line = task.request.lines().next().unwrap_or("").to_string();
        println!("{}  {:?}  {}", id_prefix, task.status, first_line);
    }
    println!("{:-<80}", "");
    println!("Showing {} tasks", tasks.len());
    Ok(())
}

fn print_task_show(task_id: &str, json_output: bool) -> Result<(), Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(assistant_store_path(&debug))?;
    let task = resolve_task_ref(&store, task_id)?;

    if json_output {
        serde_json::to_writer_pretty(std::io::stdout(), task)?;
        println!();
        return Ok(());
    }

    println!("task: {}", task.id);
    println!("title: {}", task.title);
    println!("status: {:?}", task.status);
    if let Some(root_node) = task.root_node {
        println!("root: {root_node}");
    }
    println!("events: {}", task.events.len());
    if let Some(report) = &task.last_report {
        println!("agent runs: {}", report.agent_runs.len());
        if let Some(artifact_text) = report.artifact_text.as_deref() {
            println!(
                "{}",
                console::style("── Result ─────────────────────────────────────────").dim()
            );
            println!("{artifact_text}");
        } else {
            println!("result: <none>");
        }
    } else {
        println!("result: <not available yet>");
    }
    Ok(())
}

// ── Event display (shared with assistant command) ────────────────────────

pub fn print_assistant_events(
    task_id: &str,
    filter: Result<AgentEventFilter, Box<dyn std::error::Error>>,
    json_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let filter = filter?;
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(assistant_store_path(&debug))?;
    let task = resolve_task_ref(&store, task_id)?;
    let entries = assistant_agent_events(task, &filter);

    if json_output {
        serde_json::to_writer_pretty(std::io::stdout(), &entries)?;
        println!();
        return Ok(());
    }

    println!(
        "task {} {} {:?} events={}",
        task.id,
        task.title,
        task.status,
        entries.len()
    );
    for entry in entries {
        println!("{}", util::format_agent_event(&entry));
    }
    Ok(())
}

// ── Task log display (shared with assistant command) ─────────────────────

pub fn print_assistant_logs(
    task_id: &str,
    json_output: bool,
    full_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(assistant_store_path(&debug))?;
    let task = resolve_task_ref(&store, task_id)?;

    if full_output {
        serde_json::to_writer_pretty(std::io::stdout(), task)?;
        println!();
        return Ok(());
    }

    if json_output {
        serde_json::to_writer_pretty(std::io::stdout(), &task.events)?;
        println!();
        return Ok(());
    }

    println!("task {} {} {:?}", task.id, task.title, task.status);
    for event in &task.events {
        println!("{}", format_task_log(event));
    }
    Ok(())
}

// ── Inspect / live-stream ────────────────────────────────────────────────

fn inspect_task_stream(
    task_id: &str,
    interval_ms: u64,
    json_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    let path = assistant_store_path(&debug);
    let interval = Duration::from_millis(interval_ms.max(100));
    let mut printed_task_events = BTreeSet::new();
    let mut printed_agent_events = BTreeSet::new();
    let mut last_status = None;
    let mut printed_result = false;
    let mut first_poll = true;

    loop {
        let store = FileTaskStore::open(&path)?;
        let task = resolve_task_ref(&store, task_id)?;

        if first_poll && !json_output {
            println!(
                "{}",
                console::style("── History ────────────────────────────────────────").dim()
            );
        }

        if last_status.as_ref() != Some(&task.status) {
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string(&json!({
                        "type": "task_status",
                        "task_id": task.id,
                        "status": &task.status,
                    }))?
                );
            } else {
                println!("task {} {:?}", task.id, task.status);
            }
            last_status = Some(task.status.clone());
        }

        for event in &task.events {
            if printed_task_events.insert(event.seq) {
                if json_output {
                    println!(
                        "{}",
                        serde_json::to_string(&json!({
                            "type": "task_event",
                            "task_id": task.id,
                            "event": event,
                        }))?
                    );
                } else {
                    println!("{}", format_task_log(event));
                }
            }
        }

        for entry in assistant_agent_events(task, &AgentEventFilter::default()) {
            let key = (entry.run_index, entry.event_index);
            if printed_agent_events.insert(key) {
                if json_output {
                    println!(
                        "{}",
                        serde_json::to_string(&json!({
                            "type": "agent_event",
                            "task_id": task.id,
                            "event": entry,
                        }))?
                    );
                } else {
                    println!("{}", util::format_agent_event(&entry));
                }
            }
        }

        if !printed_result
            && let Some(artifact_text) = task
                .last_report
                .as_ref()
                .and_then(|report| report.artifact_text.as_deref())
        {
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string(&json!({
                        "type": "task_result",
                        "task_id": task.id,
                        "artifact_text": artifact_text,
                    }))?
                );
            } else {
                println!(
                    "{}",
                    console::style("── Result ─────────────────────────────────────────").dim()
                );
                println!("{artifact_text}");
            }
            printed_result = true;
        }
        io::stdout().flush().ok();

        if !task_is_active(&task.status) {
            return Ok(());
        }

        if first_poll && !json_output {
            println!(
                "{}",
                console::style(format!(
                    "── Live (polling every {}ms) ───────────────────────",
                    interval.as_millis()
                ))
                .dim()
            );
        }
        first_poll = false;
        std::thread::sleep(interval);
    }
}

// ── Task ref resolution helpers ──────────────────────────────────────────

pub fn resolve_task_ref<'a>(
    store: &'a FileTaskStore,
    task_ref: &str,
) -> Result<&'a AssistantTask, Box<dyn std::error::Error>> {
    if let Some(task) = store.get_task(task_ref) {
        return Ok(task);
    }

    let matches = store
        .list_tasks()
        .into_iter()
        .filter(|task| task.id.starts_with(task_ref))
        .collect::<Vec<_>>();

    match matches.len() {
        0 => Err(format!("unknown task id {task_ref}").into()),
        1 => {
            let id = matches[0].id.clone();
            store
                .get_task(&id)
                .ok_or_else(|| format!("unknown task id {task_ref}").into())
        }
        _ => {
            let ids = matches
                .iter()
                .map(|task| task.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Err(format!("ambiguous task id prefix {task_ref}; matches: {ids}").into())
        }
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

// ── Status helpers ───────────────────────────────────────────────────────

fn task_is_active(status: &AssistantTaskStatus) -> bool {
    matches!(
        status,
        AssistantTaskStatus::Created | AssistantTaskStatus::Queued | AssistantTaskStatus::Running
    )
}

pub fn assistant_store_path(debug: &DebugConfig) -> PathBuf {
    debug.data_dir().join("assistant").join("tasks.json")
}

// ── Formatting ───────────────────────────────────────────────────────────

pub fn format_task_log(event: &AssistantTaskEvent) -> String {
    let node = event
        .node_id
        .map(|id| format!(" node={id}"))
        .unwrap_or_default();
    let operation = event
        .operation
        .map(|operation| format!(" op={operation:?}"))
        .unwrap_or_default();
    let payload = if event.payload.is_null() {
        String::new()
    } else {
        format!(" payload={}", util::compact_json(&event.payload))
    };
    format!(
        "#{:04} {} {} {} source={}{}{} - {}{}",
        event.seq,
        event.timestamp_ms,
        event.level,
        event.kind,
        event.source,
        node,
        operation,
        event.message,
        payload
    )
}

pub fn compact_json(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "<invalid-json>".to_string())
}

pub fn truncate_text(input: &str, max_chars: usize) -> String {
    let mut chars = input.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

// ── Agent event filtering ───────────────────────────────────────────────

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
}

#[derive(Debug, Clone, Serialize)]
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
                    source: util::json_string(record, "source"),
                    event: util::json_string(record, "event"),
                    name: util::json_string(record, "name"),
                    elapsed_ms: util::json_u64(record, "elapsedMs"),
                    objective: util::json_string(record, "objective"),
                    record: record.clone(),
                })
        })
        .filter(|entry| util::agent_event_matches(entry, filter))
        .collect()
}
pub fn optional_eq(expected: Option<&str>, actual: Option<&str>) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    actual.is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
}

pub fn format_agent_event(entry: &AgentEventEntry) -> String {
    let source = entry.source.as_deref().unwrap_or("-");
    let event = entry.event.as_deref().unwrap_or("-");
    let name = entry.name.as_deref().unwrap_or("-");
    let objective = entry.objective.as_deref().unwrap_or("-");
    let elapsed = entry
        .elapsed_ms
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".to_string());
    let record = truncate_text(&compact_json(&entry.record), 500);
    format!(
        "run={} event={} node={} op={:?} source={} kind={} name={} elapsed={}ms objective={} record={}",
        entry.run_index,
        entry.event_index,
        entry.node_id,
        entry.operation,
        source,
        event,
        name,
        elapsed,
        objective,
        record
    )
}pub fn parse_node_operation(input: &str) -> Result<NodeOperation, Box<dyn std::error::Error>> {
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
