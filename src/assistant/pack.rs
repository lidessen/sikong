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
    Dogfood,
}

impl AssistantPackSet {
    pub(crate) fn for_context(context: AssistantContext) -> Self {
        let mut packs = vec![AssistantPack::Core];
        if context.task_board.is_some() {
            packs.push(AssistantPack::TaskBoard);
            packs.push(AssistantPack::Dogfood);
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
                    "You are the user's assistant-level operator. Your job is to turn user requests into concrete actions using the available tools.",
                ),
                prompt_section(
                    "Operating Model",
                    "Use the available tools to fulfill the user's request in as few steps as possible. Do NOT answer questions directly when they require file access, code analysis, or project exploration — those should be handled by creating a task on the task board, which runs the engine against the real workspace.\n\nDecide quickly:\n- **Simple Q&A** that needs no file access → reply directly with finish_turn.\n- **Analysis, inspection, exploration, code change, bug fix, or any file-level work** → use create_task immediately. The engine will read files, run tools, and return results.\n- **Status check or follow-up** → use inspect_task or list_tasks first.\n\nDo not ask the user which approach they prefer. Just do the right thing.",
                ),
                prompt_section(
                    "Context",
                    "Use the Latest Message and Context sections as the current turn. The Recent Conversation section is only a small window, not the full conversation state. Use query_messages when earlier intent, decisions, or task references matter before acting.",
                ),
            ],
            Self::TaskBoard => vec![prompt_section(
                "Task Board",
                "The task board is your durable execution engine. You have tools to create, inspect, list, and cancel tasks. When you call create_task, the engine runs the request against the real filesystem in a git worktree — it can read files, analyze code, run tools, and produce results. The task result appears in the task's events and log. Use inspect_task to check results after a short wait.\n\nPrefer creating one task per distinct request. Keep task descriptions clear and action-oriented.",
            )],
            Self::Dogfood => vec![prompt_section(
                "Dogfood Development",
                "When the user asks Sikong to improve itself, treat the user as steer input and use the task board as Sikong's self-development loop. Prefer creating or inspecting one bounded roadmap task over doing implementation work inside the assistant turn. A good dogfood task names the mainline goal, the governing layer, the acceptance evidence, the child autonomy boundary, and the artifact that should come back upward. Use review-only design tasks before broad runtime changes, and keep commits for verified workspace changes outside the assistant turn.",
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
            Self::Dogfood => Some(("dogfood".to_string(), json!(dogfood_packet()))),
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
            Self::Dogfood => Vec::new(),
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssistantDogfoodContextPacket {
    pub mode: &'static str,
    pub loop_contract: &'static str,
    pub preferred_next_action: &'static str,
    pub task_request_shape: Vec<&'static str>,
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

fn dogfood_packet() -> AssistantDogfoodContextPacket {
    AssistantDogfoodContextPacket {
        mode: "sikong_self_development",
        loop_contract: "external messages are steer input; Sikong should maintain roadmap tasks and return reviewable artifacts through the recursive task engine",
        preferred_next_action: "inspect an active self-development task when one exists; otherwise create one bounded task that advances the current roadmap",
        task_request_shape: vec![
            "mainline goal",
            "governing layer",
            "acceptance evidence",
            "child autonomy boundary",
            "upward artifact",
        ],
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
