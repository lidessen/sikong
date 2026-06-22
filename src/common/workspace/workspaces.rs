use super::{
    FileSystemWorkspace, GitFileSystemWorkspace, MemoryWorkspace, Workspace, WorkspaceChange,
    WorkspaceIds, WorkspaceProvider, WorkspaceRequirement, WorkspaceResource, WorkspaceResourceRef,
    WorkspaceResult, WorkspaceSnapshot, WorkspaceSurface,
};

#[derive(Clone, Default)]
pub struct Workspaces {
    ids: WorkspaceIds,
}

impl Workspace for Workspaces {
    fn snapshot(
        &mut self,
        requirement: &WorkspaceRequirement,
    ) -> WorkspaceResult<WorkspaceSnapshot> {
        let id = self.ids.next_snapshot_id();
        Ok(match requirement.provider {
            WorkspaceProvider::Memory => MemoryWorkspace::snapshot_record(id, requirement),
            WorkspaceProvider::FileSystem => FileSystemWorkspace::snapshot_record(id, requirement),
            WorkspaceProvider::GitFileSystem => {
                GitFileSystemWorkspace::snapshot_record(id, requirement)?
            }
        })
    }

    fn open_surface(
        &mut self,
        snapshot: &WorkspaceSnapshot,
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceResult<WorkspaceSurface> {
        match snapshot.provider {
            WorkspaceProvider::Memory => {
                let id = self.ids.next_resource_id();
                Ok(MemoryWorkspace::surface_record(id, snapshot, refs))
            }
            WorkspaceProvider::FileSystem => {
                let id = self.ids.next_resource_id();
                Ok(FileSystemWorkspace::surface_record(id, snapshot, refs))
            }
            WorkspaceProvider::GitFileSystem => {
                let worktree_resource_id = self.ids.next_resource_id();
                let branch_resource_id = self.ids.next_resource_id();
                GitFileSystemWorkspace::surface_record(
                    worktree_resource_id,
                    branch_resource_id,
                    snapshot,
                    refs,
                )
            }
        }
    }

    fn capture_changes(
        &mut self,
        surface: &WorkspaceSurface,
        side_effects: Vec<String>,
    ) -> WorkspaceResult<WorkspaceChange> {
        match surface.provider {
            WorkspaceProvider::Memory => Ok(MemoryWorkspace::change_record(surface, side_effects)),
            WorkspaceProvider::FileSystem => {
                Ok(FileSystemWorkspace::change_record(surface, side_effects))
            }
            WorkspaceProvider::GitFileSystem => {
                let commit_resource_id = self.ids.next_resource_id();
                GitFileSystemWorkspace::change_record(commit_resource_id, surface, side_effects)
            }
        }
    }

    fn merge_changes(
        &mut self,
        changes: &[WorkspaceChange],
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceResult<WorkspaceSurface> {
        if changes
            .iter()
            .any(|change| change.provider == WorkspaceProvider::GitFileSystem)
        {
            let worktree_resource_id = self.ids.next_resource_id();
            let branch_resource_id = self.ids.next_resource_id();
            return GitFileSystemWorkspace::merge_record(
                worktree_resource_id,
                branch_resource_id,
                changes,
                refs,
            );
        }

        if changes
            .iter()
            .any(|change| change.provider == WorkspaceProvider::FileSystem)
        {
            let id = self.ids.next_resource_id();
            return Ok(FileSystemWorkspace::merge_surface_record(id, changes, refs));
        }

        let id = self.ids.next_resource_id();
        Ok(MemoryWorkspace::merge_surface_record(id, changes, refs))
    }

    fn cleanup(&mut self, resource: &WorkspaceResource) -> WorkspaceResult<()> {
        match resource.provider {
            WorkspaceProvider::Memory => MemoryWorkspace::default().cleanup(resource),
            WorkspaceProvider::FileSystem => FileSystemWorkspace::default().cleanup(resource),
            WorkspaceProvider::GitFileSystem => GitFileSystemWorkspace::default().cleanup(resource),
        }
    }
}
