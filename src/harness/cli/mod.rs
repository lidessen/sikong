use std::fs;
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::{
    AcpServer, AgentAssistantLoop, AgentPromptSection, AgentRunRequest, AgentRunResponse,
    AgentRunResult, AgentRunScheduler, AgentRuntimeProfile, AgentTokenUsage, AgentToolCall,
    AgentToolSpec, Artifact, ArtifactContentKind, AssistantSession, AssistantSessionConfig,
    AssistantTaskStatus, Budget, CancellationToken,
    CapabilityProfile, DebugConfig, Engine, FileTaskStore, NodeId, NodeOperation,
    NodeOperationOutput, NodePlan, NodePolicy, NodeStatus, NodeTemplate, OperationHarness,
    PlanGroup, PlanGroupMode, ProblemKey, ProblemNode, ProcessAgentRunScheduler, SikoConfig,
    TaskStore, TaskType, WorkSize, WorkspaceProvider, WorkspaceRequirement, WorkspaceSurface,
    Workspaces,

    run_acp_stdio_server,
};
use clap::{CommandFactory, Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::error;
use tracing_subscriber::EnvFilter;

pub mod launch;
pub mod metrics;
pub mod setup;
pub mod task;
pub use task::TaskCommand;

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
        }) => match print_assistant_list(json) {
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
        }) => match run_assistant_acp() {
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
            match run_assistant_prompt(message, wait_ms, workspace, allow_write, write_scope, json)
            {
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
        }) => match print_assistant_logs(&task_id, json, full) {
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
                } => match run_task_run_split_eval(
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
                } => match run_task_run_operation_eval(operation, scenario, json) {
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
            match run_assistant_prompt(
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



#[derive(Debug, Subcommand)]
enum AssistantCommand {
    /// Send one assistant message, run queued work in this process, and print the result.
    Prompt {
        /// Milliseconds to keep this process alive while queued tasks run. Set 0 to only enqueue.
        #[arg(long, default_value_t = 300_000)]
        wait_ms: u64,

        /// Root workspace used by tasks created from this prompt.
        #[arg(long, value_enum, default_value_t = AssistantPromptWorkspace::Memory)]
        workspace: AssistantPromptWorkspace,

        /// Allow created tasks to write within --write-scope.
        #[arg(long)]
        allow_write: bool,

        /// Coarse writable glob for --workspace current-git. Repeatable.
        #[arg(long = "write-scope")]
        write_scope: Vec<String>,

        /// Print structured JSON output.
        #[arg(long)]
        json: bool,

        /// Message to send to the assistant.
        #[arg(required = true, trailing_var_arg = true)]
        message: Vec<String>,
    },
    /// Print persisted task logs in chronological order.
    Logs {
        /// Task id to inspect.
        task_id: String,

        /// Print the raw structured log JSON.
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
    /// List all persisted tasks, showing ID (first 12 chars), status, and first line.
    List {
        /// Print structured JSON output.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum AssistantPromptWorkspace {
    /// In-memory workspace (no file access).
    Memory,
    /// Current file system (read files directly, no git worktree).
    CurrentFileSystem,
    /// Git worktree workspace (isolated, writable).
    CurrentGit,
}

#[derive(Debug, Subcommand)]
enum EvalCommand {
    /// Evaluate whether a real task run splits a broad task.
    TaskRunSplit {
        /// Natural task request. Do not include decomposition hints.
        #[arg(long)]
        task: Option<String>,

        /// Scenario id to evaluate, or all. Defaults to preview-runtime.
        #[arg(long)]
        scenario: Option<String>,

        /// YAML scenario file to evaluate.
        #[arg(long)]
        scenario_file: Option<PathBuf>,

        /// Write full task-run artifacts to this directory for human review.
        #[arg(long)]
        artifact_dir: Option<PathBuf>,

        /// Stop after the root Plan operation so routing can be evaluated cheaply.
        #[arg(long)]
        route_only: bool,

        /// Print full JSON evaluation output.
        #[arg(long)]
        json: bool,
    },
    /// Evaluate one task-run operation scenario in isolation.
    TaskRunOperation {
        /// Operation to evaluate, or all. Defaults to all.
        #[arg(long)]
        operation: Option<String>,

        /// Scenario id to evaluate, or all. Defaults to all selected scenarios.
        #[arg(long)]
        scenario: Option<String>,

        /// Print full JSON evaluation output.
        #[arg(long)]
        json: bool,
    },
}

pub fn run_assistant_acp() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .thread_name("siko-assistant")
        .enable_all()
        .build()?;
    runtime.block_on(run_assistant_acp_async())
}

async fn run_assistant_acp_async() -> Result<(), Box<dyn std::error::Error>> {
    let config = SikoConfig::load()?;
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(task::assistant_store_path(&debug))?;
    let worker_launch = launch::resolve_agent_loop_launch(&debug, 32);
    let shared_scheduler = Arc::new(Mutex::new(ProcessAgentRunScheduler::new(
        worker_launch.command.clone(),
        worker_launch.args.clone(),
    )));
    let assistant_loop = AgentAssistantLoop::new(shared_scheduler.clone());
    let session = AssistantSession::with_worker_factory(
        assistant_loop,
        {
            let sched = shared_scheduler.clone();
            move || Box::new(sched.clone())
        },
        AssistantSessionConfig {
            max_parallel_tasks: config.assistant.max_parallel_tasks,
            task_board_enabled: true,
            conversation_message_limit: 200,
            ..AssistantSessionConfig::default()
        },
    );
    let server = AcpServer::new(store, session);
    run_acp_stdio_server(server, BufReader::new(io::stdin()), io::stdout()).await?;
    Ok(())
}

fn run_assistant_prompt(
    message: Vec<String>,
    wait_ms: u64,
    workspace: AssistantPromptWorkspace,
    allow_write: bool,
    write_scope: Vec<String>,
    json_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let message = message.join(" ").trim().to_string();
    if message.is_empty() {
        return Err("assistant prompt message must not be empty".into());
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .thread_name("siko-assistant-prompt")
        .enable_all()
        .build()?;
    runtime.block_on(run_assistant_prompt_async(
        message,
        wait_ms,
        workspace,
        allow_write,
        write_scope,
        json_output,
    ))
}

async fn run_assistant_prompt_async(
    message: String,
    wait_ms: u64,
    workspace: AssistantPromptWorkspace,
    allow_write: bool,
    write_scope: Vec<String>,
    json_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let config = SikoConfig::load()?;
    let debug = DebugConfig::from_env();
    let root_workspace = resolve_assistant_prompt_workspace(&debug, workspace, &write_scope)?;
    let root_capabilities = if allow_write {
        CapabilityProfile::writable()
    } else {
        CapabilityProfile::read_only()
    };
    let mut store = FileTaskStore::open(task::assistant_store_path(&debug))?;
    let worker_launch = launch::resolve_agent_loop_launch(&debug, 32);
    let shared_scheduler = Arc::new(Mutex::new(ProcessAgentRunScheduler::new(
        worker_launch.command.clone(),
        worker_launch.args.clone(),
    )));
    let assistant_loop = AgentAssistantLoop::new(shared_scheduler.clone());
    let mut session = AssistantSession::with_worker_factory(
        assistant_loop,
        {
            let sched = shared_scheduler.clone();
            move || Box::new(sched.clone())
        },
        AssistantSessionConfig {
            max_parallel_tasks: config.assistant.max_parallel_tasks,
            task_board_enabled: true,
            conversation_message_limit: 200,
            root_workspace,
            root_capabilities,
        },
    );

    let started_at = Instant::now();

    let assistant_progress = if json_output {
        None
    } else {
        Some(send_spinner("assistant thinking"))
    };
    let reply = session.handle_message(&mut store, message).await;
    if let Some(ref pb) = assistant_progress {
        pb.finish_with_message("assistant turn complete ✓");
    }

    let snapshot = if reply.task_id.is_some() {
        let task_progress = if json_output {
            None
        } else {
            Some(send_spinner("task running"))
        };
        let snapshot = if wait_ms == 0 {
            session.drain(&mut store).await
        } else {
            session
                .wait_for_all(&mut store, Duration::from_millis(wait_ms))
                .await
        };
        // Keep the tokio runtime alive while background engine tasks are still
        // running. Without this, the runtime drops when the CLI returns and
        // spawned tasks are cancelled silently.
        let snapshot = if snapshot.running_tasks > 0 || snapshot.queued_tasks > 0 {
            // Poll with short timeout until the task board is idle.
            // Use 1s intervals so the CLI stays responsive to cancellation.
            let poll_interval = Duration::from_millis(1000);
            loop {
                let s = session
                    .wait_for_all(&mut store, poll_interval)
                    .await;
                if s.running_tasks == 0 && s.queued_tasks == 0 {
                    break s;
                }
                if let Some(ref pb) = task_progress {
                    pb.set_message(format!(
                        "task board: {} running, {} queued",
                        s.running_tasks, s.queued_tasks
                    ));
                }
            }
        } else {
            snapshot
        };
        if let Some(ref pb) = task_progress {
            if snapshot.running_tasks == 0 && snapshot.queued_tasks == 0 {
                pb.finish_with_message("task board idle");
            } else {
                pb.finish_with_message(format!(
                    "task board: {} running, {} queued",
                    snapshot.running_tasks, snapshot.queued_tasks
                ));
            }
        }
        snapshot
    } else {
        session.drain(&mut store).await
    };

    let task_status = reply
        .task_id
        .as_deref()
        .and_then(|task_id| store.get_task(task_id))
        .map(|task| task.status.clone());
    let final_artifact = reply
        .task_id
        .as_deref()
        .and_then(|task_id| store.get_task(task_id))
        .and_then(|task| task.last_report.as_ref())
        .and_then(|report| report.artifact_text.clone());
    let output = AssistantPromptOutput {
        response: reply.text,
        task_id: reply.task_id,
        status: task_status,
        final_artifact,
        running_tasks: snapshot.running_tasks,
        queued_tasks: snapshot.queued_tasks,
        persist_error: store.last_persist_error().map(ToString::to_string),
    };

    if json_output {
        serde_json::to_writer_pretty(std::io::stdout(), &output)?;
        println!();
        return Ok(());
    }

    let elapsed = started_at.elapsed();

    // ── Response ──
    println!(
        "{}",
        console::style("── Response ──────────────────────────────────────").dim()
    );
    let skin = termimad::MadSkin::default();
    skin.print_text(&output.response);

    // ── Result ──
    println!(
        "{}",
        console::style("── Result ─────────────────────────────────────────").dim()
    );
    if let Some(task_id) = &output.task_id {
        println!("  task:   {task_id}");
    }
    if let Some(status) = &output.status {
        let status_label = match status {
            AssistantTaskStatus::Completed => {
                console::style("✓ Completed").green().bold().to_string()
            }
            AssistantTaskStatus::Failed => console::style("✗ Failed").red().bold().to_string(),
            AssistantTaskStatus::Cancelled => {
                console::style("− Cancelled").yellow().bold().to_string()
            }
            AssistantTaskStatus::WaitingForInput => console::style("? Waiting for input")
                .blue()
                .bold()
                .to_string(),
            AssistantTaskStatus::Running => console::style("◌ Running").cyan().bold().to_string(),
            other => console::style(format!("{other:?}")).dim().to_string(),
        };
        println!("  status: {status_label}");
    }
    println!(
        "  {} {}",
        console::style("⚡").dim(),
        console::style(format_duration(elapsed)).dim()
    );
    if let Some(artifact) = &output.final_artifact {
        println!();
        println!("{artifact}");
    }
    if output.running_tasks > 0 || output.queued_tasks > 0 {
        println!(
            "  task board: {} running, {} queued",
            output.running_tasks, output.queued_tasks
        );
    }
    if let Some(task_id) = &output.task_id {
        println!(
            "{}",
            console::style("── Inspect ────────────────────────────────────────").dim()
        );
        println!("  live:   siko task inspect {task_id}");
        println!("  logs:   siko task logs {task_id}");
        println!("  result: siko task show {task_id}");
        println!("  events: siko task events {task_id}");
    }
    if let Some(error) = &output.persist_error {
        eprintln!(
            "{} failed to persist assistant task store: {error}",
            console::style("[WARN]").yellow().bold()
        );
    }
    Ok(())
}

fn send_spinner(message: &'static str) -> indicatif::ProgressBar {
    let pb = indicatif::ProgressBar::new_spinner();
    pb.set_style(
        indicatif::ProgressStyle::with_template("{spinner} {msg} ({elapsed})")
            .unwrap()
            .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"),
    );
    pb.set_message(message);
    pb.enable_steady_tick(Duration::from_millis(120));
    pb
}

fn format_duration(d: Duration) -> String {
    let secs = d.as_secs_f64();
    if secs > 60.0 {
        format!("{:.0}m {:2.0}s", secs / 60.0, secs % 60.0)
    } else {
        format!("{:6.1}s", secs)
    }
}

fn resolve_assistant_prompt_workspace(
    debug: &DebugConfig,
    workspace: AssistantPromptWorkspace,
    write_scope: &[String],
) -> Result<WorkspaceRequirement, Box<dyn std::error::Error>> {
    match workspace {
        AssistantPromptWorkspace::Memory => {
            if !write_scope.is_empty() {
                return Err(
                    "--write-scope requires --workspace current-git or current-file-system".into(),
                );
            }
            Ok(WorkspaceRequirement::memory())
        }
        AssistantPromptWorkspace::CurrentFileSystem => Ok(WorkspaceRequirement {
            provider: crate::WorkspaceProvider::FileSystem,
            read_scope: vec!["**/*".to_string()],
            write_scope: write_scope.to_vec(),
            git: None,
        }),
        AssistantPromptWorkspace::CurrentGit => {
            let repo_root = current_git_root()?;
            let worktree_root = debug.data_dir().join("worktrees").join("assistant");
            Ok(WorkspaceRequirement::git_repo(
                repo_root,
                worktree_root,
                "HEAD",
                write_scope.iter().cloned(),
            ))
        }
    }
}

fn current_git_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "current directory is not inside a git repository: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let root = String::from_utf8(output.stdout)?.trim().to_string();
    if root.is_empty() {
        return Err("git did not report a repository root".into());
    }
    Ok(PathBuf::from(root))
}

#[derive(Debug, Serialize)]
struct AssistantPromptOutput {
    response: String,
    task_id: Option<String>,
    status: Option<AssistantTaskStatus>,
    final_artifact: Option<String>,
    running_tasks: usize,
    queued_tasks: usize,
    persist_error: Option<String>,
}

fn print_assistant_logs(
    task_id: &str,
    json_output: bool,
    full_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(task::assistant_store_path(&debug))?;
    let task = task::resolve_task_ref(&store, task_id)?;

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
        println!("{}", task::format_task_log(event));
    }
    Ok(())
}

fn print_assistant_list(json_output: bool) -> Result<(), Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(task::assistant_store_path(&debug))?;
    let mut tasks = store.list_tasks();
    task::sort_tasks_newest_first(&mut tasks);

    if json_output {
        serde_json::to_writer_pretty(std::io::stdout(), &tasks)?;
        println!();
        return Ok(());
    }

    for task in &tasks {
        let id_prefix = task::task_list_id(&task.id);
        let first_line = task.request.lines().next().unwrap_or("").to_string();
        println!("{}  {:?}  {}", id_prefix, task.status, first_line);
    }
    Ok(())
}


fn run_task_run_split_eval(
    task: Option<String>,
    scenario: Option<String>,
    scenario_file: Option<PathBuf>,
    artifact_dir: Option<PathBuf>,
    route_only: bool,
    json_output: bool,
) -> Result<bool, Box<dyn std::error::Error>> {
    ensure_live_eval_enabled()?;
    let scenarios = select_task_run_split_eval_scenarios(task, scenario, scenario_file.as_deref())?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .thread_name("siko-eval")
        .enable_all()
        .build()?;
    runtime.block_on(run_task_run_split_eval_async(
        scenarios,
        artifact_dir.as_deref(),
        route_only,
        json_output,
    ))
}

async fn run_task_run_split_eval_async(
    scenarios: Vec<TaskRunSplitScenario>,
    artifact_dir: Option<&Path>,
    route_only: bool,
    json_output: bool,
) -> Result<bool, Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    let mut results = Vec::new();

    for scenario in scenarios {
        let run_started = Instant::now();
        let launch = launch::resolve_agent_loop_launch(&debug, scenario.actor_max_steps());
        let (root_workspace, allow_write) = eval_task_workspace_requirement(&scenario)?;
        let mut engine = Engine::new(
            Workspaces::default(),
            ProcessAgentRunScheduler::new(launch.command.clone(), launch.args.clone()),
        );
        if route_only {
            engine = engine.with_stop_after_route_depth(0);
        }
        let root = engine.insert_root(eval_task_root_template(
            &scenario.task,
            root_workspace,
            allow_write,
        ));
        let report = engine
            .run(root)
            .await
            .map_err(|error| format!("task run failed for scenario {}: {error:?}", scenario.id))?;

        // Collect per-agent-run metrics
        let mut metrics_collector = crate::common::metrics::MetricsCollector::new();
        for agent_run in &report.agent_runs {
            let operation = agent_run.operation.to_string();
            let duration_ms = agent_run.duration_ms;
            let passed = agent_run.terminal_tool.is_some();
            if let Some(usage) = &agent_run.usage {
                metrics_collector.record_agent_run(
                    &operation,
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.cache_read_tokens,
                    duration_ms,
                    passed,
                );
            } else {
                metrics_collector.record_agent_run(&operation, 0, 0, 0, duration_ms, passed);
            }
        }
        let metrics = metrics_collector.snapshot().to_json_value();

        let transcript = TaskRunSplitTranscript::from_engine(&scenario, root, &engine, &report);
        let artifact_files =
            write_task_run_artifacts(artifact_dir, &scenario, root, &engine, &report)?;
        let actor_usage = sum_agent_run_usage(&report.agent_runs);

        let judge_launch = launch::resolve_agent_loop_launch(&debug, 6);
        let mut judge = ProcessAgentRunScheduler::new(judge_launch.command, judge_launch.args);
        let judge_response = judge
            .run(judge_request(&transcript), CancellationToken::new())
            .await;
        let judge_usage = judge_response.usage.clone();
        let judgement = decode_judgement(judge_response.terminal_call)?;
        let total_usage = sum_usage(Some(&actor_usage), judge_usage.as_ref());

        results.push(TaskRunSplitEvalResult {
            scenario: scenario.id.clone(),
            task: scenario.task.clone(),
            expectation: scenario.expectation.clone(),
            duration_ms: run_started.elapsed().as_millis(),
            actor_usage,
            judge_usage,
            total_usage,
            judgement,
            artifact_files,
            transcript,
            metrics,
        });
    }

    let output = TaskRunSplitEvalOutput {
        passed: results.iter().all(|result| result.judgement.passed),
        results,
    };

    if json_output {
        serde_json::to_writer_pretty(std::io::stdout(), &output)?;
        println!();
    } else {
        println!(
            "task-run split eval: passed={} scenarios={}",
            output.passed,
            output.results.len()
        );
        for result in &output.results {
            println!(
                "- {} passed={} duration={}ms agent={} judge={} total={}",
                result.scenario,
                result.judgement.passed,
                result.duration_ms,
                format_usage(&result.actor_usage),
                result
                    .judge_usage
                    .as_ref()
                    .map(format_usage)
                    .unwrap_or_else(|| "0".to_string()),
                format_usage(&result.total_usage)
            );
            for finding in &result.judgement.findings {
                println!("  - {finding}");
            }
            for artifact_file in &result.artifact_files {
                println!(
                    "  artifact {} node {}: {}",
                    artifact_file.artifact_id, artifact_file.node_id, artifact_file.path
                );
            }
        }
    }

    Ok(output.passed)
}

