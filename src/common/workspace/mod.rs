mod file_system;
mod git_cli;
mod git_file_system;
mod memory;
mod workspaces;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use crate::common::types::{ArtifactId, NodeId};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub use file_system::FileSystemWorkspace;
pub use git_file_system::GitFileSystemWorkspace;
pub use memory::MemoryWorkspace;
pub use workspaces::Workspaces;

pub type WorkspaceSnapshotId = u64;
pub type WorkspaceResourceId = u64;

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
    FileSystemDirectory(FileSystemDirectoryResource),
    GitWorktree(GitWorktreeResource),
    GitBranch(GitBranchResource),
    GitCommit(GitCommitResource),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileSystemDirectoryResource {
    pub root_path: PathBuf,
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
    state: Arc<Mutex<WorkspaceIdsState>>,
}

#[derive(Debug, Default)]
struct WorkspaceIdsState {
    next_snapshot_id: WorkspaceSnapshotId,
    next_resource_id: WorkspaceResourceId,
}

impl WorkspaceIds {
    pub(super) fn next_snapshot_id(&mut self) -> WorkspaceSnapshotId {
        let mut state = self.state.lock().unwrap();
        state.next_snapshot_id += 1;
        state.next_snapshot_id
    }

    pub(super) fn next_resource_id(&mut self) -> WorkspaceResourceId {
        let mut state = self.state.lock().unwrap();
        state.next_resource_id += 1;
        state.next_resource_id
    }
}

/// Check whether a path is allowed by a set of glob scope patterns.
///
/// Each pattern supports:
/// - `**` — matches any number of path segments (including zero)
/// - `*` — matches any characters within a single path segment (never crosses `/`)
/// - `?` — matches exactly one character within a single segment
///
/// Returns `true` if `path` matches ANY of the `patterns`.
/// Returns `false` when `patterns` is empty (no scope = nothing allowed).
///
/// # Examples
///
/// ```
/// use std::path::Path;
/// # use siko::path_allowed as path_allowed;
///
/// // Match any .rs file at any depth
/// assert!(path_allowed(&["**/*.rs".into()], Path::new("src/main.rs")));
/// assert!(path_allowed(&["**/*.rs".into()], Path::new("nested/a/b/lib.rs")));
/// assert!(!path_allowed(&["**/*.rs".into()], Path::new("readme.md")));
///
/// // Match within a specific directory
/// let patterns = &["src/**/*.rs".into(), "design/**/*.md".into()];
/// assert!(path_allowed(patterns, Path::new("src/cli.rs")));
/// assert!(path_allowed(patterns, Path::new("design/README.md")));
/// assert!(!path_allowed(patterns, Path::new("tests/test.rs")));
///
/// // Empty scope allows nothing
/// assert!(!path_allowed(&[], Path::new("anything.txt")));
/// ```
pub fn path_allowed(patterns: &[String], path: &std::path::Path) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let path_str = path.to_string_lossy();
    patterns.iter().any(|pattern| glob_matches(pattern, &path_str))
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern_segments: Vec<&str> = pattern.split('/').collect();
    let path_segments: Vec<&str> = path.split('/').collect();
    segments_match(&pattern_segments, &path_segments, 0, 0)
}

fn segments_match(pattern: &[&str], path: &[&str], pi: usize, si: usize) -> bool {
    // All pattern segments consumed → path must also be fully consumed
    if pi >= pattern.len() {
        return si >= path.len();
    }

    // All path segments consumed → remaining pattern must be only `**`
    if si >= path.len() {
        return pattern[pi..].iter().all(|seg| *seg == "**");
    }

    let p_seg = pattern[pi];

    if p_seg == "**" {
        // `**` matches zero or more path segments; try each possibility
        for skip in 0..=(path.len() - si) {
            if segments_match(pattern, path, pi + 1, si + skip) {
                return true;
            }
        }
        false
    } else if segment_match(p_seg, path[si]) {
        segments_match(pattern, path, pi + 1, si + 1)
    } else {
        false
    }
}

fn segment_match(pattern: &str, segment: &str) -> bool {
    let p_chars: Vec<char> = pattern.chars().collect();
    let s_chars: Vec<char> = segment.chars().collect();
    segment_chars_match(&p_chars, &s_chars, 0, 0)
}

