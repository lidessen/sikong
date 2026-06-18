use crate::agent_worker::{AgentOperationContext, AgentPromptSection};
use crate::tools::EngineTool;

use super::finish_prompt;

pub(super) fn tools() -> Vec<EngineTool> {
    vec![EngineTool::SubmitSpecification]
}

pub(super) fn prompt(context: &AgentOperationContext) -> Vec<AgentPromptSection> {
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
            "Clarify the objective, expected artifact, acceptance boundary, workspace assumptions, and any missing constraints. Use read_operation_context for the authoritative node packet before submitting."
        }
        "Non Goals" {
            "Do not solve the task, create child nodes, verify candidate output, or mutate workspace state during specification."
        }
        "Completion" {
            finish_prompt(&[EngineTool::SubmitSpecification.name()])
        }
    }
}