#[allow(dead_code)]
fn chrono_now_date() -> String {
    let (y, m, d) = chrono_now_ymd();
    format!("{:04}-{:02}-{:02}", y, m, d)
}

#[allow(dead_code)]
fn chrono_now_month() -> String {
    let (y, m, _d) = chrono_now_ymd();
    format!("{:04}-{:02}", y, m)
}

#[allow(dead_code)]
fn chrono_now_ymd() -> (i64, i32, i32) {
    // Simple YYYY-MM-DD from system time without pulling in chrono
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Days since epoch
    let days = secs / 86400;
    // Algorithm to compute year/month/day from days since 1970-01-01
    let mut y = 1970i64;
    let mut remaining = days as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }
    let leap = is_leap(y);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m = 1;
    for days_in_month in month_days {
        if remaining < days_in_month {
            break;
        }
        remaining -= days_in_month;
        m += 1;
    }
    let d = remaining + 1;
    (y, m, d as i32)
}

#[allow(dead_code)]
fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn ensure_live_eval_enabled() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var("SIKONG_RUN_LIVE_AGENT_TESTS").ok().as_deref() != Some("1") {
        return Err("set SIKONG_RUN_LIVE_AGENT_TESTS=1 to run live evals".into());
    }
    if std::env::var("KIMI_CODE_API_KEY").is_err()
        && std::env::var("DEEPSEEK_API_KEY").is_err()
        && std::env::var("ANTHROPIC_API_KEY").is_err()
        && std::env::var("OPENAI_API_KEY").is_err()
    {
        return Err("set a provider API key such as DEEPSEEK_API_KEY or KIMI_CODE_API_KEY to run live evals".into());
    }
    Ok(())
}

