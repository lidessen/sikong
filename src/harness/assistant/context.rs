use serde::Serialize;

use crate::{AssistantTaskStatus, TaskId, TaskStore};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantContext {
    pub current_message: String,
    pub conversation: Vec<AssistantConversationMessage>,
    pub task_board: Option<AssistantTaskBoardContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssistantConversationMessage {
    pub role: AssistantConversationRole,
    pub content: String,
    pub task_id: Option<TaskId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssistantConversationRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantTaskBoardContext {
    pub active_task: Option<TaskId>,
    pub tasks: Vec<AssistantContextTask>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantContextTask {
    pub id: TaskId,
    pub title: String,
    pub status: AssistantTaskStatus,
}

impl AssistantContext {
    pub fn build(store: &impl TaskStore, message: impl Into<String>) -> Self {
        Self::build_with_task_board(store, message, true)
    }

    pub fn message_only(message: impl Into<String>) -> Self {
        Self {
            current_message: message.into(),
            conversation: Vec::new(),
            task_board: None,
        }
    }

    pub fn with_conversation(mut self, conversation: Vec<AssistantConversationMessage>) -> Self {
        self.conversation = conversation;
        self
    }

    pub fn build_with_task_board(
        store: &impl TaskStore,
        message: impl Into<String>,
        task_board_enabled: bool,
    ) -> Self {
        let tasks = store
            .list_tasks()
            .into_iter()
            .map(|task| AssistantContextTask {
                id: task.id,
                title: task.title,
                status: task.status,
            })
            .collect::<Vec<_>>();
        let active_task = tasks
            .iter()
            .find(|task| {
                matches!(
                    task.status,
                    AssistantTaskStatus::Created
                        | AssistantTaskStatus::Queued
                        | AssistantTaskStatus::Running
                        | AssistantTaskStatus::WaitingForInput
                )
            })
            .map(|task| task.id.clone());

        let task_board =
            task_board_enabled.then_some(AssistantTaskBoardContext { active_task, tasks });

        Self {
            current_message: message.into(),
            conversation: Vec::new(),
            task_board,
        }
    }
}
