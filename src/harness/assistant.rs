use serde::Serialize;
use serde_json::{Value, json};

use crate::tools::{assistant_terminal_tool_names, assistant_tool_specs};
use crate::{
    AgentPromptSection, AgentRunKind, AgentToolSpec, AssistantContext, AssistantContextTask,
};

use super::{AgentRunContext, Harness};

pub type AssistantHarness = Harness<AssistantContext>;

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

impl Harness<AssistantContext> {
    pub fn context_packet(context: &AssistantContext) -> AssistantTurnContextPacket {
        AssistantTurnContextPacket {
            kind: "assistant_turn",
            current_message: context.current_message.clone(),
            active_task: context.active_task.clone(),
            tasks: context.tasks.iter().map(task_packet).collect(),
        }
    }
}

impl AgentRunContext for AssistantContext {
    fn kind(&self) -> AgentRunKind {
        AgentRunKind::AssistantTurn
    }

    fn objective(&self) -> String {
        "Assistant turn".to_string()
    }

    fn prompt(&self) -> Vec<AgentPromptSection> {
        vec![
            prompt_section(
                "Role",
                "You are the assistant-level coordinator for a multi-task recursive agent engine.",
            ),
            prompt_section(
                "Decision Scope",
                "Decide whether to create a task, inspect a task, list tasks, cancel active work, or reply directly. Do not execute engine node work yourself.",
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

    fn input(&self) -> Value {
        let packet = AssistantHarness::context_packet(self);
        serde_json::to_value(&packet).unwrap_or_else(|_| {
            json!({
                "kind": "assistant_turn",
                "error": "failed to serialize context packet",
            })
        })
    }

    fn tools(&self) -> Vec<AgentToolSpec> {
        assistant_tool_specs(self)
    }

    fn terminal_tool_names(&self) -> Vec<String> {
        assistant_terminal_tool_names()
    }
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
