use serde::Serialize;
use serde_json::{Value, json};

use crate::AgentToolSpec;
use crate::agent_run::{AgentPromptSection, AgentRunRequest, AgentRunResponse};
use crate::node::NodePlan;
use crate::types::NodeOperation;
use crate::workspace::WorkspaceProvider;

use super::tools::{EngineTool, EngineTools, read_operation_context_spec};
use super::{AgentOperationContext, AgentRunDecodeError, AgentRunResult};

macro_rules! operation_prompt {
    ($(
        $title:literal {
            $content:expr
        }
    )+ $(,)?) => {
        vec![
            $(
                    crate::agent_run::AgentPromptSection {
                    title: $title.to_string(),
                    content: ($content).into(),
                }
            ),+
        ]
    };
}

#[derive(Debug, Clone)]
pub struct OperationHarness {
    context: AgentOperationContext,
}

impl OperationHarness {
    pub fn new(context: AgentOperationContext) -> Self {
        Self { context }
    }

    fn context(&self) -> &AgentOperationContext {
        &self.context
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineAgentContextPacket {
    pub kind: &'static str,
    pub operation: NodeOperation,
    pub node: EngineAgentNodePacket,
    pub candidate: Option<EngineAgentArtifactPacket>,
    pub child_artifacts: Vec<EngineAgentArtifactPacket>,
    pub workspace_surface: Option<EngineAgentWorkspaceSurfacePacket>,
    pub plan: NodePlan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineAgentNodePacket {
    pub id: u64,
    pub parent: Option<u64>,
    pub key: String,
    pub intent: String,
    pub status: String,
    pub workspace: EngineAgentWorkspaceRequirementPacket,
    pub allow_write: bool,
    pub budget_max_attempts: u32,
    pub execution_attempts: u32,
    pub verification_attempts: usize,
    pub acquired: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineAgentWorkspaceRequirementPacket {
    pub provider: WorkspaceProvider,
    pub read_scope: Vec<String>,
    pub write_scope: Vec<String>,
    pub git: Option<EngineAgentGitRequirementPacket>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineAgentGitRequirementPacket {
    pub repo_root: String,
    pub worktree_root: String,
    pub base_ref: String,
    pub fetch_remote: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineAgentArtifactPacket {
    pub id: u64,
    pub node_id: u64,
    pub content_kind: String,
    pub text: String,
    pub children: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineAgentWorkspaceSurfacePacket {
    pub conflicts: Vec<String>,
    pub git_worktree_path: Option<String>,
    pub git_branch_name: Option<String>,
}

pub(super) fn finish_prompt(tools: &[&str]) -> String {
    format!(
        "Finish this run by calling one of these tools: {}. The agent loop will stop after that tool call.",
        tools.join(", ")
    )
}

fn operation_prompt_sections(
    operation: NodeOperation,
    context: &AgentOperationContext,
) -> Vec<AgentPromptSection> {
    match operation {
        NodeOperation::Specify => operation_prompt! {
            "Role" {
                "You are the specification pass for one recursive engine node."
            }
            "Node To Specify" {
                format!(
                    "Normalize node {} into a precise problem statement. Current intent: {}",
                    context.node.id, context.node.intent
                )
            }
            "Specification Standard" {
                "Clarify the objective, expected artifact, acceptance boundary, workspace assumptions, and any missing constraints. Use read_operation_context for the authoritative node packet before submitting."
            }
            "Non Goals" {
                "Do not solve the task, create child nodes, verify candidate output, or mutate workspace state during specification."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitSpecification.name()])
            }
        },
        NodeOperation::Acquire => operation_prompt! {
            "Role" {
                "You are the information acquisition pass for a blocked recursive engine node."
            }
            "Information Gap" {
                format!(
                    "Find the missing information needed to continue node {}. Current intent: {}",
                    context.node.id, context.node.intent
                )
            }
            "Evidence Standard" {
                "Use read_operation_context to inspect the requested need, then return concise evidence with provenance or reasoning strong enough for the next operation to proceed."
            }
            "Boundary" {
                "Do not create child nodes or execute workspace changes. This pass only supplies the missing information and the next plan transition."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitEvidence.name()])
            }
        },
        NodeOperation::Plan => operation_prompt! {
            "Role" {
                "You are the planning pass for one recursive engine node."
            }
            "Parent Problem" {
                format!(
                    "Plan node {} by identifying the main contradiction first. Parent intent: {}",
                    context.node.id, context.node.intent
                )
            }
            "Contradiction Analysis" {
                "Analyze the main problem before decomposing. If the work is a sequence of qualitatively different phases, choose mode stage. If the work is the same phase split across independent items, choose mode parallel. Do not encode dependency graphs."
            }
            "Planning Strategy" {
                "Use read_operation_context before submitting. Create the smallest useful item set. Stage items are executed in order. Parallel items are intended to converge independently before Combine. If an item needs further decomposition, give it a group plan of its own instead of mixing serial and parallel structure in one group."
            }
            "Non Goals" {
                "Do not execute item work or combine results here. This pass only defines one local plan group."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitPlanGroup.name()])
            }
        },
        NodeOperation::Execute => operation_prompt! {
            "Role" {
                "You are the atomic execution pass for one recursive engine node."
            }
            "Work Item" {
                format!(
                    "Solve node {} inside the allowed workspace and capability scope. Node intent: {}",
                    context.node.id, context.node.intent
                )
            }
            "Workspace Rules" {
                "Use read_operation_context before acting. If workspace_surface is present, treat it as the concrete execution surface. Respect allow_write, read_scope, write_scope, and provider details exactly. Submit only the work result; the workspace provider captures file changes and side effects."
            }
            "Execution Standard" {
                "Produce the smallest complete artifact that satisfies this node. Do not split the work, verify acceptance, or decide global task completion from this pass."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitWork.name()])
            }
        },
        NodeOperation::Combine => operation_prompt! {
            "Role" {
                "You are the convergence pass that combines accepted child artifacts."
            }
            "Integration Inputs" {
                format!(
                    "Combine {} child artifacts for parent node {}. Parent intent: {}",
                    context.child_artifacts.len(),
                    context.node.id,
                    context.node.intent
                )
            }
            "Workspace Integration" {
                "Use read_operation_context to inspect child artifacts and workspace_surface. Workspace change details are normally hidden. If conflicts are present, resolve those conflict paths as part of the combined artifact instead of treating them as deterministic failure."
            }
            "Combination Standard" {
                "Preserve accepted child work, remove contradictions, explain resolved conflicts, and submit one coherent parent-level result."
            }
            "Non Goals" {
                "Do not create new child nodes or re-run verification. Verification happens after this combined result is submitted."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitCombination.name()])
            }
        },
        NodeOperation::Verify => operation_prompt! {
            "Role" {
                "You are the verification pass for one candidate artifact."
            }
            "Candidate Under Review" {
                format!(
                    "Judge candidate output for node {} against intent: {}",
                    context.node.id, context.node.intent
                )
            }
            "Verification Lens" {
                "Use read_operation_context to inspect the candidate artifact, node constraints, workspace scope, and any child artifact evidence. Workspace change details are verified by the engine instead of model judgment."
            }
            "Verdict Standard" {
                "Accept only when the candidate satisfies the node intent and scope. Reject with actionable feedback when the same node can retry. Mark uncertain only when required information is missing rather than guessed."
            }
            "Boundary" {
                "Do not edit the artifact or workspace in verification. Return only the verdict and concise reasoning."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitVerdict.name()])
            }
        },
        NodeOperation::Commit => operation_prompt! {
            "Role" {
                "You are the commit/report pass for an accepted recursive engine node."
            }
            "Accepted Node" {
                format!(
                    "Prepare the final report signal for node {} after convergence. Node intent: {}",
                    context.node.id, context.node.intent
                )
            }
            "Report Standard" {
                "Use read_operation_context to inspect the accepted candidate. Summarize the durable result, unresolved caveats, and any operator-facing next step."
            }
            "Boundary" {
                "Do not modify artifacts, spawn new work, or re-open verification. This pass only records the accepted node as committed."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitCommit.name()])
            }
        },
    }
}

