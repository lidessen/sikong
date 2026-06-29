use std::collections::BTreeSet;
use std::io::{self, Write};
use std::path::PathBuf;
use std::time::Duration;

use super::util;
use crate::{AssistantTaskEvent, AssistantTaskStatus, DebugConfig, FileTaskStore, TaskStore};
use clap::Subcommand;
use serde_json::json;

pub use crate::task_board::view::{
    AgentEventEntry, AgentEventFilter, assistant_agent_events, legacy_uuid_v7_timestamp_ms,
    parse_node_operation, resolve_task_ref, sort_tasks_newest_first, task_list_id,
};

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

        /// Replay the current task history once and exit without following live updates.
        #[arg(long)]
        no_follow: bool,

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
            no_follow,
            json,
        } => inspect_task_stream(&task_id, interval_ms, no_follow, json),
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
        serde_json::to_writer_pretty(std::io::stdout(), &task)?;
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
    let entries = assistant_agent_events(&task, &filter);
    let include_task_events = filter.is_empty();

    if json_output {
        if include_task_events {
            let task_events = task.events.iter().map(|event| {
                json!({
                    "type": "task_event",
                    "task_id": task.id,
                    "event": event,
                })
            });
            let agent_events = entries.iter().map(|entry| {
                json!({
                    "type": "agent_event",
                    "task_id": task.id,
                    "event": entry,
                })
            });
            let combined = task_events.chain(agent_events).collect::<Vec<_>>();
            serde_json::to_writer_pretty(std::io::stdout(), &combined)?;
        } else {
            serde_json::to_writer_pretty(std::io::stdout(), &entries)?;
        }
        println!();
        return Ok(());
    }

    let task_event_count = if include_task_events {
        task.events.len()
    } else {
        0
    };
    println!(
        "task {} {} {:?} events={}",
        task.id,
        task.title,
        task.status,
        task_event_count + entries.len()
    );
    if include_task_events {
        for event in &task.events {
            println!("{}", format_task_log(event));
        }
    }
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
        serde_json::to_writer_pretty(std::io::stdout(), &task)?;
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
    no_follow: bool,
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

        for entry in assistant_agent_events(&task, &AgentEventFilter::default()) {
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
        if no_follow {
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
}
