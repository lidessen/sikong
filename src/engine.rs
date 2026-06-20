use std::collections::HashMap;

use async_recursion::async_recursion;

use crate::CancellationToken;
use crate::agent_run::AgentRunScheduler;
use crate::engine_resources::WorkspaceResourceRegistry;
use crate::node::{Artifact, ArtifactContentKind, NodePlan, NodeTemplate, ProblemNode};
use crate::task_run::{
    AgentOperationContext, AgentRunResult, NodeOperationOutput, OperationHarness,
};
use crate::types::{
    AgentRunRecord, ArtifactId, AttemptRecord, EngineError, EngineReport, FailureClass, NodeId,
    NodeOperation, NodeStatus, OperationEvent, ProblemKey, VerificationVerdict,
};
use crate::workspace::{Workspace, WorkspaceChange, WorkspaceResourceRef, WorkspaceSurface};

pub struct Engine<W: Workspace, A: AgentRunScheduler> {
    workspace: W,
    agent: A,
    next_node_id: NodeId,
    next_artifact_id: ArtifactId,
    nodes: HashMap<NodeId, ProblemNode>,
    artifacts: HashMap<ArtifactId, Artifact>,
    memo_table: HashMap<ProblemKey, ArtifactId>,
    attempts: HashMap<ProblemKey, Vec<AttemptRecord>>,
    events: Vec<OperationEvent>,
    agent_runs: Vec<AgentRunRecord>,
    workspace_resources: WorkspaceResourceRegistry,
}