fn run_task_run_operation_eval(
    operation: Option<String>,
    scenario: Option<String>,
    json_output: bool,
) -> Result<bool, Box<dyn std::error::Error>> {
    ensure_live_eval_enabled()?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .thread_name("siko-operation-eval")
        .enable_all()
        .build()?;
    runtime.block_on(run_task_run_operation_eval_async(
        operation,
        scenario,
        json_output,
    ))
}

async fn run_task_run_operation_eval_async(
    operation: Option<String>,
    scenario: Option<String>,
    json_output: bool,
) -> Result<bool, Box<dyn std::error::Error>> {
    let scenarios = select_operation_eval_scenarios(operation.as_deref(), scenario.as_deref())?;
    let debug = DebugConfig::from_env();
    let worker_launch = launch::resolve_agent_loop_launch(&debug, 6);
    let judge_launch = launch::resolve_agent_loop_launch(&debug, 4);
    let mut worker =
        ProcessAgentRunScheduler::new(worker_launch.command.clone(), worker_launch.args.clone());
    let mut judge = ProcessAgentRunScheduler::new(judge_launch.command, judge_launch.args);
    let mut results = Vec::new();

    for scenario in scenarios {
        let harness = OperationHarness::new(scenario.context.clone());
        let request = harness.build_agent_run();
        let started = Instant::now();
        let response = worker.run(request.clone(), CancellationToken::new()).await;
        let duration_ms = started.elapsed().as_millis();
        let decoded = harness.decode_result(response.clone());
        let decoded_summary = match &decoded {
            Ok(result) => Some(operation_result_summary(result)),
            Err(error) => Some(format!("decode_error: {}", error.message)),
        };
        let (judgement, judge_usage) = if decoded.is_ok() {
            let judge_response = judge
                .run(
                    operation_judge_request(
                        &scenario,
                        &request,
                        &response,
                        decoded_summary.as_deref(),
                    ),
                    CancellationToken::new(),
                )
                .await;
            (
                decode_operation_judgement(judge_response.terminal_call)?,
                judge_response.usage,
            )
        } else {
            (
                OperationEvalJudgement {
                    passed: false,
                    findings: vec!["operation output failed Rust protocol decoding".to_string()],
                    evidence: decoded_summary.clone().into_iter().collect(),
                },
                None,
            )
        };
        let actor_usage = response.usage.clone();
        let total_usage = sum_usage(actor_usage.as_ref(), judge_usage.as_ref());

        results.push(TaskRunOperationEvalResult {
            operation: format!("{:?}", scenario.operation),
            scenario: scenario.id.to_string(),
            expectation: scenario.expectation.to_string(),
            duration_ms,
            terminal_tool: response
                .terminal_call
                .as_ref()
                .map(|call| call.name.clone()),
            tool_calls: response
                .tool_calls
                .iter()
                .map(|call| call.name.clone())
                .collect(),
            decoded: decoded.is_ok(),
            decoded_output: decoded_summary,
            actor_usage,
            judge_usage,
            total_usage,
            judgement,
        });
    }

    let output = TaskRunOperationEvalOutput {
        passed: results
            .iter()
            .all(|result| result.decoded && result.judgement.passed),
        results,
    };

    if json_output {
        serde_json::to_writer_pretty(std::io::stdout(), &output)?;
        println!();
    } else {
        println!(
            "task-run operation eval: passed={} scenarios={}",
            output.passed,
            output.results.len()
        );
        for result in &output.results {
            println!(
                "- {}:{} passed={} decoded={} duration={}ms terminal={} usage={}",
                result.operation,
                result.scenario,
                result.judgement.passed,
                result.decoded,
                result.duration_ms,
                result.terminal_tool.as_deref().unwrap_or("<none>"),
                format_usage(&result.total_usage)
            );
            for finding in &result.judgement.findings {
                println!("  - {finding}");
            }
        }
    }

    Ok(output.passed)
}

fn select_task_run_split_eval_scenarios(
    task: Option<String>,
    scenario: Option<String>,
    scenario_file: Option<&Path>,
) -> Result<Vec<TaskRunSplitScenario>, Box<dyn std::error::Error>> {
    if let Some(path) = scenario_file {
        if task.is_some() || scenario.is_some() {
            return Err("--scenario-file cannot be combined with --task or --scenario".into());
        }
        return Ok(vec![load_task_run_split_scenario_file(path)?]);
    }

    if let Some(task) = task {
        return Ok(vec![TaskRunSplitScenario {
            id: "custom".to_string(),
            task,
            expectation: "Evaluate whether the task-run engine selected an appropriate execution shape for this custom request, without requiring decomposition when an atomic run is sufficient.".to_string(),
            workspace: TaskRunSplitWorkspace::Memory,
            max_steps: None,
        }]);
    }

    let scenario = scenario.unwrap_or_else(|| "preview-runtime".to_string());
    let scenarios = task_run_split_eval_scenarios()
        .into_iter()
        .filter(|item| scenario == "all" || item.id == scenario)
        .collect::<Vec<_>>();

    if scenarios.is_empty() {
        return Err(format!("no task-run split eval scenario matched scenario={scenario}").into());
    }

    Ok(scenarios)
}

fn load_task_run_split_scenario_file(
    path: &Path,
) -> Result<TaskRunSplitScenario, Box<dyn std::error::Error>> {
    let config = config::Config::builder()
        .add_source(
            config::File::from(path)
                .format(config::FileFormat::Yaml)
                .required(true),
        )
        .build()?;
    let file = config.try_deserialize::<TaskRunSplitScenarioFile>()?;
    file.into_scenario()
}

