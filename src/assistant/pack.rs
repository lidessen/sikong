use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{
    AgentPromptSection, AgentToolSpec, AssistantContext, AssistantContextTask,
    AssistantConversationMessage,
};

use super::tools::{
    AssistantTool, specs_for_tools, terminal_tool_names as assistant_terminal_tool_names,
};

#[derive(Debug, Clone)]
pub(crate) struct AssistantPackSet {
    context: AssistantContext,
    packs: Vec<AssistantPack>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssistantPack {
    Core,
    TaskBoard,
}

impl AssistantPackSet {
    pub(crate) fn for_context(context: AssistantContext) -> Self {
        let mut packs = vec![AssistantPack::Core];
        if context.task_board.is_some() {
            packs.push(AssistantPack::TaskBoard);
        }
        Self { context, packs }
    }

    pub(crate) fn prompt_sections(&self) -> Vec<AgentPromptSection> {
        let mut sections = Vec::new();
        for pack in &self.packs {
            sections.extend(pack.prompt_sections());
        }
        if !self.context.conversation.is_empty() {
            sections.push(prompt_section(
                "Recent Conversation",
                render_recent_conversation(&self.context.conversation, 12),
            ));
        }
        sections.push(prompt_section(
            "Latest Message",
            self.context.current_message.clone(),
        ));
        sections.push(prompt_section(
            "Completion",
            format!(
                "Finish this run by calling one of these tools: {}. The agent loop will stop after that tool call.",
                self.terminal_tool_names().join(", ")
            ),
        ));
        sections
    }

    pub(crate) fn input(&self) -> Value {
        let mut object = Map::new();
        object.insert("kind".to_string(), json!("assistant_turn"));
        object.insert(
            "current_message".to_string(),
            json!(self.context.current_message),
        );
        object.insert(
            "conversation".to_string(),
            json!({
                "messages": self.context.conversation,
            }),
        );

        for pack in &self.packs {
            if let Some((key, value)) = pack.context_fragment(&self.context) {
                object.insert(key, value);
            }
        }

        Value::Object(object)
    }

    pub(crate) fn tool_specs(&self) -> Vec<AgentToolSpec> {
        let terminal_tools = assistant_terminal_tool_names();
        let tools = self
            .packs
            .iter()
            .flat_map(|pack| pack.tools())
            .collect::<Vec<_>>();
        let (mut non_terminal, terminal): (Vec<_>, Vec<_>) = tools
            .into_iter()
            .partition(|tool| !terminal_tools.iter().any(|name| name == tool.name()));
        non_terminal.extend(terminal);
        specs_for_tools(&non_terminal)
    }

    pub(crate) fn terminal_tool_names(&self) -> Vec<String> {
        assistant_terminal_tool_names()
    }
}

impl AssistantPack {
    fn prompt_sections(&self) -> Vec<AgentPromptSection> {
        match self {
            Self::Core => vec![
                prompt_section(
                    "Role",
                    "You are the user's assistant-level operator for a multi-task recursive agent engine. Stay at the task and outcome level unless the user asks for implementation details.",
                ),
                prompt_section(
                    "Operating Model",
                    "Use the available assistant tools as ingredients, utensils, and durable task controls. Decide whether this turn needs a direct reply, task-board action, or inspection of an existing task. Choose the smallest useful tool sequence, then finish the turn. Do not execute engine node work yourself.",
                ),
                prompt_section(
                    "Context",
                    "The latest message and turn context are injected directly. The Recent Conversation section is only a small window, not the full conversation state. Use query_messages when earlier intent, decisions, or task references matter before acting.",
                ),
            ],
            Self::TaskBoard => vec![prompt_section(
                "Task Board",
                "The task board pack is available. Use it when the user asks to start durable work, manage running work, inspect progress, cancel work, or make a decision about an existing task. Keep the user's view focused on goal, status, risk, and next decision; avoid exposing engine internals unless they explain a blocker.",
            )],
        }
    }

    fn context_fragment(&self, context: &AssistantContext) -> Option<(String, Value)> {
        match self {
            Self::Core => None,
            Self::TaskBoard => context.task_board.as_ref().map(|task_board| {
                (
                    "task_board".to_string(),
                    json!(task_board_packet(task_board)),
                )
            }),
        }
    }

    fn tools(&self) -> Vec<AssistantTool> {
        match self {
            Self::Core => vec![AssistantTool::QueryMessages, AssistantTool::FinishTurn],
            Self::TaskBoard => vec![
                AssistantTool::ListTasks,
                AssistantTool::InspectTask,
                AssistantTool::CreateTask,
                AssistantTool::CancelTask,
            ],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssistantTaskBoardContextPacket {
    pub active_task: Option<String>,
    pub tasks: Vec<AssistantTurnTaskPacket>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssistantTurnTaskPacket {
    pub id: String,
    pub title: String,
    pub status: String,
}

fn task_board_packet(
    context: &super::context::AssistantTaskBoardContext,
) -> AssistantTaskBoardContextPacket {
    AssistantTaskBoardContextPacket {
        active_task: context.active_task.clone(),
        tasks: context.tasks.iter().map(task_packet).collect(),
    }
}

fn task_packet(task: &AssistantContextTask) -> AssistantTurnTaskPacket {
    AssistantTurnTaskPacket {
        id: task.id.clone(),
        title: task.title.clone(),
        status: format!("{:?}", task.status),
    }
}

fn prompt_section(title: impl Into<String>, content: impl Into<String>) -> AgentPromptSection {
    AgentPromptSection {
        title: title.into(),
        content: content.into(),
    }
}

fn render_recent_conversation(messages: &[AssistantConversationMessage], limit: usize) -> String {
    messages
        .iter()
        .rev()
        .take(limit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|message| {
            let task = message
                .task_id
                .as_ref()
                .map(|task_id| format!(" task={task_id}"))
                .unwrap_or_default();
            format!("{:?}{task}: {}", message.role, message.content)
        })
        .collect::<Vec<_>>()
        .join("\n")
}
