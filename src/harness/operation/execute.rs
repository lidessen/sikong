use crate::agent_worker::{AgentOperationContext, AgentPromptSection};
use crate::tools::EngineTool;

use super::finish_prompt;

pub(super) fn tools() -> Vec<EngineTool> {
    vec![EngineTool::SubmitWork]
}

pub(super) fn prompt(context: &AgentOperationContext) -> Vec<AgentPromptSection> {
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
            "Use read_operation_context before acting. Respect allow_write, read_scope, write_scope, and provider details exactly. Report changed paths and side effects in the terminal payload."
        }
        "Execution Standard" {
            "Produce the smallest complete artifact that satisfies this node. Do not split the work, verify acceptance, or decide global task completion from this pass."
        }
        "Completion" {
            finish_prompt(&[EngineTool::SubmitWork.name()])
        }
    }
}