fn task_run_split_eval_scenarios() -> Vec<TaskRunSplitScenario> {
    vec![
        TaskRunSplitScenario {
            id: "simple-qa".to_string(),
            task: "Answer in two short paragraphs: what is a task-run engine, and when should it avoid splitting work?".to_string(),
            expectation: "This is a simple answer task. The engine may keep it atomic or use a very small plan; do not require child decomposition. Pass if it avoids unnecessary orchestration and produces a clear final answer.".to_string(),
            workspace: TaskRunSplitWorkspace::Memory,
            max_steps: None,
        },
        TaskRunSplitScenario {
            id: "design-analysis".to_string(),
            task: "Analyze this self-contained Rust-controlled agent task-run engine design and propose reliability improvements for planning, execution, verification, and logging. Design summary: Rust owns the engine state machine and workspace resources; each node first runs Specify to submit next, size, and reason; the engine maps small next work to Execute and large next work to Plan; Plan can create either Stage or Parallel child nodes; every child re-enters Specify before execution; Bun agent-host runs one agent loop per operation through terminal tools; Memory workspace is used for this eval, so produce analysis artifacts rather than editing files."
                .to_string(),
            expectation: "This is a self-contained analysis task with one primary recommendation artifact. The engine may keep it atomic if the final analysis covers planning, execution, verification, and logging with coherent reliability improvements; do not require decomposition solely because the output is structured.".to_string(),
            workspace: TaskRunSplitWorkspace::Memory,
            max_steps: None,
        },
        TaskRunSplitScenario {
            id: "small-app".to_string(),
            task: "Develop a tiny static counter application concept for a developer preview: include the HTML, CSS, JavaScript behavior, and a short run instruction. The current workspace is memory-only, so produce implementation artifacts rather than editing files.".to_string(),
            expectation: "This is a tiny application delivery task in a memory workspace. The engine may keep it atomic if the final artifact covers HTML, CSS, JavaScript behavior, and run instructions without hidden steps; do not require decomposition for such a small static artifact.".to_string(),
            workspace: TaskRunSplitWorkspace::Memory,
            max_steps: None,
        },
        TaskRunSplitScenario {
            id: "preview-runtime".to_string(),
            task: "Prepare a developer-preview readiness package for this self-contained Rust/Bun agent runtime design. Context: Rust schedules task-run nodes and owns workspace resources; Bun agent-host provides operation agent loops through terminal tools. The package has six distinct workstreams that each need their own evidence before final recommendation: launch/configuration guide, host protocol smoke-test plan, task-run divide policy review, workspace/resource lifecycle review, logging/observability checklist, and known-limits release notes. The current workspace is memory-only, so produce readiness artifacts and test plans rather than editing files."
                .to_string(),
            expectation: "This is a broad product-engineering task. The engine should split it into meaningful child work, execute those children, combine evidence, verify readiness, and commit or explain a terminal state.".to_string(),
            workspace: TaskRunSplitWorkspace::Memory,
            max_steps: None,
        },
        TaskRunSplitScenario {
            id: "sikong-project-analysis".to_string(),
            task: "Analyze the current sikong repository itself in the provided read-only git worktree. Identify the highest-leverage engineering improvements for the Rust task-run engine, agent-host/agent-loop boundary, live eval workflow, logging, and design docs. Produce a prioritized improvement report with concrete file or module evidence, tradeoffs, and the first two changes you would make next. Do not modify files."
                .to_string(),
            expectation: "This is a realistic repository-analysis task. The engine should use the git-backed workspace, inspect actual sikong files, and produce a concrete prioritized report grounded in paths/modules from the repository. It may split into meaningful analysis surfaces, but should not fabricate file evidence or return generic advice.".to_string(),
            workspace: TaskRunSplitWorkspace::CurrentGit {
                read_scope: vec![
                    "src/**/*.rs".to_string(),
                    "packages/agent-host/src/**/*.ts".to_string(),
                    "packages/agent-loop/src/**/*.ts".to_string(),
                    "design/**/*.md".to_string(),
                    "AGENTS.md".to_string(),
                ],
                write_scope: Vec::new(),
            },
            max_steps: None,
        },
        TaskRunSplitScenario {
            id: "sikong-redundancy-audit".to_string(),
            task: "Audit the current sikong repository for redundant or stale design/code surfaces after the Rust task-run refactor. Focus on src/task_run, src/agent_run, packages/agent-host, packages/agent-loop, and design docs. Produce a cleanup proposal that names likely redundant files, duplicated concepts, stale docs, or over-complex abstractions, with evidence paths and a low-risk cleanup order. Do not modify files."
                .to_string(),
            expectation: "This is a realistic redundancy audit. The engine should inspect actual repo files through the git-backed workspace and produce evidence-backed cleanup recommendations. Passing requires concrete path-level evidence and a prioritized cleanup sequence, not generic refactor advice.".to_string(),
            workspace: TaskRunSplitWorkspace::CurrentGit {
                read_scope: vec![
                    "src/task_run/**/*.rs".to_string(),
                    "src/agent_run/**/*.rs".to_string(),
                    "packages/agent-host/src/**/*.ts".to_string(),
                    "packages/agent-loop/src/**/*.ts".to_string(),
                    "design/**/*.md".to_string(),
                ],
                write_scope: Vec::new(),
            },
            max_steps: None,
        },
        TaskRunSplitScenario {
            id: "sikong-design-doc-draft".to_string(),
            task: "Inspect the current sikong repository and draft a design-document addition that explains how to run and interpret task-run live evals. Ground the draft in the actual CLI surface, logging commands, runtime profiles, and operation/task-run eval behavior. Produce the proposed markdown section plus a short note naming where it should live. Do not modify files."
                .to_string(),
            expectation: "This is a realistic documentation task. The engine should inspect actual CLI/design sources, then produce a usable markdown draft with concrete commands and interpretation guidance. It may stay atomic or split if useful, but the final artifact must be grounded in repository evidence.".to_string(),
            workspace: TaskRunSplitWorkspace::CurrentGit {
                read_scope: vec![
                    "src/cli.rs".to_string(),
                    "design/**/*.md".to_string(),
                    "development-log/**/*.md".to_string(),
                    "AGENTS.md".to_string(),
                ],
                write_scope: Vec::new(),
            },
            max_steps: None,
        },
    ]
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskRunSplitScenarioFile {
    id: String,
    task: String,
    expectation: String,
    workspace: TaskRunSplitScenarioFileWorkspace,
    #[serde(default)]
    max_steps: Option<usize>,
}

impl TaskRunSplitScenarioFile {
    fn into_scenario(self) -> Result<TaskRunSplitScenario, Box<dyn std::error::Error>> {
        Ok(TaskRunSplitScenario {
            id: self.id,
            task: self.task,
            expectation: self.expectation,
            workspace: self.workspace.into_workspace()?,
            max_steps: self.max_steps,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskRunSplitScenarioFileWorkspace {
    provider: String,
    #[serde(default)]
    read_scope: Vec<String>,
    #[serde(default)]
    write_scope: Vec<String>,
    #[serde(default)]
    allow_write: bool,
}

impl TaskRunSplitScenarioFileWorkspace {
    fn into_workspace(self) -> Result<TaskRunSplitWorkspace, Box<dyn std::error::Error>> {
        let write_scope = if self.allow_write {
            self.write_scope
        } else {
            Vec::new()
        };
        match self.provider.as_str() {
            "memory" => {
                if !self.read_scope.is_empty() {
                    return Err("memory scenario workspace must not define read_scope".into());
                }
                Ok(TaskRunSplitWorkspace::Memory)
            }
            "current-file-system" => Ok(TaskRunSplitWorkspace::CurrentFileSystem {
                read_scope: self.read_scope,
                write_scope,
            }),
            "current-git" => Ok(TaskRunSplitWorkspace::CurrentGit {
                read_scope: self.read_scope,
                write_scope,
            }),
            other => Err(format!(
                "unsupported task-run split scenario workspace provider: {other}"
            )
            .into()),
        }
    }
}

fn eval_task_root_template(
    task: &str,
    workspace: WorkspaceRequirement,
    allow_write: bool,
) -> NodeTemplate {
    NodeTemplate {
        policy: NodePolicy::Explore,
        task_type: TaskType::Explore,
        key: ProblemKey("task-run-split-eval".to_string()),
        intent: task.to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace,
        capabilities: if allow_write {
            CapabilityProfile::writable()
        } else {
            CapabilityProfile::read_only()
        },
        budget: Budget::default(),
        plan: NodePlan::Execute,
    }
}

fn eval_task_workspace_requirement(
    scenario: &TaskRunSplitScenario,
) -> Result<(WorkspaceRequirement, bool), Box<dyn std::error::Error>> {
    match &scenario.workspace {
        TaskRunSplitWorkspace::Memory => Ok((WorkspaceRequirement::memory(), false)),
        TaskRunSplitWorkspace::CurrentFileSystem {
            read_scope,
            write_scope,
        } => Ok((
            WorkspaceRequirement {
                provider: WorkspaceProvider::FileSystem,
                read_scope: read_scope.clone(),
                write_scope: write_scope.clone(),
                git: None,
            },
            !write_scope.is_empty(),
        )),
        TaskRunSplitWorkspace::CurrentGit {
            read_scope,
            write_scope,
        } => {
            let repo_root = std::env::current_dir()?;
            let worktree_root = std::env::temp_dir()
                .join("siko-live-eval-worktrees")
                .join(format!("{}-{}", std::process::id(), scenario.id));
            std::fs::create_dir_all(&worktree_root)?;
            Ok((
                WorkspaceRequirement {
                    provider: WorkspaceProvider::GitFileSystem,
                    read_scope: read_scope.clone(),
                    write_scope: write_scope.clone(),
                    git: Some(crate::GitWorkspaceRequirement {
                        repo_root,
                        worktree_root,
                        base_ref: "HEAD".to_string(),
                        fetch_remote: None,
                    }),
                },
                !write_scope.is_empty(),
            ))
        }
    }
}

#[derive(Debug, Clone)]
struct TaskRunSplitScenario {
    id: String,
    task: String,
    expectation: String,
    workspace: TaskRunSplitWorkspace,
    max_steps: Option<usize>,
}

#[derive(Debug, Clone)]
enum TaskRunSplitWorkspace {
    Memory,
    CurrentFileSystem {
        read_scope: Vec<String>,
        write_scope: Vec<String>,
    },
    CurrentGit {
        read_scope: Vec<String>,
        write_scope: Vec<String>,
    },
}

impl TaskRunSplitWorkspace {
    fn label(&self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::CurrentFileSystem { .. } => "current-file-system",
            Self::CurrentGit { .. } => "current-git",
        }
    }
}

impl TaskRunSplitScenario {
    fn actor_max_steps(&self) -> usize {
        if let Some(steps) = self.max_steps {
            return steps;
        }
        match &self.workspace {
            TaskRunSplitWorkspace::Memory => 24,
            TaskRunSplitWorkspace::CurrentFileSystem { .. }
            | TaskRunSplitWorkspace::CurrentGit { .. } => 32,
        }
    }
}

#[derive(Debug, Serialize)]
struct TaskRunSplitTranscript {
    scenario: String,
    task: String,
    expectation: String,
    workspace: String,
    root: u64,
    status: String,
    artifact: Option<u64>,
    root_children: Vec<TaskRunSplitChild>,
    agent_runs: Vec<TaskRunSplitAgentRun>,
    events: Vec<TaskRunSplitEvent>,
}

#[derive(Debug, Serialize)]
struct TaskRunSplitChild {
    id: u64,
    key: String,
    intent: String,
    plan: String,
    read_scope: Vec<String>,
    write_scope: Vec<String>,
}

#[derive(Debug, Serialize)]
struct TaskRunSplitAgentRun {
    node_id: u64,
    operation: String,
    terminal_tool: Option<String>,
    terminal_payload: Option<Value>,
    duration_ms: u128,
    usage: Option<AgentTokenUsage>,
    report: String,
}

#[derive(Debug, Serialize)]
struct TaskRunSplitEvent {
    node_id: u64,
    operation: String,
    note: String,
}

#[derive(Debug, Serialize)]
struct TaskRunSplitEvalOutput {
    passed: bool,
    results: Vec<TaskRunSplitEvalResult>,
}

#[derive(Debug, Serialize)]
struct TaskRunSplitEvalResult {
    scenario: String,
    task: String,
    expectation: String,
    duration_ms: u128,
    actor_usage: AgentTokenUsage,
    judge_usage: Option<AgentTokenUsage>,
    total_usage: AgentTokenUsage,
    judgement: TaskRunSplitJudgement,
    artifact_files: Vec<TaskRunArtifactFile>,
    transcript: TaskRunSplitTranscript,
    /// Per-operation metrics collected from agent runs.
    metrics: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize)]
struct TaskRunSplitJudgement {
    passed: bool,
    findings: Vec<String>,
    evidence: Vec<String>,
}

#[derive(Debug, Serialize)]
struct TaskRunArtifactFile {
    artifact_id: u64,
    node_id: u64,
    path: String,
}

#[derive(Debug, Serialize)]
struct TaskRunOperationEvalOutput {
    passed: bool,
    results: Vec<TaskRunOperationEvalResult>,
}

#[derive(Debug, Serialize)]
struct TaskRunOperationEvalResult {
    operation: String,
    scenario: String,
    expectation: String,
    duration_ms: u128,
    terminal_tool: Option<String>,
    tool_calls: Vec<String>,
    decoded: bool,
    decoded_output: Option<String>,
    actor_usage: Option<AgentTokenUsage>,
    judge_usage: Option<AgentTokenUsage>,
    total_usage: AgentTokenUsage,
    judgement: OperationEvalJudgement,
}

#[derive(Debug, Deserialize, Serialize)]
struct OperationEvalJudgement {
    passed: bool,
    findings: Vec<String>,
    evidence: Vec<String>,
}

#[derive(Debug, Clone)]
struct OperationEvalScenario {
    id: &'static str,
    operation: NodeOperation,
    expectation: &'static str,
    context: crate::AgentOperationContext,
}

fn sum_usage(
    actor_usage: Option<&AgentTokenUsage>,
    judge_usage: Option<&AgentTokenUsage>,
) -> AgentTokenUsage {
    [actor_usage, judge_usage]
        .into_iter()
        .flatten()
        .cloned()
        .sum()
}

fn sum_agent_run_usage(runs: &[crate::AgentRunRecord]) -> AgentTokenUsage {
    runs.iter()
        .filter_map(|run| run.usage.as_ref())
        .cloned()
        .sum()
}

fn format_usage(usage: &AgentTokenUsage) -> String {
    format!(
        "active={} total={} in={} out={} cache={} cache_read={} cache_create={}",
        usage.active_tokens(),
        usage.total_tokens,
        usage.input_tokens,
        usage.output_tokens,
        usage.cached_tokens(),
        usage.cache_read_tokens,
        usage.cache_creation_tokens
    )
}

fn select_operation_eval_scenarios(
    operation: Option<&str>,
    scenario: Option<&str>,
) -> Result<Vec<OperationEvalScenario>, Box<dyn std::error::Error>> {
    let operation = operation.unwrap_or("all");
    let scenario = scenario.unwrap_or("all");
    let scenarios = operation_eval_scenarios()
        .into_iter()
        .filter(|item| operation == "all" || operation_name(item.operation) == operation)
        .filter(|item| scenario == "all" || item.id == scenario)
        .collect::<Vec<_>>();

    if scenarios.is_empty() {
        return Err(format!(
            "no task-run operation eval scenarios matched operation={operation} scenario={scenario}"
        )
        .into());
    }

    Ok(scenarios)
}

fn operation_eval_scenarios() -> Vec<OperationEvalScenario> {
    vec![
        OperationEvalScenario {
            id: "execute",
            operation: NodeOperation::Specify,
            expectation: "Specify should produce next as the release-note polish work, size tiny or small, and a concise reason. It must not submit route, shape, or missing_info fields.",
            context: operation_context(
                NodeOperation::Specify,
                problem_node(
                    1,
                    "specify-execute",
                    "Polish one short release note paragraph.",
                    NodePlan::Execute,
                ),
                None,
                Vec::new(),
                None,
            ),
        },
        OperationEvalScenario {
            id: "split",
            operation: NodeOperation::Specify,
            expectation: "Specify should keep next focused on the developer-preview preparation work, classify its size as large or xlarge, and explain why the engine should plan it by size. It must not submit a split/execute route.",
            context: operation_context(
                NodeOperation::Specify,
                problem_node(
                    1,
                    "specify-split",
                    "Prepare a small agent runtime for a developer preview across runtime, host integration, docs, and smoke tests.",
                    NodePlan::Execute,
                ),
                None,
                Vec::new(),
                None,
            ),
        },
        OperationEvalScenario {
            id: "coherent-medium",
            operation: NodeOperation::Specify,
            expectation: "Specify should produce next as one coherent prompt/test/eval improvement, classify size as medium, and explain why it should stay together instead of being prematurely decomposed.",
            context: operation_context(
                NodeOperation::Specify,
                problem_node(
                    1,
                    "specify-coherent-medium",
                    "Improve task-run operation prompts for Specify, Execute, and Verify so local work is routed and retried correctly, then update focused harness tests and one operation eval scenario.",
                    NodePlan::Execute,
                ),
                None,
                Vec::new(),
                None,
            ),
        },
        OperationEvalScenario {
            id: "independent-evidence-surfaces",
            operation: NodeOperation::Specify,
            expectation: "Specify should preserve the single cleanup proposal intent while classifying the next work as large or xlarge because the evidence spans independently inspectable surfaces. It must not create the plan itself or submit a route field.",
            context: operation_context(
                NodeOperation::Specify,
                problem_node(
                    1,
                    "specify-independent-evidence-surfaces",
                    "Audit the repository for redundant or stale surfaces after the Rust task-run refactor. Focus on src/task_run, src/agent_run, packages/agent-host, packages/agent-loop, and design docs. Produce one cleanup proposal with evidence paths and a low-risk cleanup order.",
                    NodePlan::Execute,
                ),
                None,
                Vec::new(),
                None,
            ),
        },
        OperationEvalScenario {
            id: "git-redundancy-audit-surfaces",
            operation: NodeOperation::Specify,
            expectation: "Specify should preserve the read-only redundancy audit intent, classify its size as large or xlarge because the evidence spans independently inspectable repository surfaces, and explain that planning improves reliability before a cleanup proposal is combined. It must not create the plan itself or submit a route field.",
            context: operation_context(
                NodeOperation::Specify,
                ProblemNode {
                    workspace: WorkspaceRequirement::git([
                        "src/task_run/**/*.rs",
                        "src/agent_run/**/*.rs",
                        "packages/agent-host/src/**/*.ts",
                        "packages/agent-loop/src/**/*.ts",
                        "design/**/*.md",
                    ]),
                    ..problem_node(
                        1,
                        "specify-git-redundancy-audit-surfaces",
                        "Audit the current sikong repository for redundant or stale design/code surfaces after the Rust task-run refactor. Focus on src/task_run, src/agent_run, packages/agent-host, packages/agent-loop, and design docs. Produce a cleanup proposal that names likely redundant files, duplicated concepts, stale docs, or over-complex abstractions, with evidence paths and a low-risk cleanup order. Do not modify files.",
                        NodePlan::Execute,
                    )
                },
                None,
                Vec::new(),
                None,
            ),
        },
        OperationEvalScenario {
            id: "evidence-work",
            operation: NodeOperation::Specify,
            expectation: "Specify should make next the concrete evidence-gathering work, size that evidence work rather than the broader configuration goal, and explain why provider-specific configuration depends on that evidence. It must not use missing_info.",
            context: operation_context(
                NodeOperation::Specify,
                problem_node(
                    1,
                    "specify-evidence-work",
                    "Configure the production model provider selected by the user, but the provider choice is not present.",
                    NodePlan::Execute,
                ),
                None,
                Vec::new(),
                None,
            ),
        },
        OperationEvalScenario {
            id: "stage",
            operation: NodeOperation::Plan,
            expectation: "Plan should use mode=stage for qualitatively different phases that must happen in order.",
            context: operation_context(
                NodeOperation::Plan,
                problem_node(
                    1,
                    "plan-stage",
                    "Make a CLI preview reliable: first define scope, then implement the command, then document and smoke test it.",
                    NodePlan::NeedsPlanning,
                ),
                None,
                Vec::new(),
                None,
            ),
        },
        OperationEvalScenario {
            id: "parallel",
            operation: NodeOperation::Plan,
            expectation: "Plan should use mode=parallel for independent same-phase checks over separate surfaces.",
            context: operation_context(
                NodeOperation::Plan,
                problem_node(
                    1,
                    "plan-parallel",
                    "Review the Rust CLI, the agent-host package, and the agent-loop package for naming consistency.",
                    NodePlan::NeedsPlanning,
                ),
                None,
                Vec::new(),
                None,
            ),
        },
        OperationEvalScenario {
            id: "git-parallel-scoped",
            operation: NodeOperation::Plan,
            expectation: "Plan should use mode=parallel for independent repository evidence surfaces, create one child per major surface, and include coarse read_scope globs that narrow each child to its surface. Every item must use requires_prior_results=false.",
            context: operation_context(
                NodeOperation::Plan,
                ProblemNode {
                    workspace: WorkspaceRequirement {
                        provider: WorkspaceProvider::GitFileSystem,
                        read_scope: vec![
                            "src/task_run/**/*.rs".to_string(),
                            "src/agent_run/**/*.rs".to_string(),
                            "packages/agent-host/src/**/*.ts".to_string(),
                            "packages/agent-loop/src/**/*.ts".to_string(),
                            "design/**/*.md".to_string(),
                        ],
                        write_scope: Vec::new(),
                        git: None,
                    },
                    ..problem_node(
                        1,
                        "plan-git-parallel-scoped",
                        "Plan a read-only redundancy audit across five independent evidence surfaces: src/task_run, src/agent_run, packages/agent-host, packages/agent-loop, and design docs. Each child should inspect its own surface and produce evidence for the parent cleanup proposal.",
                        NodePlan::NeedsPlanning,
                    )
                },
                None,
                Vec::new(),
                None,
            ),
        },
        OperationEvalScenario {
            id: "simple-result",
            operation: NodeOperation::Execute,
            expectation: "Execute should produce the smallest complete artifact for an atomic memory-only task.",
            context: operation_context(
                NodeOperation::Execute,
                problem_node(
                    1,
                    "execute-simple",
                    "Write a two-sentence developer-preview readiness summary.",
                    NodePlan::Execute,
                ),
                None,
                Vec::new(),
                Some(memory_surface(Vec::new())),
            ),
        },
        OperationEvalScenario {
            id: "blocked-files",
            operation: NodeOperation::Execute,
            expectation: "Execute should report a concrete blocker instead of pretending to inspect files it cannot read.",
            context: operation_context(
                NodeOperation::Execute,
                problem_node(
                    1,
                    "execute-blocked-files",
                    "Read src/task_run and summarize module ownership.",
                    NodePlan::Execute,
                ),
                None,
                Vec::new(),
                Some(memory_surface(Vec::new())),
            ),
        },
        OperationEvalScenario {
            id: "normal",
            operation: NodeOperation::Combine,
            expectation: "Combine should integrate accepted child artifacts into one coherent parent artifact without adding unsupported facts.",
            context: operation_context(
                NodeOperation::Combine,
                problem_node(
                    1,
                    "combine-normal",
                    "Combine implementation and documentation readiness notes.",
                    NodePlan::Group(PlanGroup {
                        mode: PlanGroupMode::Parallel,
                        items: Vec::new(),
                    }),
                ),
                None,
                vec![
                    text_artifact(1, 2, "Implementation path is wired through agent-host."),
                    text_artifact(2, 3, "Documentation must include live eval commands."),
                ],
                Some(memory_surface(Vec::new())),
            ),
        },
        OperationEvalScenario {
            id: "conflict",
            operation: NodeOperation::Combine,
            expectation: "Combine should acknowledge conflict paths and describe a coherent parent-level resolution without acting as an independent investigation role.",
            context: operation_context(
                NodeOperation::Combine,
                problem_node(
                    1,
                    "combine-conflict",
                    "Merge two child changes that both update the same command documentation.",
                    NodePlan::Group(PlanGroup {
                        mode: PlanGroupMode::Parallel,
                        items: Vec::new(),
                    }),
                ),
                None,
                vec![
                    text_artifact(1, 2, "Child A documents task-run-operation usage."),
                    text_artifact(2, 3, "Child B documents task-run-split usage."),
                ],
                Some(memory_surface(vec!["design/recursive-agent-engine.md"])),
            ),
        },
        OperationEvalScenario {
            id: "accept",
            operation: NodeOperation::Verify,
            expectation: "Verify should accept a candidate that directly satisfies the node intent.",
            context: operation_context(
                NodeOperation::Verify,
                problem_node(
                    1,
                    "verify-accept",
                    "Return a two-item checklist for running operation evals.",
                    NodePlan::Execute,
                ),
                Some(text_artifact(
                    1,
                    1,
                    "1. Run one operation scenario. 2. Inspect the decoded terminal output and judge findings.",
                )),
                Vec::new(),
                None,
            ),
        },
        OperationEvalScenario {
            id: "reject",
            operation: NodeOperation::Verify,
            expectation: "Verify should reject an incomplete candidate with a retryable failure class.",
            context: operation_context(
                NodeOperation::Verify,
                problem_node(
                    1,
                    "verify-reject",
                    "Return a concrete two-item checklist for running operation evals.",
                    NodePlan::Execute,
                ),
                Some(text_artifact(1, 1, "Looks fine.")),
                Vec::new(),
                None,
            ),
        },
        OperationEvalScenario {
            id: "uncertain",
            operation: NodeOperation::Verify,
            expectation: "Verify should use need_information when acceptance depends on missing facts.",
            context: operation_context(
                NodeOperation::Verify,
                problem_node(
                    1,
                    "verify-uncertain",
                    "Validate the candidate against the user's selected production model provider. The selected provider is not present in this context; the workspace provider is only execution storage and must not be treated as the selected provider.",
                    NodePlan::Execute,
                ),
                Some(text_artifact(
                    1,
                    1,
                    "The implementation supports the provider after the user selects one.",
                )),
                Vec::new(),
                None,
            ),
        },
    ]
}

fn operation_context(
    operation: NodeOperation,
    node: ProblemNode,
    candidate: Option<Artifact>,
    child_artifacts: Vec<Artifact>,
    workspace_surface: Option<WorkspaceSurface>,
) -> crate::AgentOperationContext {
    crate::AgentOperationContext {
        node,
        operation,
        candidate,
        child_artifacts,
        workspace_surface,
    }
}

fn problem_node(id: NodeId, key: &str, intent: &str, plan: NodePlan) -> ProblemNode {
    ProblemNode {
        id,
        key: ProblemKey(key.to_string()),
        parent: None,
        intent: intent.to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        children: Vec::new(),
        status: NodeStatus::New,
        plan,
        candidate: None,
        accepted_artifact: None,
        execution_attempts: 0,
        verification_attempts: 0,
        policy: NodePolicy::Explore,
        task_type: TaskType::Explore,
    }
}

fn text_artifact(id: u64, node_id: u64, text: &str) -> Artifact {
    Artifact {
        id,
        node_id,
        content_kind: ArtifactContentKind::Text,
        text: text.to_string(),
        workspace_change: None,
        children: Vec::new(),
    }
}

fn memory_surface(conflicts: Vec<&str>) -> WorkspaceSurface {
    WorkspaceSurface {
        snapshot_id: 1,
        provider: WorkspaceProvider::Memory,
        resources: Vec::new(),
        changed_paths: Vec::new(),
        conflicts: conflicts.into_iter().map(str::to_string).collect(),
        git: None,
    }
}

fn operation_name(operation: NodeOperation) -> &'static str {
    match operation {
        NodeOperation::Specify => "specify",
        NodeOperation::Plan => "plan",
        NodeOperation::Execute => "execute",
        NodeOperation::Combine => "combine",
        NodeOperation::Verify => "verify",
        NodeOperation::Commit => "commit",
    }
}

fn operation_result_summary(result: &AgentRunResult) -> String {
    match &result.output {
        NodeOperationOutput::Specified { scope_assessment } => format!(
            "specified next={} size={:?} reason={}",
            truncate_for_eval(&scope_assessment.next, 240),
            scope_assessment.size,
            truncate_for_eval(&scope_assessment.reason, 240)
        ),
        NodeOperationOutput::Planned { group } => {
            format!("planned mode={:?} items={}", group.mode, group.items.len())
        }
        NodeOperationOutput::InvalidPlan { code, reason } => {
            if code.is_empty() {
                format!("invalid plan reason={}", truncate_for_eval(reason, 240))
            } else {
                format!(
                    "invalid plan gate={} reason={}",
                    code,
                    truncate_for_eval(reason, 240)
                )
            }
        }
        NodeOperationOutput::Executed { output } => {
            format!("executed output={}", truncate_for_eval(output, 500))
        }
        NodeOperationOutput::Combined { output } => {
            format!("combined output={}", truncate_for_eval(output, 500))
        }
        NodeOperationOutput::Verified { verdict } => format!("verified verdict={verdict:?}"),
    }
}

fn truncate_for_eval(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        format!("{}...", value.chars().take(max).collect::<String>())
    }
}

fn operation_judge_request(
    scenario: &OperationEvalScenario,
    request: &AgentRunRequest,
    response: &AgentRunResponse,
    decoded_output: Option<&str>,
) -> AgentRunRequest {
    let input = json!({
        "operation": format!("{:?}", scenario.operation),
        "scenario": scenario.id,
        "expectation": scenario.expectation,
        "request": request,
        "response": response,
        "decoded_output": decoded_output,
    });
    AgentRunRequest {
        protocol_version: 1,
        objective: format!(
            "Judge task-run {:?} scenario {}",
            scenario.operation, scenario.id
        ),
        prompt: vec![
            AgentPromptSection {
                title: "Role".to_string(),
                content: "You are an independent evaluator for one recursive task-run operation."
                    .to_string(),
            },
            AgentPromptSection {
                title: "Evaluation Context".to_string(),
                content: render_json_prompt_context(&input),
            },
            AgentPromptSection {
                title: "Rubric".to_string(),
                content: "Judge whether this isolated operation behaved like the requested operation and scenario. Pass only if it stayed inside that operation's role, used the expected terminal tool, produced a useful result for the scenario, and did not perform another operation's responsibility. Treat explicit scenario constraints such as not using legacy route, shape, or missing_info fields as hard requirements. Do not require full task completion; this is an operation-level eval."
                    .to_string(),
            },
            AgentPromptSection {
                title: "Output".to_string(),
                content: "You must finish by calling the finish_eval tool with passed, findings, and evidence. A plain text answer is invalid."
                    .to_string(),
            },
        ],
        input,
        tools: vec![eval_judgement_tool_spec()],
        terminal_tool_set: vec!["finish_eval".to_string()],
        runtime_profile: AgentRuntimeProfile::General,
        effort: None,
    }
}

fn eval_judgement_tool_spec() -> AgentToolSpec {
    AgentToolSpec {
        name: "finish_eval".to_string(),
        description: "Submit the evaluation judgement.".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "passed": { "type": "boolean" },
                "findings": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "evidence": {
                    "type": "array",
                    "items": { "type": "string" }
                }
            },
            "required": ["passed", "findings", "evidence"],
            "additionalProperties": false
        }),
    }
}

