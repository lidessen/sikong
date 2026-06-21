use super::{
    FileSystemDirectoryResource, Workspace, WorkspaceChange, WorkspaceIds, WorkspaceProvider,
    WorkspaceRequirement, WorkspaceResource, WorkspaceResourceId, WorkspaceResourceKind,
    WorkspaceResourceMetadata, WorkspaceResourceRef, WorkspaceResourceState, WorkspaceResult,
    WorkspaceSnapshot, WorkspaceSnapshotId, WorkspaceSurface,
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

    pub(super) fn surface_record(
        id: WorkspaceResourceId,
        snapshot: &WorkspaceSnapshot,
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceSurface {
        WorkspaceSurface {
            snapshot_id: snapshot.id,
            provider: WorkspaceProvider::FileSystem,
            resources: vec![WorkspaceResource {
                id,
                provider: WorkspaceProvider::FileSystem,
                kind: WorkspaceResourceKind::Directory,
                state: WorkspaceResourceState::Active,
                refs,
                metadata: WorkspaceResourceMetadata::FileSystemDirectory(
                    FileSystemDirectoryResource {
                        root_path: std::env::current_dir().unwrap_or_else(|_| ".".into()),
                    },
                ),
            }],
            changed_paths: Vec::new(),
            conflicts: Vec::new(),
            git: None,
        }
    }

    pub(super) fn change_record(
        surface: &WorkspaceSurface,
        side_effects: Vec<String>,
    ) -> WorkspaceChange {
        WorkspaceChange {
            provider: WorkspaceProvider::FileSystem,
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
        }
    }

    pub(super) fn merge_surface_record(
        id: WorkspaceResourceId,
        changes: &[WorkspaceChange],
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceSurface {
        WorkspaceSurface {
            snapshot_id: 0,
            provider: WorkspaceProvider::FileSystem,
            resources: vec![WorkspaceResource {
                id,
                provider: WorkspaceProvider::FileSystem,
                kind: WorkspaceResourceKind::Directory,
                state: WorkspaceResourceState::Active,
                refs,
                metadata: WorkspaceResourceMetadata::FileSystemDirectory(
                    FileSystemDirectoryResource {
                        root_path: std::env::current_dir().unwrap_or_else(|_| ".".into()),
                    },
                ),
            }],
            changed_paths: changes
                .iter()
                .flat_map(|change| change.changed_paths.iter().cloned())
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

    fn open_surface(
        &mut self,
        snapshot: &WorkspaceSnapshot,
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceResult<WorkspaceSurface> {
        let id = self.ids.next_resource_id();
        Ok(Self::surface_record(id, snapshot, refs))
    }

    fn capture_changes(
        &mut self,
        surface: &WorkspaceSurface,
        side_effects: Vec<String>,
    ) -> WorkspaceResult<WorkspaceChange> {
        Ok(Self::change_record(surface, side_effects))
    }

    fn merge_changes(
        &mut self,
        changes: &[WorkspaceChange],
        refs: Vec<WorkspaceResourceRef>,
    ) -> WorkspaceResult<WorkspaceSurface> {
        let id = self.ids.next_resource_id();
        Ok(Self::merge_surface_record(id, changes, refs))
    }

    fn cleanup(&mut self, _resource: &WorkspaceResource) -> WorkspaceResult<()> {
        Ok(())
    }
}
