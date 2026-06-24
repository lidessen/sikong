use std::{ffi::OsStr, fs, path::Path, process::Command};

use super::{WorkspaceError, WorkspaceResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CommitAllResult {
    pub(super) changed_paths: Vec<String>,
    pub(super) commit_sha: Option<String>,
}

pub(super) struct GitCli;

impl GitCli {
    pub(super) fn fetch(repo_root: &Path, remote: &str) -> WorkspaceResult<()> {
        Self::run(format!("fetch {remote}"), repo_root, ["fetch", remote]).map(|_| ())
    }

    pub(super) fn rev_parse(repo_root: &Path, rev: &str) -> WorkspaceResult<String> {
        Self::run(format!("rev-parse {rev}"), repo_root, ["rev-parse", rev])
            .map(|output| output.trim().to_string())
    }

    pub(super) fn create_worktree(
        repo_root: &Path,
        worktree_path: &Path,
        branch_name: &str,
        base_sha: &str,
    ) -> WorkspaceResult<()> {
        if let Some(parent) = worktree_path.parent() {
            fs::create_dir_all(parent).map_err(|error| WorkspaceError::Io {
                operation: "create worktree parent".to_string(),
                path: parent.to_path_buf(),
                message: error.to_string(),
            })?;
        }
        Self::run(
            format!("worktree add {branch_name}"),
            repo_root,
            [
                OsStr::new("worktree"),
                OsStr::new("add"),
                OsStr::new("-b"),
                OsStr::new(branch_name),
                worktree_path.as_os_str(),
                OsStr::new(base_sha),
            ],
        )
        .map(|_| ())
    }

    pub(super) fn remove_worktree(repo_root: &Path, worktree_path: &Path) -> WorkspaceResult<()> {
        Self::run(
            format!("worktree remove {}", worktree_path.display()),
            repo_root,
            [
                OsStr::new("worktree"),
                OsStr::new("remove"),
                OsStr::new("--force"),
                worktree_path.as_os_str(),
            ],
        )
        .map(|_| ())
    }

    pub(super) fn delete_branch(repo_root: &Path, branch_name: &str) -> WorkspaceResult<()> {
        Self::run(
            format!("branch delete {branch_name}"),
            repo_root,
            [
                OsStr::new("branch"),
                OsStr::new("-D"),
                OsStr::new(branch_name),
            ],
        )
        .map(|_| ())
    }

    /// Stage and commit all changed files (modified, added, deleted, untracked)
    /// within the worktree. This is the general-purpose "commit everything" path.
    pub(super) fn commit_all(
        worktree_path: &Path,
        message: &str,
    ) -> WorkspaceResult<CommitAllResult> {
        Self::run("add -A", worktree_path, ["add", "-A"])?;
        let changed_paths = Self::diff_cached_paths(worktree_path)?;
        if changed_paths.is_empty() {
            return Ok(CommitAllResult {
                changed_paths,
                commit_sha: None,
            });
        }

        Self::run(
            "commit",
            worktree_path,
            [OsStr::new("commit"), OsStr::new("-m"), OsStr::new(message)],
        )?;
        let commit_sha = Self::rev_parse(worktree_path, "HEAD")?;
        Ok(CommitAllResult {
            changed_paths,
            commit_sha: Some(commit_sha),
        })
    }

    /// Stage and commit only those changed files whose paths match at least one
    /// of the `write_scope` glob patterns. Files outside the write scope are
    /// left unstaged (they remain as working-tree changes but are not committed).
    ///
    /// This is the write-scope-aware alternative to [`commit_all`] and is used
    /// by the engine's post-completion lifecycle hook to ensure only paths
    /// within the node's declared write_scope are committed.
    pub(super) fn commit_write_scope(
        worktree_path: &Path,
        message: &str,
        write_scope: &[String],
    ) -> WorkspaceResult<CommitAllResult> {
        // ── 1. Discover all changed files ──────────────────────────────
        // `git status --porcelain -z` gives machine-parseable output with
        // NUL-separated entries:  "XY <path>\0"
        let raw = Self::run(
            "status porcelain",
            worktree_path,
            [
                OsStr::new("status"),
                OsStr::new("--porcelain"),
                OsStr::new("-z"),
            ],
        )?;

        let entries: Vec<&str> = raw.split('\0').filter(|s| !s.is_empty()).collect();
        let mut all_changed = Vec::new();
        let mut scope_paths = Vec::new();

        for entry in &entries {
            // Each entry looks like "XY <path>" where XY are status codes.
            // The path starts at byte 3 (after two status chars and a space).
            let trimmed = entry.trim();
            if trimmed.len() < 4 {
                continue;
            }
            let path_part = &trimmed[3..];

            // Handle quoted paths (git may quote paths containing special chars)
            let path = if path_part.starts_with('"') {
                // Try a simple unescape: strip surrounding quotes
                let unquoted = path_part.trim_matches('"');
                // Replace common escape sequences
                unquoted.replace("\\\"", "\"").replace("\\\\", "\\")
            } else {
                path_part.to_string()
            };

            all_changed.push(path.clone());

            // Check if this path matches any write_scope pattern
            if crate::common::workspace::path_allowed(write_scope, std::path::Path::new(&path)) {
                scope_paths.push(path);
            }
        }

        // ── 2. Stage only write-scope paths ────────────────────────────
        if scope_paths.is_empty() {
            return Ok(CommitAllResult {
                changed_paths: all_changed,
                commit_sha: None,
            });
        }

        let mut add_args: Vec<&OsStr> = vec![OsStr::new("add"), OsStr::new("--")];
        for path in &scope_paths {
            add_args.push(OsStr::new(path));
        }
        Self::run("add write-scope", worktree_path, add_args)?;

        // ── 3. Check if anything was staged ────────────────────────────
        let staged = Self::diff_cached_paths(worktree_path)?;
        if staged.is_empty() {
            return Ok(CommitAllResult {
                changed_paths: all_changed,
                commit_sha: None,
            });
        }

        // ── 4. Commit ──────────────────────────────────────────────────
        Self::run(
            "commit",
            worktree_path,
            [OsStr::new("commit"), OsStr::new("-m"), OsStr::new(message)],
        )?;
        let commit_sha = Self::rev_parse(worktree_path, "HEAD")?;

        Ok(CommitAllResult {
            changed_paths: staged,
            commit_sha: Some(commit_sha),
        })
    }

    pub(super) fn merge_branch(worktree_path: &Path, branch_name: &str) -> WorkspaceResult<()> {
        Self::run(
            format!("merge {branch_name}"),
            worktree_path,
            [
                OsStr::new("merge"),
                OsStr::new("--no-ff"),
                OsStr::new("--no-edit"),
                OsStr::new(branch_name),
            ],
        )
        .map(|_| ())
    }

    pub(super) fn conflict_paths(worktree_path: &Path) -> WorkspaceResult<Vec<String>> {
        Self::run(
            "conflict paths",
            worktree_path,
            [
                OsStr::new("diff"),
                OsStr::new("--name-only"),
                OsStr::new("--diff-filter=U"),
                OsStr::new("-z"),
            ],
        )
        .map(parse_nul_paths)
    }

    fn diff_cached_paths(worktree_path: &Path) -> WorkspaceResult<Vec<String>> {
        Self::run(
            "diff cached paths",
            worktree_path,
            [
                OsStr::new("diff"),
                OsStr::new("--cached"),
                OsStr::new("--name-only"),
                OsStr::new("-z"),
            ],
        )
        .map(parse_nul_paths)
    }

    fn run<I, S>(operation: impl Into<String>, cwd: &Path, args: I) -> WorkspaceResult<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let operation = operation.into();
        let output = Command::new("git")
            .arg("-c")
            .arg("user.name=Sikong")
            .arg("-c")
            .arg("user.email=sikong@example.invalid")
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|error| WorkspaceError::Io {
                operation: operation.clone(),
                path: cwd.to_path_buf(),
                message: error.to_string(),
            })?;

        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(WorkspaceError::GitCommand {
            operation,
            cwd: cwd.to_path_buf(),
            message: format!(
                "git exited with {}: {}{}",
                output.status,
                stderr.trim(),
                stdout.trim()
            ),
        })
    }
}

fn parse_nul_paths(output: String) -> Vec<String> {
    output
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}
