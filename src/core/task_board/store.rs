use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use nanoid::nanoid;
use serde::{Deserialize, Serialize};

use super::{AssistantTask, AssistantTaskEventRecord, AssistantTaskStatus, TaskId};
use crate::{EngineReport, NodeId};
use serde_json::Value;
use tracing::{Level, error};

pub trait TaskStore {
    fn create_task(&mut self, request: String) -> TaskId;
    fn get_task(&self, id: &str) -> Option<&AssistantTask>;
    fn list_tasks(&self) -> Vec<AssistantTask>;
    fn set_task_status(&mut self, id: &str, status: AssistantTaskStatus);
    fn record_task_event(&mut self, id: &str, record: AssistantTaskEventRecord);
    fn push_task_event(&mut self, id: &str, message: impl Into<String>) {
        self.record_task_event(
            id,
            AssistantTaskEventRecord {
                level: Level::INFO,
                kind: "task.event".to_string(),
                source: "assistant".to_string(),
                message: message.into(),
                node_id: None,
                operation: None,
                payload: Value::Null,
            },
        );
    }
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
        let id = new_task_id(&self.tasks);
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

    fn set_task_status(&mut self, id: &str, status: AssistantTaskStatus) {
        if let Some(task) = self.tasks.get_mut(id) {
            task.status = status;
        }
    }

    fn record_task_event(&mut self, id: &str, record: AssistantTaskEventRecord) {
        if let Some(task) = self.tasks.get_mut(id) {
            task.record_event(record);
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
    last_persist_error: Option<String>,
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
        Ok(Self {
            path,
            tasks,
            last_persist_error: None,
        })
    }

    pub fn last_persist_error(&self) -> Option<&str> {
        self.last_persist_error.as_deref()
    }

    fn persist(&mut self) {
        match self.try_persist() {
            Ok(()) => self.last_persist_error = None,
            Err(error) => {
                let message = error.to_string();
                error!(
                    target: "siko.task",
                    path = %self.path.display(),
                    error = %message,
                    "failed to persist assistant task store"
                );
                self.last_persist_error = Some(message);
            }
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
        let id = new_task_id(&self.tasks);
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

    fn set_task_status(&mut self, id: &str, status: AssistantTaskStatus) {
        if let Some(task) = self.tasks.get_mut(id) {
            task.status = status;
            self.persist();
        }
    }

    fn record_task_event(&mut self, id: &str, record: AssistantTaskEventRecord) {
        if let Some(task) = self.tasks.get_mut(id) {
            task.record_event(record);
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

fn new_task_id(existing: &BTreeMap<TaskId, AssistantTask>) -> TaskId {
    loop {
        let id = nanoid!(8);
        if !existing.contains_key(&id) {
            return id;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // ── temp_path_for tests ───────────────────────────────────────────────

    #[test]
    fn temp_path_for_adds_tmp_extension_to_regular_file() {
        let path = Path::new("/tmp/store/tasks.json");
        let result = temp_path_for(path);
        assert_eq!(result, PathBuf::from("/tmp/store/tasks.json.tmp"));
    }

    #[test]
    fn temp_path_for_handles_file_with_double_extension() {
        let path = Path::new("data.tar.gz");
        let result = temp_path_for(path);
        assert_eq!(result, PathBuf::from("data.tar.gz.tmp"));
    }

    #[test]
    fn temp_path_for_handles_file_without_extension() {
        let path = Path::new("datafile");
        let result = temp_path_for(path);
        assert_eq!(result, PathBuf::from("datafile.tmp"));
    }

    #[test]
    fn temp_path_for_handles_relative_path() {
        let path = Path::new("relative/path/tasks.json");
        let result = temp_path_for(path);
        assert_eq!(result, PathBuf::from("relative/path/tasks.json.tmp"));
    }

    #[test]
    fn temp_path_for_handles_dotfile() {
        let path = Path::new(".secret");
        let result = temp_path_for(path);
        assert_eq!(result, PathBuf::from(".secret.tmp"));
    }

    #[test]
    fn temp_path_for_handles_path_with_dot_in_directory() {
        let path = Path::new("/home/user/.config/app/data.yaml");
        let result = temp_path_for(path);
        assert_eq!(
            result,
            PathBuf::from("/home/user/.config/app/data.yaml.tmp")
        );
    }

    // ── invalid_data tests ────────────────────────────────────────────────

    #[test]
    fn invalid_data_creates_io_error_with_string() {
        let error = invalid_data("something went wrong");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        let msg = error.to_string();
        assert!(
            msg.contains("something went wrong"),
            "error should contain message: {msg}"
        );
    }

    #[test]
    fn invalid_data_creates_io_error_from_std_error() {
        let parse_error = "not-a-number".parse::<i32>().unwrap_err();
        let error = invalid_data(parse_error);
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn invalid_data_preserves_inner_message() {
        let inner = std::io::Error::new(std::io::ErrorKind::NotFound, "inner error");
        let error = invalid_data(inner);
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        let msg = error.to_string();
        assert!(
            msg.contains("inner error"),
            "error should contain inner message: {msg}"
        );
    }

    #[test]
    fn memory_store_generates_short_task_ids() {
        let mut store = MemoryTaskStore::new();

        let id = store.create_task("short id".to_string());

        assert!(id.chars().count() == 8, "task id should stay compact: {id}");
        let task = store.get_task(&id).expect("task should exist");
        assert!(task.created_at_ms > 0);
        assert!(store.get_task(&id).is_some());
    }

    #[test]
    fn file_store_generates_unique_short_task_ids() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("tasks.json");
        let mut store = FileTaskStore::open(&path).unwrap();

        let first = store.create_task("first".to_string());
        let second = store.create_task("second".to_string());

        assert_ne!(first, second);
        assert_eq!(first.chars().count(), 8);
        assert_eq!(second.chars().count(), 8);
    }

    #[test]
    fn legacy_persisted_tasks_without_created_at_default_to_zero() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("tasks.json");
        std::fs::write(
            &path,
            r#"{
  "tasks": {
    "legacy-task": {
      "id": "legacy-task",
      "title": "legacy",
      "request": "legacy",
      "status": "Completed",
      "root_node": null,
      "last_report": null,
      "events": []
    }
  }
}"#,
        )
        .unwrap();

        let store = FileTaskStore::open(path).unwrap();
        let task = store.get_task("legacy-task").expect("legacy task");

        assert_eq!(task.created_at_ms, 0);
    }
}
