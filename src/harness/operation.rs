use serde::Serialize;
use serde_json::{Value, json};

use crate::AgentToolSpec;
use crate::agent_worker::{
    AgentHarness, AgentOperationContext, AgentPromptSection, AgentRunKind, AgentRunRequest,
    AgentRunResult, AgentWorkerResult, NodeOperationOutput,
};
use crate::node::NodeScript;
use crate::tools::{EngineTool, EngineTools, read_operation_context_spec};
use crate::types::NodeOperation;
use crate::workspace::WorkspaceProvider;

macro_rules! operation_prompt {
    ($(
        $title:literal {
            $content:expr
        }
    )+ $(,)?) => {
        vec![
            $(
                crate::agent_worker::AgentPromptSection {
                    title: $title.to_string(),
                    content: ($content).into(),
                }
            ),+
        ]
    };
}

mod acquire;
mod combine;
mod commit;
mod divide;
mod execute;
mod specify;
mod verify;

use super::{AgentRunContext, AgentRunHarness, Harness};

#[derive(Debug, Clone, Default)]
pub struct EngineAgentHarness;

pub type OperationHarness = Harness<AgentOperationContext>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineAgentContextPacket {
    pub kind: &'static str,
    pub operation: NodeOperation,
    pub node: EngineAgentNodePacket,
    pub candidate: Option<EngineAgentArtifactPacket>,
    pub child_artifacts: Vec<EngineAgentArtifactPacket>,
    pub workspace_integration: Option<EngineAgentWorkspaceIntegrationPacket>,
    pub script: NodeScript,
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
    pub kind: String,
    pub text: String,
    pub changed_paths: Vec<String>,
    pub side_effects: Vec<String>,
    pub children: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineAgentWorkspaceIntegrationPacket {
    pub changed_paths: Vec<String>,
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
        NodeOperation::Specify => specify::prompt(context),
        NodeOperation::Acquire => acquire::prompt(context),
        NodeOperation::Divide => divide::prompt(context),
        NodeOperation::Execute => execute::prompt(context),
        NodeOperation::Combine => combine::prompt(context),
        NodeOperation::Verify => verify::prompt(context),
        NodeOperation::Commit => commit::prompt(context),
    }
}

fn tools_for_operation(operation: NodeOperation) -> Vec<EngineTool> {
    match operation {
        NodeOperation::Specify => specify::tools(),
        NodeOperation::Acquire => acquire::tools(),
        NodeOperation::Divide => divide::tools(),
        NodeOperation::Execute => execute::tools(),
        NodeOperation::Combine => combine::tools(),
        NodeOperation::Verify => verify::tools(),
        NodeOperation::Commit => commit::tools(),
    }
}

impl EngineAgentHarness {
    pub fn terminal_tool_names(operation: NodeOperation) -> Vec<String> {
        operation_tool_names(operation)
    }
}

impl Harness<AgentOperationContext> {
    pub fn context_packet(&self) -> EngineAgentContextPacket {
        operation_context_packet(self.context())
    }

    pub fn terminal_tool_names(&self) -> Vec<String> {
        self.context().terminal_tool_names().into_iter().collect()
    }

    pub fn decode_result(&self, result: AgentWorkerResult) -> AgentRunResult {
        let allowed_tools = operation_tool_names(self.context().operation);
        match result.terminal_call {
            Some(call) if allowed_tools.contains(&call.name) => AgentRunResult {
                report: result.report,
                terminal_tool: Some(call.name.clone()),
                output: EngineTool::from_name(&call.name)
                    .map(|tool| tool.decode_call(&EngineTools, call.arguments))
                    .unwrap_or(NodeOperationOutput::Noop),
            },
            Some(call) => AgentRunResult {
                report: format!(
                    "{}; protocol violation: worker called unexpected terminal tool {}",
                    result.report, call.name
                ),
                terminal_tool: Some(call.name),
                output: NodeOperationOutput::Noop,
            },
            None => AgentRunResult {
                report: format!(
                    "{}; protocol violation: worker ended without required terminal tool",
                    result.report
                ),
                terminal_tool: None,
                output: NodeOperationOutput::Noop,
            },
        }
    }
}

impl AgentRunContext for AgentOperationContext {
    fn kind(&self) -> AgentRunKind {
        AgentRunKind::EngineOperation
    }

    fn objective(&self) -> String {
        format!("{:?} node {}", self.operation, self.node.id)
    }

    fn prompt(&self) -> Vec<AgentPromptSection> {
        operation_prompt_sections(self.operation, self)
    }

    fn input(&self) -> Value {
        let packet = operation_context_packet(self);
        serde_json::to_value(&packet).unwrap_or_else(|_| {
            json!({
                "kind": "engine_operation",
                "operation": format!("{:?}", self.operation),
                "error": "failed to serialize context packet",
            })
        })
    }

    fn tools(&self) -> Vec<AgentToolSpec> {
        let mut tool_specs = vec![read_operation_context_spec()];
        tool_specs.extend(
            tools_for_operation(self.operation)
                .into_iter()
                .map(|tool| tool.spec()),
        );
        tool_specs
    }

    fn terminal_tool_names(&self) -> Vec<String> {
        operation_tool_names(self.operation)
    }
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
        workspace_integration: context.workspace_integration.as_ref().map(|integration| {
            EngineAgentWorkspaceIntegrationPacket {
                changed_paths: integration.changed_paths.clone(),
                conflicts: integration.conflicts.clone(),
                git_worktree_path: integration
                    .git
                    .as_ref()
                    .map(|git| git.worktree_path.display().to_string()),
                git_branch_name: integration.git.as_ref().map(|git| git.branch_name.clone()),
            }
        }),
        script: context.node.script.clone(),
    }
}

impl AgentHarness for EngineAgentHarness {
    fn build_run(&mut self, context: AgentOperationContext) -> AgentRunRequest {
        OperationHarness::new(context).build_agent_run()
    }

    fn decode_result(
        &mut self,
        context: &AgentOperationContext,
        result: AgentWorkerResult,
    ) -> AgentRunResult {
        OperationHarness::new(context.clone()).decode_result(result)
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
    let (changed_paths, side_effects) = artifact
        .workspace_delta
        .as_ref()
        .map(|delta| (delta.changed_paths.clone(), delta.side_effects.clone()))
        .unwrap_or_default();
    EngineAgentArtifactPacket {
        id: artifact.id,
        node_id: artifact.node_id,
        kind: format!("{:?}", artifact.kind),
        text: artifact.text.clone(),
        changed_paths,
        side_effects,
        children: artifact.children.clone(),
    }
}

fn operation_tool_names(operation: NodeOperation) -> Vec<String> {
    tools_for_operation(operation)
        .into_iter()
        .map(|tool| tool.name().to_string())
        .collect()
}
