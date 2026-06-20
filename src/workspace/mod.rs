mod file_system;
mod git_cli;
mod git_file_system;
mod memory;
mod workspaces;

use std::path::PathBuf;

use crate::types::{ArtifactId, NodeId, WorkspaceResourceId, WorkspaceSnapshotId};
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
pub struct WorkspaceResource {
    pub id: WorkspaceResourceId,
    pub provider: WorkspaceProvider,
    pub kind: WorkspaceResourceKind,
    pub state: WorkspaceResourceState,
    pub refs: Vec<WorkspaceResourceRef>,
    pub metadata: WorkspaceResourceMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceResourceKind {
    Memory,
    Directory,
    GitWorktree,
    GitBranch,
    GitCommit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceResourceState {
    Active,
    Released,
    FailedCleanup,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceResourceRef {
    RunningNode(NodeId),
    CandidateArtifact(ArtifactId),
    ChildInputForCombine(NodeId),
    MergeSurface(NodeId),
    DebugRetain,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceResourceMetadata {
    None,
    GitWorktree(GitWorktreeResource),
    GitBranch(GitBranchResource),
    GitCommit(GitCommitResource),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitWorktreeResource {
    pub repo_root: PathBuf,
    pub worktree_path: PathBuf,
    pub branch_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitBranchResource {
    pub repo_root: PathBuf,
    pub worktree_root: PathBuf,
    pub base_sha: String,
    pub branch_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommitResource {
    pub repo_root: PathBuf,
    pub branch_name: String,
    pub commit_sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSurface {
    pub snapshot_id: WorkspaceSnapshotId,
    pub provider: WorkspaceProvider,
    pub resources: Vec<WorkspaceResource>,
    pub changed_paths: Vec<String>,
    pub conflicts: Vec<String>,
    pub git: Option<GitWorkspaceSurface>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitWorkspaceSurface {
    pub repo_root: PathBuf,
    pub worktree_root: PathBuf,
    pub base_sha: String,
    pub worktree_path: PathBuf,
    pub branch_name: String,
    pub worktree_resource_id: WorkspaceResourceId,
    pub branch_resource_id: WorkspaceResourceId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceChange {
    pub provider: WorkspaceProvider,
    pub resources: Vec<WorkspaceResource>,
    pub resource_ids: Vec<WorkspaceResourceId>,
    pub changed_paths: Vec<String>,
    pub side_effects: Vec<String>,
    pub conflicts: Vec<String>,
    pub git: Option<GitWorkspaceChange>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitWorkspaceChange {
    pub repo_root: PathBuf,
    pub worktree_root: PathBuf,
    pub base_sha: String,
    pub branch_name: String,
    pub worktree_path: Option<PathBuf>,
    pub commit_sha: Option<String>,
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
    fn open_surface(
        &mut self,
        snapshot: &WorkspaceSnapshot,
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceResult<WorkspaceSurface>;
    fn capture_changes(
        &mut self,
        surface: &WorkspaceSurface,
        side_effects: Vec<String>,
    ) -> WorkspaceResult<WorkspaceChange>;
    fn merge_changes(
        &mut self,
        changes: &[WorkspaceChange],
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceResult<WorkspaceSurface>;
    fn cleanup(&mut self, resource: &WorkspaceResource) -> WorkspaceResult<()>;
}

#[derive(Debug, Clone, Default)]
pub(super) struct WorkspaceIds {
    next_snapshot_id: WorkspaceSnapshotId,
    next_resource_id: WorkspaceResourceId,
}

impl WorkspaceIds {
    pub(super) fn next_snapshot_id(&mut self) -> WorkspaceSnapshotId {
        self.next_snapshot_id += 1;
        self.next_snapshot_id
    }

    pub(super) fn next_resource_id(&mut self) -> WorkspaceResourceId {
        self.next_resource_id += 1;
        self.next_resource_id
    }
}
