use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::{
    AgentTokenUsage, CapabilityProfile, DebugConfig, NodeOperation, NodeStatus, NodeTemplate,
    PlanGroup, PlanGroupMode, ProblemKey, ProblemNode, SikoConfig, TaskType, WorkSize,
    WorkspaceRequirement, WorkspaceSurface,
};
use clap::{CommandFactory, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::error;
use tracing_subscriber::EnvFilter;

pub mod launch;
pub mod metrics;
pub mod setup;
pub mod task;
pub use task::TaskCommand;
pub mod assistant;
pub use assistant::AssistantCommand;
pub use assistant::AssistantPromptOutput;
pub use assistant::AssistantPromptWorkspace;
pub mod chrono;
pub mod eval;
pub use eval::EvalCommand;

pub use launch::AgentHostLaunch;

/// Consistent JSON output format for all commands.
/// Wraps command output in a uniform structure with machine-readable keys.
#[derive(Debug, Serialize)]
struct CliOutput {
    status: String,
    data: Option<serde_json::Value>,
    error: Option<String>,
}

impl CliOutput {
    fn ok(data: serde_json::Value) -> Self {
        Self {
            status: "ok".to_string(),
            data: Some(data),
            error: None,
        }
    }
    fn error(msg: impl Into<String>) -> Self {
        Self {
            status: "error".to_string(),
            data: None,
            error: Some(msg.into()),
        }
    }
}

fn print_json_output(output: &CliOutput) {
    serde_json::to_writer_pretty(std::io::stdout(), output).ok();
    println!();
}

fn print_json_data(data: serde_json::Value) {
    print_json_output(&CliOutput::ok(data));
}

fn print_json_error(msg: impl Into<String>) {
    print_json_output(&CliOutput::error(msg));
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

pub fn run(args: impl IntoIterator<Item = String>) -> i32 {
    init_tracing();

    // Pre-process args to intercept --help/--version with --json before clap handles them
    let args_vec: Vec<String> = args.into_iter().collect();
    let has_json = args_vec.iter().any(|a| a == "--json");
    if has_json {
        if args_vec.iter().any(|a| a == "--version" || a == "-V") {
            let version = concat!(
                env!("SIKO_BUILD_VERSION"),
                " (",
                env!("CARGO_PKG_NAME"),
                ")"
            )
            .to_string();
            print_json_data(serde_json::json!({"version": version}));
            return 0;
        }
        if args_vec.iter().any(|a| a == "--help" || a == "-h") {
            let help_text = Cli::command().render_help().to_string();
            print_json_data(serde_json::json!({"help": help_text}));
            return 0;
        }
    }

    match Cli::try_parse_from(std::iter::once("siko".to_string()).chain(args_vec)) {
        Ok(cli) => run_cli(cli),
        Err(error) => {
            let _ = error.print();
            error.exit_code()
        }
    }
}

fn require_dev() -> Result<(), ()> {
    if std::env::var("SIKONG_DEV").as_deref() == Ok("1") {
        Ok(())
    } else {
        Err(())
    }
}

fn run_cli(cli: Cli) -> i32 {
    // Load config and apply env overrides
    if let Ok(config) = SikoConfig::load() {
        config.apply_env();
    }

    match cli.command {
        Some(Command::Assistant {
            acp: false,
            command: Some(AssistantCommand::List { json }),
        }) => match assistant::print_assistant_list(json) {
            Ok(()) => 0,
            Err(error) => {
                error!(%error, "failed to list assistant tasks");
                eprintln!("failed to list assistant tasks: {error}");
                1
            }
        },
        Some(Command::Assistant {
            acp: true,
            command: None,
        }) => match assistant::run_assistant_acp() {
            Ok(()) => 0,
            Err(error) => {
                error!(%error, "failed to run assistant ACP server");
                1
            }
        },
        Some(Command::Assistant {
            acp: false,
            command:
                Some(AssistantCommand::Prompt {
                    message,
                    wait_ms,
                    workspace,
                    allow_write,
                    write_scope,
                    json,
                }),
        }) => {
            match assistant::run_assistant_prompt(
                message,
                wait_ms,
                workspace,
                allow_write,
                write_scope,
                json,
            ) {
                Ok(()) => 0,
                Err(error) => {
                    error!(%error, "failed to run assistant prompt");
                    eprintln!("failed to run assistant prompt: {error}");
                    1
                }
            }
        }
        Some(Command::Assistant {
            acp: false,
            command:
                Some(AssistantCommand::Logs {
                    task_id,
                    json,
                    full,
                }),
        }) => match assistant::print_assistant_logs(&task_id, json, full) {
            Ok(()) => 0,
            Err(error) => {
                error!(%error, task_id, "failed to print assistant logs");
                eprintln!("failed to print assistant logs for {task_id}: {error}");
                1
            }
        },
        Some(Command::Assistant {
            acp: false,
            command:
                Some(AssistantCommand::Events {
                    task_id,
                    operation,
                    event,
                    tool,
                    source,
                    query,
                    json,
                }),
        }) => match task::print_assistant_events(
            &task_id,
            task::AgentEventFilter::try_new(operation, event, tool, source, query),
            json,
        ) {
            Ok(()) => 0,
            Err(error) => {
                error!(%error, task_id, "failed to print assistant events");
                eprintln!("failed to print assistant events for {task_id}: {error}");
                1
            }
        },
        Some(Command::Assistant {
            acp: true,
            command: Some(_),
        }) => {
            eprintln!("--acp cannot be combined with assistant subcommands");
            2
        }
        Some(Command::Assistant {
            acp: false,
            command: None,
        })
        | None => {
            eprintln!("{}", Cli::command().render_help());
            0
        }
        Some(Command::Eval { command }) => {
            if require_dev().is_err() {
                eprintln!("error: eval is an internal command. Set SIKONG_DEV=1 to enable.");
                return 1;
            }
            match command {
                EvalCommand::TaskRunSplit {
                    task,
                    scenario,
                    scenario_file,
                    artifact_dir,
                    route_only,
                    json,
                } => match eval::run_task_run_split_eval(
                    task,
                    scenario,
                    scenario_file,
                    artifact_dir,
                    route_only,
                    json,
                ) {
                    Ok(passed) => {
                        if passed {
                            0
                        } else {
                            1
                        }
                    }
                    Err(error) => {
                        error!(%error, "failed to run eval");
                        eprintln!("failed to run eval: {error}");
                        1
                    }
                },
                EvalCommand::TaskRunOperation {
                    operation,
                    scenario,
                    json,
                } => match eval::run_task_run_operation_eval(operation, scenario, json) {
                    Ok(passed) => {
                        if passed {
                            0
                        } else {
                            1
                        }
                    }
                    Err(error) => {
                        error!(%error, "failed to run eval");
                        eprintln!("failed to run eval: {error}");
                        1
                    }
                },
            }
        }
        Some(Command::Send {
            task,
            wait_ms,
            json,
            allow_write,
            write_scope,
        }) => {
            if task.is_empty() {
                eprintln!("error: task description is required");
                return 1;
            }
            let effective_scope = if allow_write && !write_scope.is_empty() {
                write_scope
            } else if allow_write {
                vec!["**/*".to_string()]
            } else {
                Vec::new()
            };
            match assistant::run_assistant_prompt(
                task,
                wait_ms,
                AssistantPromptWorkspace::CurrentFileSystem,
                allow_write,
                effective_scope,
                json,
            ) {
                Ok(()) => 0,
                Err(error) => {
                    error!(%error, "failed to send task");
                    eprintln!("failed to send task: {error}");
                    1
                }
            }
        }
        Some(Command::Task { command }) => match task::run_task_command(command) {
            Ok(()) => 0,
            Err(error) => {
                error!(%error, "failed to run task command");
                eprintln!("failed to run task command: {error}");
                1
            }
        },
        Some(Command::Setup { json }) => match setup::run_setup(json) {
            Ok(()) => 0,
            Err(error) => {
                if json {
                    print_json_error(format!("setup failed: {error}"));
                } else {
                    eprintln!("setup failed: {error}");
                }
                1
            }
        },
        Some(Command::Metrics { json }) => {
            metrics::run_metrics_command(json);
            0
        }
        Some(Command::Log { limit, json }) => match task::print_task_logs(limit, json) {
            Ok(()) => 0,
            Err(error) => {
                error!(%error, "failed to show task logs");
                eprintln!("failed to show task logs: {error}");
                1
            }
        },
    }
}

#[derive(Debug, Parser)]
#[command(name = "siko")]
#[command(about = "Recursive agent engine prototype")]
#[command(version = concat!(
    env!("SIKO_BUILD_VERSION"),
    " (",
    env!("CARGO_PKG_NAME"),
    ")"
))]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the assistant entrypoint.
    Assistant {
        #[command(subcommand)]
        command: Option<AssistantCommand>,

        /// Serve the Assistant Agent over ACP JSON-RPC stdio.
        #[arg(long)]
        acp: bool,
    },
    /// Send a task through the assistant. This is the primary user-facing command.
    /// Use the assistant layer to understand requests, create tasks, and return results.
    Send {
        /// Task description. Example: "analyze this project", "fix the bug in src/main.rs"
        #[arg(required = true, trailing_var_arg = true)]
        task: Vec<String>,

        /// Wait time in milliseconds for agent response timeout (default 30000 = 30 sec).
        #[arg(long, default_value_t = 30_000)]
        wait_ms: u64,

        /// Print structured JSON output.
        #[arg(long)]
        json: bool,

        /// Allow the agent to modify files in the workspace (default: true).
        /// Set --no-allow-write to make the agent read-only.
        #[arg(long, default_value_t = true)]
        allow_write: bool,

        /// Coarse writable glob when --allow-write is set. Repeatable for multiple paths.
        /// Defaults to **/* (entire workspace) when --allow-write is set without this flag.
        #[arg(long = "write-scope")]
        write_scope: Vec<String>,
    },
    /// Inspect assistant task records.
    Task {
        #[command(subcommand)]
        command: TaskCommand,
    },
    /// Run evaluation scenarios (internal).
    #[command(hide = true)]
    Eval {
        #[command(subcommand)]
        command: EvalCommand,
    },
    /// Interactive first-time setup: configure provider, backend, and API keys.
    Setup {
        /// Print structured JSON output.
        #[arg(long)]
        json: bool,
    },
    /// Collect and display current metrics snapshot.
    Metrics {
        /// Print structured JSON output.
        #[arg(long)]
        json: bool,
    },
    /// Show recent task execution records from the task store.
    Log {
        /// Maximum number of recent tasks to display.
        #[arg(long, default_value_t = 10)]
        limit: usize,

        /// Print structured JSON output.
        #[arg(long)]
        json: bool,
    },
}

