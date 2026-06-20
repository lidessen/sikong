use serde::Serialize;
use serde_json::{Value, json};

use crate::AgentToolSpec;
use crate::agent_run::{AgentEffort, AgentPromptSection, AgentRunRequest, AgentRunResponse};
use crate::workspace::WorkspaceProvider;

use super::tools::{EngineTool, EngineTools, read_operation_context_spec};
use super::{
    AgentOperationContext, AgentRunDecodeError, AgentRunResult, Artifact, NodeOperation, NodePlan,
    ScopeAssessment, WorkSize,
};

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
    pub size: WorkSize,
    pub scope_assessment: Option<ScopeAssessment>,
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

fn context_access_section() -> AgentPromptSection {
    AgentPromptSection {
        title: "Context Access".to_string(),
        content: "The operation context is injected into this run. Use read_operation_context when you need the authoritative packet, full node details, candidate artifact, child artifacts, or workspace surface before submitting."
            .to_string(),
    }
}

fn with_context_access(mut sections: Vec<AgentPromptSection>) -> Vec<AgentPromptSection> {
    sections.insert(1, context_access_section());
    sections
}

fn operation_prompt_sections(
    operation: NodeOperation,
    context: &AgentOperationContext,
) -> Vec<AgentPromptSection> {
    match operation {
        NodeOperation::Specify => with_context_access(operation_prompt! {
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
                "Turn the raw intent into a stable work brief: what result would matter, what boundary keeps it from drifting, what workspace assumptions shape the work, and what specific fact would block even a responsible scope judgement. Assess the node intent itself, not the cost of this Specify pass. The engine will choose the next operation from your scope assessment."
            }
            "Scope Reading" {
                "Pick the smallest safe size by cognitive load, not by artifact type. tiny feels like a direct answer from injected context. small feels like one local problem with one obvious verification path. medium feels like one coherent change or analysis that may touch several related facts or files. large feels like ordered phases, shared evidence feeding later work, or several concerns that deserve separate verification. xlarge feels like multiple independent targets or repo-wide exploration that would make one run brittle."
            }
            "Scope Examples" {
                "Use these as analogies, not rules. A direct explanation from the current message is tiny. A local API rename with a focused test is small. One coherent feature or design review across related files is medium. A phased migration, repo-wide audit, or several independent packages is large or xlarge."
            }
            "Shape Reading" {
                "Read the shape of the problem. atomic means one coherent responsibility. phased means the understanding changes as work progresses, such as inspect then change then validate. independent_areas means several weakly coupled surfaces can be explored separately before convergence. unknown is only for cases where the injected context is genuinely insufficient to classify the work."
            }
            "Missing Information" {
                "Ask for missing information only when one concrete absent fact blocks a responsible next step. Do not ask for ordinary implementation choices, local acceptance details, or constraints that a later Plan or Execute pass can refine. If the intent already identifies a local area, do not ask which exact file, prompt string, or test to inspect; that discovery belongs to Execute. If the work is broad but understandable, submit missing_info as null and let the engine route it."
            }
            "Non Goals" {
                "Do not solve the task, create the plan, verify a candidate, combine child work, or mutate workspace state. This pass only makes the node legible enough for the engine to route safely."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitSpecification.name()])
            }
        }),
        NodeOperation::Acquire => with_context_access(operation_prompt! {
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
                "Return only the evidence that unblocks the next routing decision: facts, provenance when available, reasoning when provenance is internal, and any uncertainty that should remain visible. Do not turn this into a broad research task."
            }
            "Boundary" {
                "Do not create child nodes, choose a plan, or execute workspace changes. This pass supplies missing information evidence so the engine can re-run Specify with better context."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitEvidence.name()])
            }
        }),
        NodeOperation::Plan => with_context_access(operation_prompt! {
            "Role" {
                "You are the planning pass for one recursive engine node."
            }
            "Parent Problem" {
                format!(
                    "Plan node {} by understanding the main contradiction first. Parent intent: {}",
                    context.node.id, context.node.intent
                )
            }
            "Planning Lens" {
                "Find the load-bearing 30% of this parent problem: the pressure that determines the shape of the rest. Decompose only around that pressure. Keep child intent clear enough that each child can re-enter Specify and solve its own local 70% without being micromanaged by this plan."
            }
            "Group Shape" {
                "Choose stage when the parent problem wants a changing line of thought: each item transforms the understanding for the next item, and early evidence should shape later work. Choose parallel when the parent problem wants several comparable evidence surfaces explored independently before a later convergence pass. Do not invent dependency graphs; if sibling output must be interpreted together, leave that synthesis to Combine."
            }
            "Planning Strategy" {
                "Create the smallest useful item set that preserves the parent shape. A good child is a coherent responsibility, not a checklist row. This Plan pass defines only the current local group; child nodes always re-enter Specify, so do not decide child split/execute here."
            }
            "Plan Item Shape" {
                "Each item should describe one child node. Prefer key and intent. Include size, shape, reference_match, and scope_signals when useful to preserve the sizing reason. Use shape values atomic, phased, independent_areas, or unknown. Write scope_signals as an array of short strings. You may also use title, description, and verification; the engine will keep the description and append verification as the child acceptance note. Do not include plan.kind or nested groups in plan items."
            }
            "Non Goals" {
                "Do not execute item work or combine results here. This pass only defines one local plan group."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitPlanGroup.name()])
            }
        }),
        NodeOperation::Execute => with_context_access(operation_prompt! {
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
                "If workspace_surface is present, treat it as the concrete execution surface. Respect allow_write, read_scope, write_scope, and provider details exactly. Submit only the work result; the workspace provider captures file changes and side effects."
            }
            "Execution Standard" {
                "Produce the smallest complete artifact that satisfies this node. Work like a competent owner of this local slice: inspect the relevant context, make the local change or answer, and run focused checks when the workspace and capability scope allow it. Include the useful evidence in the submitted result. Do not split the work, claim final task acceptance, or decide global completion from this pass."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitWork.name()])
            }
        }),
        NodeOperation::Combine => with_context_access(operation_prompt! {
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
                "Workspace change details are normally hidden. If conflicts are present, resolve those conflict paths as part of the combined artifact instead of treating them as deterministic failure."
            }
            "Combination Standard" {
                "Reconstruct the parent-level result from the accepted child evidence. Do not paste child outputs together. Preserve what matters, discard duplicate or local scaffolding, resolve contradictions against the parent intent, and make remaining caveats explicit. If the children represent parallel evidence surfaces, synthesize the common conclusion and the meaningful differences."
            }
            "Non Goals" {
                "Do not create new child nodes or re-run verification. Verification happens after this combined result is submitted."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitCombination.name()])
            }
        }),
        NodeOperation::Verify => with_context_access(operation_prompt! {
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
                "Judge the candidate artifact against the node constraints, workspace scope, and any child artifact evidence. Workspace change details are verified by the engine instead of model judgment."
            }
            "Verdict Standard" {
                "Use this judgement model. If a concrete external fact is missing from the operation context, return verdict=need_information with the specific missing fact. If the candidate satisfies the node intent and scope with available evidence, accept it. If it falls short but the same node can repair it, reject with feedback written for the next Execute attempt: what is missing, what evidence shows the gap, and what a corrected artifact should change. Do not reject based on style preference alone."
            }
            "Boundary" {
                "Do not edit the artifact or workspace in verification. Return only the verdict and concise reasoning that helps the engine either converge or retry efficiently."
            }
            "Completion" {
                finish_prompt(&[EngineTool::SubmitVerdict.name()])
            }
        }),
        NodeOperation::Commit => {
            panic!("Commit is an engine-only event and must not build an agent run")
        }
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
        NodeOperation::Commit => {
            panic!("Commit is an engine-only event and must not expose agent tools")
        }
    }
}

impl OperationHarness {
    pub fn build_agent_run(&self) -> AgentRunRequest {
        let context = self.context();
        let request = AgentRunRequest::new(
            format!("{:?} node {}", context.operation, context.node.id),
            operation_prompt_sections(context.operation, context),
            operation_input(context),
            operation_tools(context),
            operation_tool_names(context.operation),
        );
        match context.operation {
            NodeOperation::Plan => request.with_effort(AgentEffort::Max),
            _ => request,
        }
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
        size: node.size,
        scope_assessment: node.scope_assessment.clone(),
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

fn artifact_packet(artifact: &Artifact) -> EngineAgentArtifactPacket {
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