impl TaskRunSplitTranscript {
    fn from_engine(
        scenario: &TaskRunSplitScenario,
        root: u64,
        engine: &Engine<Workspaces, ProcessAgentRunScheduler>,
        report: &crate::EngineReport,
    ) -> Self {
        let root_node = engine.node(root).expect("root node should exist");
        let root_children = root_node
            .children
            .iter()
            .filter_map(|child_id| engine.node(*child_id).ok())
            .map(|node| TaskRunSplitChild {
                id: node.id,
                key: node.key.0.clone(),
                intent: node.intent.clone(),
                plan: format!("{:?}", node.plan),
                read_scope: node.workspace.read_scope.clone(),
                write_scope: node.workspace.write_scope.clone(),
            })
            .collect();
        Self {
            scenario: scenario.id.to_string(),
            task: scenario.task.clone(),
            expectation: scenario.expectation.to_string(),
            workspace: scenario.workspace.label().to_string(),
            root,
            status: format!("{:?}", report.status),
            artifact: report.artifact,
            root_children,
            agent_runs: report
                .agent_runs
                .iter()
                .map(|run| TaskRunSplitAgentRun {
                    node_id: run.node_id,
                    operation: format!("{:?}", run.operation),
                    terminal_tool: run.terminal_tool.clone(),
                    terminal_payload: run
                        .terminal_payload
                        .as_ref()
                        .map(summarize_terminal_payload),
                    duration_ms: run.duration_ms,
                    usage: run.usage.clone(),
                    report: run.report.clone(),
                })
                .collect(),
            events: report
                .events
                .iter()
                .map(|event| TaskRunSplitEvent {
                    node_id: event.node_id,
                    operation: format!("{:?}", event.operation),
                    note: event.note.clone(),
                })
                .collect(),
        }
    }
}

