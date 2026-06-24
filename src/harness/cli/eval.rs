use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::{
    AgentPromptSection, AgentRunRequest, AgentRunResponse, AgentRunResult, AgentRunScheduler,
    AgentRuntimeProfile, AgentTokenUsage, AgentToolCall, AgentToolSpec, Artifact,
    ArtifactContentKind, Budget, CancellationToken, CapabilityProfile, DebugConfig, Engine, NodeId,
    NodeOperation, NodeOperationOutput, NodePlan, NodePolicy, NodeStatus, NodeTemplate,
    OperationHarness, PlanGroup, PlanGroupMode, ProblemKey, ProblemNode, ProcessAgentRunScheduler,
    SikoConfig, TaskType, WorkSize, WorkspaceProvider, WorkspaceRequirement, WorkspaceSurface,
    Workspaces,
};
use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::error;

use super::chrono;
use super::launch;

#[derive(Debug, Subcommand)]
pub enum EvalCommand {
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

pub fn run_task_run_split_eval(
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

pub fn ensure_live_eval_enabled() -> Result<(), Box<dyn std::error::Error>> {
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

pub fn run_task_run_operation_eval(
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

pub fn select_task_run_split_eval_scenarios(
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

pub fn load_task_run_split_scenario_file(
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
pub struct TaskRunSplitScenarioFile {
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
pub struct TaskRunSplitScenarioFileWorkspace {
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

pub fn eval_task_root_template(
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

pub fn eval_task_workspace_requirement(
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
pub struct TaskRunSplitScenario {
    pub id: String,
    pub task: String,
    pub expectation: String,
    pub workspace: TaskRunSplitWorkspace,
    pub max_steps: Option<usize>,
}

#[derive(Debug, Clone)]
pub enum TaskRunSplitWorkspace {
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
pub struct TaskRunSplitTranscript {
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
pub struct TaskRunSplitChild {
    id: u64,
    key: String,
    intent: String,
    plan: String,
    read_scope: Vec<String>,
    write_scope: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct TaskRunSplitAgentRun {
    node_id: u64,
    operation: String,
    terminal_tool: Option<String>,
    terminal_payload: Option<Value>,
    duration_ms: u128,
    usage: Option<AgentTokenUsage>,
    report: String,
}

#[derive(Debug, Serialize)]
pub struct TaskRunSplitEvent {
    node_id: u64,
    operation: String,
    note: String,
}

#[derive(Debug, Serialize)]
pub struct TaskRunSplitEvalOutput {
    passed: bool,
    results: Vec<TaskRunSplitEvalResult>,
}

#[derive(Debug, Serialize)]
pub struct TaskRunSplitEvalResult {
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
pub struct TaskRunSplitJudgement {
    passed: bool,
    findings: Vec<String>,
    evidence: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct TaskRunArtifactFile {
    artifact_id: u64,
    node_id: u64,
    path: String,
}

#[derive(Debug, Serialize)]
pub struct TaskRunOperationEvalOutput {
    passed: bool,
    results: Vec<TaskRunOperationEvalResult>,
}

#[derive(Debug, Serialize)]
pub struct TaskRunOperationEvalResult {
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
pub struct OperationEvalJudgement {
    passed: bool,
    findings: Vec<String>,
    evidence: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct OperationEvalScenario {
    pub id: &'static str,
    pub operation: NodeOperation,
    pub expectation: &'static str,
    context: crate::AgentOperationContext,
}

pub fn sum_usage(
    actor_usage: Option<&AgentTokenUsage>,
    judge_usage: Option<&AgentTokenUsage>,
) -> AgentTokenUsage {
    [actor_usage, judge_usage]
        .into_iter()
        .flatten()
        .cloned()
        .sum()
}

pub fn sum_agent_run_usage(runs: &[crate::AgentRunRecord]) -> AgentTokenUsage {
    runs.iter()
        .filter_map(|run| run.usage.as_ref())
        .cloned()
        .sum()
}

pub fn format_usage(usage: &AgentTokenUsage) -> String {
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

pub fn select_operation_eval_scenarios(
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

pub fn operation_context(
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

pub fn problem_node(id: NodeId, key: &str, intent: &str, plan: NodePlan) -> ProblemNode {
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
        last_verdict_reason: None,
        policy: NodePolicy::Explore,
        task_type: TaskType::Explore,
    }
}

pub fn text_artifact(id: u64, node_id: u64, text: &str) -> Artifact {
    Artifact {
        id,
        node_id,
        content_kind: ArtifactContentKind::Text,
        text: text.to_string(),
        workspace_change: None,
        children: Vec::new(),
    }
}

pub fn memory_surface(conflicts: Vec<&str>) -> WorkspaceSurface {
    WorkspaceSurface {
        snapshot_id: 1,
        provider: WorkspaceProvider::Memory,
        resources: Vec::new(),
        changed_paths: Vec::new(),
        conflicts: conflicts.into_iter().map(str::to_string).collect(),
        git: None,
    }
}

pub fn operation_name(operation: NodeOperation) -> &'static str {
    match operation {
        NodeOperation::Specify => "specify",
        NodeOperation::Plan => "plan",
        NodeOperation::Execute => "execute",
        NodeOperation::Combine => "combine",
        NodeOperation::Verify => "verify",
        NodeOperation::Commit => "commit",
    }
}

pub fn operation_result_summary(result: &AgentRunResult) -> String {
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

pub fn truncate_for_eval(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        format!("{}...", value.chars().take(max).collect::<String>())
    }
}

pub fn operation_judge_request(
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

pub fn eval_judgement_tool_spec() -> AgentToolSpec {
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

pub fn write_task_run_artifacts(
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

pub fn collect_accepted_artifact_ids(
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

pub fn render_task_run_artifact_file(
    scenario: &TaskRunSplitScenario,
    report: &crate::EngineReport,
    artifact: &Artifact,
) -> String {
    format!(
        "# Task Run Artifact\n\nscenario: {}\nstatus: {:?}\nartifact_id: {}\nnode_id: {}\n\n---\n\n{}\n",
        scenario.id, report.status, artifact.id, artifact.node_id, artifact.text
    )
}

pub fn sanitize_artifact_file_component(value: &str) -> String {
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

pub fn judge_request(transcript: &TaskRunSplitTranscript) -> AgentRunRequest {
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

pub fn summarize_terminal_payload(value: &Value) -> Value {
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

pub fn render_json_prompt_context(value: &Value) -> String {
    match serde_json::to_string_pretty(value) {
        Ok(json) => format!("```json\n{json}\n```"),
        Err(_) => value.to_string(),
    }
}

pub fn decode_judgement(
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

pub fn decode_operation_judgement(
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
