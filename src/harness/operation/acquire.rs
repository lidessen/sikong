use crate::agent_worker::{AgentOperationContext, AgentPromptSection};
use crate::tools::EngineTool;

use super::finish_prompt;

pub(super) fn tools() -> Vec<EngineTool> {
    vec![EngineTool::SubmitEvidence]
}

pub(super) fn prompt(context: &AgentOperationContext) -> Vec<AgentPromptSection> {
    operation_prompt! {
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
            "Do not rewrite the plan, create child nodes, or execute workspace changes. This pass only supplies the missing information and the next script transition."
        }
        "Completion" {
            finish_prompt(&[EngineTool::SubmitEvidence.name()])
        }
    }
}