fn write_task_run_artifacts(
    artifact_dir: Option<&Path>,
    scenario: &TaskRunSplitScenario,
    root: u64,
    engine: &Engine<Workspaces, ProcessAgentRunScheduler>,
    report: &crate::EngineReport,
) -> Result<Vec<TaskRunArtifactFile>, Box<dyn std::error::Error>> {
    let Some(artifact_dir) = artifact_dir else {
        return Ok(Vec::new());
    };

    let scenario_dir = artifact_dir.join(sanitize_artifact_file_component(&scenario.id));
    fs::create_dir_all(&scenario_dir)?;

    let mut artifact_ids = Vec::new();
    if let Some(artifact_id) = report.artifact {
        artifact_ids.push(artifact_id);
    }
    collect_accepted_artifact_ids(root, engine, &mut artifact_ids)?;
    artifact_ids.sort_unstable();
    artifact_ids.dedup();

    artifact_ids
        .into_iter()
        .map(|artifact_id| {
            let artifact = engine
                .artifact(artifact_id)
                .map_err(|error| format!("missing task-run artifact {artifact_id}: {error:?}"))?;
            let filename = if Some(artifact_id) == report.artifact {
                format!("final-artifact-{artifact_id}.md")
            } else {
                format!("artifact-{artifact_id}-node-{}.md", artifact.node_id)
            };
            let path = scenario_dir.join(filename);
            fs::write(
                &path,
                render_task_run_artifact_file(scenario, report, artifact),
            )?;
            Ok(TaskRunArtifactFile {
                artifact_id,
                node_id: artifact.node_id,
                path: path.display().to_string(),
            })
        })
        .collect()
}

