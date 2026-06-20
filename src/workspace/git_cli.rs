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
