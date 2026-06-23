use serde::Serialize;
use serde_json::{Value, json};

use crate::AgentToolSpec;
use crate::common::workspace::WorkspaceProvider;
use crate::core::agent_run::{
    AgentEffort, AgentPromptSection, AgentRunRequest, AgentRunResponse, AgentRuntimeProfile,
};
use crate::harness::governance::{
    GovernanceGate, GovernanceLayer, active_hard_gates_for, governance_layer_for,
};

use super::tools::{EngineTool, EngineTools};
use super::{
    AgentOperationContext, AgentRunDecodeError, AgentRunResult, Artifact, NodeOperation, NodePlan,
    NodePolicy, ScopeAssessment, TaskType, WorkSize,
};

macro_rules! operation_prompt {
    ($(
        $title:literal {
            $content:expr
        }
    )+ $(,)?) => {
        vec![
            $(
                    crate::core::agent_run::AgentPromptSection {
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
    pub governance: EngineAgentGovernancePacket,
    pub node: EngineAgentNodePacket,
    pub candidate: Option<EngineAgentArtifactPacket>,
    pub child_artifacts: Vec<EngineAgentArtifactPacket>,
    pub workspace_surface: Option<EngineAgentWorkspaceSurfacePacket>,
    pub plan: NodePlan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineAgentGovernancePacket {
    pub layer: GovernanceLayer,
    pub hard_gates: Vec<EngineAgentGovernanceGatePacket>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineAgentGovernanceGatePacket {
    pub id: &'static str,
    pub description: &'static str,
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
    pub verification_attempts: u32,
    pub policy: NodePolicy,
    pub task_type: TaskType,
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
    pub file_system_root_path: Option<String>,
    pub git_worktree_path: Option<String>,
    pub git_branch_name: Option<String>,
}

pub(super) fn finish_prompt(tools: &[&str]) -> String {
    format!(
        "Finish this run by calling one of these tools: {}. The agent loop will stop after that tool call.",
        tools.join(", ")
    )
}

fn operation_context_section(context: &AgentOperationContext) -> AgentPromptSection {
    AgentPromptSection {
        title: "Operation Context".to_string(),
        content: render_context_json(&operation_input(context)),
    }
}

fn with_operation_context(
    context: &AgentOperationContext,
    mut sections: Vec<AgentPromptSection>,
) -> Vec<AgentPromptSection> {
    sections.insert(1, operation_context_section(context));
    sections
}

fn render_context_json(value: &Value) -> String {
    match serde_json::to_string_pretty(value) {
        Ok(json) => format!("```json\n{json}\n```"),
        Err(_) => value.to_string(),
    }
}

fn operation_prompt_sections(context: &AgentOperationContext) -> Vec<AgentPromptSection> {
    match context.operation {
        NodeOperation::Specify => with_operation_context(
            context,
            operation_prompt! {
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
                    "Turn the raw intent into the next useful unit of work without dropping stated responsibilities or adding new ones. Submit next as an intent-preserving rewrite that can be passed directly to Execute or Plan. Do not make the task more specific than the raw intent and Operation Context support. Submit size as the size of that next unit, using exactly one schema value: tiny, small, medium, large, x_large. Size controls execution shape: tiny, small, and medium normally execute as one node; large and x_large are planned before execution. Multiple named files, modules, operations, tests, or eval scenarios are signals, not a decision rule: keep them together when they form one coherent change package with one shared purpose and one verification loop; choose large or x_large only when the current intent contains separate goals, ordered phases, or independently verifiable work packages."
                }
                "Attention Contract" {
                    "This pass defines the next parent contract, not the local solution. Preserve the attention boundary: the user's current intent, the next work boundary, and the evidence boundary that determines whether this node should stay atomic or enter Plan. Let later Execute or child nodes own local execution."
                }
                "Size Reading" {
                    "Pick the smallest safe size by coordination cost while preserving the user's full current intent. tiny is a direct answer from current context. small is one local problem with one obvious verification path. medium is one coherent responsibility or coherent change package whose evidence cannot usefully be accepted in separate parts, even if it touches several nearby files, prompts, tests, or eval cases. large means planning reduces risk because the work has ordered phases, shared evidence feeding later work, multiple independently accepted deliverables, separate responsibilities that deserve separate verification, or a single final proposal built from several independently inspectable evidence surfaces. x_large means multiple independent targets or product delivery across several major surfaces."
                }
                "Evidence Surface Reading" {
                    "Judge evidence boundaries before judging the final artifact shape. A single final document or recommendation can still be large when it depends on several independent evidence surfaces. If each surface could be inspected, accepted, or rejected without knowing the others first, choose large or x_large: planning improves reliability by giving each surface its own context and evidence boundary before Combine synthesizes the final artifact. Do not treat 'same theme', 'one report', 'cross-surface comparison', or 'one worker can hold the context' as enough reason to keep the work medium. Cross-surface comparison is usually a Combine responsibility after child surfaces have produced evidence; it is not a reason to make evidence collection atomic. A repository audit across several top-level subsystems, packages, runtime boundaries, eval surfaces, or doc families should enter Plan unless the user only asked for a plan document. A local change means one behavior or one code path with supporting prompt/test/eval/doc updates. Separate packages, subsystems, runtime boundaries, or doc families named as audit targets are independent evidence surfaces, not nearby parts of one local change. Keep the work medium only when the evidence is useful only when inspected together from the start."
                }
                "Medium Versus Large" {
                    "Do not count surfaces mechanically. A prompt change plus focused harness tests plus one eval scenario can still be medium when all pieces serve the same behavioral fix. Runtime implementation plus host integration plus documentation plus smoke tests is usually large because those are separate work packages with different acceptance surfaces. When unsure, ask whether splitting would make the result more reliable or only add coordination overhead; if splitting only adds overhead, keep the next unit medium."
                }
                "Boundary" {
                    "Information gathering is not a special route. If the raw intent cannot be meaningfully worked without a missing user choice, missing external fact, or missing input location, make next the concrete evidence-gathering work and size that work. Otherwise keep the user's requested work intact and let Execute or Plan handle the local details."
                }
                "Constraints" {
                    "Use tools in this pass only for targeted look to avoid mis-sizing or losing the user's intent; do not perform broad inspection, implementation, verification, or evidence collection here."
                }
                "Completion" {
                    finish_prompt(&[EngineTool::SubmitSpecification.name()])
                }
            },
        ),
        NodeOperation::Plan => with_operation_context(
            context,
            operation_prompt! {
                "Role" {
                    "You are the planning pass for one recursive engine node."
                }
                "Parent Problem" {
                    format!(
                        "Plan node {} by understanding the main contradiction first. Parent intent: {}",
                        context.node.id, context.node.intent
                    )
                }
                "Leverage Parent Context" {
                    "When the parent Operation Context already names independent evidence surfaces, such as module directories, package paths, doc families, runtime boundaries, or explicit audit targets, produce child scopes from that boundary directly. Do not read representative files, inspect workspace paths, or enumerate those surfaces just to decide the plan. If a human lead could assign child scopes from the parent context, use that same level of specificity in the plan items. Use tools only when the boundary is genuinely ambiguous or missing."
                }
                "Group Rules" {
                    format!(
                        "{}\n\n{}\n\n{}",
                        "Find the parent problem's attention boundary: the pressure that determines the shape of the rest. Decompose only around that pressure. Keep child intent clear enough that each child can re-enter Specify and solve its own local problem without being micromanaged by this plan.",
                        "Plan is the method layer for divide-and-conquer. The parent owns the mainline, group mode, child boundaries, and acceptance evidence. Children own local investigation and tactics. Divide only where it lowers global attention cost: ordered phases become stage; independent evidence surfaces become parallel; a coherent local change stays one child.",
                        "Create the smallest useful non-empty item set that preserves the parent shape. A good child is a natural next-level subproblem with its own main contradiction, not a checklist row. This Plan pass defines only the current local group; child nodes always re-enter Specify, so do not force them to execute and do not pre-expand their internal plan here.",
                    )
                }
                "Group Shape" {
                    "Choose stage when the parent problem uses ordered language such as first/then/after, or when each item changes the understanding needed for the next item. Choose parallel only when every item can start immediately and does not need outputs from any sibling item. Do not invert these modes: ordered phases are stage; mutually independent peer surfaces are parallel."
                }
                "Item Shape" {
                    format!(
                        "{}\n\n{}",
                        "Each item should describe one child node. Submit at least one item, and normally one item per ordered phase or independent surface named by the parent intent. Prefer key and intent. Keep child intents concise and outcome-level. Include requires_prior_results for every item: use false when it can run from the parent context alone, and true only when it must wait for earlier item outputs. In parallel mode every item must use requires_prior_results=false. Do not add a synthesis, summary, final-report, or convergence item to a parallel group; the parent Combine pass performs that integration after child artifacts are accepted. Include size and reason when useful to preserve why the child is that size. If the parent has a file workspace and a child owns a narrower evidence surface, include read_scope as coarse glob strings within the parent scope, such as src/task_run/**/*.rs; include write_scope only when the child may write and needs a narrower write surface. Leave scopes empty when the child should inherit the parent workspace unchanged. You may also use title, description, and verification when they clarify acceptance without micromanaging execution. Use policy=decompose when a child is itself large enough to need further decomposition (up to 3 levels deep). Children with decompose policy will be automatically routed through their own Plan phase. Do not include plan.kind or nested groups in plan items.",
                        "Recursive planning is allowed and sometimes required. A child may later split again when it still contains multiple independent deliverables, ordered phases, or more work than one coherent artifact can safely hold. That second split should be decided by the child Specify/Plan pass, not precomputed by the parent. The engine supports up to 3 levels of recursive decomposition: parent plans children, children with decompose policy plan their own children, and those grandchildren execute as leaf nodes. Use policy=decompose on plan items that should be further broken down rather than executed directly.",
                    )
                }
                "Completion" {
                    finish_prompt(&[EngineTool::SubmitPlanGroup.name()])
                }
            },
        ),
        NodeOperation::Execute => with_operation_context(
            context,
            operation_prompt! {
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
                    format!(
                        "If workspace_surface is present, treat it as the concrete execution surface. Respect read_scope, write_scope, provider details, and allow_write exactly. read_scope controls what files may be read. allow_write controls mutation only; do not report a write-permission blocker for read-only inspection work. Submit only the work result; the workspace provider captures file changes and side effects. If the work asks you to inspect files or external state but read_scope is empty and the context provides no readable surface, say exactly that no readable file or external evidence surface is available.\n\nWrite permission: {} (allow_write={})",
                        if context.node.capabilities.allow_write { "enabled" } else { "disabled" },
                        context.node.capabilities.allow_write,
                    )
                }
                "Constraints" {
                    format!(
                        "{}\n\n{}\n\n{}\n\n{}",
                        "If the node asks for a self-contained analysis, design proposal, readiness package, test plan, explanation, or memory-only artifact, do the work from the supplied task text and operation context. Empty read_scope is not a blocker for that kind of work. Keep unknown details at the appropriate abstraction level; submit a blocker only when the node explicitly requires evidence that is unavailable.",
                        "If the node asks you to inspect, cite, compare, or make factual claims about external URLs, repositories, docs, current releases, or other outside state, use available web or retrieval tools to observe that evidence before submitting factual claims. If no retrieval tool or supplied evidence is available, submit that evidence gap as the work result instead of reconstructing details from model memory.",
                        "Produce the smallest complete artifact that satisfies this node from Operation Context and the allowed workspace surface. Work like a competent owner of this local slice: inspect the relevant context, make the local change or answer, and run focused checks when the workspace and capability scope allow it. Include the useful evidence in the submitted result. Do not split the work, claim final task acceptance, or decide global completion from this pass.",
                        "Own local execution inside this node. Choose the concrete inspection path, implementation tactic, and focused evidence that best satisfies the node. If you discover that the parent intent, workspace boundary, or acceptance evidence is wrong, submit that as the result or blocker instead of silently changing the parent contract.",
                    )
                }
                "Completion" {
                    finish_prompt(&[EngineTool::SubmitWork.name()])
                }
            },
        ),
        NodeOperation::Combine => with_operation_context(
            context,
            operation_prompt! {
                "Role" {
                    "You are the parent execution pass resuming after child artifacts have been accepted."
                }
                "Integration Inputs" {
                    format!(
                        "Synthesize {} accepted child artifacts for parent node {}. Parent intent: {}",
                        context.child_artifacts.len(),
                        context.node.id,
                        context.node.intent
                    )
                }
                "Workspace Integration" {
                    "Workspace change details are normally hidden. If conflicts are present, resolve those conflict paths as part of the parent artifact instead of treating them as deterministic failure. Operation Context is the complete available input for this pass; do not defer by saying you will inspect files or gather more context."
                }
                "Parent Synthesis Standard" {
                    format!(
                        "{}\n\n{}",
                        "Produce the parent-level artifact from accepted child evidence already present in Operation Context. Do not paste child outputs together, do not restart child work, and do not introduce new factual claims that are not supported by child artifacts or parent context. Preserve what matters, discard duplicate or local scaffolding, resolve contradictions against the parent intent, and make remaining caveats explicit. If children represent parallel evidence surfaces, synthesize the common conclusion and meaningful differences. A useful conflict resolution names the conflict path, states how accepted child artifacts should be woven together, and submits the merged parent-level artifact.",
                        "Act as the same parent that delegated the children, not as a new independent role. Accept compressed child artifacts as the evidence surface, not the full trace. Preserve the parent mainline, integrate what supports it, reject or qualify weak evidence, and surface any child result that would require changing the parent contract.",
                    )
                }
                "Completion" {
                    finish_prompt(&[EngineTool::SubmitCombination.name()])
                }
            },
        ),
        NodeOperation::Verify => with_operation_context(
            context,
            operation_prompt! {
                "Role" {
                    "You are the verification pass for one candidate artifact."
                }
                "Candidate Under Review" {
                    format!(
                        "Judge candidate output for node {} against intent: {}",
                        context.node.id, context.node.intent
                    )
                }
                "Verdict Standard" {
                    "Use this judgement model. The verdict value must be exactly one of: accept, reject, need_information. If acceptance depends on a concrete fact missing from Operation Context, return verdict=need_information with the specific missing fact. If the candidate satisfies the node intent and scope with available evidence, return verdict=accept. If it falls short but the same node can repair it, return verdict=reject with feedback written for the next Execute attempt: what is missing, what evidence shows the gap, and what a corrected artifact should change. If the candidate reports no readable workspace surface, verify that claim against Operation Context instead of assuming one exists. Empty read_scope is not missing information for self-contained analysis, design proposal, readiness package, test plan, explanation, or memory-only artifact work unless the node explicitly requires unavailable evidence. Do not reject based on style preference alone."
                }
                "Constraints" {
                    format!(
                        "{}\n\n{}\n\n{}",
                        "Judge the candidate artifact against the node intent, workspace scope, and any child artifact evidence present in Operation Context. Workspace change details are verified by the engine instead of model judgment. Verify against the node intent and available context, not against extra requirements introduced along the way.",
                        "When the node intent asks for concrete evidence from external URLs, repositories, project docs, current releases, or other outside state, do not accept factual claims that are only reconstructed from training knowledge or unstated memory. Accept only if the candidate cites observed evidence supplied in Operation Context or gathered during execution; otherwise return reject or need_information and name the missing external evidence.",
                        "Do not edit the artifact or workspace in verification. Return only the verdict and concise reasoning that helps the engine either converge or retry efficiently.",
                    )
                }
                "Completion" {
                    finish_prompt(&[EngineTool::SubmitVerdict.name()])
                }
            },
        ),
        NodeOperation::Commit => {
            panic!("Commit is an engine-only event and must not build an agent run")
        }
    }
}


fn tools_for_operation(operation: NodeOperation) -> Vec<EngineTool> {
    match operation {
        NodeOperation::Specify => vec![EngineTool::SubmitSpecification],
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
            operation_prompt_sections(context),
            operation_input(context),
            operation_tools(context),
            operation_tool_names(context.operation),
        )
        .with_runtime_profile(runtime_profile_for_operation(context));
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

fn runtime_profile_for_operation(context: &AgentOperationContext) -> AgentRuntimeProfile {
    if matches!(context.operation, NodeOperation::Specify)
        || (matches!(context.operation, NodeOperation::Verify)
            && context.workspace_surface.is_none())
    {
        return AgentRuntimeProfile::General;
    }

    match context.node.workspace.provider {
        WorkspaceProvider::FileSystem | WorkspaceProvider::GitFileSystem => {
            AgentRuntimeProfile::Code
        }
        WorkspaceProvider::Memory => AgentRuntimeProfile::General,
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
    tools_for_operation(context.operation)
        .into_iter()
        .map(|tool| tool.spec())
        .collect()
}

fn operation_context_packet(context: &AgentOperationContext) -> EngineAgentContextPacket {
    EngineAgentContextPacket {
        kind: "engine_operation",
        operation: context.operation,
        governance: governance_packet(context.operation),
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
                file_system_root_path: surface.resources.iter().find_map(
                    |resource| match &resource.metadata {
                        crate::WorkspaceResourceMetadata::FileSystemDirectory(directory) => {
                            Some(directory.root_path.display().to_string())
                        }
                        _ => None,
                    },
                ),
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

fn governance_packet(operation: NodeOperation) -> EngineAgentGovernancePacket {
    EngineAgentGovernancePacket {
        layer: governance_layer_for(operation).unwrap_or(GovernanceLayer::Arch),
        hard_gates: active_hard_gates_for(operation)
            .iter()
            .copied()
            .map(gate_packet)
            .collect(),
    }
}

fn gate_packet(gate: GovernanceGate) -> EngineAgentGovernanceGatePacket {
    EngineAgentGovernanceGatePacket {
        id: gate.id(),
        description: gate.description(),
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
                    base_ref: git.base_ref.clone(),
                    fetch_remote: git.fetch_remote.clone(),
                }),
        },
        allow_write: node.capabilities.allow_write,
        budget_max_attempts: node.budget.max_attempts,
        execution_attempts: node.execution_attempts,
        verification_attempts: node.verification_attempts,
        policy: node.policy,
        task_type: node.task_type,
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