fn collect_accepted_artifact_ids(
    node_id: u64,
    engine: &Engine<Workspaces, ProcessAgentRunScheduler>,
    artifact_ids: &mut Vec<u64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let node = engine
        .node(node_id)
        .map_err(|error| format!("missing task-run node {node_id}: {error:?}"))?;
    if let Some(artifact_id) = node.accepted_artifact {
        artifact_ids.push(artifact_id);
    }
    for child_id in &node.children {
        collect_accepted_artifact_ids(*child_id, engine, artifact_ids)?;
    }
    Ok(())
}

fn render_task_run_artifact_file(
    scenario: &TaskRunSplitScenario,
    report: &crate::EngineReport,
    artifact: &Artifact,
) -> String {
    format!(
        "# Task Run Artifact\n\nscenario: {}\nstatus: {:?}\nartifact_id: {}\nnode_id: {}\n\n---\n\n{}\n",
        scenario.id, report.status, artifact.id, artifact.node_id, artifact.text
    )
}

fn sanitize_artifact_file_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "scenario".to_string()
    } else {
        trimmed.to_string()
    }
}

fn judge_request(transcript: &TaskRunSplitTranscript) -> AgentRunRequest {
    let input = json!({ "transcript": transcript });
    AgentRunRequest {
        protocol_version: 1,
        objective: "Judge task-run split quality".to_string(),
        prompt: vec![
            AgentPromptSection {
                title: "Role".to_string(),
                content: "You are an independent evaluator for a recursive task-run engine."
                    .to_string(),
            },
            AgentPromptSection {
                title: "Evaluation Context".to_string(),
                content: render_json_prompt_context(&input),
            },
            AgentPromptSection {
                title: "Rubric".to_string(),
                content: "Judge whether the engine completed a real single task run and selected an appropriate execution shape for the scenario expectation. Pass only when the final status and artifact satisfy the scenario. Inspect each run's terminal_payload when judging the route: Specify payload explains the selected next work and size; Plan payload explains stage versus parallel decomposition; Execute/Combine/Verify payloads show the submitted artifact or verdict. For simple answer, analysis, and small delivery tasks, WaitingForInfo, Pruned, Failed, missing artifact, or a blocker-only artifact is not a pass unless the scenario explicitly asks for missing-information handling. Do not require decomposition for simple tasks; penalize unnecessary splitting when the expectation says the task should remain atomic. For broad design, engineering, or application delivery tasks, expect a real Specify decision, Plan operation, meaningful child nodes or stages, child Execute operations when split, Combine when needed, verification, and a final commit or clearly justified terminal state. For git-backed repository scenarios, require concrete repository evidence such as file paths, module names, CLI commands, or design-document references from the checked-out worktree; generic advice without path-level evidence is not a pass. Child nodes must be relevant to the original task and must not be trivial copies or an over-fragmented checklist. Penalize skipped major phases, weak final artifacts, long stalls, protocol failures, or expensive runs that do not buy useful coverage. Do not treat high cache-read totals as automatically efficient: if a single run approaches or exceeds its context budget, repeatedly scans the same surface, or produces a very large artifact where decomposition would have improved coverage, record that as an efficiency or routing finding even if the scenario still passes."
                    .to_string(),
            },
            AgentPromptSection {
                title: "Output".to_string(),
                content: "You must finish by calling the finish_eval tool with passed, findings, and evidence. A plain text answer is invalid."
                    .to_string(),
            },
        ],
        input,
        tools: vec![eval_judgement_tool_spec()],
        terminal_tool_set: vec!["finish_eval".to_string()],
        runtime_profile: AgentRuntimeProfile::General,
        effort: None,
    }
}

