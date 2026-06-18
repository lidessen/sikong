use std::{collections::BTreeSet, ffi::OsStr, fs, path::Path, process::Command};

use crate::types::{WorkspaceDeltaId, WorkspaceInstanceId, WorkspaceSnapshotId};

use super::{
    GitWorkspaceDelta, GitWorkspaceInstance, GitWorkspaceIntegration, GitWorkspaceSnapshot,
    Workspace, WorkspaceDelta, WorkspaceError, WorkspaceIds, WorkspaceInstance,
    WorkspaceIntegration, WorkspaceProvider, WorkspaceRequirement, WorkspaceResult,
    WorkspaceSnapshot,
};

#[derive(Debug, Clone, Default)]
pub struct GitFileSystemWorkspace {
    ids: WorkspaceIds,
}

impl GitFileSystemWorkspace {
    pub(super) fn snapshot_record(
        id: WorkspaceSnapshotId,
        requirement: &WorkspaceRequirement,
    ) -> WorkspaceResult<WorkspaceSnapshot> {
        let git = requirement
            .git
            .as_ref()
            .map(|git| {
                if let Some(remote) = &git.fetch_remote {
                    GitCli::fetch(&git.repo_root, remote)?;
                }
                let base_sha = GitCli::rev_parse(&git.repo_root, &git.base_ref)?;
                Ok(GitWorkspaceSnapshot {
                    repo_root: git.repo_root.clone(),
                    worktree_root: git.worktree_root.clone(),
                    base_ref: git.base_ref.clone(),
                    base_sha,
                })
            })
            .transpose()?;

        Ok(WorkspaceSnapshot {
            id,
            provider: WorkspaceProvider::GitFileSystem,
            scope: requirement
                .read_scope
                .iter()
                .chain(requirement.write_scope.iter())
                .cloned()
                .collect(),
            git,
        })
    }

    pub(super) fn fork_record(
        id: WorkspaceInstanceId,
        snapshot: &WorkspaceSnapshot,
    ) -> WorkspaceResult<WorkspaceInstance> {
        let git = snapshot
            .git
            .as_ref()
            .map(|git| {
                let branch_name = format!("sikong/node-{}-{id}", snapshot.id);
                let worktree_path = git.worktree_root.join(format!("node-{}-{id}", snapshot.id));
                GitCli::create_worktree(
                    &git.repo_root,
                    &worktree_path,
                    &branch_name,
                    &git.base_sha,
                )?;

                Ok(GitWorkspaceInstance {
                    repo_root: git.repo_root.clone(),
                    worktree_root: git.worktree_root.clone(),
                    base_sha: git.base_sha.clone(),
                    worktree_path,
                    branch_name,
                })
            })
            .transpose()?;

        Ok(WorkspaceInstance {
            id,
            snapshot_id: snapshot.id,
            provider: WorkspaceProvider::GitFileSystem,
            git,
        })
    }

    pub(super) fn delta_record(
        id: WorkspaceDeltaId,
        instance: &WorkspaceInstance,
        changed_paths: Vec<String>,
        side_effects: Vec<String>,
    ) -> WorkspaceResult<WorkspaceDelta> {
        let Some(git_instance) = &instance.git else {
            return Ok(WorkspaceDelta {
                id,
                instance_id: instance.id,
                provider: WorkspaceProvider::GitFileSystem,
                changed_paths,
                side_effects,
                git: None,
            });
        };

        let mut side_effects = side_effects;
        let detected_paths =
            GitCli::commit_all(&git_instance.worktree_path, &format!("sikong delta {id}"))?;
        if let Some(commit_sha) = &detected_paths.commit_sha {
            side_effects.push(format!("git_commit:{commit_sha}"));
        }

        Ok(WorkspaceDelta {
            id,
            instance_id: instance.id,
            provider: WorkspaceProvider::GitFileSystem,
            changed_paths: detected_paths.changed_paths,
            side_effects,
            git: Some(GitWorkspaceDelta {
                repo_root: git_instance.repo_root.clone(),
                worktree_root: git_instance.worktree_root.clone(),
                base_sha: git_instance.base_sha.clone(),
                branch_name: git_instance.branch_name.clone(),
                worktree_path: git_instance.worktree_path.clone(),
                commit_sha: detected_paths.commit_sha,
            }),
        })
    }

