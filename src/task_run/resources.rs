use std::collections::HashMap;

use crate::workspace::{
    WorkspaceResource, WorkspaceResourceId, WorkspaceResourceRef, WorkspaceResourceState,
};

#[derive(Debug, Default)]
pub(crate) struct WorkspaceResourceRegistry {
    resources: HashMap<WorkspaceResourceId, WorkspaceResource>,
}

impl WorkspaceResourceRegistry {
    pub(crate) fn track_all(&mut self, resources: impl IntoIterator<Item = WorkspaceResource>) {
        for resource in resources {
            self.resources.insert(resource.id, resource);
        }
    }

    pub(crate) fn retain(&mut self, id: WorkspaceResourceId, resource_ref: WorkspaceResourceRef) {
        let Some(resource) = self.resources.get_mut(&id) else {
            return;
        };
        if !resource.refs.contains(&resource_ref) {
            resource.refs.push(resource_ref);
        }
    }

    pub(crate) fn release(&mut self, id: WorkspaceResourceId, resource_ref: &WorkspaceResourceRef) {
        if let Some(resource) = self.resources.get_mut(&id) {
            resource.refs.retain(|current| current != resource_ref);
        }
    }

    pub(crate) fn release_all_refs(&mut self) {
        for resource in self.resources.values_mut() {
            resource.refs.clear();
        }
    }

    pub(crate) fn releasable_ids(&self) -> Vec<WorkspaceResourceId> {
        self.resources
            .values()
            .filter(|resource| {
                resource.refs.is_empty() && resource.state == WorkspaceResourceState::Active
            })
            .map(|resource| resource.id)
            .collect()
    }

    pub(crate) fn resource(&self, id: WorkspaceResourceId) -> Option<&WorkspaceResource> {
        self.resources.get(&id)
    }

    pub(crate) fn mark_released(&mut self, id: WorkspaceResourceId) {
        if let Some(resource) = self.resources.get_mut(&id) {
            resource.state = WorkspaceResourceState::Released;
        }
    }

    pub(crate) fn mark_failed_cleanup(&mut self, id: WorkspaceResourceId) {
        if let Some(resource) = self.resources.get_mut(&id) {
            resource.state = WorkspaceResourceState::FailedCleanup;
        }
    }

    pub(crate) fn drain_all(&mut self) -> Vec<WorkspaceResource> {
        self.resources
            .drain()
            .map(|(_, resource)| resource)
            .collect()
    }
}
