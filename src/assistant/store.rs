use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::task::{AssistantTask, AssistantTaskEvent, TaskId};
use crate::{EngineReport, NodeId};

pub trait TaskStore {
    fn create_task(&mut self, request: String) -> TaskId;
    fn get_task(&self, id: &str) -> Option<&AssistantTask>;
    fn list_tasks(&self) -> Vec<AssistantTask>;
    fn set_task_status(&mut self, id: &str, status: super::task::AssistantTaskStatus);
    fn push_task_event(&mut self, id: &str, message: impl Into<String>);
    fn apply_task_report(&mut self, id: &str, root: NodeId, report: EngineReport);
}

#[derive(Debug, Default)]
pub struct MemoryTaskStore {
    tasks: BTreeMap<TaskId, AssistantTask>,
}

impl MemoryTaskStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl TaskStore for MemoryTaskStore {
    fn create_task(&mut self, request: String) -> TaskId {
        let id = Uuid::now_v7().to_string();
        self.tasks
            .insert(id.clone(), AssistantTask::new(id.clone(), request));
        id
    }

    fn get_task(&self, id: &str) -> Option<&AssistantTask> {
        self.tasks.get(id)
    }

    fn list_tasks(&self) -> Vec<AssistantTask> {
        self.tasks.values().cloned().collect()
    }

    fn set_task_status(&mut self, id: &str, status: super::task::AssistantTaskStatus) {
        if let Some(task) = self.tasks.get_mut(id) {
            task.status = status;
        }
    }

    fn push_task_event(&mut self, id: &str, message: impl Into<String>) {
        if let Some(task) = self.tasks.get_mut(id) {
            task.events.push(AssistantTaskEvent {
                message: message.into(),
            });
        }
    }

    fn apply_task_report(&mut self, id: &str, root: NodeId, report: EngineReport) {
        if let Some(task) = self.tasks.get_mut(id) {
            task.apply_report(root, report);
        }
    }
}

#[derive(Debug)]
pub struct FileTaskStore {
    path: PathBuf,
    tasks: BTreeMap<TaskId, AssistantTask>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedTasks {
    tasks: BTreeMap<TaskId, AssistantTask>,
}

impl FileTaskStore {
    pub fn open(path: impl Into<PathBuf>) -> std::io::Result<Self> {
        let path = path.into();
        let tasks = if path.exists() {
            let data = std::fs::read_to_string(&path)?;
            if data.trim().is_empty() {
                BTreeMap::new()
            } else {
                serde_json::from_str::<PersistedTasks>(&data)
                    .map_err(invalid_data)?
                    .tasks
            }
        } else {
            BTreeMap::new()
        };
        Ok(Self { path, tasks })
    }

    fn persist(&self) {
        if let Err(error) = self.try_persist() {
            panic!(
                "failed to persist assistant task store {}: {error}",
                self.path.display()
            );
        }
    }

    fn try_persist(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let payload = serde_json::to_vec_pretty(&PersistedTasks {
            tasks: self.tasks.clone(),
        })
        .map_err(invalid_data)?;
        let temp_path = temp_path_for(&self.path);
        std::fs::write(&temp_path, payload)?;
        std::fs::rename(temp_path, &self.path)?;
        Ok(())
    }
}

impl TaskStore for FileTaskStore {
    fn create_task(&mut self, request: String) -> TaskId {
        let id = Uuid::now_v7().to_string();
        self.tasks
            .insert(id.clone(), AssistantTask::new(id.clone(), request));
        self.persist();
        id
    }

    fn get_task(&self, id: &str) -> Option<&AssistantTask> {
        self.tasks.get(id)
    }

    fn list_tasks(&self) -> Vec<AssistantTask> {
        self.tasks.values().cloned().collect()
    }

    fn set_task_status(&mut self, id: &str, status: super::task::AssistantTaskStatus) {
        if let Some(task) = self.tasks.get_mut(id) {
            task.status = status;
            self.persist();
        }
    }

    fn push_task_event(&mut self, id: &str, message: impl Into<String>) {
        if let Some(task) = self.tasks.get_mut(id) {
            task.events.push(AssistantTaskEvent {
                message: message.into(),
            });
            self.persist();
        }
    }

    fn apply_task_report(&mut self, id: &str, root: NodeId, report: EngineReport) {
        if let Some(task) = self.tasks.get_mut(id) {
            task.apply_report(root, report);
            self.persist();
        }
    }
}

fn temp_path_for(path: &Path) -> PathBuf {
    let mut temp = path.to_path_buf();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map_or("tmp".to_string(), |extension| format!("{extension}.tmp"));
    temp.set_extension(extension);
    temp
}

fn invalid_data(error: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, error)
}