    pub(super) fn integration_record(
        deltas: &[WorkspaceDelta],
    ) -> WorkspaceResult<WorkspaceIntegration> {
        let git_deltas: Vec<_> = deltas
            .iter()
            .filter_map(|delta| delta.git.as_ref())
            .collect();
        if git_deltas.is_empty() {
            return Ok(Self::path_conflict_integration_record(deltas));
        }

        let first = git_deltas[0];
        let delta_key = deltas
            .iter()
            .map(|delta| delta.id.to_string())
            .collect::<Vec<_>>()
            .join("-");
        let branch_name = format!("sikong/integration/{delta_key}");
        let worktree_path = first.worktree_root.join(format!("integration-{delta_key}"));

        let mut conflicts = Vec::new();
        GitCli::create_worktree(
            &first.repo_root,
            &worktree_path,
            &branch_name,
            &first.base_sha,
        )?;
        for git_delta in &git_deltas {
            if git_delta.commit_sha.is_none() {
                continue;
            }
            if GitCli::merge_branch(&worktree_path, &git_delta.branch_name).is_err() {
                conflicts = GitCli::conflict_paths(&worktree_path)?;
                if conflicts.is_empty() {
                    return Err(WorkspaceError::GitCommand {
                        operation: format!("merge {}", git_delta.branch_name),
                        cwd: worktree_path,
                        message: "git merge failed without reported conflict paths".to_string(),
                    });
                }
                break;
            }
        }

        let changed_paths = dedupe_preserving_order(
            deltas
                .iter()
                .flat_map(|delta| delta.changed_paths.iter().cloned()),
        );

        Ok(WorkspaceIntegration {
            deltas: deltas.iter().map(|delta| delta.id).collect(),
            changed_paths,
            conflicts,
            git: Some(GitWorkspaceIntegration {
                worktree_path,
                branch_name,
            }),
        })
    }

    pub fn dispose_instance(&self, instance: &WorkspaceInstance) -> WorkspaceResult<()> {
        let Some(git) = &instance.git else {
            return Ok(());
        };
        GitCli::remove_worktree(&git.repo_root, &git.worktree_path)?;
        GitCli::delete_branch(&git.repo_root, &git.branch_name)
    }

    fn path_conflict_integration_record(deltas: &[WorkspaceDelta]) -> WorkspaceIntegration {
        let mut changed_paths = Vec::new();
        let mut seen = BTreeSet::new();
        let mut conflicts = Vec::new();

        for delta in deltas {
            for path in &delta.changed_paths {
                if !seen.insert(path.clone()) {
                    conflicts.push(path.clone());
                }
                changed_paths.push(path.clone());
            }
        }

        WorkspaceIntegration {
            deltas: deltas.iter().map(|delta| delta.id).collect(),
            changed_paths,
            conflicts,
            git: None,
        }
    }
}

impl Workspace for GitFileSystemWorkspace {
    fn snapshot(
        &mut self,
        requirement: &WorkspaceRequirement,
    ) -> WorkspaceResult<WorkspaceSnapshot> {
        let id = self.ids.next_snapshot_id();
        Self::snapshot_record(id, requirement)
    }

    fn fork(&mut self, snapshot: &WorkspaceSnapshot) -> WorkspaceResult<WorkspaceInstance> {
        let id = self.ids.next_instance_id();
        Self::fork_record(id, snapshot)
    }

    fn collect_delta(
        &mut self,
        instance: &WorkspaceInstance,
        changed_paths: Vec<String>,
        side_effects: Vec<String>,
    ) -> WorkspaceResult<WorkspaceDelta> {
        let id = self.ids.next_delta_id();
        Self::delta_record(id, instance, changed_paths, side_effects)
    }

    fn combine(&self, deltas: &[WorkspaceDelta]) -> WorkspaceResult<WorkspaceIntegration> {
        Self::integration_record(deltas)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommitAllResult {
    changed_paths: Vec<String>,
    commit_sha: Option<String>,
}

struct GitCli;

impl GitCli {
    fn fetch(repo_root: &Path, remote: &str) -> WorkspaceResult<()> {
        Self::run(format!("fetch {remote}"), repo_root, ["fetch", remote]).map(|_| ())
    }

    fn rev_parse(repo_root: &Path, rev: &str) -> WorkspaceResult<String> {
        Self::run(format!("rev-parse {rev}"), repo_root, ["rev-parse", rev])
            .map(|output| output.trim().to_string())
    }

    fn create_worktree(
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

    fn remove_worktree(repo_root: &Path, worktree_path: &Path) -> WorkspaceResult<()> {
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

    fn delete_branch(repo_root: &Path, branch_name: &str) -> WorkspaceResult<()> {
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

    fn commit_all(worktree_path: &Path, message: &str) -> WorkspaceResult<CommitAllResult> {
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

    fn merge_branch(worktree_path: &Path, branch_name: &str) -> WorkspaceResult<()> {
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

    fn conflict_paths(worktree_path: &Path) -> WorkspaceResult<Vec<String>> {
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

fn dedupe_preserving_order(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut deduped = Vec::new();
    for path in paths {
        if seen.insert(path.clone()) {
            deduped.push(path);
        }
    }
    deduped
}
