use crate::agent_worker::{AgentOperationContext, AgentPromptSection};
use crate::tools::EngineTool;

use super::finish_prompt;

pub(super) fn tools() -> Vec<EngineTool> {
    vec![EngineTool::SubmitDivision]
}

pub(super) fn prompt(context: &AgentOperationContext) -> Vec<AgentPromptSection> {
    operation_prompt! {
        "Role" {
            "You are the decomposition pass for one recursive engine node."
        }
        "Parent Problem" {
            format!(
                "Split node {} into child nodes that can converge independently. Parent intent: {}",
                context.node.id, context.node.intent
            )
        }
        "Decomposition Strategy" {
            "Prefer the smallest useful child set. Each child should have a clear intent, dependency boundary, read scope, write scope, and operation hint when the next operation is obvious."
        }
        "Workspace Scope" {
            "Use read_operation_context before submitting. Keep child scopes inside the parent workspace requirement and avoid overlapping write scopes unless the overlap is intentional and must be combined later."
        }
        "Non Goals" {
            "Do not execute child work or combine results here. This pass only defines the recursive children."
        }
        "Completion" {
            finish_prompt(&[EngineTool::SubmitDivision.name()])
        }
    }
}
