use crate::agent_worker::{AgentOperationContext, AgentPromptSection};
use crate::tools::EngineTool;

use super::finish_prompt;

pub(super) fn tools() -> Vec<EngineTool> {
    vec![EngineTool::SubmitVerdict]
}

pub(super) fn prompt(context: &AgentOperationContext) -> Vec<AgentPromptSection> {
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
        "Verification Lens" {
            "Use read_operation_context to inspect the candidate artifact, node constraints, workspace scope, changed paths, side effects, and any child artifact evidence."
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
    }
}
