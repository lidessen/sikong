use super::{
    FileSystemWorkspace, GitFileSystemWorkspace, MemoryWorkspace, Workspace, WorkspaceDelta,
    WorkspaceIds, WorkspaceInstance, WorkspaceIntegration, WorkspaceProvider, WorkspaceRequirement,
    WorkspaceResult, WorkspaceSnapshot,
};

#[derive(Default)]
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

    fn fork(&mut self, snapshot: &WorkspaceSnapshot) -> WorkspaceResult<WorkspaceInstance> {
        let id = self.ids.next_instance_id();
        Ok(match snapshot.provider {
            WorkspaceProvider::Memory => MemoryWorkspace::fork_record(id, snapshot),
            WorkspaceProvider::FileSystem => FileSystemWorkspace::fork_record(id, snapshot),
            WorkspaceProvider::GitFileSystem => GitFileSystemWorkspace::fork_record(id, snapshot)?,
        })
    }

    fn collect_delta(
        &mut self,
        instance: &WorkspaceInstance,
        changed_paths: Vec<String>,
        side_effects: Vec<String>,
    ) -> WorkspaceResult<WorkspaceDelta> {
        let id = self.ids.next_delta_id();
        match instance.provider {
            WorkspaceProvider::Memory => Ok(MemoryWorkspace::delta_record(
                id,
                instance,
                changed_paths,
                side_effects,
            )),
            WorkspaceProvider::FileSystem => Ok(FileSystemWorkspace::delta_record(
                id,
                instance,
                changed_paths,
                side_effects,
            )),
            WorkspaceProvider::GitFileSystem => {
                GitFileSystemWorkspace::delta_record(id, instance, changed_paths, side_effects)
            }
        }
    }

    fn combine(&self, deltas: &[WorkspaceDelta]) -> WorkspaceResult<WorkspaceIntegration> {
        if deltas
            .iter()
            .any(|delta| delta.provider == WorkspaceProvider::GitFileSystem)
        {
            return GitFileSystemWorkspace::integration_record(deltas);
        }

        if deltas
            .iter()
            .any(|delta| delta.provider == WorkspaceProvider::FileSystem)
        {
            return Ok(FileSystemWorkspace::integration_record(deltas));
        }

        Ok(MemoryWorkspace::integration_record(deltas))
    }
}