fn segment_chars_match(pattern: &[char], segment: &[char], pi: usize, si: usize) -> bool {
    // All pattern chars consumed → all segment chars must also be consumed
    if pi >= pattern.len() {
        return si >= segment.len();
    }

    // Handle `*` — matches zero or more chars within this segment
    if pattern[pi] == '*' {
        let remaining = segment.len().saturating_sub(si);
        for skip in 0..=remaining {
            if segment_chars_match(pattern, segment, pi + 1, si + skip) {
                return true;
            }
        }
        return false;
    }

    // Segment exhausted but pattern remains → no match
    if si >= segment.len() {
        return false;
    }

    // Handle `?` — matches exactly one char
    if pattern[pi] == '?' {
        return segment_chars_match(pattern, segment, pi + 1, si + 1);
    }

    // Exact char match
    if pattern[pi] != segment[si] {
        return false;
    }
    segment_chars_match(pattern, segment, pi + 1, si + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn workspace_requirement_memory_constructor() {
        let req = WorkspaceRequirement::memory();
        assert_eq!(req.provider, WorkspaceProvider::Memory);
        assert!(req.read_scope.is_empty());
        assert!(req.write_scope.is_empty());
        assert!(req.git.is_none());
    }

    #[test]
    fn workspace_requirement_read_only_files_constructor() {
        let req = WorkspaceRequirement::read_only_files();
        assert_eq!(req.provider, WorkspaceProvider::FileSystem);
        assert_eq!(req.read_scope, vec!["**/*"]);
        assert!(req.write_scope.is_empty());
        assert!(req.git.is_none());
    }

    #[test]
    fn workspace_requirement_git_constructor_with_single_path() {
        let req = WorkspaceRequirement::git(["src/main.rs"]);
        assert_eq!(req.provider, WorkspaceProvider::GitFileSystem);
        assert_eq!(req.read_scope, vec!["**/*"]);
        assert_eq!(req.write_scope, vec!["src/main.rs"]);
        assert!(req.git.is_none());
    }

    #[test]
    fn workspace_requirement_git_constructor_with_multiple_paths() {
        let req = WorkspaceRequirement::git(["src/**/*.rs", "design/**/*.md"]);
        assert_eq!(req.provider, WorkspaceProvider::GitFileSystem);
        assert_eq!(req.read_scope, vec!["**/*"]);
        assert_eq!(req.write_scope.len(), 2);
        assert!(req.write_scope.contains(&"src/**/*.rs".to_string()));
        assert!(req.write_scope.contains(&"design/**/*.md".to_string()));
        assert!(req.git.is_none());
    }

    #[test]
    fn workspace_requirement_git_constructor_empty_write_scope() {
        let req = WorkspaceRequirement::git(Vec::<String>::new());
        assert_eq!(req.provider, WorkspaceProvider::GitFileSystem);
        assert_eq!(req.read_scope, vec!["**/*"]);
        assert!(req.write_scope.is_empty());
        assert!(req.git.is_none());
    }

    #[test]
    fn workspace_requirement_git_repo_constructor() {
        let req = WorkspaceRequirement::git_repo("/repo", "/worktrees", "main", ["src/*"]);
        assert_eq!(req.provider, WorkspaceProvider::GitFileSystem);
        assert_eq!(req.read_scope, vec!["**/*"]);
        assert_eq!(req.write_scope, vec!["src/*"]);
        let git = req.git.expect("git requirement");
        assert_eq!(git.repo_root, PathBuf::from("/repo"));
        assert_eq!(git.worktree_root, PathBuf::from("/worktrees"));
        assert_eq!(git.base_ref, "main");
        assert!(git.fetch_remote.is_none());
    }

    #[test]
    fn workspace_requirement_git_repo_constructor_with_fetch_remote() {
        let mut req = WorkspaceRequirement::git_repo("/repo", "/worktrees", "main", Vec::<String>::new());
        req.git.as_mut().unwrap().fetch_remote = Some("origin".to_string());
        let git = req.git.expect("git requirement");
        assert_eq!(git.fetch_remote.as_deref(), Some("origin"));
    }

    #[test]
    fn workspace_ids_produce_unique_ids() {
        let mut ids = WorkspaceIds::default();
        let a = ids.next_snapshot_id();
        let b = ids.next_snapshot_id();
        assert!(b > a);
        let c = ids.next_resource_id();
        let d = ids.next_resource_id();
        assert!(d > c);
    }

    #[test]
    fn workspace_ids_separate_counters_for_snapshots_and_resources() {
        let mut ids = WorkspaceIds::default();
        assert_eq!(ids.next_snapshot_id(), 1);
        assert_eq!(ids.next_snapshot_id(), 2);
        assert_eq!(ids.next_resource_id(), 1);
        assert_eq!(ids.next_resource_id(), 2);
        assert_eq!(ids.next_snapshot_id(), 3);
        assert_eq!(ids.next_resource_id(), 3);
    }

    #[test]
    fn workspace_ids_cloned_instance_shares_state() {
        let ids_a = WorkspaceIds::default();
        let mut ids_b = ids_a.clone();
        assert_eq!(ids_b.next_snapshot_id(), 1);
        assert_eq!(ids_b.next_snapshot_id(), 2);
        // The original should see the same state because they share an Arc<Mutex<>>
        let mut ids_a = ids_a;
        assert_eq!(ids_a.next_snapshot_id(), 3);
    }

    #[test]
    fn workspace_provider_serde_roundtrip() {
        let cases = [
            WorkspaceProvider::Memory,
            WorkspaceProvider::FileSystem,
            WorkspaceProvider::GitFileSystem,
        ];
        for provider in cases {
            let json = serde_json::to_string(&provider).unwrap();
            let back: WorkspaceProvider = serde_json::from_str(&json).unwrap();
            assert_eq!(provider, back);
        }
    }

    #[test]
    fn workspace_requirement_serde_roundtrip() {
        let req = WorkspaceRequirement::git(["src/**/*.rs"]);
        let json = serde_json::to_string(&req).unwrap();
        let back: WorkspaceRequirement = serde_json::from_str(&json).unwrap();
        assert_eq!(req.provider, back.provider);
        assert_eq!(req.read_scope, back.read_scope);
        assert_eq!(req.write_scope, back.write_scope);
        assert_eq!(req.git, back.git);
    }

    #[test]
    fn workspace_resource_ref_variants() {
        // Verify all variants can be constructed and debug-printed
        let variants = vec![
            WorkspaceResourceRef::RunningNode(1),
            WorkspaceResourceRef::CandidateArtifact(42),
            WorkspaceResourceRef::ChildInputForCombine(7),
            WorkspaceResourceRef::MergeSurface(3),
            WorkspaceResourceRef::DebugRetain,
        ];
        assert_eq!(variants.len(), 5);
        assert!(format!("{:?}", variants).contains("RunningNode(1)"));
    }
    // ── path_allowed tests ────────────────────────────────────────────────

    #[test]
    fn path_allowed_double_star_matches_any_depth() {
        assert!(path_allowed(&["**/*.rs".into()], Path::new("src/main.rs")));
        assert!(path_allowed(&["**/*.rs".into()], Path::new("a/b/c/lib.rs")));
        assert!(!path_allowed(&["**/*.rs".into()], Path::new("readme.md")));
    }

    #[test]
    fn path_allowed_double_star_in_middle() {
        assert!(path_allowed(&["src/**/*.rs".into()], Path::new("src/main.rs")));
        assert!(path_allowed(&["src/**/*.rs".into()], Path::new("src/cli/mod.rs")));
        assert!(path_allowed(&["src/**/*.rs".into()], Path::new("src/a/b/c/lib.rs")));
        assert!(!path_allowed(&["src/**/*.rs".into()], Path::new("tests/test.rs")));
        assert!(!path_allowed(&["src/**/*.rs".into()], Path::new("src/main.c")));
    }

    #[test]
    fn path_allowed_multiple_patterns() {
        let patterns = &["src/**/*.rs".into(), "design/**/*.md".into()];
        assert!(path_allowed(patterns, Path::new("src/cli.rs")));
        assert!(path_allowed(patterns, Path::new("design/README.md")));
        assert!(!path_allowed(patterns, Path::new("tests/test.rs")));
        assert!(!path_allowed(patterns, Path::new("Cargo.toml")));
    }

    #[test]
    fn path_allowed_empty_scope_allows_nothing() {
        assert!(!path_allowed(&[], Path::new("anything.txt")));
        assert!(!path_allowed(&[], Path::new("")));
        assert!(!path_allowed(&[], Path::new("/")));
    }

    #[test]
    fn path_allowed_single_star_within_segment() {
        assert!(path_allowed(&["src/*.rs".into()], Path::new("src/main.rs")));
        assert!(!path_allowed(&["src/*.rs".into()], Path::new("src/main.c")));
        // single * does NOT cross directory boundaries
        assert!(!path_allowed(&["src/*.rs".into()], Path::new("src/cli/mod.rs")));
    }

    #[test]
    fn path_allowed_question_matches_exactly_one_char() {
        assert!(path_allowed(&["src/??.rs".into()], Path::new("src/cl.rs")));
        assert!(path_allowed(&["src/??.rs".into()], Path::new("src/ab.rs")));
        assert!(!path_allowed(&["src/??.rs".into()], Path::new("src/abc.rs")));
        assert!(!path_allowed(&["src/??.rs".into()], Path::new("src/a.rs")));
    }

    #[test]
    fn path_allowed_exact_path_match() {
        assert!(path_allowed(&["src/main.rs".into()], Path::new("src/main.rs")));
        assert!(!path_allowed(&["src/main.rs".into()], Path::new("src/lib.rs")));
        assert!(!path_allowed(&["src/main.rs".into()], Path::new("other/src/main.rs")));
    }

    #[test]
    fn path_allowed_double_star_at_end() {
        assert!(path_allowed(&["src/**".into()], Path::new("src/main.rs")));
        assert!(path_allowed(&["src/**".into()], Path::new("src/a/b/c")));
        assert!(path_allowed(&["src/**".into()], Path::new("src/")));
        assert!(!path_allowed(&["src/**".into()], Path::new("lib/main.rs")));
    }

    #[test]
    fn path_allowed_double_star_matches_zero_segments() {
        assert!(path_allowed(&["src/**/lib.rs".into()], Path::new("src/lib.rs")));
        assert!(path_allowed(&["src/**/lib.rs".into()], Path::new("src/sub/lib.rs")));
        assert!(path_allowed(&["src/**/lib.rs".into()], Path::new("src/a/b/lib.rs")));
        assert!(!path_allowed(&["src/**/lib.rs".into()], Path::new("src/main.rs")));
    }

    #[test]
    fn path_allowed_root_pattern_no_directory() {
        assert!(path_allowed(&["*.rs".into()], Path::new("main.rs")));
        assert!(path_allowed(&["*.rs".into()], Path::new("lib.rs")));
        assert!(!path_allowed(&["*.rs".into()], Path::new("src/main.rs")));
    }

    // ── glob_matches tests ────────────────────────────────────────────────

    #[test]
    fn glob_matches_exact_string() {
        assert!(glob_matches("src/main.rs", "src/main.rs"));
        assert!(!glob_matches("src/main.rs", "src/lib.rs"));
    }

    #[test]
    fn glob_matches_wildcard() {
        assert!(glob_matches("*.rs", "main.rs"));
        assert!(glob_matches("*.rs", "lib.rs"));
        assert!(!glob_matches("*.rs", "main.c"));
    }

    #[test]
    fn glob_matches_double_star() {
        assert!(glob_matches("**/*.rs", "main.rs"));
        assert!(glob_matches("**/*.rs", "src/main.rs"));
        assert!(glob_matches("**/*.rs", "a/b/c/main.rs"));
        assert!(!glob_matches("**/*.rs", "main.txt"));
    }

    // ── segments_match tests ──────────────────────────────────────────────

    #[test]
    fn segments_match_exact_all_segments() {
        assert!(segments_match(&["src", "main.rs"], &["src", "main.rs"], 0, 0));
        assert!(!segments_match(&["src", "main.rs"], &["src", "lib.rs"], 0, 0));
    }

    #[test]
    fn segments_match_double_star_matches_multiple() {
        assert!(segments_match(&["src", "**", "lib.rs"], &["src", "a", "b", "lib.rs"], 0, 0));
        assert!(segments_match(&["src", "**", "lib.rs"], &["src", "lib.rs"], 0, 0));
        assert!(!segments_match(&["src", "**", "lib.rs"], &["src", "main.rs"], 0, 0));
    }

    #[test]
    fn segments_match_only_double_star_remaining_when_path_exhausted() {
        // Path exhausted but pattern has ** remaining = match
        assert!(segments_match(&["a", "**"], &["a"], 0, 0));
        assert!(segments_match(&["a", "**", "**"], &["a"], 0, 0));
        // Path exhausted but pattern has non-** = no match
        assert!(!segments_match(&["a", "b"], &["a"], 0, 0));
    }

    #[test]
    fn segments_match_pattern_exhausted_before_path() {
        assert!(!segments_match(&["a"], &["a", "b"], 0, 0));
        assert!(segments_match(&["a", "**"], &["a", "b", "c"], 0, 0));
    }

    // ── segment_match tests ───────────────────────────────────────────────

    #[test]
    fn segment_match_exact() {
        assert!(segment_match("main.rs", "main.rs"));
        assert!(!segment_match("main.rs", "lib.rs"));
    }

    #[test]
    fn segment_match_single_star() {
        assert!(segment_match("*.rs", "main.rs"));
        assert!(segment_match("*.rs", "lib.rs"));
        assert!(!segment_match("*.rs", "main.c"));
        assert!(segment_match("main.*", "main.rs"));
    }

    #[test]
    fn segment_match_question_mark() {
        assert!(segment_match("??.rs", "ab.rs"));
        assert!(segment_match("??.rs", "cl.rs"));
        assert!(!segment_match("??.rs", "abc.rs"));
        assert!(!segment_match("??.rs", "a.rs"));
    }

    #[test]
    fn segment_match_star_with_question() {
        assert!(segment_match("?at.*", "cat.rs"));
        assert!(segment_match("?at.*", "bat.txt"));
        assert!(!segment_match("?at.*", "at.rs"));
        assert!(!segment_match("?at.*", "chat.rs"));
    }

    // ── segment_chars_match tests ────────────────────────────────────────

    #[test]
    fn segment_chars_match_empty() {
        let empty: Vec<char> = vec![];
        assert!(segment_chars_match(&empty, &empty, 0, 0));
        assert!(!segment_chars_match(&['a'], &empty, 0, 0));
        assert!(!segment_chars_match(&empty, &['a'], 0, 0));
    }

    #[test]
    fn segment_chars_match_star_matches_zero_chars() {
        assert!(segment_chars_match(&['*'], &[], 0, 0));
        assert!(segment_chars_match(&['*'], &['a'], 0, 0));
    }

    #[test]
    fn segment_chars_match_star_matches_multiple_chars() {
        assert!(segment_chars_match(&['a', '*', 'c'], &['a', 'b', 'c'], 0, 0));
        assert!(segment_chars_match(&['a', '*', 'c'], &['a', 'b', 'b', 'c'], 0, 0));
        assert!(!segment_chars_match(&['a', '*', 'c'], &['a', 'b', 'd'], 0, 0));
    }

    #[test]
    fn segment_chars_match_question_matches_exactly_one() {
        assert!(segment_chars_match(&['?'], &['a'], 0, 0));
        assert!(!segment_chars_match(&['?'], &[], 0, 0));
        assert!(!segment_chars_match(&['?'], &['a', 'b'], 0, 0));
    }

    #[test]
    fn segment_chars_match_exact_chars() {
        assert!(segment_chars_match(&['a', 'b', 'c'], &['a', 'b', 'c'], 0, 0));
        assert!(!segment_chars_match(&['a', 'b', 'c'], &['a', 'b', 'd'], 0, 0));
        assert!(!segment_chars_match(&['a', 'b', 'c'], &['a', 'b'], 0, 0));
    }

    #[test]
    fn segment_chars_match_star_at_start() {
        assert!(segment_chars_match(&['*', '.', 'r', 's'], &['m', 'a', 'i', 'n', '.', 'r', 's'], 0, 0));
        assert!(!segment_chars_match(&['*', '.', 'r', 's'], &['m', 'a', 'i', 'n', '.', 'c'], 0, 0));
    }
}