fn tools_for_operation(operation: NodeOperation) -> Vec<EngineTool> {
    match operation {
        NodeOperation::Specify => vec![EngineTool::SubmitSpecification],
        NodeOperation::Acquire => vec![EngineTool::SubmitEvidence],
        NodeOperation::Plan => vec![EngineTool::SubmitPlanGroup],
        NodeOperation::Execute => vec![EngineTool::SubmitWork],
        NodeOperation::Combine => vec![EngineTool::SubmitCombination],
        NodeOperation::Verify => vec![EngineTool::SubmitVerdict],
        NodeOperation::Commit => vec![EngineTool::SubmitCommit],
    }
}

impl OperationHarness {
    pub fn build_agent_run(&self) -> AgentRunRequest {
        let context = self.context();
        AgentRunRequest::new(
            format!("{:?} node {}", context.operation, context.node.id),
            operation_prompt_sections(context.operation, context),
            operation_input(context),
            operation_tools(context),
            operation_tool_names(context.operation),
        )
    }

    pub fn context_packet(&self) -> EngineAgentContextPacket {
        operation_context_packet(self.context())
    }

    pub fn terminal_tool_names(&self) -> Vec<String> {
        operation_tool_names(self.context().operation)
    }

    pub fn decode_result(
        &self,
        result: AgentRunResponse,
    ) -> Result<AgentRunResult, AgentRunDecodeError> {
        let allowed_tools = operation_tool_names(self.context().operation);
        match result.terminal_call {
            Some(call) if allowed_tools.contains(&call.name) => {
                let terminal_tool = call.name.clone();
                let Some(tool) = EngineTool::from_name(&terminal_tool) else {
                    return Err(AgentRunDecodeError {
                        message: format!(
                            "{}; run decode failed: terminal tool {} is not registered",
                            result.report, terminal_tool
                        ),
                        terminal_tool: Some(terminal_tool),
                    });
                };
                let output = tool
                    .decode_call(&EngineTools, call.arguments)
                    .map_err(|error| AgentRunDecodeError {
                        message: format!(
                            "{}; run decode failed: terminal tool {} payload is invalid: {}",
                            result.report, terminal_tool, error
                        ),
                        terminal_tool: Some(terminal_tool.clone()),
                    })?;

                Ok(AgentRunResult {
                    report: result.report,
                    terminal_tool: Some(terminal_tool),
                    output,
                })
            }
            Some(call) => Err(AgentRunDecodeError {
                message: format!(
                    "{}; run decode failed: scheduler called unexpected terminal tool {}",
                    result.report, call.name
                ),
                terminal_tool: Some(call.name),
            }),
            None => Err(AgentRunDecodeError {
                message: format!(
                    "{}; run decode failed: scheduler ended without required terminal tool",
                    result.report
                ),
                terminal_tool: None,
            }),
        }
    }
}