impl<W, A> Engine<W, A>
where
    W: Workspace + Send,
    A: AgentRunScheduler + Send,
{
    pub fn new(workspace: W, agent: A) -> Self {
        Self {
            workspace,
            agent,
            next_node_id: 0,
            next_artifact_id: 0,
            nodes: HashMap::new(),
            artifacts: HashMap::new(),
            memo_table: HashMap::new(),
            attempts: HashMap::new(),
            events: Vec::new(),
            agent_runs: Vec::new(),
            workspace_resources: WorkspaceResourceRegistry::default(),
        }
    }

    pub fn insert_root(&mut self, template: NodeTemplate) -> NodeId {
        self.insert_node(None, template)
    }

    pub async fn run(&mut self, root: NodeId) -> Result<EngineReport, EngineError> {
        self.run_with_cancel(root, CancellationToken::new()).await
    }

    pub async fn run_with_cancel(
        &mut self,
        root: NodeId,
        cancellation: CancellationToken,
    ) -> Result<EngineReport, EngineError> {
        let result = self.resolve(root, &cancellation).await;
        self.workspace_resources.release_all_refs();
        let cleanup_result = self.cleanup_releasable_resources();
        let artifact = result?;
        cleanup_result?;
        let status = self.node(root)?.status;
        Ok(EngineReport {
            root,
            status,
            artifact,
            events: self.events.clone(),
            agent_runs: self.agent_runs.clone(),
        })
    }

    pub fn node(&self, id: NodeId) -> Result<&ProblemNode, EngineError> {
        self.nodes.get(&id).ok_or(EngineError::MissingNode(id))
    }

    pub fn artifact(&self, id: ArtifactId) -> Result<&Artifact, EngineError> {
        self.artifacts
            .get(&id)
            .ok_or(EngineError::MissingArtifact(id))
    }

    pub fn events(&self) -> &[OperationEvent] {
        &self.events
    }

    pub fn agent_runs(&self) -> &[AgentRunRecord] {
        &self.agent_runs
    }

    pub fn attempts_for(&self, key: &ProblemKey) -> &[AttemptRecord] {
        self.attempts
            .get(key)
            .map_or(&[] as &[AttemptRecord], Vec::as_slice)
    }

    pub fn memo_len(&self) -> usize {
        self.memo_table.len()
    }

    #[async_recursion]
    async fn resolve(
        &mut self,
        node_id: NodeId,
        cancellation: &CancellationToken,
    ) -> Result<Option<ArtifactId>, EngineError> {
        check_cancelled(cancellation)?;
        let key = self.node(node_id)?.key.clone();
        if let Some(artifact_id) = self.memo_table.get(&key).copied() {
            self.run_agent(node_id, NodeOperation::Commit, cancellation)
                .await?;
            self.node_mut(node_id)?.status = NodeStatus::Committed;
            self.node_mut(node_id)?.accepted_artifact = Some(artifact_id);
            return Ok(Some(artifact_id));
        }

        self.specify(node_id, cancellation).await?;

        if self.acquire_if_needed(node_id, cancellation).await? {
            return self.resolve(node_id, cancellation).await;
        }

        if self.should_plan(node_id)? {
            self.plan_group(node_id, cancellation).await?;
            let child_ids = self.node(node_id)?.children.clone();
            for child_id in child_ids {
                self.resolve(child_id, cancellation).await?;
            }
            self.combine(node_id, cancellation).await?;
        } else if self.node(node_id)?.candidate.is_none() {
            self.execute(node_id, cancellation).await?;
        }

        self.verify_and_maybe_commit(node_id, cancellation).await
    }

    async fn specify(
        &mut self,
        node_id: NodeId,
        cancellation: &CancellationToken,
    ) -> Result<(), EngineError> {
        if self.node(node_id)?.status == NodeStatus::New {
            self.run_agent(node_id, NodeOperation::Specify, cancellation)
                .await?;
            self.node_mut(node_id)?.status = NodeStatus::Specified;
        }
        Ok(())
    }

    async fn acquire_if_needed(
        &mut self,
        node_id: NodeId,
        cancellation: &CancellationToken,
    ) -> Result<bool, EngineError> {
        if !matches!(self.node(node_id)?.plan, NodePlan::NeedsInfo { .. }) {
            return Ok(false);
        }

        let result = self
            .run_agent(node_id, NodeOperation::Acquire, cancellation)
            .await?;
        if let NodeOperationOutput::Acquired {
            need,
            evidence,
            next_plan,
        } = result.output
        {
            let artifact_id = self.push_artifact(
                node_id,
                ArtifactContentKind::Text,
                evidence,
                None,
                Vec::new(),
            );
            self.node_mut(node_id)?
                .acquired
                .push(format!("{need}={artifact_id}"));
            self.node_mut(node_id)?.plan = next_plan;
            self.node_mut(node_id)?.status = NodeStatus::Specified;
            return Ok(true);
        }

        Ok(false)
    }

    fn should_plan(&self, node_id: NodeId) -> Result<bool, EngineError> {
        Ok(matches!(self.node(node_id)?.plan, NodePlan::Group(_))
            && self.node(node_id)?.children.is_empty())
    }

    async fn plan_group(
        &mut self,
        node_id: NodeId,
        cancellation: &CancellationToken,
    ) -> Result<(), EngineError> {
        let result = self
            .run_agent(node_id, NodeOperation::Plan, cancellation)
            .await?;
        let NodeOperationOutput::Planned { group } = result.output else {
            return Ok(());
        };
        let child_ids: Vec<_> = group
            .items
            .into_iter()
            .map(|template| self.insert_node(Some(node_id), template))
            .collect();
        self.node_mut(node_id)?.children = child_ids;
        self.node_mut(node_id)?.status = NodeStatus::Planned;
        Ok(())
    }

    async fn execute(
        &mut self,
        node_id: NodeId,
        cancellation: &CancellationToken,
    ) -> Result<(), EngineError> {
        let workspace = self.node(node_id)?.workspace.clone();
        let snapshot = self.workspace.snapshot(&workspace)?;
        let surface = self
            .workspace
            .open_surface(&snapshot, vec![WorkspaceResourceRef::RunningNode(node_id)])?;
        self.workspace_resources
            .track_all(surface.resources.clone());

        let result = self
            .run_agent_with_surface(
                node_id,
                NodeOperation::Execute,
                surface.clone(),
                cancellation,
            )
            .await?;
        let NodeOperationOutput::Executed { output } = result.output else {
            return Ok(());
        };

        let change = self.workspace.capture_changes(&surface, Vec::new())?;
        self.workspace_resources.track_all(change.resources.clone());

        let artifact_id = self.push_artifact(
            node_id,
            ArtifactContentKind::Text,
            output,
            Some(change.clone()),
            Vec::new(),
        );
        self.retain_change_resources(
            &change,
            WorkspaceResourceRef::CandidateArtifact(artifact_id),
        );
        self.release_surface_resources(&surface, WorkspaceResourceRef::RunningNode(node_id));
        self.cleanup_releasable_resources()?;
        let node = self.node_mut(node_id)?;
        node.execution_attempts += 1;
        node.candidate = Some(artifact_id);
        node.status = NodeStatus::Verifying;
        Ok(())
    }

    async fn combine(
        &mut self,
        node_id: NodeId,
        cancellation: &CancellationToken,
    ) -> Result<(), EngineError> {
        let child_ids = self.node(node_id)?.children.clone();

        let mut child_artifacts = Vec::new();
        let mut child_changes = Vec::new();
        for child_id in child_ids {
            if let Some(artifact_id) = self.node(child_id)?.accepted_artifact {
                child_artifacts.push(artifact_id);
                if let Some(change) = self.artifact(artifact_id)?.workspace_change.clone() {
                    child_changes.push(change);
                }
            }
        }

        let child_ref = WorkspaceResourceRef::ChildInputForCombine(node_id);
        for change in &child_changes {
            self.retain_change_resources(change, child_ref.clone());
        }
        let merge_ref = WorkspaceResourceRef::MergeSurface(node_id);
        let merge_surface = self
            .workspace
            .merge_changes(&child_changes, vec![merge_ref.clone()])?;
        self.workspace_resources
            .track_all(merge_surface.resources.clone());
        let result = self
            .run_agent_with_surface(
                node_id,
                NodeOperation::Combine,
                merge_surface.clone(),
                cancellation,
            )
            .await?;
        let NodeOperationOutput::Combined { output } = result.output else {
            return Ok(());
        };

        let change = self.workspace.capture_changes(&merge_surface, Vec::new())?;
        self.workspace_resources.track_all(change.resources.clone());
        let artifact_id = self.push_artifact(
            node_id,
            ArtifactContentKind::Text,
            output,
            Some(change.clone()),
            child_artifacts,
        );
        self.retain_change_resources(
            &change,
            WorkspaceResourceRef::CandidateArtifact(artifact_id),
        );
        self.release_surface_resources(&merge_surface, merge_ref);
        for child_change in &child_changes {
            self.release_change_resources(child_change, &child_ref);
        }
        self.cleanup_releasable_resources()?;
        self.node_mut(node_id)?.candidate = Some(artifact_id);
        self.node_mut(node_id)?.status = NodeStatus::Verifying;
        Ok(())
    }

    #[async_recursion]
    async fn verify_and_maybe_commit(
        &mut self,
        node_id: NodeId,
        cancellation: &CancellationToken,
    ) -> Result<Option<ArtifactId>, EngineError> {
        let artifact_id = self
            .node(node_id)?
            .candidate
            .ok_or(EngineError::NoCandidate(node_id))?;
        let verdict = self.verify(node_id, artifact_id, cancellation).await?;
        self.record_attempt(node_id, NodeOperation::Verify, Some(verdict.clone()))?;

        match verdict {
            VerificationVerdict::Accept => {
                self.commit(node_id, artifact_id, cancellation).await?;
                Ok(Some(artifact_id))
            }
            VerificationVerdict::Uncertain { missing_info, .. } => {
                self.run_agent(node_id, NodeOperation::Acquire, cancellation)
                    .await?;
                self.record(
                    node_id,
                    NodeOperation::Acquire,
                    format!("uncertain: {missing_info}"),
                );
                self.node_mut(node_id)?.status = NodeStatus::WaitingForInfo;
                Ok(None)
            }
            VerificationVerdict::Reject { failure_class, .. } => {
                self.handle_reject(node_id, failure_class, cancellation)
                    .await
            }
        }
    }

    async fn verify(
        &mut self,
        node_id: NodeId,
        artifact_id: ArtifactId,
        cancellation: &CancellationToken,
    ) -> Result<VerificationVerdict, EngineError> {
        let result = self
            .run_agent(node_id, NodeOperation::Verify, cancellation)
            .await?;
        let NodeOperationOutput::Verified {
            verdict: worker_verdict,
        } = result.output
        else {
            return Ok(VerificationVerdict::Accept);
        };

        if let Some(change) = &self.artifact(artifact_id)?.workspace_change {
            let node = self.node(node_id)?;
            if !node.capabilities.allow_write
                && (!change.changed_paths.is_empty() || !change.side_effects.is_empty())
            {
                return Ok(VerificationVerdict::Reject {
                    failure_class: FailureClass::UnsafeSideEffect,
                    reason: "read-only node produced workspace change".to_string(),
                });
            }

            if change
                .side_effects
                .iter()
                .any(|effect| effect.starts_with("conflict:"))
            {
                return Ok(VerificationVerdict::Reject {
                    failure_class: FailureClass::MergeConflict,
                    reason: "workspace merge surface conflict".to_string(),
                });
            }

            if node.capabilities.allow_write {
                let out_of_scope = change
                    .changed_paths
                    .iter()
                    .any(|path| !path_allowed(path, &node.workspace.write_scope));
                if out_of_scope {
                    return Ok(VerificationVerdict::Reject {
                        failure_class: FailureClass::UnsafeSideEffect,
                        reason: "changed path outside write scope".to_string(),
                    });
                }
            }
        }

        self.node_mut(node_id)?.verification_attempts += 1;
        Ok(worker_verdict)
    }

    #[async_recursion]
    async fn handle_reject(
        &mut self,
        node_id: NodeId,
        failure_class: FailureClass,
        cancellation: &CancellationToken,
    ) -> Result<Option<ArtifactId>, EngineError> {
        let attempts = self.node(node_id)?.execution_attempts;
        let max_attempts = self.node(node_id)?.budget.max_attempts;
        if failure_class == FailureClass::UnsafeSideEffect
            || failure_class == FailureClass::MergeConflict
            || attempts >= max_attempts
        {
            let status = if failure_class == FailureClass::BudgetExhausted {
                NodeStatus::Rejected
            } else {
                NodeStatus::Pruned
            };
            self.record(
                node_id,
                NodeOperation::Verify,
                format!("rejected terminally: {failure_class:?}"),
            );
            self.node_mut(node_id)?.status = status;
            return Ok(None);
        }

        self.run_agent(node_id, NodeOperation::Specify, cancellation)
            .await?;
        self.record(
            node_id,
            NodeOperation::Specify,
            format!("retry after {failure_class:?}"),
        );
        self.node_mut(node_id)?.candidate = None;
        self.execute(node_id, cancellation).await?;
        self.verify_and_maybe_commit(node_id, cancellation).await
    }

    async fn commit(
        &mut self,
        node_id: NodeId,
        artifact_id: ArtifactId,
        cancellation: &CancellationToken,
    ) -> Result<(), EngineError> {
        self.run_agent(node_id, NodeOperation::Commit, cancellation)
            .await?;
        let key = self.node(node_id)?.key.clone();
        self.memo_table.insert(key, artifact_id);
        let node = self.node_mut(node_id)?;
        node.status = NodeStatus::Committed;
        node.accepted_artifact = Some(artifact_id);
        Ok(())
    }

    fn insert_node(&mut self, parent: Option<NodeId>, template: NodeTemplate) -> NodeId {
        self.next_node_id += 1;
        let id = self.next_node_id;
        self.nodes.insert(
            id,
            ProblemNode {
                id,
                key: template.key,
                parent,
                intent: template.intent,
                workspace: template.workspace,
                capabilities: template.capabilities,
                budget: template.budget,
                children: Vec::new(),
                status: NodeStatus::New,
                plan: template.plan,
                acquired: Vec::new(),
                candidate: None,
                accepted_artifact: None,
                execution_attempts: 0,
                verification_attempts: 0,
            },
        );
        id
    }

    fn push_artifact(
        &mut self,
        node_id: NodeId,
        content_kind: ArtifactContentKind,
        text: String,
        workspace_change: Option<WorkspaceChange>,
        children: Vec<ArtifactId>,
    ) -> ArtifactId {
        self.next_artifact_id += 1;
        let id = self.next_artifact_id;
        self.artifacts.insert(
            id,
            Artifact {
                id,
                node_id,
                content_kind,
                text,
                workspace_change,
                children,
            },
        );
        id
    }

    fn record(&mut self, node_id: NodeId, operation: NodeOperation, note: impl Into<String>) {
        self.events.push(OperationEvent {
            node_id,
            operation,
            note: note.into(),
        });
    }

    async fn run_agent(
        &mut self,
        node_id: NodeId,
        operation: NodeOperation,
        cancellation: &CancellationToken,
    ) -> Result<AgentRunResult, EngineError> {
        let context = self.agent_context(node_id, operation, None)?;
        self.run_agent_with_context(context, cancellation).await
    }

    async fn run_agent_with_surface(
        &mut self,
        node_id: NodeId,
        operation: NodeOperation,
        workspace_surface: WorkspaceSurface,
        cancellation: &CancellationToken,
    ) -> Result<AgentRunResult, EngineError> {
        let context = self.agent_context(node_id, operation, Some(workspace_surface))?;
        self.run_agent_with_context(context, cancellation).await
    }

    async fn run_agent_with_context(
        &mut self,
        context: AgentOperationContext,
        cancellation: &CancellationToken,
    ) -> Result<AgentRunResult, EngineError> {
        check_cancelled(cancellation)?;
        let node_id = context.node.id;
        let operation = context.operation;
        let harness = OperationHarness::new(context.clone());
        let input = harness.build_agent_run();
        let worker_result = self.agent.run(input, cancellation.clone()).await;
        check_cancelled(cancellation)?;
        let result = match harness.decode_result(worker_result) {
            Ok(result) => result,
            Err(error) => {
                self.agent_runs.push(AgentRunRecord {
                    node_id,
                    operation,
                    report: error.message.clone(),
                    terminal_tool: error.terminal_tool.clone(),
                });
                self.record(node_id, operation, error.message.clone());
                return Err(EngineError::AgentProtocol(error.message));
            }
        };
        self.agent_runs.push(AgentRunRecord {
            node_id,
            operation,
            report: result.report.clone(),
            terminal_tool: result.terminal_tool.clone(),
        });
        self.record(node_id, operation, result.report.clone());
        Ok(result)
    }

    fn agent_context(
        &self,
        node_id: NodeId,
        operation: NodeOperation,
        workspace_surface: Option<WorkspaceSurface>,
    ) -> Result<AgentOperationContext, EngineError> {
        let node = self.node(node_id)?.clone();
        let candidate = node
            .candidate
            .map(|artifact_id| self.artifact(artifact_id).cloned())
            .transpose()?;
        let child_artifacts = node
            .children
            .iter()
            .filter_map(|child_id| self.nodes.get(child_id))
            .filter_map(|child| child.accepted_artifact)
            .map(|artifact_id| self.artifact(artifact_id).cloned())
            .collect::<Result<Vec<_>, _>>()?;

        Ok(AgentOperationContext {
            node,
            operation,
            candidate,
            child_artifacts,
            workspace_surface,
        })
    }

    fn record_attempt(
        &mut self,
        node_id: NodeId,
        operation: NodeOperation,
        verdict: Option<VerificationVerdict>,
    ) -> Result<(), EngineError> {
        let key = self.node(node_id)?.key.clone();
        self.attempts.entry(key).or_default().push(AttemptRecord {
            node_id,
            operation,
            verdict,
        });
        Ok(())
    }

    fn retain_change_resources(
        &mut self,
        change: &WorkspaceChange,
        resource_ref: WorkspaceResourceRef,
    ) {
        for id in &change.resource_ids {
            self.workspace_resources.retain(*id, resource_ref.clone());
        }
    }

    fn release_change_resources(
        &mut self,
        change: &WorkspaceChange,
        resource_ref: &WorkspaceResourceRef,
    ) {
        for id in &change.resource_ids {
            self.workspace_resources.release(*id, resource_ref);
        }
    }

    fn release_surface_resources(
        &mut self,
        surface: &WorkspaceSurface,
        resource_ref: WorkspaceResourceRef,
    ) {
        for resource in &surface.resources {
            self.workspace_resources.release(resource.id, &resource_ref);
        }
    }

    fn cleanup_releasable_resources(&mut self) -> Result<(), EngineError> {
        let ids = self.workspace_resources.releasable_ids();
        for id in ids {
            let Some(resource) = self.workspace_resources.resource(id).cloned() else {
                continue;
            };
            match self.workspace.cleanup(&resource) {
                Ok(()) => self.workspace_resources.mark_released(id),
                Err(error) => {
                    self.workspace_resources.mark_failed_cleanup(id);
                    return Err(EngineError::Workspace(error));
                }
            }
        }
        Ok(())
    }

    fn node_mut(&mut self, id: NodeId) -> Result<&mut ProblemNode, EngineError> {
        self.nodes.get_mut(&id).ok_or(EngineError::MissingNode(id))
    }
}

fn path_allowed(path: &str, scopes: &[String]) -> bool {
    scopes.iter().any(|scope| {
        scope == "**/*"
            || scope == path
            || (scope.ends_with('*') && path.starts_with(scope.trim_end_matches('*')))
    })
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), EngineError> {
    if cancellation.is_cancelled() {
        Err(EngineError::Cancelled)
    } else {
        Ok(())
    }
}
