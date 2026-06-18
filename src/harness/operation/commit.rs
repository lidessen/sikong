use crate::agent_worker::{AgentOperationContext, AgentPromptSection};
use crate::tools::EngineTool;

use super::finish_prompt;

pub(super) fn tools() -> Vec<EngineTool> {
    vec![EngineTool::SubmitCommit]
}

pub(super) fn prompt(context: &AgentOperationContext) -> Vec<AgentPromptSection> {
    operation_prompt! {
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
            "Use read_operation_context to inspect the accepted candidate. Summarize the durable result, relevant changed paths, unresolved caveats, and any operator-facing next step."
        }
        "Boundary" {
            "Do not modify artifacts, spawn new work, or re-open verification. This pass only records the accepted node as committed."
        }
        "Completion" {
            finish_prompt(&[EngineTool::SubmitCommit.name()])
        }
    }
}
