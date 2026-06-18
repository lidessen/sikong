use crate::types::{WorkspaceDeltaId, WorkspaceInstanceId, WorkspaceSnapshotId};

use super::{
    Workspace, WorkspaceDelta, WorkspaceIds, WorkspaceInstance, WorkspaceIntegration,
    WorkspaceProvider, WorkspaceRequirement, WorkspaceResult, WorkspaceSnapshot,
};

#[derive(Debug, Clone, Default)]
pub struct FileSystemWorkspace {
    ids: WorkspaceIds,
}

impl FileSystemWorkspace {
    pub(super) fn snapshot_record(
        id: WorkspaceSnapshotId,
        requirement: &WorkspaceRequirement,
    ) -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            id,
            provider: WorkspaceProvider::FileSystem,
            scope: requirement
                .read_scope
                .iter()
                .chain(requirement.write_scope.iter())
                .cloned()
                .collect(),
            git: None,
        }
    }

    pub(super) fn fork_record(
        id: WorkspaceInstanceId,
        snapshot: &WorkspaceSnapshot,
    ) -> WorkspaceInstance {
        WorkspaceInstance {
            id,
            snapshot_id: snapshot.id,
            provider: WorkspaceProvider::FileSystem,
            git: None,
        }
    }

    pub(super) fn delta_record(
        id: WorkspaceDeltaId,
        instance: &WorkspaceInstance,
        changed_paths: Vec<String>,
        side_effects: Vec<String>,
    ) -> WorkspaceDelta {
        WorkspaceDelta {
            id,
            instance_id: instance.id,
            provider: WorkspaceProvider::FileSystem,
            changed_paths,
            side_effects,
            git: None,
        }
    }

    pub(super) fn integration_record(deltas: &[WorkspaceDelta]) -> WorkspaceIntegration {
        WorkspaceIntegration {
            deltas: deltas.iter().map(|delta| delta.id).collect(),
            changed_paths: deltas
                .iter()
                .flat_map(|delta| delta.changed_paths.iter().cloned())
                .collect(),
            conflicts: Vec::new(),
            git: None,
        }
    }
}

impl Workspace for FileSystemWorkspace {
    fn snapshot(
        &mut self,
        requirement: &WorkspaceRequirement,
    ) -> WorkspaceResult<WorkspaceSnapshot> {
        let id = self.ids.next_snapshot_id();
        Ok(Self::snapshot_record(id, requirement))
    }

    fn fork(&mut self, snapshot: &WorkspaceSnapshot) -> WorkspaceResult<WorkspaceInstance> {
        let id = self.ids.next_instance_id();
        Ok(Self::fork_record(id, snapshot))
    }

    fn collect_delta(
        &mut self,
        instance: &WorkspaceInstance,
        changed_paths: Vec<String>,
        side_effects: Vec<String>,
    ) -> WorkspaceResult<WorkspaceDelta> {
        let id = self.ids.next_delta_id();
        Ok(Self::delta_record(
            id,
            instance,
            changed_paths,
            side_effects,
        ))
    }

    fn combine(&self, deltas: &[WorkspaceDelta]) -> WorkspaceResult<WorkspaceIntegration> {
        Ok(Self::integration_record(deltas))
    }
}
