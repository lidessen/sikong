use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::time::Instant;

use clap::{CommandFactory, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use siko::{
    AcpServer, AgentAssistantLoop, AgentPromptSection, AgentRunRequest, AgentRunResponse,
    AgentRunResult, AgentRunScheduler, AgentRuntimeProfile, AgentTokenUsage, AgentToolCall,
    AgentToolSpec, Artifact, ArtifactContentKind, AssistantSession, AssistantSessionConfig,
    AssistantTaskEvent, Budget, CancellationToken, CapabilityProfile, DebugConfig, Engine,
    FileTaskStore, MemoryWorkspace, NodeId, NodeOperation, NodeOperationOutput, NodePlan,
    NodeStatus, NodeTemplate, OperationHarness, PlanGroup, PlanGroupMode, ProblemKey, ProblemNode,
    ProcessAgentRunScheduler, SikoConfig, TaskStore, WorkSize, WorkspaceProvider,
    WorkspaceRequirement, WorkspaceSurface, run_acp_stdio_server,
};
use tracing::error;
use tracing_subscriber::EnvFilter;

pub fn run(args: impl IntoIterator<Item = String>) -> i32 {
    init_tracing();
    match Cli::try_parse_from(std::iter::once("siko".to_string()).chain(args)) {
        Ok(cli) => run_cli(cli),
        Err(error) => {
            let _ = error.print();
            error.exit_code()
        }
    }
}

fn run_cli(cli: Cli) -> i32 {
    match cli.command {
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
            command: Some(AssistantCommand::Logs { task_id, json }),
        }) => match print_assistant_logs(&task_id, json) {
            Ok(()) => 0,
            Err(error) => {
                error!(%error, task_id, "failed to print assistant logs");
                eprintln!("failed to print assistant logs for {task_id}: {error}");
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
        Some(Command::Eval { command }) => match command {
            EvalCommand::TaskRunSplit {
                task,
                scenario,
                json,
            } => match run_task_run_split_eval(task, scenario, json) {
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
        },
    }
}

#[derive(Debug, Parser)]
#[command(name = "siko")]
#[command(about = "Recursive agent engine prototype")]
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
    /// Run explicit live evaluation scenarios.
    Eval {
        #[command(subcommand)]
        command: EvalCommand,
    },
}

#[derive(Debug, Subcommand)]
enum AssistantCommand {
    /// Print persisted task logs in chronological order.
    Logs {
        /// Task id to inspect.
        task_id: String,

        /// Print the raw structured log JSON.
        #[arg(long)]
        json: bool,
    },
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
        .enable_time()
        .build()?;
    runtime.block_on(run_assistant_acp_async())
}

async fn run_assistant_acp_async() -> Result<(), Box<dyn std::error::Error>> {
    let config = SikoConfig::load()?;
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(assistant_store_path(&debug))?;
    let launch = resolve_agent_host_launch(&debug);
    let assistant_loop = AgentAssistantLoop::new(ProcessAgentRunScheduler::new(
        launch.command.clone(),
        launch.args.clone(),
    ));
    let session = AssistantSession::with_worker_factory(
        assistant_loop,
        {
            let launch = launch.clone();
            move || ProcessAgentRunScheduler::new(launch.command.clone(), launch.args.clone())
        },
        AssistantSessionConfig {
            max_parallel_tasks: config.assistant.max_parallel_tasks,
            task_board_enabled: true,
            conversation_message_limit: 200,
        },
    );
    let server = AcpServer::new(store, session);
    run_acp_stdio_server(server, BufReader::new(io::stdin()), io::stdout()).await?;
    Ok(())
}

fn print_assistant_logs(
    task_id: &str,
    json_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(assistant_store_path(&debug))?;
    let task = store
        .get_task(task_id)
        .ok_or_else(|| format!("unknown task id {task_id}"))?;

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

fn assistant_store_path(debug: &DebugConfig) -> PathBuf {
    debug.data_dir().join("assistant").join("tasks.json")
}

fn format_task_log(event: &AssistantTaskEvent) -> String {
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
        format!(" payload={}", compact_json(&event.payload))
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

fn compact_json(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "<invalid-json>".to_string())
}

fn run_task_run_split_eval(
    task: Option<String>,
    scenario: Option<String>,
    json_output: bool,
) -> Result<bool, Box<dyn std::error::Error>> {
    ensure_live_eval_enabled()?;
    let scenarios = select_task_run_split_eval_scenarios(task, scenario)?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .thread_name("siko-eval")
        .enable_all()
        .build()?;
    runtime.block_on(run_task_run_split_eval_async(scenarios, json_output))
}

async fn run_task_run_split_eval_async(
    scenarios: Vec<TaskRunSplitScenario>,
    json_output: bool,
) -> Result<bool, Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    let mut results = Vec::new();

    for scenario in scenarios {
        let run_started = Instant::now();
        let launch = resolve_agent_loop_launch(&debug, 8);
        let mut engine = Engine::new(
            MemoryWorkspace::default(),
            ProcessAgentRunScheduler::new(launch.command.clone(), launch.args.clone()),
        );
        let root = engine.insert_root(eval_task_root_template(&scenario.task));
        let report = engine
            .run(root)
            .await
            .map_err(|error| format!("task run failed for scenario {}: {error:?}", scenario.id))?;
        let transcript = TaskRunSplitTranscript::from_engine(&scenario, root, &engine, &report);
        let actor_usage = sum_agent_run_usage(&report.agent_runs);

        let judge_launch = resolve_agent_loop_launch(&debug, 6);
        let mut judge = ProcessAgentRunScheduler::new(judge_launch.command, judge_launch.args);
        let judge_response = judge
            .run(judge_request(&transcript), CancellationToken::new())
            .await;
        let judge_usage = judge_response.usage.clone();
        let judgement = decode_judgement(judge_response.terminal_call)?;
        let total_usage = sum_usage(Some(&actor_usage), judge_usage.as_ref());

        results.push(TaskRunSplitEvalResult {
            scenario: scenario.id.to_string(),
            task: scenario.task,
            expectation: scenario.expectation.to_string(),
            duration_ms: run_started.elapsed().as_millis(),
            actor_usage,
            judge_usage,
            total_usage,
            judgement,
            transcript,
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
                "- {} passed={} duration={}ms agent_tokens={} judge_tokens={} total_tokens={}",
                result.scenario,
                result.judgement.passed,
                result.duration_ms,
                result.actor_usage.total_tokens,
                result
                    .judge_usage
                    .as_ref()
                    .map(|usage| usage.total_tokens)
                    .unwrap_or(0),
                result.total_usage.total_tokens
            );
            for finding in &result.judgement.findings {
                println!("  - {finding}");
            }
        }
    }

    Ok(output.passed)
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
    let worker_launch = resolve_agent_loop_launch(&debug, 6);
    let judge_launch = resolve_agent_loop_launch(&debug, 4);
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
                "- {}:{} passed={} decoded={} duration={}ms terminal={} tokens={} in={} out={} cache_read={}",
                result.operation,
                result.scenario,
                result.judgement.passed,
                result.decoded,
                result.duration_ms,
                result.terminal_tool.as_deref().unwrap_or("<none>"),
                result.total_usage.total_tokens,
                result.total_usage.input_tokens,
                result.total_usage.output_tokens,
                result.total_usage.cache_read_tokens
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
) -> Result<Vec<TaskRunSplitScenario>, Box<dyn std::error::Error>> {
    if let Some(task) = task {
        return Ok(vec![TaskRunSplitScenario {
            id: "custom",
            task,
            expectation: "Evaluate whether the task-run engine selected an appropriate execution shape for this custom request, without requiring decomposition when an atomic run is sufficient.",
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

fn task_run_split_eval_scenarios() -> Vec<TaskRunSplitScenario> {
    vec![
        TaskRunSplitScenario {
            id: "simple-qa",
            task: "Answer in two short paragraphs: what is a task-run engine, and when should it avoid splitting work?".to_string(),
            expectation: "This is a simple answer task. The engine may keep it atomic or use a very small plan; do not require child decomposition. Pass if it avoids unnecessary orchestration and produces a clear final answer.",
        },
        TaskRunSplitScenario {
            id: "design-analysis",
            task: "Analyze this self-contained Rust-controlled agent task-run engine design and propose reliability improvements for planning, execution, verification, and logging. Design summary: Rust owns the engine state machine and workspace resources; each node first runs Specify to submit next, size, and reason; the engine maps small next work to Execute and large next work to Plan; Plan can create either Stage or Parallel child nodes; every child re-enters Specify before execution; Bun agent-host runs one agent loop per operation through terminal tools; Memory workspace is used for this eval, so produce analysis artifacts rather than editing files."
                .to_string(),
            expectation: "This is a self-contained analysis task with one primary recommendation artifact. The engine may keep it atomic if the final analysis covers planning, execution, verification, and logging with coherent reliability improvements; do not require decomposition solely because the output is structured.",
        },
        TaskRunSplitScenario {
            id: "small-app",
            task: "Develop a tiny static counter application concept for a developer preview: include the HTML, CSS, JavaScript behavior, and a short run instruction. The current workspace is memory-only, so produce implementation artifacts rather than editing files.".to_string(),
            expectation: "This is a tiny application delivery task in a memory workspace. The engine may keep it atomic if the final artifact covers HTML, CSS, JavaScript behavior, and run instructions without hidden steps; do not require decomposition for such a small static artifact.",
        },
        TaskRunSplitScenario {
            id: "preview-runtime",
            task: "Prepare a developer-preview readiness package for this self-contained Rust/Bun agent runtime design. Context: Rust schedules task-run nodes and owns workspace resources; Bun agent-host provides operation agent loops through terminal tools. The package has six distinct workstreams that each need their own evidence before final recommendation: launch/configuration guide, host protocol smoke-test plan, task-run divide policy review, workspace/resource lifecycle review, logging/observability checklist, and known-limits release notes. The current workspace is memory-only, so produce readiness artifacts and test plans rather than editing files."
                .to_string(),
            expectation: "This is a broad product-engineering task. The engine should split it into meaningful child work, execute those children, combine evidence, verify readiness, and commit or explain a terminal state.",
        },
    ]
}

fn eval_task_root_template(task: &str) -> NodeTemplate {
    NodeTemplate {
        key: ProblemKey("task-run-split-eval".to_string()),
        intent: task.to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    }
}

#[derive(Debug, Clone)]
struct TaskRunSplitScenario {
    id: &'static str,
    task: String,
    expectation: &'static str,
}

#[derive(Debug, Serialize)]
struct TaskRunSplitTranscript {
    scenario: String,
    task: String,
    expectation: String,
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
}

#[derive(Debug, Serialize)]
struct TaskRunSplitAgentRun {
    node_id: u64,
    operation: String,
    terminal_tool: Option<String>,
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
    transcript: TaskRunSplitTranscript,
}

#[derive(Debug, Deserialize, Serialize)]
struct TaskRunSplitJudgement {
    passed: bool,
    findings: Vec<String>,
    evidence: Vec<String>,
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
    context: siko::AgentOperationContext,
}

fn sum_usage(
    actor_usage: Option<&AgentTokenUsage>,
    judge_usage: Option<&AgentTokenUsage>,
) -> AgentTokenUsage {
    let mut total = AgentTokenUsage::default();
    for usage in [actor_usage, judge_usage].into_iter().flatten() {
        total.input_tokens += usage.input_tokens;
        total.output_tokens += usage.output_tokens;
        total.total_tokens += usage.total_tokens;
        total.cache_read_tokens += usage.cache_read_tokens;
        total.cache_creation_tokens += usage.cache_creation_tokens;
    }
    total
}

fn sum_agent_run_usage(runs: &[siko::AgentRunRecord]) -> AgentTokenUsage {
    let mut total = AgentTokenUsage::default();
    for usage in runs.iter().filter_map(|run| run.usage.as_ref()) {
        total.input_tokens += usage.input_tokens;
        total.output_tokens += usage.output_tokens;
        total.total_tokens += usage.total_tokens;
        total.cache_read_tokens += usage.cache_read_tokens;
        total.cache_creation_tokens += usage.cache_creation_tokens;
    }
    total
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
                    NodePlan::Split,
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
                    NodePlan::Split,
                ),
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
            expectation: "Combine should integrate child artifacts into one coherent parent artifact.",
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
            expectation: "Combine should acknowledge conflict paths and describe a coherent resolution.",
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
) -> siko::AgentOperationContext {
    siko::AgentOperationContext {
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
        NodeOperationOutput::InvalidPlan { reason } => {
            format!("invalid plan reason={}", truncate_for_eval(reason, 240))
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
        engine: &Engine<MemoryWorkspace, ProcessAgentRunScheduler>,
        report: &siko::EngineReport,
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
            })
            .collect();
        Self {
            scenario: scenario.id.to_string(),
            task: scenario.task.clone(),
            expectation: scenario.expectation.to_string(),
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
                content: "Judge whether the engine completed a real single task run and selected an appropriate execution shape for the scenario expectation. Pass only when the final status and artifact satisfy the scenario. For simple answer, analysis, and small delivery tasks, WaitingForInfo, Pruned, Failed, missing artifact, or a blocker-only artifact is not a pass unless the scenario explicitly asks for missing-information handling. Do not require decomposition for simple tasks; penalize unnecessary splitting when the expectation says the task should remain atomic. For broad design, engineering, or application delivery tasks, expect a real Specify decision, Plan operation, meaningful child nodes or stages, child Execute operations when split, Combine when needed, verification, and a final commit or clearly justified terminal state. Child nodes must be relevant to the original task and must not be trivial copies or an over-fragmented checklist. Penalize skipped major phases, weak final artifacts, long stalls, protocol failures, or expensive runs that do not buy useful coverage."
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentHostLaunch {
    command: String,
    args: Vec<String>,
}

fn resolve_agent_loop_launch(debug: &DebugConfig, max_steps: usize) -> AgentHostLaunch {
    let mut launch = resolve_agent_host_launch(debug);
    let provider = std::env::var("SIKONG_AGENT_HOST_PROVIDER")
        .ok()
        .filter(|value| value == "deepseek" || value == "kimi")
        .unwrap_or_else(|| "kimi".to_string());
    let runtime = std::env::var("SIKONG_AGENT_HOST_RUNTIME")
        .ok()
        .filter(|value| value == "ai-sdk" || value == "claude-code")
        .unwrap_or_else(|| "claude-code".to_string());
    launch.args.extend(
        [
            "--worker",
            "agent-loop",
            "--provider",
            provider.as_str(),
            "--runtime",
            runtime.as_str(),
            "--max-steps",
        ]
        .into_iter()
        .map(str::to_string),
    );
    launch.args.push(max_steps.to_string());
    launch
}

fn resolve_agent_host_launch(debug: &DebugConfig) -> AgentHostLaunch {
    resolve_agent_host_launch_from(
        &|name| std::env::var(name).ok(),
        std::env::current_exe().ok().as_deref(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
        debug,
    )
}

fn resolve_agent_host_launch_from(
    env: &dyn Fn(&str) -> Option<String>,
    current_exe: Option<&Path>,
    manifest_dir: &Path,
    debug: &DebugConfig,
) -> AgentHostLaunch {
    if let Some(command) = debug
        .agent_host_command
        .clone()
        .or_else(|| non_empty_env(env, "SIKONG_AGENT_HOST_COMMAND"))
    {
        return AgentHostLaunch {
            command,
            args: Vec::new(),
        };
    }

    if let Some(script) = debug
        .agent_host_script
        .clone()
        .or_else(|| non_empty_env(env, "SIKONG_AGENT_HOST_SCRIPT"))
    {
        return bun_script_launch(env, debug, script);
    }

    if let Some(path) = sibling_agent_host_binary(current_exe) {
        return binary_launch(path);
    }

    if let Some(runtime_dir) = debug
        .runtime_dir
        .clone()
        .or_else(|| non_empty_env(env, "SIKONG_RUNTIME_DIR").map(PathBuf::from))
    {
        let path = Path::new(&runtime_dir)
            .join("bin")
            .join(agent_host_binary_name());
        if path.exists() {
            return binary_launch(path);
        }
    }

    let dev_script = manifest_dir
        .join("packages")
        .join("agent-host")
        .join("src")
        .join("runtime-host.ts");
    if dev_script.exists() {
        return bun_script_launch(env, debug, dev_script.to_string_lossy().to_string());
    }

    bun_script_launch(
        env,
        debug,
        "packages/agent-host/src/runtime-host.ts".to_string(),
    )
}

fn non_empty_env(env: &dyn Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    env(name).and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn sibling_agent_host_binary(current_exe: Option<&Path>) -> Option<PathBuf> {
    let exe = current_exe?;
    let sibling = exe.parent()?.join(agent_host_binary_name());
    sibling.exists().then_some(sibling)
}

fn binary_launch(path: impl Into<PathBuf>) -> AgentHostLaunch {
    AgentHostLaunch {
        command: path.into().to_string_lossy().to_string(),
        args: Vec::new(),
    }
}

fn bun_script_launch(
    env: &dyn Fn(&str) -> Option<String>,
    debug: &DebugConfig,
    script: String,
) -> AgentHostLaunch {
    AgentHostLaunch {
        command: non_empty_env(env, "SIKONG_BUN_COMMAND")
            .or_else(|| debug.bun_command.clone())
            .unwrap_or_else(|| "bun".to_string()),
        args: vec![script],
    }
}

fn agent_host_binary_name() -> &'static str {
    if cfg!(windows) {
        "siko-agent-host.exe"
    } else {
        "siko-agent-host"
    }
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
    use std::collections::BTreeMap;
    use std::fs;

    fn env_lookup<'a>(env: &'a BTreeMap<&'a str, &'a str>) -> impl Fn(&str) -> Option<String> + 'a {
        |name| env.get(name).map(|value| value.to_string())
    }

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
                command: Some(AssistantCommand::Logs { task_id, json: true })
            }) if task_id == "task_1"
        ));
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
                    json: false
                }
            }) if scenario == "all"
        ));
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
        let line = format_task_log(&AssistantTaskEvent {
            seq: 7,
            timestamp_ms: 1_719_000_000_000,
            level: tracing::Level::INFO.to_string(),
            kind: "agent.run".to_string(),
            source: "agent".to_string(),
            message: "completed execute".to_string(),
            node_id: Some(3),
            operation: Some(siko::NodeOperation::Execute),
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

    #[test]
    fn agent_host_launch_uses_command_override() {
        let env = BTreeMap::from([("SIKONG_AGENT_HOST_COMMAND", "/tmp/siko-agent-host")]);

        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            None,
            Path::new("/missing"),
            &test_debug_config(),
        );

        assert_eq!(
            launch,
            AgentHostLaunch {
                command: "/tmp/siko-agent-host".to_string(),
                args: Vec::new(),
            }
        );
    }

    #[test]
    fn agent_host_launch_uses_script_override_with_bun_command() {
        let env = BTreeMap::from([
            ("SIKONG_AGENT_HOST_SCRIPT", "/tmp/runtime-host.ts"),
            ("SIKONG_BUN_COMMAND", "/opt/bun"),
        ]);

        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            None,
            Path::new("/missing"),
            &test_debug_config(),
        );

        assert_eq!(
            launch,
            AgentHostLaunch {
                command: "/opt/bun".to_string(),
                args: vec!["/tmp/runtime-host.ts".to_string()],
            }
        );
    }

    #[test]
    fn agent_host_launch_prefers_sibling_release_binary() {
        let temp = tempfile::tempdir().unwrap();
        let exe = temp.path().join("siko");
        let host = temp.path().join(agent_host_binary_name());
        fs::write(&exe, "").unwrap();
        fs::write(&host, "").unwrap();
        let env = BTreeMap::new();

        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            Some(&exe),
            Path::new("/missing"),
            &test_debug_config(),
        );

        assert_eq!(launch, binary_launch(host));
    }

    #[test]
    fn agent_host_launch_uses_runtime_bundle_binary() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let host = bin.join(agent_host_binary_name());
        fs::write(&host, "").unwrap();
        let runtime_dir = temp.path().to_string_lossy().to_string();
        let env = BTreeMap::from([("SIKONG_RUNTIME_DIR", runtime_dir.as_str())]);

        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            None,
            Path::new("/missing"),
            &test_debug_config(),
        );

        assert_eq!(launch, binary_launch(host));
    }

    #[test]
    fn agent_host_launch_falls_back_to_dev_script() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp
            .path()
            .join("packages")
            .join("agent-host")
            .join("src")
            .join("runtime-host.ts");
        fs::create_dir_all(script.parent().unwrap()).unwrap();
        fs::write(&script, "").unwrap();
        let env = BTreeMap::new();

        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            None,
            temp.path(),
            &test_debug_config(),
        );

        assert_eq!(
            launch,
            AgentHostLaunch {
                command: "bun".to_string(),
                args: vec![script.to_string_lossy().to_string()],
            }
        );
    }

    #[test]
    fn agent_host_launch_uses_debug_command() {
        let debug = DebugConfig {
            agent_host_command: Some("/configured/siko-agent-host".to_string()),
            ..DebugConfig::default()
        };
        let env = BTreeMap::new();

        let launch =
            resolve_agent_host_launch_from(&env_lookup(&env), None, Path::new("/missing"), &debug);

        assert_eq!(
            launch,
            AgentHostLaunch {
                command: "/configured/siko-agent-host".to_string(),
                args: Vec::new(),
            }
        );
    }

    #[test]
    fn agent_host_launch_uses_debug_script_and_bun_command() {
        let debug = DebugConfig {
            bun_command: Some("/configured/bun".to_string()),
            agent_host_script: Some("/configured/runtime-host.ts".to_string()),
            ..DebugConfig::default()
        };
        let env = BTreeMap::new();

        let launch =
            resolve_agent_host_launch_from(&env_lookup(&env), None, Path::new("/missing"), &debug);

        assert_eq!(
            launch,
            AgentHostLaunch {
                command: "/configured/bun".to_string(),
                args: vec!["/configured/runtime-host.ts".to_string()],
            }
        );
    }
}