fn summarize_terminal_payload(value: &Value) -> Value {
    const MAX_STRING_CHARS: usize = 2_000;
    match value {
        Value::String(text) if text.chars().count() > MAX_STRING_CHARS => {
            let preview = text.chars().take(MAX_STRING_CHARS).collect::<String>();
            json!({
                "preview": preview,
                "truncated": true,
                "original_chars": text.chars().count()
            })
        }
        Value::Array(items) => Value::Array(items.iter().map(summarize_terminal_payload).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), summarize_terminal_payload(value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn render_json_prompt_context(value: &Value) -> String {
    match serde_json::to_string_pretty(value) {
        Ok(json) => format!("```json\n{json}\n```"),
        Err(_) => value.to_string(),
    }
}

fn decode_judgement(
    terminal_call: Option<AgentToolCall>,
) -> Result<TaskRunSplitJudgement, Box<dyn std::error::Error>> {
    let Some(call) = terminal_call else {
        return Err("judge did not call finish_eval".into());
    };
    if call.name != "finish_eval" {
        return Err(format!("judge called unexpected terminal tool {}", call.name).into());
    }
    Ok(serde_json::from_value(call.arguments)?)
}

fn decode_operation_judgement(
    terminal_call: Option<AgentToolCall>,
) -> Result<OperationEvalJudgement, Box<dyn std::error::Error>> {
    let Some(call) = terminal_call else {
        return Err("judge did not call finish_eval".into());
    };
    if call.name != "finish_eval" {
        return Err(format!("judge called unexpected terminal tool {}", call.name).into());
    }
    Ok(serde_json::from_value(call.arguments)?)
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::task;
    use crate::{AgentRunRecord, AssistantTask, AssistantTaskEvent, EngineReport};

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

        let scenario = load_task_run_split_scenario_file(&path).unwrap();

        assert_eq!(scenario.id, "doc-review");
        assert_eq!(scenario.expectation, "Produce file-backed findings.");
        assert!(matches!(
            scenario.workspace,
            TaskRunSplitWorkspace::CurrentFileSystem {
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
            let scenario = load_task_run_split_scenario_file(&scenario_path).unwrap();
            assert!(!scenario.id.is_empty());
            assert!(!scenario.task.is_empty());
            assert!(!scenario.expectation.is_empty());
        }
    }

    #[test]
    fn scenario_file_cannot_be_combined_with_task_or_scenario() {
        let path = Path::new("evals/task-run/dogfood-doc-review.yaml");

        let task_error =
            select_task_run_split_eval_scenarios(Some("review docs".to_string()), None, Some(path))
                .unwrap_err();
        assert!(task_error.to_string().contains("cannot be combined"));

        let scenario_error =
            select_task_run_split_eval_scenarios(None, Some("simple-qa".to_string()), Some(path))
                .unwrap_err();
        assert!(scenario_error.to_string().contains("cannot be combined"));
    }

    #[test]
    fn artifact_file_component_is_filesystem_safe() {
        assert_eq!(
            sanitize_artifact_file_component("dogfood/doc review"),
            "dogfood-doc-review"
        );
        assert_eq!(sanitize_artifact_file_component("..."), "scenario");
    }

    #[test]
    fn chrono_now_month_format() {
        let month = chrono_now_month();
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
        let error = resolve_assistant_prompt_workspace(
            &test_debug_config(),
            AssistantPromptWorkspace::Memory,
            &["src/**".to_string()],
        )
        .unwrap_err();
        assert!(error.to_string().contains("--workspace current-git"));
    }

    #[test]
    fn task_run_operation_eval_selects_operation_scenarios() {
        let scenarios = select_operation_eval_scenarios(Some("verify"), Some("all")).unwrap();
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
        let error = select_operation_eval_scenarios(Some("commit"), Some("all"))
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
        assert!(is_leap(2000));
        assert!(is_leap(2024));
        assert!(is_leap(1996));
        assert!(is_leap(2400));
    }

    #[test]
    fn is_leap_returns_false_for_common_years() {
        assert!(!is_leap(2023));
        assert!(!is_leap(1900));
        assert!(!is_leap(2100));
        assert!(!is_leap(2025));
    }

    #[test]
    fn is_leap_handles_century_rule() {
        assert!(!is_leap(1700));
        assert!(!is_leap(1800));
        assert!(!is_leap(1900));
        assert!(is_leap(1600));
        assert!(is_leap(2000));
        assert!(is_leap(2400));
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
        let total = sum_usage(Some(&actor), Some(&judge));
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
        let total = sum_usage(Some(&actor), None);
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
        let total = sum_usage(None, Some(&judge));
        assert_eq!(total.input_tokens, 50);
    }

    #[test]
    fn sum_usage_with_both_none_returns_default() {
        let total = sum_usage(None, None);
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
        let _total = sum_usage(Some(&actor), Some(&judge));
        assert_eq!(actor.input_tokens, 100);
        assert_eq!(judge.input_tokens, 200);
    }

    #[test]
    fn sum_agent_run_usage_empty_slice() {
        let total = sum_agent_run_usage(&[]);
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
        let total = sum_agent_run_usage(&runs);
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
        let total = sum_agent_run_usage(&runs);
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
        let total = sum_agent_run_usage(&runs);
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
        let formatted = format_usage(&usage);
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
        let formatted = format_usage(&usage);
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
        assert_eq!(operation_name(NodeOperation::Specify), "specify");
        assert_eq!(operation_name(NodeOperation::Plan), "plan");
        assert_eq!(operation_name(NodeOperation::Execute), "execute");
        assert_eq!(operation_name(NodeOperation::Combine), "combine");
        assert_eq!(operation_name(NodeOperation::Verify), "verify");
        assert_eq!(operation_name(NodeOperation::Commit), "commit");
    }

    #[test]
    fn truncate_for_eval_preserves_short_input() {
        assert_eq!(truncate_for_eval("hello world", 20), "hello world");
    }

    #[test]
    fn truncate_for_eval_exact_fit() {
        assert_eq!(truncate_for_eval("hello", 5), "hello");
    }

    #[test]
    fn truncate_for_eval_appends_ellipsis_when_exceeding() {
        let result = truncate_for_eval("this is a long string that should be truncated", 15);
        assert_eq!(result, "this is a long ...");
    }

    #[test]
    fn truncate_for_eval_handles_empty_string() {
        assert_eq!(truncate_for_eval("", 10), "");
    }

    #[test]
    fn truncate_for_eval_handles_multi_byte_chars() {
        assert_eq!(truncate_for_eval("日本語の文字列", 4), "日本語の...");
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
        let result = render_json_prompt_context(&value);
        assert!(result.starts_with("```json"));
        assert!(result.contains("\"key\": \"value\""));
        assert!(result.contains("\"number\": 42"));
        assert!(result.ends_with("```"));
    }

    #[test]
    fn render_json_prompt_context_handles_null() {
        assert_eq!(
            render_json_prompt_context(&serde_json::Value::Null),
            "```json\nnull\n```"
        );
    }

    #[test]
    fn render_json_prompt_context_handles_array() {
        let value = serde_json::json!([1, "two", true]);
        let result = render_json_prompt_context(&value);
        assert!(result.starts_with("```json"));
        assert!(result.contains("\"two\""));
        assert!(result.ends_with("```"));
    }

    #[test]
    fn chrono_now_date_has_correct_format() {
        let date = chrono_now_date();
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