mod tests {
    use super::assistant;
    use super::eval;
    use super::task;
    use super::*;
    use crate::{AgentRunRecord, AssistantTask, AssistantTaskEvent, EngineReport, FileTaskStore};

    fn test_debug_config() -> DebugConfig {
        DebugConfig::default()
    }

    #[test]
    fn parses_assistant_acp_command() {
        let cli = Cli::try_parse_from(["siko", "assistant", "--acp"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Assistant {
                acp: true,
                command: None
            })
        ));
    }

    #[test]
    fn parses_assistant_logs_command() {
        let cli = Cli::try_parse_from(["siko", "assistant", "logs", "task_1", "--json"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Assistant {
                acp: false,
                command: Some(AssistantCommand::Logs {
                    task_id,
                    json: true,
                    full: false,
                })
            }) if task_id == "task_1"
        ));
    }

    #[test]
    fn parses_assistant_logs_full_command() {
        let cli = Cli::try_parse_from(["siko", "assistant", "logs", "task_1", "--full"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Assistant {
                acp: false,
                command: Some(AssistantCommand::Logs {
                    task_id,
                    json: false,
                    full: true,
                })
            }) if task_id == "task_1"
        ));
    }

    #[test]
    fn parses_assistant_events_command() {
        let cli = Cli::try_parse_from([
            "siko",
            "assistant",
            "events",
            "task_1",
            "--operation",
            "execute",
            "--event",
            "tool_call_start",
            "--tool",
            "Read",
            "--source",
            "agent-loop",
            "--query",
            "src/cli.rs",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Assistant {
                acp: false,
                command: Some(AssistantCommand::Events {
                    task_id,
                    operation: Some(operation),
                    event: Some(event),
                    tool: Some(tool),
                    source: Some(source),
                    query: Some(query),
                    json: true,
                })
            }) if task_id == "task_1"
                && operation == "execute"
                && event == "tool_call_start"
                && tool == "Read"
                && source == "agent-loop"
                && query == "src/cli.rs"
        ));
    }

    #[test]
    fn parses_task_list_command() {
        let cli = Cli::try_parse_from(["siko", "task", "list", "--limit", "5", "--json"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Task {
                command: TaskCommand::List {
                    limit: 5,
                    json: true
                }
            })
        ));
    }

    #[test]
    fn parses_task_show_command() {
        let cli = Cli::try_parse_from(["siko", "task", "show", "task_1", "--json"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Task {
                command: TaskCommand::Show {
                    task_id,
                    json: true
                }
            }) if task_id == "task_1"
        ));
    }

    #[test]
    fn parses_task_events_command() {
        let cli = Cli::try_parse_from([
            "siko",
            "task",
            "events",
            "task_1",
            "--operation",
            "execute",
            "--event",
            "tool_call_start",
            "--tool",
            "Read",
            "--source",
            "agent-loop",
            "--query",
            "src/cli.rs",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Task {
                command: TaskCommand::Events {
                    task_id,
                    operation: Some(operation),
                    event: Some(event),
                    tool: Some(tool),
                    source: Some(source),
                    query: Some(query),
                    json: true,
                }
            }) if task_id == "task_1"
                && operation == "execute"
                && event == "tool_call_start"
                && tool == "Read"
                && source == "agent-loop"
                && query == "src/cli.rs"
        ));
    }

    #[test]
    fn parses_task_inspect_command() {
        let cli = Cli::try_parse_from([
            "siko",
            "task",
            "inspect",
            "task_1",
            "--interval-ms",
            "250",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Task {
                command: TaskCommand::Inspect {
                    task_id,
                    interval_ms: 250,
                    json: true
                }
            }) if task_id == "task_1"
        ));
    }

    #[test]
    fn resolve_task_ref_accepts_unique_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("tasks.json");
        fs::write(
            &path,
            r#"{
  "tasks": {
    "019ef7bf-1b03-7000-8000-000000000001": {
      "id": "019ef7bf-1b03-7000-8000-000000000001",
      "title": "one",
      "request": "one",
      "status": "Running",
      "root_node": null,
      "last_report": null,
      "events": []
    },
    "019ef7c0-2222-7000-8000-000000000002": {
      "id": "019ef7c0-2222-7000-8000-000000000002",
      "title": "two",
      "request": "two",
      "status": "Completed",
      "root_node": null,
      "last_report": null,
      "events": []
    }
  }
}"#,
        )
        .unwrap();
        let store = FileTaskStore::open(path).unwrap();

        let task = task::resolve_task_ref(&store, "019ef7bf-1b0").unwrap();

        assert_eq!(task.id, "019ef7bf-1b03-7000-8000-000000000001");
    }

    #[test]
    fn resolve_task_ref_rejects_ambiguous_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("tasks.json");
        fs::write(
            &path,
            r#"{
  "tasks": {
    "019ef7bf-1b03-7000-8000-000000000001": {
      "id": "019ef7bf-1b03-7000-8000-000000000001",
      "title": "one",
      "request": "one",
      "status": "Running",
      "root_node": null,
      "last_report": null,
      "events": []
    },
    "019ef7bf-1b04-7000-8000-000000000002": {
      "id": "019ef7bf-1b04-7000-8000-000000000002",
      "title": "two",
      "request": "two",
      "status": "Completed",
      "root_node": null,
      "last_report": null,
      "events": []
    }
  }
}"#,
        )
        .unwrap();
        let store = FileTaskStore::open(path).unwrap();

        let error = task::resolve_task_ref(&store, "019ef7bf-1b0").unwrap_err();

        assert!(error.to_string().contains("ambiguous task id prefix"));
    }

    #[test]
    fn task_list_id_preserves_short_ids() {
        assert_eq!(task::task_list_id("mjo8xq4ab-Cd3_"), "mjo8xq4ab-Cd3_");
    }

    #[test]
    fn task_list_id_truncates_legacy_uuid_ids() {
        assert_eq!(
            task::task_list_id("019ef7bf-1b03-7ec2-be4d-f200fb793694"),
            "019ef7bf-1b0"
        );
    }

    #[test]
    fn sort_tasks_newest_first_uses_created_at_not_id() {
        let mut older = AssistantTask::new("zzzzzzzz".to_string(), "older".to_string());
        older.created_at_ms = 10;
        let mut newer = AssistantTask::new("aaaaaaaa".to_string(), "newer".to_string());
        newer.created_at_ms = 20;
        let mut tasks = vec![older, newer];

        task::sort_tasks_newest_first(&mut tasks);

        assert_eq!(tasks[0].id, "aaaaaaaa");
        assert_eq!(tasks[1].id, "zzzzzzzz");
    }

    #[test]
    fn legacy_uuid_v7_timestamp_ms_reads_time_prefix() {
        assert_eq!(
            task::legacy_uuid_v7_timestamp_ms("019ef7bf-1b03-7ec2-be4d-f200fb793694"),
            u64::from_str_radix("019ef7bf1b03", 16).ok()
        );
        assert_eq!(task::legacy_uuid_v7_timestamp_ms("short-id"), None);
    }

    #[test]
    fn assistant_agent_events_filters_persisted_run_events() {
        let mut task = AssistantTask::new("task_1".to_string(), "inspect logs".to_string());
        task.apply_report(
            1,
            EngineReport {
                root: 1,
                status: NodeStatus::Committed,
                artifact: None,
                artifact_text: None,
                events: Vec::new(),
                agent_runs: vec![
                    AgentRunRecord {
                        node_id: 1,
                        operation: NodeOperation::Specify,
                        report: "specified".to_string(),
                        terminal_tool: Some("submit_specification".to_string()),
                        terminal_payload: None,
                        duration_ms: 10,
                        usage: None,
                        events: vec![json!({
                            "source": "agent-loop",
                            "event": "tool_call_start",
                            "name": "submit_specification",
                            "objective": "Specify node 1",
                            "elapsedMs": 1
                        })],
                    },
                    AgentRunRecord {
                        node_id: 1,
                        operation: NodeOperation::Execute,
                        report: "executed".to_string(),
                        terminal_tool: Some("submit_work".to_string()),
                        terminal_payload: None,
                        duration_ms: 20,
                        usage: None,
                        events: vec![
                            json!({
                                "source": "agent-loop",
                                "event": "tool_call_start",
                                "name": "Read",
                                "objective": "Execute node 1",
                                "elapsedMs": 2,
                                "args": "{\"file_path\":\"src/cli.rs\"}"
                            }),
                            json!({
                                "source": "agent-loop",
                                "event": "usage",
                                "objective": "Execute node 1",
                                "totalTokens": 42
                            }),
                        ],
                    },
                ],
            },
        );
        let filter = task::AgentEventFilter::try_new(
            Some("execute".to_string()),
            Some("tool_call_start".to_string()),
            Some("read".to_string()),
            Some("agent-loop".to_string()),
            Some("src/cli.rs".to_string()),
        )
        .unwrap();

        let entries = task::assistant_agent_events(&task, &filter);

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].run_index, 2);
        assert_eq!(entries[0].event_index, 1);
        assert_eq!(entries[0].operation, NodeOperation::Execute);
        assert_eq!(entries[0].name.as_deref(), Some("Read"));
    }

    #[test]
    fn parses_task_run_split_eval_command() {
        let cli = Cli::try_parse_from([
            "siko",
            "eval",
            "task-run-split",
            "--task",
            "improve runtime",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Eval {
                command: EvalCommand::TaskRunSplit {
                    task: Some(task),
                    scenario: None,
                    scenario_file: None,
                    artifact_dir: None,
                    route_only: false,
                    json: true
                }
            }) if task == "improve runtime"
        ));
    }

    #[test]
    fn parses_task_run_split_eval_scenario_command() {
        let cli =
            Cli::try_parse_from(["siko", "eval", "task-run-split", "--scenario", "all"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Eval {
                command: EvalCommand::TaskRunSplit {
                    task: None,
                    scenario: Some(scenario),
                    scenario_file: None,
                    artifact_dir: None,
                    route_only: false,
                    json: false
                }
            }) if scenario == "all"
        ));
    }

    #[test]
    fn parses_task_run_split_eval_scenario_file_command() {
        let cli = Cli::try_parse_from([
            "siko",
            "eval",
            "task-run-split",
            "--scenario-file",
            "evals/task-run/dogfood-doc-review.yaml",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Eval {
                command: EvalCommand::TaskRunSplit {
                    task: None,
                    scenario: None,
                    scenario_file: Some(path),
                    artifact_dir: None,
                    route_only: false,
                    json: false
                }
            }) if path.as_path() == Path::new("evals/task-run/dogfood-doc-review.yaml")
        ));
    }

    #[test]
    fn parses_task_run_split_eval_artifact_dir() {
        let cli = Cli::try_parse_from([
            "siko",
            "eval",
            "task-run-split",
            "--scenario",
            "simple-qa",
            "--artifact-dir",
            "/tmp/siko-artifacts",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Eval {
                command: EvalCommand::TaskRunSplit {
                    task: None,
                    scenario: Some(scenario),
                    scenario_file: None,
                    artifact_dir: Some(path),
                    route_only: false,
                    json: false
                }
            }) if scenario == "simple-qa" && path.as_path() == Path::new("/tmp/siko-artifacts")
        ));
    }

    #[test]
    fn parses_task_run_split_eval_route_only() {
        let cli = Cli::try_parse_from([
            "siko",
            "eval",
            "task-run-split",
            "--scenario",
            "sikong-project-analysis",
            "--route-only",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Eval {
                command: EvalCommand::TaskRunSplit {
                    task: None,
                    scenario: Some(scenario),
                    scenario_file: None,
                    artifact_dir: None,
                    route_only: true,
                    json: false
                }
            }) if scenario == "sikong-project-analysis"
        ));
    }

    #[test]
    fn loads_task_run_split_scenario_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("scenario.yaml");
        fs::write(
            &path,
            r#"id: doc-review
task: Review design docs.
expectation: Produce file-backed findings.
workspace:
  provider: current-file-system
  read_scope:
    - design/**/*.md
    - src/task_run/**/*.rs
"#,
        )
        .unwrap();

        let scenario = eval::load_task_run_split_scenario_file(&path).unwrap();

        assert_eq!(scenario.id, "doc-review");
        assert_eq!(scenario.expectation, "Produce file-backed findings.");
        assert!(matches!(
            scenario.workspace,
            eval::TaskRunSplitWorkspace::CurrentFileSystem {
                ref read_scope,
                ref write_scope,
            }
                if read_scope == &vec![
                    "design/**/*.md".to_string(),
                    "src/task_run/**/*.rs".to_string()
                ] && write_scope.is_empty()
        ));
    }

    #[test]
    fn scenario_files_are_valid() {
        for path in [
            "evals/task-run/autonomous-iteration.yaml",
            "evals/task-run/project-analysis.yaml",
        ] {
            let scenario_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
            let scenario = eval::load_task_run_split_scenario_file(&scenario_path).unwrap();
            assert!(!scenario.id.is_empty());
            assert!(!scenario.task.is_empty());
            assert!(!scenario.expectation.is_empty());
        }
    }

    #[test]
    fn scenario_file_cannot_be_combined_with_task_or_scenario() {
        let path = Path::new("evals/task-run/dogfood-doc-review.yaml");

        let task_error = eval::select_task_run_split_eval_scenarios(
            Some("review docs".to_string()),
            None,
            Some(path),
        )
        .unwrap_err();
        assert!(task_error.to_string().contains("cannot be combined"));

        let scenario_error = eval::select_task_run_split_eval_scenarios(
            None,
            Some("simple-qa".to_string()),
            Some(path),
        )
        .unwrap_err();
        assert!(scenario_error.to_string().contains("cannot be combined"));
    }

    #[test]
    fn artifact_file_component_is_filesystem_safe() {
        assert_eq!(
            eval::sanitize_artifact_file_component("dogfood/doc review"),
            "dogfood-doc-review"
        );
        assert_eq!(eval::sanitize_artifact_file_component("..."), "scenario");
    }

    #[test]
    fn chrono_now_month_format() {
        let month = chrono::chrono_now_month();
        // Should match YYYY-MM format
        assert_eq!(month.len(), 7);
        assert_eq!(month.chars().filter(|&c| c == '-').count(), 1);
        let parts: Vec<&str> = month.split('-').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].len(), 4); // YYYY
        assert_eq!(parts[1].len(), 2); // MM
    }

    #[test]
    fn parses_task_run_operation_eval_command() {
        let cli = Cli::try_parse_from([
            "siko",
            "eval",
            "task-run-operation",
            "--operation",
            "verify",
            "--scenario",
            "reject",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Eval {
                command: EvalCommand::TaskRunOperation {
                    operation: Some(operation),
                    scenario: Some(scenario),
                    json: true
                }
            }) if operation == "verify" && scenario == "reject"
        ));
    }

    #[test]
    fn parses_assistant_prompt_command() {
        let cli = Cli::try_parse_from([
            "siko",
            "assistant",
            "prompt",
            "--wait-ms",
            "5000",
            "--json",
            "推进",
            "dogfood",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Assistant {
                acp: false,
                command: Some(AssistantCommand::Prompt {
                    message,
                    wait_ms: 5000,
                    workspace: AssistantPromptWorkspace::Memory,
                    allow_write: false,
                    write_scope,
                    json: true,
                })
            }) if message == ["推进", "dogfood"] && write_scope.is_empty()
        ));
    }

    #[test]
    fn parses_assistant_prompt_current_git_workspace() {
        let cli = Cli::try_parse_from([
            "siko",
            "assistant",
            "prompt",
            "--workspace",
            "current-git",
            "--allow-write",
            "--write-scope",
            "src/**",
            "推进",
            "dogfood",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Assistant {
                acp: false,
                command: Some(AssistantCommand::Prompt {
                    message,
                    workspace: AssistantPromptWorkspace::CurrentGit,
                    allow_write: true,
                    write_scope,
                    ..
                })
            }) if message == ["推进", "dogfood"] && write_scope == ["src/**"]
        ));
    }

    #[test]
    fn assistant_prompt_memory_workspace_rejects_write_scope() {
        let error = assistant::resolve_assistant_prompt_workspace(
            &test_debug_config(),
            AssistantPromptWorkspace::Memory,
            &["src/**".to_string()],
        )
        .unwrap_err();
        assert!(error.to_string().contains("--workspace current-git"));
    }

    #[test]
    fn task_run_operation_eval_selects_operation_scenarios() {
        let scenarios = eval::select_operation_eval_scenarios(Some("verify"), Some("all")).unwrap();
        assert_eq!(scenarios.len(), 3);
        assert!(
            scenarios
                .iter()
                .all(|scenario| scenario.operation == NodeOperation::Verify)
        );
        assert!(scenarios.iter().any(|scenario| scenario.id == "accept"));
        assert!(scenarios.iter().any(|scenario| scenario.id == "reject"));
        assert!(scenarios.iter().any(|scenario| scenario.id == "uncertain"));
    }

    #[test]
    fn task_run_operation_eval_does_not_expose_commit_as_agent_scenario() {
        let error = eval::select_operation_eval_scenarios(Some("commit"), Some("all"))
            .expect_err("commit is an engine event, not an agent eval scenario");
        assert!(error.to_string().contains("no task-run operation eval"));
    }

    #[test]
    fn formats_structured_task_log_with_node_context() {
        let line = task::format_task_log(&AssistantTaskEvent {
            seq: 7,
            timestamp_ms: 1_719_000_000_000,
            level: tracing::Level::INFO.to_string(),
            kind: "agent.run".to_string(),
            source: "agent".to_string(),
            message: "completed execute".to_string(),
            node_id: Some(3),
            operation: Some(crate::NodeOperation::Execute),
            payload: serde_json::json!({
                "terminal_tool": "submit_work"
            }),
        });

        assert!(line.contains("#0007"));
        assert!(line.contains("agent.run"));
        assert!(line.contains("node=3"));
        assert!(line.contains("op=Execute"));
        assert!(line.contains("submit_work"));
    }

    // ── Utility function tests ──────────────────────────────────────────

    #[test]
    fn is_leap_returns_true_for_typical_leap_years() {
        assert!(chrono::is_leap(2000));
        assert!(chrono::is_leap(2024));
        assert!(chrono::is_leap(1996));
        assert!(chrono::is_leap(2400));
    }

    #[test]
    fn is_leap_returns_false_for_common_years() {
        assert!(!chrono::is_leap(2023));
        assert!(!chrono::is_leap(1900));
        assert!(!chrono::is_leap(2100));
        assert!(!chrono::is_leap(2025));
    }

    #[test]
    fn is_leap_handles_century_rule() {
        assert!(!chrono::is_leap(1700));
        assert!(!chrono::is_leap(1800));
        assert!(!chrono::is_leap(1900));
        assert!(chrono::is_leap(1600));
        assert!(chrono::is_leap(2000));
        assert!(chrono::is_leap(2400));
    }

    #[test]
    fn sum_usage_adds_actor_and_judge() {
        let actor = AgentTokenUsage {
            input_tokens: 100,
            output_tokens: 50,
            active_tokens: 150,
            total_tokens: 150,
            cache_read_tokens: 10,
            cache_creation_tokens: 5,
        };
        let judge = AgentTokenUsage {
            input_tokens: 200,
            output_tokens: 100,
            active_tokens: 300,
            total_tokens: 300,
            cache_read_tokens: 20,
            cache_creation_tokens: 10,
        };
        let total = eval::sum_usage(Some(&actor), Some(&judge));
        assert_eq!(total.input_tokens, 300);
        assert_eq!(total.output_tokens, 150);
        assert_eq!(total.active_tokens, 450);
        assert_eq!(total.total_tokens, 450);
        assert_eq!(total.cache_read_tokens, 30);
        assert_eq!(total.cache_creation_tokens, 15);
    }

    #[test]
    fn sum_usage_with_actor_only() {
        let actor = AgentTokenUsage {
            input_tokens: 100,
            active_tokens: 100,
            total_tokens: 100,
            ..AgentTokenUsage::default()
        };
        let total = eval::sum_usage(Some(&actor), None);
        assert_eq!(total.input_tokens, 100);
        assert_eq!(total.output_tokens, 0);
    }

    #[test]
    fn sum_usage_with_judge_only() {
        let judge = AgentTokenUsage {
            input_tokens: 50,
            active_tokens: 50,
            total_tokens: 50,
            ..AgentTokenUsage::default()
        };
        let total = eval::sum_usage(None, Some(&judge));
        assert_eq!(total.input_tokens, 50);
    }

    #[test]
    fn sum_usage_with_both_none_returns_default() {
        let total = eval::sum_usage(None, None);
        assert_eq!(total.input_tokens, 0);
        assert_eq!(total.total_tokens, 0);
    }

    #[test]
    fn sum_usage_does_not_mutate_inputs() {
        let actor = AgentTokenUsage {
            input_tokens: 100,
            active_tokens: 100,
            total_tokens: 100,
            ..AgentTokenUsage::default()
        };
        let judge = AgentTokenUsage {
            input_tokens: 200,
            active_tokens: 200,
            total_tokens: 200,
            ..AgentTokenUsage::default()
        };
        let _total = eval::sum_usage(Some(&actor), Some(&judge));
        assert_eq!(actor.input_tokens, 100);
        assert_eq!(judge.input_tokens, 200);
    }

    #[test]
    fn sum_agent_run_usage_empty_slice() {
        let total = eval::sum_agent_run_usage(&[]);
        assert_eq!(total.input_tokens, 0);
    }

    #[test]
    fn sum_agent_run_usage_single_run() {
        let runs = [AgentRunRecord {
            node_id: 1,
            operation: NodeOperation::Execute,
            report: "done".to_string(),
            terminal_tool: Some("submit_work".to_string()),
            terminal_payload: None,
            duration_ms: 100,
            usage: Some(AgentTokenUsage {
                input_tokens: 500,
                output_tokens: 200,
                active_tokens: 700,
                total_tokens: 700,
                cache_read_tokens: 50,
                cache_creation_tokens: 25,
            }),
            events: Vec::new(),
        }];
        let total = eval::sum_agent_run_usage(&runs);
        assert_eq!(total.input_tokens, 500);
        assert_eq!(total.output_tokens, 200);
        assert_eq!(total.cache_read_tokens, 50);
        assert_eq!(total.cache_creation_tokens, 25);
    }

    #[test]
    fn sum_agent_run_usage_skips_runs_without_usage() {
        let runs = [
            AgentRunRecord {
                node_id: 1,
                operation: NodeOperation::Execute,
                report: "no usage".to_string(),
                terminal_tool: Some("submit_work".to_string()),
                terminal_payload: None,
                duration_ms: 50,
                usage: None,
                events: Vec::new(),
            },
            AgentRunRecord {
                node_id: 2,
                operation: NodeOperation::Specify,
                report: "with usage".to_string(),
                terminal_tool: Some("submit_specification".to_string()),
                terminal_payload: None,
                duration_ms: 30,
                usage: Some(AgentTokenUsage {
                    input_tokens: 100,
                    output_tokens: 50,
                    active_tokens: 150,
                    total_tokens: 150,
                    cache_read_tokens: 10,
                    cache_creation_tokens: 5,
                }),
                events: Vec::new(),
            },
            AgentRunRecord {
                node_id: 3,
                operation: NodeOperation::Verify,
                report: "no usage either".to_string(),
                terminal_tool: Some("submit_verdict".to_string()),
                terminal_payload: None,
                duration_ms: 20,
                usage: None,
                events: Vec::new(),
            },
        ];
        let total = eval::sum_agent_run_usage(&runs);
        assert_eq!(total.input_tokens, 100);
        assert_eq!(total.output_tokens, 50);
        assert_eq!(total.cache_read_tokens, 10);
    }

    #[test]
    fn sum_agent_run_usage_multiple_runs() {
        let make_run = |id: u64, input: u64| AgentRunRecord {
            node_id: id,
            operation: NodeOperation::Execute,
            report: "run".to_string(),
            terminal_tool: Some("submit_work".to_string()),
            terminal_payload: None,
            duration_ms: 10,
            usage: Some(AgentTokenUsage {
                input_tokens: input,
                active_tokens: input,
                total_tokens: input,
                ..AgentTokenUsage::default()
            }),
            events: Vec::new(),
        };
        let runs = vec![make_run(1, 100), make_run(2, 200), make_run(3, 300)];
        let total = eval::sum_agent_run_usage(&runs);
        assert_eq!(total.input_tokens, 600);
    }

    #[test]
    fn truncate_text_preserves_short_input() {
        assert_eq!(task::truncate_text("hello", 10), "hello");
    }

    #[test]
    fn truncate_text_exact_fit() {
        assert_eq!(task::truncate_text("hello", 5), "hello");
    }

    #[test]
    fn truncate_text_appends_ellipsis_when_exceeding() {
        assert_eq!(task::truncate_text("hello world", 5), "hello...");
    }

    #[test]
    fn truncate_text_handles_empty_string() {
        assert_eq!(task::truncate_text("", 10), "");
    }

    #[test]
    fn truncate_text_handles_multi_byte_chars() {
        assert_eq!(task::truncate_text("日本語", 2), "日本...");
    }

    #[test]
    fn truncate_text_handles_zero_max_chars() {
        assert_eq!(task::truncate_text("hello", 0), "...");
    }

    #[test]
    fn compact_json_formats_value() {
        let value = serde_json::json!({"a": 1, "b": "two"});
        let result = task::compact_json(&value);
        assert_eq!(result, r#"{"a":1,"b":"two"}"#);
    }

    #[test]
    fn compact_json_handles_null() {
        assert_eq!(task::compact_json(&serde_json::Value::Null), "null");
    }

    #[test]
    fn compact_json_handles_array() {
        let value = serde_json::json!([1, 2, 3]);
        assert_eq!(task::compact_json(&value), "[1,2,3]");
    }

    #[test]
    fn format_usage_includes_all_fields() {
        let usage = AgentTokenUsage {
            input_tokens: 100,
            output_tokens: 200,
            active_tokens: 300,
            total_tokens: 500,
            cache_read_tokens: 50,
            cache_creation_tokens: 25,
        };
        let formatted = eval::format_usage(&usage);
        assert!(formatted.contains("active=300"));
        assert!(formatted.contains("total=500"));
        assert!(formatted.contains("in=100"));
        assert!(formatted.contains("out=200"));
        assert!(formatted.contains("cache=75"));
        assert!(formatted.contains("cache_read=50"));
        assert!(formatted.contains("cache_create=25"));
    }

    #[test]
    fn format_usage_handles_zero_values() {
        let usage = AgentTokenUsage::default();
        let formatted = eval::format_usage(&usage);
        assert!(formatted.contains("active=0"));
        assert!(formatted.contains("total=0"));
    }

    #[test]
    fn optional_eq_both_none_returns_true() {
        let a: Option<&str> = None;
        let b: Option<&str> = None;
        assert!(task::optional_eq(a, b));
    }

    #[test]
    fn optional_eq_filter_none_always_passes() {
        let filter: Option<&str> = None;
        assert!(task::optional_eq(filter, Some("anything")));
        assert!(task::optional_eq(filter, None));
    }

    #[test]
    fn optional_eq_case_insensitive_match() {
        assert!(task::optional_eq(Some("Hello"), Some("hello")));
        assert!(task::optional_eq(Some("WORLD"), Some("world")));
        assert!(task::optional_eq(Some("MiXeD"), Some("mixed")));
    }

    #[test]
    fn optional_eq_mismatch_returns_false() {
        assert!(!task::optional_eq(Some("hello"), Some("world")));
        assert!(!task::optional_eq(Some("abc"), Some("xyz")));
    }

    #[test]
    fn optional_eq_filter_none_with_actual_none_returns_true() {
        assert!(task::optional_eq(None, None));
    }

    // ── Additional utility function tests ─────────────────────────────────

    #[test]
    fn operation_name_maps_all_variants() {
        assert_eq!(eval::operation_name(NodeOperation::Specify), "specify");
        assert_eq!(eval::operation_name(NodeOperation::Plan), "plan");
        assert_eq!(eval::operation_name(NodeOperation::Execute), "execute");
        assert_eq!(eval::operation_name(NodeOperation::Combine), "combine");
        assert_eq!(eval::operation_name(NodeOperation::Verify), "verify");
        assert_eq!(eval::operation_name(NodeOperation::Commit), "commit");
    }

    #[test]
    fn truncate_for_eval_preserves_short_input() {
        assert_eq!(eval::truncate_for_eval("hello world", 20), "hello world");
    }

    #[test]
    fn truncate_for_eval_exact_fit() {
        assert_eq!(eval::truncate_for_eval("hello", 5), "hello");
    }

    #[test]
    fn truncate_for_eval_appends_ellipsis_when_exceeding() {
        let result = eval::truncate_for_eval("this is a long string that should be truncated", 15);
        assert_eq!(result, "this is a long ...");
    }

    #[test]
    fn truncate_for_eval_handles_empty_string() {
        assert_eq!(eval::truncate_for_eval("", 10), "");
    }

    #[test]
    fn truncate_for_eval_handles_multi_byte_chars() {
        assert_eq!(eval::truncate_for_eval("日本語の文字列", 4), "日本語の...");
    }

    #[test]
    fn assistant_agent_events_returns_empty_when_no_report() {
        let task = AssistantTask::new("task_empty".to_string(), "no report yet".to_string());
        let filter = task::AgentEventFilter::try_new(None, None, None, None, None).unwrap();
        let entries = task::assistant_agent_events(&task, &filter);
        assert!(entries.is_empty());
    }

    #[test]
    fn render_json_prompt_context_formats_pretty_json() {
        let value = serde_json::json!({"key": "value", "number": 42});
        let result = eval::render_json_prompt_context(&value);
        assert!(result.starts_with("```json"));
        assert!(result.contains("\"key\": \"value\""));
        assert!(result.contains("\"number\": 42"));
        assert!(result.ends_with("```"));
    }

    #[test]
    fn render_json_prompt_context_handles_null() {
        assert_eq!(
            eval::render_json_prompt_context(&serde_json::Value::Null),
            "```json\nnull\n```"
        );
    }

    #[test]
    fn render_json_prompt_context_handles_array() {
        let value = serde_json::json!([1, "two", true]);
        let result = eval::render_json_prompt_context(&value);
        assert!(result.starts_with("```json"));
        assert!(result.contains("\"two\""));
        assert!(result.ends_with("```"));
    }

    #[test]
    fn chrono_now_date_has_correct_format() {
        let date = chrono::chrono_now_date();
        // Should match YYYY-MM-DD format
        assert_eq!(date.len(), 10);
        assert_eq!(date.chars().filter(|&c| c == '-').count(), 2);
        let parts: Vec<&str> = date.split('-').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].len(), 4); // YYYY
        assert_eq!(parts[1].len(), 2); // MM
        assert_eq!(parts[2].len(), 2); // DD
        // Should be parseable as numbers
        assert!(parts[0].parse::<i32>().is_ok());
        assert!(parts[1].parse::<u32>().is_ok());
        assert!(parts[2].parse::<u32>().is_ok());
    }
    #[test]
    fn parse_node_operation_specify() {
        let result = task::parse_node_operation("specify");
        assert_eq!(result.unwrap(), NodeOperation::Specify);
    }

    #[test]
    fn parse_node_operation_case_insensitive() {
        let result = task::parse_node_operation("EXECUTE");
        assert_eq!(result.unwrap(), NodeOperation::Execute);
    }

    #[test]
    fn parse_node_operation_trims_whitespace() {
        let result = task::parse_node_operation("  plan  ");
        assert_eq!(result.unwrap(), NodeOperation::Plan);
    }

    #[test]
    fn parse_node_operation_all_variants() {
        for (input, expected) in [
            ("specify", NodeOperation::Specify),
            ("plan", NodeOperation::Plan),
            ("execute", NodeOperation::Execute),
            ("combine", NodeOperation::Combine),
            ("verify", NodeOperation::Verify),
            ("commit", NodeOperation::Commit),
        ] {
            let result = task::parse_node_operation(input);
            assert_eq!(result.unwrap(), expected, "failed for input: {input}");
        }
    }

    #[test]
    fn parse_node_operation_unknown_returns_error() {
        let result = task::parse_node_operation("invalid_op");
        assert!(result.is_err());
        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("invalid_op"),
            "error should mention the invalid input: {error}"
        );
        assert!(
            error.contains("specify"),
            "error should list valid operations: {error}"
        );
        assert!(
            error.contains("plan"),
            "error should list valid operations: {error}"
        );
        assert!(
            error.contains("execute"),
            "error should list valid operations: {error}"
        );
        assert!(
            error.contains("combine"),
            "error should list valid operations: {error}"
        );
        assert!(
            error.contains("verify"),
            "error should list valid operations: {error}"
        );
        assert!(
            error.contains("commit"),
            "error should list valid operations: {error}"
        );
    }
}
