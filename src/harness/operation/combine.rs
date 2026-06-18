use crate::agent_worker::{AgentOperationContext, AgentPromptSection};
use crate::tools::EngineTool;

use super::finish_prompt;

pub(super) fn tools() -> Vec<EngineTool> {
    vec![EngineTool::SubmitCombination]
}

pub(super) fn prompt(context: &AgentOperationContext) -> Vec<AgentPromptSection> {
    operation_prompt! {
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
            "Use read_operation_context to inspect child artifacts and workspace_integration. If conflicts are present, resolve them as part of the combined artifact instead of treating them as deterministic failure."
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
    }
}
