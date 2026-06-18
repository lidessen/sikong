mod file_system;
mod git_file_system;
mod memory;
mod workspaces;

use std::path::PathBuf;

use crate::types::{WorkspaceDeltaId, WorkspaceInstanceId, WorkspaceSnapshotId};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub use file_system::FileSystemWorkspace;
pub use git_file_system::GitFileSystemWorkspace;
pub use memory::MemoryWorkspace;
pub use workspaces::Workspaces;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum WorkspaceProvider {
    Memory,
    FileSystem,
    GitFileSystem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WorkspaceRequirement {
    pub provider: WorkspaceProvider,
    pub read_scope: Vec<String>,
    pub write_scope: Vec<String>,
    pub git: Option<GitWorkspaceRequirement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GitWorkspaceRequirement {
    pub repo_root: PathBuf,
    pub worktree_root: PathBuf,
    pub base_ref: String,
    pub fetch_remote: Option<String>,
}

impl WorkspaceRequirement {
    pub fn memory() -> Self {
        Self {
            provider: WorkspaceProvider::Memory,
            read_scope: Vec::new(),
            write_scope: Vec::new(),
            git: None,
        }
    }

    pub fn read_only_files() -> Self {
        Self {
            provider: WorkspaceProvider::FileSystem,
            read_scope: vec!["**/*".to_string()],
            write_scope: Vec::new(),
            git: None,
        }
    }

    pub fn git(write_scope: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            provider: WorkspaceProvider::GitFileSystem,
            read_scope: vec!["**/*".to_string()],
            write_scope: write_scope.into_iter().map(Into::into).collect(),
            git: None,
        }
    }

    pub fn git_repo(
        repo_root: impl Into<PathBuf>,
        worktree_root: impl Into<PathBuf>,
        base_ref: impl Into<String>,
        write_scope: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            provider: WorkspaceProvider::GitFileSystem,
            read_scope: vec!["**/*".to_string()],
            write_scope: write_scope.into_iter().map(Into::into).collect(),
            git: Some(GitWorkspaceRequirement {
                repo_root: repo_root.into(),
                worktree_root: worktree_root.into(),
                base_ref: base_ref.into(),
                fetch_remote: None,
            }),
        }
    }

    pub fn with_git_fetch_remote(mut self, remote: impl Into<String>) -> Self {
        if let Some(git) = &mut self.git {
            git.fetch_remote = Some(remote.into());
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSnapshot {
    pub id: WorkspaceSnapshotId,
    pub provider: WorkspaceProvider,
    pub scope: Vec<String>,
    pub git: Option<GitWorkspaceSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitWorkspaceSnapshot {
    pub repo_root: PathBuf,
    pub worktree_root: PathBuf,
    pub base_ref: String,
    pub base_sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceInstance {
    pub id: WorkspaceInstanceId,
    pub snapshot_id: WorkspaceSnapshotId,
    pub provider: WorkspaceProvider,
    pub git: Option<GitWorkspaceInstance>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitWorkspaceInstance {
    pub repo_root: PathBuf,
    pub worktree_root: PathBuf,
    pub base_sha: String,
    pub worktree_path: PathBuf,
    pub branch_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceDelta {
    pub id: WorkspaceDeltaId,
    pub instance_id: WorkspaceInstanceId,
    pub provider: WorkspaceProvider,
    pub changed_paths: Vec<String>,
    pub side_effects: Vec<String>,
    pub git: Option<GitWorkspaceDelta>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitWorkspaceDelta {
    pub repo_root: PathBuf,
    pub worktree_root: PathBuf,
    pub base_sha: String,
    pub branch_name: String,
    pub worktree_path: PathBuf,
    pub commit_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceIntegration {
    pub deltas: Vec<WorkspaceDeltaId>,
    pub changed_paths: Vec<String>,
    pub conflicts: Vec<String>,
    pub git: Option<GitWorkspaceIntegration>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitWorkspaceIntegration {
    pub worktree_path: PathBuf,
    pub branch_name: String,
}

pub type WorkspaceResult<T> = Result<T, WorkspaceError>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WorkspaceError {
    #[error("workspace git operation failed during {operation} in {cwd}: {message}")]
    GitCommand {
        operation: String,
        cwd: PathBuf,
        message: String,
    },
    #[error("workspace io operation failed during {operation} at {path}: {message}")]
    Io {
        operation: String,
        path: PathBuf,
        message: String,
    },
    #[error("workspace operation {operation} requires git metadata")]
    MissingGitMetadata { operation: String },
}

pub trait Workspace {
    fn snapshot(
        &mut self,
        requirement: &WorkspaceRequirement,
    ) -> WorkspaceResult<WorkspaceSnapshot>;
    fn fork(&mut self, snapshot: &WorkspaceSnapshot) -> WorkspaceResult<WorkspaceInstance>;
    fn collect_delta(
        &mut self,
        instance: &WorkspaceInstance,
        changed_paths: Vec<String>,
        side_effects: Vec<String>,
    ) -> WorkspaceResult<WorkspaceDelta>;
    fn combine(&self, deltas: &[WorkspaceDelta]) -> WorkspaceResult<WorkspaceIntegration>;
}

#[derive(Debug, Clone, Default)]
pub(super) struct WorkspaceIds {
    next_snapshot_id: WorkspaceSnapshotId,
    next_instance_id: WorkspaceInstanceId,
    next_delta_id: WorkspaceDeltaId,
}

impl WorkspaceIds {
    pub(super) fn next_snapshot_id(&mut self) -> WorkspaceSnapshotId {
        self.next_snapshot_id += 1;
        self.next_snapshot_id
    }

    pub(super) fn next_instance_id(&mut self) -> WorkspaceInstanceId {
        self.next_instance_id += 1;
        self.next_instance_id
    }

    pub(super) fn next_delta_id(&mut self) -> WorkspaceDeltaId {
        self.next_delta_id += 1;
        self.next_delta_id
    }
}
