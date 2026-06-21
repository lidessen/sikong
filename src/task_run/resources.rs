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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{
        WorkspaceProvider, WorkspaceResourceKind, WorkspaceResourceMetadata,
    };

    fn make_resource(id: WorkspaceResourceId) -> WorkspaceResource {
        WorkspaceResource {
            id,
            provider: WorkspaceProvider::Memory,
            kind: WorkspaceResourceKind::Memory,
            state: WorkspaceResourceState::Active,
            refs: Vec::new(),
            metadata: WorkspaceResourceMetadata::None,
        }
    }

    fn resource_with_refs(id: WorkspaceResourceId, refs: Vec<WorkspaceResourceRef>) -> WorkspaceResource {
        WorkspaceResource {
            id,
            provider: WorkspaceProvider::Memory,
            kind: WorkspaceResourceKind::Memory,
            state: WorkspaceResourceState::Active,
            refs,
            metadata: WorkspaceResourceMetadata::None,
        }
    }

    #[test]
    fn track_all_inserts_resources_by_id() {
        let mut reg = WorkspaceResourceRegistry::default();
        assert!(reg.resource(1).is_none());
        reg.track_all([make_resource(1), make_resource(2)]);
        assert_eq!(reg.resource(1).unwrap().id, 1);
        assert_eq!(reg.resource(2).unwrap().id, 2);
    }

    #[test]
    fn track_all_overwrites_existing_id() {
        let mut reg = WorkspaceResourceRegistry::default();
        let mut r1 = make_resource(1);
        r1.kind = WorkspaceResourceKind::Directory;
        reg.track_all([r1]);
        // overwrite with a different kind
        let r2 = make_resource(1);
        reg.track_all([r2]);
        assert_eq!(reg.resource(1).unwrap().kind, WorkspaceResourceKind::Memory);
    }

    #[test]
    fn retain_adds_ref_when_not_present() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.track_all([make_resource(1)]);
        let rf = WorkspaceResourceRef::RunningNode(10);
        reg.retain(1, rf.clone());
        assert!(reg.resource(1).unwrap().refs.contains(&rf));
    }

    #[test]
    fn retain_does_not_duplicate_existing_ref() {
        let mut reg = WorkspaceResourceRegistry::default();
        let rf = WorkspaceResourceRef::RunningNode(10);
        reg.track_all([resource_with_refs(1, vec![rf.clone()])]);
        reg.retain(1, rf.clone());
        assert_eq!(reg.resource(1).unwrap().refs.len(), 1);
    }

    #[test]
    fn retain_unknown_id_is_noop() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.retain(99, WorkspaceResourceRef::RunningNode(1));
        // no panic, no entry created
        assert!(reg.resource(99).is_none());
    }

    #[test]
    fn release_removes_specific_ref() {
        let mut reg = WorkspaceResourceRegistry::default();
        let rf1 = WorkspaceResourceRef::RunningNode(1);
        let rf2 = WorkspaceResourceRef::RunningNode(2);
        reg.track_all([resource_with_refs(1, vec![rf1.clone(), rf2.clone()])]);
        reg.release(1, &rf1);
        assert!(!reg.resource(1).unwrap().refs.contains(&rf1));
        assert!(reg.resource(1).unwrap().refs.contains(&rf2));
    }

    #[test]
    fn release_unknown_id_is_noop() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.release(99, &WorkspaceResourceRef::RunningNode(1));
        // no panic
    }

    #[test]
    fn release_absent_ref_is_noop() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.track_all([make_resource(1)]);
        reg.release(1, &WorkspaceResourceRef::RunningNode(5));
        assert!(reg.resource(1).unwrap().refs.is_empty());
    }

    #[test]
    fn release_all_refs_clears_all_resources() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.track_all([
            resource_with_refs(1, vec![WorkspaceResourceRef::RunningNode(1)]),
            resource_with_refs(2, vec![WorkspaceResourceRef::RunningNode(2), WorkspaceResourceRef::DebugRetain]),
        ]);
        reg.release_all_refs();
        assert!(reg.resource(1).unwrap().refs.is_empty());
        assert!(reg.resource(2).unwrap().refs.is_empty());
    }

    #[test]
    fn releasable_ids_returns_empty_when_all_have_refs() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.track_all([resource_with_refs(1, vec![WorkspaceResourceRef::RunningNode(1)])]);
        assert!(reg.releasable_ids().is_empty());
    }

    #[test]
    fn releasable_ids_returns_ids_with_no_refs_and_active() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.track_all([
            make_resource(1),
            resource_with_refs(2, vec![WorkspaceResourceRef::RunningNode(10)]),
            make_resource(3),
        ]);
        let mut ids = reg.releasable_ids();
        ids.sort();
        assert_eq!(ids, vec![1, 3]);
    }

    #[test]
    fn releasable_ids_excludes_released_and_failed_resources() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.track_all([make_resource(1), make_resource(2), make_resource(3)]);
        reg.mark_released(2);
        reg.mark_failed_cleanup(3);
        assert_eq!(reg.releasable_ids(), vec![1]);
    }

    #[test]
    fn mark_released_changes_state() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.track_all([make_resource(1)]);
        reg.mark_released(1);
        assert_eq!(
            reg.resource(1).unwrap().state,
            WorkspaceResourceState::Released
        );
    }

    #[test]
    fn mark_released_unknown_id_is_noop() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.mark_released(99);
        // no panic
    }

    #[test]
    fn mark_failed_cleanup_changes_state() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.track_all([make_resource(1)]);
        reg.mark_failed_cleanup(1);
        assert_eq!(
            reg.resource(1).unwrap().state,
            WorkspaceResourceState::FailedCleanup
        );
    }

    #[test]
    fn mark_failed_cleanup_unknown_id_is_noop() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.mark_failed_cleanup(99);
        // no panic
    }

    #[test]
    fn resource_returns_none_for_absent_id() {
        let reg = WorkspaceResourceRegistry::default();
        assert!(reg.resource(1).is_none());
    }

    #[test]
    fn drain_all_removes_all_resources() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.track_all([make_resource(1), make_resource(2)]);
        let drained = reg.drain_all();
        assert_eq!(drained.len(), 2);
        assert!(reg.resource(1).is_none());
        assert!(reg.resource(2).is_none());
    }

    #[test]
    fn drain_all_on_empty_registry() {
        let mut reg = WorkspaceResourceRegistry::default();
        let drained = reg.drain_all();
        assert!(drained.is_empty());
    }

    #[test]
    fn lifecycle_track_retain_release_mark_released() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.track_all([make_resource(1)]);
        let rf = WorkspaceResourceRef::RunningNode(7);
        reg.retain(1, rf.clone());
        assert!(reg.releasable_ids().is_empty());
        reg.release(1, &rf);
        assert_eq!(reg.releasable_ids(), vec![1]);
        reg.mark_released(1);
        assert!(reg.releasable_ids().is_empty());
        assert_eq!(reg.resource(1).unwrap().state, WorkspaceResourceState::Released);
    }

    #[test]
    fn multiple_refs_tracked_independently() {
        let mut reg = WorkspaceResourceRegistry::default();
        reg.track_all([make_resource(1)]);
        let rf_a = WorkspaceResourceRef::RunningNode(10);
        let rf_b = WorkspaceResourceRef::CandidateArtifact(42_u64);
        let rf_c = WorkspaceResourceRef::DebugRetain;
        reg.retain(1, rf_a.clone());
        reg.retain(1, rf_b.clone());
        reg.retain(1, rf_c.clone());
        assert_eq!(reg.resource(1).unwrap().refs.len(), 3);
        reg.release(1, &rf_b);
        assert_eq!(reg.resource(1).unwrap().refs.len(), 2);
        reg.release(1, &rf_a);
        reg.release(1, &rf_c);
        assert!(reg.resource(1).unwrap().refs.is_empty());
    }
}