fn operation_input(context: &AgentOperationContext) -> Value {
    let packet = operation_context_packet(context);
    serde_json::to_value(&packet).unwrap_or_else(|_| {
        json!({
            "kind": "engine_operation",
            "operation": format!("{:?}", context.operation),
            "error": "failed to serialize context packet",
        })
    })
}

fn operation_tools(context: &AgentOperationContext) -> Vec<AgentToolSpec> {
    let mut tool_specs = vec![read_operation_context_spec()];
    tool_specs.extend(
        tools_for_operation(context.operation)
            .into_iter()
            .map(|tool| tool.spec()),
    );
    tool_specs
}

fn operation_context_packet(context: &AgentOperationContext) -> EngineAgentContextPacket {
    EngineAgentContextPacket {
        kind: "engine_operation",
        operation: context.operation,
        node: node_packet(context),
        candidate: context.candidate.as_ref().map(artifact_packet),
        child_artifacts: context
            .child_artifacts
            .iter()
            .map(artifact_packet)
            .collect(),
        workspace_surface: context.workspace_surface.as_ref().map(|surface| {
            EngineAgentWorkspaceSurfacePacket {
                conflicts: surface.conflicts.clone(),
                git_worktree_path: surface
                    .git
                    .as_ref()
                    .map(|git| git.worktree_path.display().to_string()),
                git_branch_name: surface.git.as_ref().map(|git| git.branch_name.clone()),
            }
        }),
        plan: context.node.plan.clone(),
    }
}

fn node_packet(context: &AgentOperationContext) -> EngineAgentNodePacket {
    let node = &context.node;
    EngineAgentNodePacket {
        id: node.id,
        parent: node.parent,
        key: node.key.0.clone(),
        intent: node.intent.clone(),
        status: format!("{:?}", node.status),
        workspace: EngineAgentWorkspaceRequirementPacket {
            provider: node.workspace.provider,
            read_scope: node.workspace.read_scope.clone(),
            write_scope: node.workspace.write_scope.clone(),
            git: node
                .workspace
                .git
                .as_ref()
                .map(|git| EngineAgentGitRequirementPacket {
                    repo_root: git.repo_root.display().to_string(),
                    worktree_root: git.worktree_root.display().to_string(),
                    base_ref: git.base_ref.clone(),
                    fetch_remote: git.fetch_remote.clone(),
                }),
        },
        allow_write: node.capabilities.allow_write,
        budget_max_attempts: node.budget.max_attempts,
        execution_attempts: node.execution_attempts,
        verification_attempts: node.verification_attempts,
        acquired: node.acquired.clone(),
    }
}

fn artifact_packet(artifact: &crate::Artifact) -> EngineAgentArtifactPacket {
    EngineAgentArtifactPacket {
        id: artifact.id,
        node_id: artifact.node_id,
        content_kind: format!("{:?}", artifact.content_kind),
        text: artifact.text.clone(),
        children: artifact.children.clone(),
    }
}

fn operation_tool_names(operation: NodeOperation) -> Vec<String> {
    tools_for_operation(operation)
        .into_iter()
        .map(|tool| tool.name().to_string())
        .collect()
}
