use serde::Serialize;
use serde_json::{Value, json};

use crate::{AgentPromptSection, AgentRunRequest, AssistantContext, AssistantContextTask};

use super::tools::{
    specs_for_context as assistant_tool_specs, terminal_tool_names as assistant_terminal_tool_names,
};

#[derive(Debug, Clone)]
pub struct AssistantHarness {
    context: AssistantContext,
}

impl AssistantHarness {
    pub fn new(context: AssistantContext) -> Self {
        Self { context }
    }

    fn context(&self) -> &AssistantContext {
        &self.context
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssistantTurnContextPacket {
    pub kind: &'static str,
    pub current_message: String,
    pub active_task: Option<String>,
    pub tasks: Vec<AssistantTurnTaskPacket>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssistantTurnTaskPacket {
    pub id: String,
    pub title: String,
    pub status: String,
}

impl AssistantHarness {
    pub fn build_agent_run(&self) -> AgentRunRequest {
        let context = self.context();
        AgentRunRequest::new(
            "Assistant turn".to_string(),
            assistant_prompt(),
            assistant_input(context),
            assistant_tool_specs(context),
            assistant_terminal_tool_names(),
        )
    }

    pub fn context_packet(context: &AssistantContext) -> AssistantTurnContextPacket {
        AssistantTurnContextPacket {
            kind: "assistant_turn",
            current_message: context.current_message.clone(),
            active_task: context.active_task.clone(),
            tasks: context.tasks.iter().map(task_packet).collect(),
        }
    }
}

fn assistant_prompt() -> Vec<AgentPromptSection> {
    vec![
        prompt_section(
            "Role",
            "You are the assistant-level coordinator for a multi-task recursive agent engine.",
        ),
        prompt_section(
            "Operating Model",
            "Use the available assistant tools as your ingredients and utensils. You may inspect context, list tasks, inspect tasks, create tasks, cancel tasks, and then finish the turn. Do not execute engine node work yourself.",
        ),
        prompt_section(
            "Context",
            "Use read_assistant_context when you need the structured packet. Treat the current message, active task, and task list as the source of truth.",
        ),
        prompt_section(
            "Completion",
            format!(
                "Finish this run by calling one of these tools: {}. The agent loop will stop after that tool call.",
                assistant_terminal_tool_names().join(", ")
            ),
        ),
    ]
}

fn assistant_input(context: &AssistantContext) -> Value {
    let packet = AssistantHarness::context_packet(context);
    serde_json::to_value(&packet).unwrap_or_else(|_| {
        json!({
            "kind": "assistant_turn",
            "error": "failed to serialize context packet",
        })
    })
}

fn prompt_section(title: impl Into<String>, content: impl Into<String>) -> AgentPromptSection {
    AgentPromptSection {
        title: title.into(),
        content: content.into(),
    }
}

fn task_packet(task: &AssistantContextTask) -> AssistantTurnTaskPacket {
    AssistantTurnTaskPacket {
        id: task.id.clone(),
        title: task.title.clone(),
        status: format!("{:?}", task.status),
    }
}
