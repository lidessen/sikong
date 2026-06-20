use std::collections::BTreeSet;

use crate::types::{WorkspaceResourceId, WorkspaceSnapshotId};

use super::{
    GitBranchResource, GitCommitResource, GitWorkspaceChange, GitWorkspaceSnapshot,
    GitWorkspaceSurface, GitWorktreeResource, Workspace, WorkspaceChange, WorkspaceError,
    WorkspaceIds, WorkspaceProvider, WorkspaceRequirement, WorkspaceResource,
    WorkspaceResourceKind, WorkspaceResourceMetadata, WorkspaceResourceRef, WorkspaceResourceState,
    WorkspaceResult, WorkspaceSnapshot, WorkspaceSurface, git_cli::GitCli,
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

    pub(super) fn surface_record(
        worktree_resource_id: WorkspaceResourceId,
        branch_resource_id: WorkspaceResourceId,
        snapshot: &WorkspaceSnapshot,
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceResult<WorkspaceSurface> {
        let git = snapshot
            .git
            .as_ref()
            .map(|git| {
                let branch_name = format!("sikong/node-{}-{branch_resource_id}", snapshot.id);
                let worktree_path = git
                    .worktree_root
                    .join(format!("node-{}-{worktree_resource_id}", snapshot.id));
                GitCli::create_worktree(
                    &git.repo_root,
                    &worktree_path,
                    &branch_name,
                    &git.base_sha,
                )?;

                Ok(GitWorkspaceSurface {
                    repo_root: git.repo_root.clone(),
                    worktree_root: git.worktree_root.clone(),
                    base_sha: git.base_sha.clone(),
                    worktree_path,
                    branch_name,
                    worktree_resource_id,
                    branch_resource_id,
                })
            })
            .transpose()?;

        let resources = git
            .as_ref()
            .map(|git| {
                vec![
                    WorkspaceResource {
                        id: git.worktree_resource_id,
                        provider: WorkspaceProvider::GitFileSystem,
                        kind: WorkspaceResourceKind::GitWorktree,
                        state: WorkspaceResourceState::Active,
                        refs: refs.clone(),
                        metadata: WorkspaceResourceMetadata::GitWorktree(GitWorktreeResource {
                            repo_root: git.repo_root.clone(),
                            worktree_path: git.worktree_path.clone(),
                            branch_name: git.branch_name.clone(),
                        }),
                    },
                    WorkspaceResource {
                        id: git.branch_resource_id,
                        provider: WorkspaceProvider::GitFileSystem,
                        kind: WorkspaceResourceKind::GitBranch,
                        state: WorkspaceResourceState::Active,
                        refs,
                        metadata: WorkspaceResourceMetadata::GitBranch(GitBranchResource {
                            repo_root: git.repo_root.clone(),
                            worktree_root: git.worktree_root.clone(),
                            base_sha: git.base_sha.clone(),
                            branch_name: git.branch_name.clone(),
                        }),
                    },
                ]
            })
            .unwrap_or_default();

        Ok(WorkspaceSurface {
            snapshot_id: snapshot.id,
            provider: WorkspaceProvider::GitFileSystem,
            resources,
            changed_paths: Vec::new(),
            conflicts: Vec::new(),
            git,
        })
    }

    pub(super) fn change_record(
        commit_resource_id: WorkspaceResourceId,
        surface: &WorkspaceSurface,
        side_effects: Vec<String>,
    ) -> WorkspaceResult<WorkspaceChange> {
        let Some(git_surface) = &surface.git else {
            return Ok(WorkspaceChange {
                provider: WorkspaceProvider::GitFileSystem,
                resources: Vec::new(),
                resource_ids: surface
                    .resources
                    .iter()
                    .map(|resource| resource.id)
                    .collect(),
                changed_paths: Vec::new(),
                side_effects,
                conflicts: Vec::new(),
                git: None,
            });
        };

        let mut side_effects = side_effects;
        let detected_paths = GitCli::commit_all(
            &git_surface.worktree_path,
            &format!("sikong resource change {commit_resource_id}"),
        )?;
        if let Some(commit_sha) = &detected_paths.commit_sha {
            side_effects.push(format!("git_commit:{commit_sha}"));
        }

        let mut resource_ids = vec![git_surface.branch_resource_id];
        let mut resources = Vec::new();
        if let Some(commit_sha) = &detected_paths.commit_sha {
            resource_ids.push(commit_resource_id);
            resources.push(WorkspaceResource {
                id: commit_resource_id,
                provider: WorkspaceProvider::GitFileSystem,
                kind: WorkspaceResourceKind::GitCommit,
                state: WorkspaceResourceState::Active,
                refs: Vec::new(),
                metadata: WorkspaceResourceMetadata::GitCommit(GitCommitResource {
                    repo_root: git_surface.repo_root.clone(),
                    branch_name: git_surface.branch_name.clone(),
                    commit_sha: commit_sha.clone(),
                }),
            });
        }

        Ok(WorkspaceChange {
            provider: WorkspaceProvider::GitFileSystem,
            resources,
            resource_ids,
            changed_paths: detected_paths.changed_paths,
            side_effects,
            conflicts: Vec::new(),
            git: Some(GitWorkspaceChange {
                repo_root: git_surface.repo_root.clone(),
                worktree_root: git_surface.worktree_root.clone(),
                base_sha: git_surface.base_sha.clone(),
                branch_name: git_surface.branch_name.clone(),
                worktree_path: None,
                commit_sha: detected_paths.commit_sha,
            }),
        })
    }

    pub(super) fn merge_record(
        worktree_resource_id: WorkspaceResourceId,
        branch_resource_id: WorkspaceResourceId,
        changes: &[WorkspaceChange],
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceResult<WorkspaceSurface> {
        let git_changes: Vec<_> = changes
            .iter()
            .filter_map(|change| change.git.as_ref())
            .collect();
        if git_changes.is_empty() {
            return Ok(Self::path_conflict_merge_surface_record(
                worktree_resource_id,
                changes,
                refs,
            ));
        }

        let first = git_changes[0];
        let branch_name = format!("sikong/merge/{branch_resource_id}");
        let worktree_path = first
            .worktree_root
            .join(format!("merge-{worktree_resource_id}"));

        let mut conflicts = Vec::new();
        GitCli::create_worktree(
            &first.repo_root,
            &worktree_path,
            &branch_name,
            &first.base_sha,
        )?;
        for git_change in &git_changes {
            if git_change.commit_sha.is_none() {
                continue;
            }
            if GitCli::merge_branch(&worktree_path, &git_change.branch_name).is_err() {
                conflicts = GitCli::conflict_paths(&worktree_path)?;
                if conflicts.is_empty() {
                    return Err(WorkspaceError::GitCommand {
                        operation: format!("merge {}", git_change.branch_name),
                        cwd: worktree_path,
                        message: "git merge failed without reported conflict paths".to_string(),
                    });
                }
                break;
            }
        }

        let changed_paths = dedupe_preserving_order(
            changes
                .iter()
                .flat_map(|change| change.changed_paths.iter().cloned()),
        );

        Ok(WorkspaceSurface {
            snapshot_id: 0,
            provider: WorkspaceProvider::GitFileSystem,
            resources: vec![
                WorkspaceResource {
                    id: worktree_resource_id,
                    provider: WorkspaceProvider::GitFileSystem,
                    kind: WorkspaceResourceKind::GitWorktree,
                    state: WorkspaceResourceState::Active,
                    refs: refs.clone(),
                    metadata: WorkspaceResourceMetadata::GitWorktree(GitWorktreeResource {
                        repo_root: first.repo_root.clone(),
                        worktree_path: worktree_path.clone(),
                        branch_name: branch_name.clone(),
                    }),
                },
                WorkspaceResource {
                    id: branch_resource_id,
                    provider: WorkspaceProvider::GitFileSystem,
                    kind: WorkspaceResourceKind::GitBranch,
                    state: WorkspaceResourceState::Active,
                    refs,
                    metadata: WorkspaceResourceMetadata::GitBranch(GitBranchResource {
                        repo_root: first.repo_root.clone(),
                        worktree_root: first.worktree_root.clone(),
                        base_sha: first.base_sha.clone(),
                        branch_name: branch_name.clone(),
                    }),
                },
            ],
            changed_paths,
            conflicts,
            git: Some(GitWorkspaceSurface {
                repo_root: first.repo_root.clone(),
                worktree_root: first.worktree_root.clone(),
                base_sha: first.base_sha.clone(),
                worktree_path: worktree_path.clone(),
                branch_name,
                worktree_resource_id,
                branch_resource_id,
            }),
        })
    }

    fn path_conflict_merge_surface_record(
        resource_id: WorkspaceResourceId,
        changes: &[WorkspaceChange],
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceSurface {
        let mut changed_paths = Vec::new();
        let mut seen = BTreeSet::new();
        let mut conflicts = Vec::new();

        for change in changes {
            for path in &change.changed_paths {
                if !seen.insert(path.clone()) {
                    conflicts.push(path.clone());
                }
                changed_paths.push(path.clone());
            }
        }

        WorkspaceSurface {
            snapshot_id: 0,
            provider: WorkspaceProvider::GitFileSystem,
            resources: vec![WorkspaceResource {
                id: resource_id,
                provider: WorkspaceProvider::GitFileSystem,
                kind: WorkspaceResourceKind::Memory,
                state: WorkspaceResourceState::Active,
                refs,
                metadata: WorkspaceResourceMetadata::None,
            }],
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

    fn open_surface(
        &mut self,
        snapshot: &WorkspaceSnapshot,
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceResult<WorkspaceSurface> {
        let worktree_resource_id = self.ids.next_resource_id();
        let branch_resource_id = self.ids.next_resource_id();
        Self::surface_record(worktree_resource_id, branch_resource_id, snapshot, refs)
    }

    fn capture_changes(
        &mut self,
        surface: &WorkspaceSurface,
        side_effects: Vec<String>,
    ) -> WorkspaceResult<WorkspaceChange> {
        let commit_resource_id = self.ids.next_resource_id();
        Self::change_record(commit_resource_id, surface, side_effects)
    }

    fn merge_changes(
        &mut self,
        changes: &[WorkspaceChange],
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceResult<WorkspaceSurface> {
        let worktree_resource_id = self.ids.next_resource_id();
        let branch_resource_id = self.ids.next_resource_id();
        Self::merge_record(worktree_resource_id, branch_resource_id, changes, refs)
    }

    fn cleanup(&mut self, resource: &WorkspaceResource) -> WorkspaceResult<()> {
        match &resource.metadata {
            WorkspaceResourceMetadata::GitWorktree(git) => {
                GitCli::remove_worktree(&git.repo_root, &git.worktree_path)
            }
            WorkspaceResourceMetadata::GitBranch(git) => {
                GitCli::delete_branch(&git.repo_root, &git.branch_name)
            }
            WorkspaceResourceMetadata::GitCommit(_) | WorkspaceResourceMetadata::None => Ok(()),
        }
    }
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
