use crate::{AssistantTaskStatus, TaskId, TaskStore};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantContext {
    pub current_message: String,
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

        Self {
            current_message: message.into(),
            active_task,
            tasks,
        }
    }
}
