use std::{collections::HashMap, time::Instant};

use async_recursion::async_recursion;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::common::workspace::{
    GitWorkspaceSurface, Workspace, WorkspaceChange, WorkspaceProvider, WorkspaceResource,
    WorkspaceResourceMetadata, WorkspaceResourceRef, WorkspaceResourceState, WorkspaceSurface,
};
use crate::core::agent_run::{AgentRunScheduler, CancellationToken};

use super::node::{
    Artifact, ArtifactContentKind, NodePlan, NodePolicy, NodeTemplate, PlanGroupMode, ProblemNode,
    ScopeAssessment, WorkSize,
};
use super::resources::WorkspaceResourceRegistry;
use super::{
    AgentOperationContext, AgentRunRecord, AgentRunResult, ArtifactId, AttemptRecord, EngineError,
    EngineReport, FailureClass, NodeId, NodeOperation, NodeOperationOutput, NodeStatus,
    OperationEvent, OperationHarness, ProblemKey, VerificationVerdict,
};

fn plan_from_scope_assessment(assessment: &ScopeAssessment, current_plan: &NodePlan) -> NodePlan {
    match assessment.size {
        WorkSize::Tiny => NodePlan::FastExecute,
        WorkSize::Small | WorkSize::Medium => NodePlan::Execute,
        WorkSize::Large | WorkSize::XLarge => match current_plan {
            NodePlan::Group(_) => current_plan.clone(),
            _ => NodePlan::NeedsPlanning,
        },
    }
}

pub struct Engine<W: Workspace, A: AgentRunScheduler> {
    workspace: W,
    agent: A,
    stop_after_route_depth: Option<usize>,
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
    W: Workspace + Clone + Send + 'static,
    A: AgentRunScheduler + Clone + Send + 'static,
{
    pub fn new(workspace: W, agent: A) -> Self {
        Self {
            workspace,
            agent,
            stop_after_route_depth: None,
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

    pub fn with_stop_after_route_depth(mut self, depth: usize) -> Self {
        self.stop_after_route_depth = Some(depth);
        self
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
        let result = self.resolve(root, 0, &cancellation).await;
        self.workspace_resources.release_all_refs();
        let cleanup_result = self.cleanup_releasable_resources();
        let artifact = result?;
        cleanup_result?;
        let status = self.node(root)?.status;
        let artifact_text = artifact.and_then(|artifact_id| {
            self.artifacts
                .get(&artifact_id)
                .map(|artifact| artifact.text.clone())
        });
        Ok(EngineReport {
            root,
            status,
            artifact,
            artifact_text,
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
        depth: usize,
        cancellation: &CancellationToken,
    ) -> Result<Option<ArtifactId>, EngineError> {
        check_cancelled(cancellation)?;
        let key = self.node(node_id)?.key.clone();
        if let Some(artifact_id) = self.memo_table.get(&key).copied() {
            self.commit(node_id, artifact_id)?;
            return Ok(Some(artifact_id));
        }

        self.specify(node_id, cancellation).await?;

        let should_plan = self.should_plan(node_id)?;
        if self.stop_after_route_depth == Some(depth) && !should_plan {
            self.record(
                node_id,
                NodeOperation::Specify,
                format!("stopped after specify at depth {depth}"),
            );
            return Ok(None);
        }

        if should_plan {
            self.plan_group(node_id, cancellation).await?;
            if self.stop_after_route_depth == Some(depth) {
                self.record(
                    node_id,
                    NodeOperation::Plan,
                    format!("stopped after plan at depth {depth}"),
                );
                return Ok(None);
            }
            let child_ids = self.node(node_id)?.children.clone();
            match self.group_mode(node_id)? {
                Some(PlanGroupMode::Parallel) => {
                    self.resolve_parallel_children(child_ids, depth + 1, cancellation)
                        .await?;
                }
                Some(PlanGroupMode::Stage) | None => {
                    for child_id in child_ids {
                        if self
                            .resolve(child_id, depth + 1, cancellation)
                            .await?
                            .is_none()
                        {
                            self.mark_parent_blocked_by_children(node_id)?;
                            return Ok(None);
                        }
                    }
                }
            }
            if !self.all_children_accepted(node_id)? {
                self.mark_parent_blocked_by_children(node_id)?;
                return Ok(None);
            }
            self.combine(node_id, cancellation).await?;
        } else if self.node(node_id)?.candidate.is_none() {
            match self.node(node_id)?.plan {
                NodePlan::FastExecute => {
                    self.fast_execute(node_id, cancellation).await?;
                    // If fast_execute self-verified and already committed,
                    // return the accepted artifact and skip verify.
                    if self.node(node_id)?.status == NodeStatus::Committed {
                        return Ok(self.node(node_id)?.accepted_artifact);
                    }
                }
                _ => {
                    self.execute(node_id, cancellation).await?;
                }
            }
        }

        self.verify_and_maybe_commit(node_id, cancellation).await
    }

    async fn specify(
        &mut self,
        node_id: NodeId,
        cancellation: &CancellationToken,
    ) -> Result<(), EngineError> {
        if self.node(node_id)?.status == NodeStatus::New {
            let result = self
                .run_agent(node_id, NodeOperation::Specify, cancellation)
                .await?;
            if let NodeOperationOutput::Specified { scope_assessment } = result.output {
                let current_plan = self.node(node_id)?.plan.clone();
                let plan = plan_from_scope_assessment(&scope_assessment, &current_plan);
                let node = self.node_mut(node_id)?;
                node.size = scope_assessment.size;
                node.intent = scope_assessment.next.clone();
                node.scope_assessment = Some(scope_assessment);
                node.plan = plan;
            }
            self.node_mut(node_id)?.status = NodeStatus::Specified;
        }
        Ok(())
    }

    fn should_plan(&self, node_id: NodeId) -> Result<bool, EngineError> {
        Ok(matches!(
            self.node(node_id)?.plan,
            NodePlan::NeedsPlanning | NodePlan::Group(_)
        ) && self.node(node_id)?.children.is_empty())
    }

    fn group_mode(&self, node_id: NodeId) -> Result<Option<PlanGroupMode>, EngineError> {
        Ok(match &self.node(node_id)?.plan {
            NodePlan::Group(group) => Some(group.mode),
            _ => None,
        })
    }

    fn all_children_accepted(&self, node_id: NodeId) -> Result<bool, EngineError> {
        self.node(node_id)?
            .children
            .iter()
            .try_fold(true, |accepted, child_id| {
                Ok(accepted && self.node(*child_id)?.accepted_artifact.is_some())
            })
    }

    fn mark_parent_blocked_by_children(&mut self, node_id: NodeId) -> Result<(), EngineError> {
        let child_ids = self.node(node_id)?.children.clone();
        let child_statuses = child_ids
            .iter()
            .map(|child_id| self.node(*child_id).map(|child| (*child_id, child.status)))
            .collect::<Result<Vec<_>, _>>()?;

        let waiting_children = child_statuses
            .iter()
            .filter_map(|(child_id, status)| {
                (*status == NodeStatus::WaitingForInfo).then_some(child_id.to_string())
            })
            .collect::<Vec<_>>();

        if !waiting_children.is_empty() {
            self.record(
                node_id,
                NodeOperation::Combine,
                format!(
                    "waiting for child information before combine: {}",
                    waiting_children.join(", ")
                ),
            );
            self.node_mut(node_id)?.status = NodeStatus::WaitingForInfo;
            return Ok(());
        }

        let unresolved_children = child_statuses
            .iter()
            .filter_map(|(child_id, status)| {
                (!matches!(status, NodeStatus::Committed)).then_some(child_id.to_string())
            })
            .collect::<Vec<_>>();
        self.record(
            node_id,
            NodeOperation::Combine,
            format!(
                "blocked by unresolved children before combine: {}",
                unresolved_children.join(", ")
            ),
        );
        self.node_mut(node_id)?.status = NodeStatus::Pruned;
        Ok(())
    }

    async fn plan_group(
        &mut self,
        node_id: NodeId,
        cancellation: &CancellationToken,
    ) -> Result<(), EngineError> {
        let result = self
            .run_agent(node_id, NodeOperation::Plan, cancellation)
            .await?;
        let group = match result.output {
            NodeOperationOutput::Planned { group } => group,
            NodeOperationOutput::InvalidPlan { gate, reason } => {
                self.record(
                    node_id,
                    NodeOperation::Plan,
                    match gate {
                        Some(gate) => format!("invalid plan {}: {reason}", gate.id()),
                        None => format!("invalid plan: {reason}"),
                    },
                );
                return Err(EngineError::AgentProtocol(format!(
                    "invalid plan for node {node_id}: {}{reason}",
                    gate.map(|gate| format!("{}: ", gate.id()))
                        .unwrap_or_default()
                )));
            }
            _ => return Ok(()),
        };
        self.node_mut(node_id)?.plan = NodePlan::Group(group.clone());
        let parent = self.node(node_id)?.clone();
        let child_ids: Vec<_> = group
            .items
            .into_iter()
            .map(|template| {
                let template = inherit_child_defaults(&parent, template)?;
                Ok(self.insert_node(Some(node_id), template))
            })
            .collect::<Result<Vec<_>, EngineError>>()?;
        self.node_mut(node_id)?.children = child_ids;
        self.node_mut(node_id)?.status = NodeStatus::Planned;
        Ok(())
    }

    /// Resolve child nodes in parallel. Each branch runs in a separate tokio task
    /// with its own Engine clone. A [`BranchWorkspaceGuard`] wraps each branch Engine
    /// inside the spawned task so that workspace resources are deterministically
    /// cleaned up even if the branch panics or errors.
    async fn resolve_parallel_children(
        &mut self,
        child_ids: Vec<NodeId>,
        depth: usize,
        cancellation: &CancellationToken,
    ) -> Result<(), EngineError> {
        let mut branches = JoinSet::new();
        let stop_after_route_depth = self.stop_after_route_depth;
        for child_id in child_ids {
            check_cancelled(cancellation)?;
            let child = self.node(child_id)?.clone();
            let workspace = self.workspace.clone();
            let agent = self.agent.clone();
            let cancellation = cancellation.clone();
            branches.spawn(async move {
                // Build the branch engine inside a RAII guard so that if
                // resolve panics or errors, the guard's Drop cleans up any
                // workspace resources the branch created.
                let mut branch = Engine::new(workspace.clone(), agent);
                branch.stop_after_route_depth = stop_after_route_depth;
                branch.next_node_id = child.id;
                branch.nodes.insert(child.id, child);

                // Wrap the Engine in the guard. The guard will clean up
                // workspace resources on drop unless consumed by into_engine().
                let mut guard = BranchEngineGuard::new(branch, workspace);

                // Resolve the child node inside the guard scope.
                // On success, consume the guard and return the engine.
                // On error/panic, the guard's Drop cleans up resources.
                guard.resolve(child_id, depth, &cancellation).await?;

                let engine = guard.into_engine();
                Ok::<_, EngineError>((child_id, engine))
            });
        }

        while let Some(branch) = branches.join_next().await {
            let (child_id, branch) =
                branch.map_err(|error| EngineError::AgentProtocol(error.to_string()))??;
            self.merge_parallel_branch(child_id, branch)?;
            self.cleanup_releasable_resources()?;
        }
        self.cleanup_releasable_resources()?;

        Ok(())
    }

    fn merge_parallel_branch(
        &mut self,
        child_id: NodeId,
        mut branch: Engine<W, A>,
    ) -> Result<(), EngineError> {
        let mut node_ids = branch.nodes.keys().copied().collect::<Vec<_>>();
        node_ids.sort_unstable();
        let mut node_map = HashMap::new();
        node_map.insert(child_id, child_id);
        for id in node_ids.iter().copied().filter(|id| *id != child_id) {
            self.next_node_id += 1;
            node_map.insert(id, self.next_node_id);
        }

        let mut artifact_ids = branch.artifacts.keys().copied().collect::<Vec<_>>();
        artifact_ids.sort_unstable();
        let mut artifact_map = HashMap::new();
        for id in artifact_ids {
            self.next_artifact_id += 1;
            artifact_map.insert(id, self.next_artifact_id);
        }

        let resources = branch
            .workspace_resources
            .drain_all()
            .into_iter()
            .map(|resource| remap_workspace_resource(resource, &node_map, &artifact_map));
        self.workspace_resources.track_all(resources);

        for (_, artifact) in branch.artifacts {
            let artifact = remap_artifact(artifact, &node_map, &artifact_map)?;
            self.artifacts.insert(artifact.id, artifact);
        }

        for (_, node) in branch.nodes {
            let node = remap_node(node, &node_map, &artifact_map)?;
            self.nodes.insert(node.id, node);
        }

        for event in branch.events {
            self.events.push(OperationEvent {
                node_id: remap_node_id(event.node_id, &node_map)?,
                operation: event.operation,
                note: event.note,
            });
        }

        for run in branch.agent_runs {
            self.agent_runs.push(AgentRunRecord {
                node_id: remap_node_id(run.node_id, &node_map)?,
                operation: run.operation,
                report: run.report,
                terminal_tool: run.terminal_tool,
                terminal_payload: run.terminal_payload,
                duration_ms: run.duration_ms,
                usage: run.usage,
                events: run.events,
            });
        }

        for (key, attempts) in branch.attempts {
            let remapped = attempts
                .into_iter()
                .map(|attempt| {
                    Ok(AttemptRecord {
                        node_id: remap_node_id(attempt.node_id, &node_map)?,
                        operation: attempt.operation,
                        verdict: attempt.verdict,
                    })
                })
                .collect::<Result<Vec<_>, EngineError>>()?;
            self.attempts.entry(key).or_default().extend(remapped);
        }

        for (key, artifact_id) in branch.memo_table {
            self.memo_table
                .insert(key, remap_artifact_id(artifact_id, &artifact_map)?);
        }

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
        // Post-completion lifecycle hook: commit write_scope paths
        self.post_completion_write_scope_commit(node_id, &surface)?;
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

    /// Lightweight fast path for tiny tasks.
    ///
    /// Runs the agent directly (no workspace surface), and on success
    /// self-verifies by committing the output immediately. On failure
    /// (e.g., agent returns unexpected output), falls back to the
    /// standard verify-then-reject path by creating a candidate artifact.
    async fn fast_execute(
        &mut self,
        node_id: NodeId,
        cancellation: &CancellationToken,
    ) -> Result<(), EngineError> {
        self.record(
            node_id,
            NodeOperation::Execute,
            "fast execute path",
        );

        let result = self
            .run_agent(node_id, NodeOperation::Execute, cancellation)
            .await?;

        let NodeOperationOutput::Executed { output } = result.output else {
            // Fast path failed — agent did not produce Executed output.
            // Fall back: create an empty candidate so verify handles it.
            self.node_mut(node_id)?.execution_attempts += 1;
            self.record(
                node_id,
                NodeOperation::Execute,
                "fast execute did not produce Executed output, falling back to verify",
            );
            return Ok(());
        };

        // Success path: self-verify by committing directly.
        let artifact_id = self.push_artifact(
            node_id,
            ArtifactContentKind::Text,
            output,
            None,
            Vec::new(),
        );

        self.node_mut(node_id)?.execution_attempts += 1;
        self.commit(node_id, artifact_id)?;
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
        // Post-completion lifecycle hook: commit write_scope paths
        self.post_completion_write_scope_commit(node_id, &merge_surface)?;
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
                self.commit(node_id, artifact_id)?;
                Ok(Some(artifact_id))
            }
            VerificationVerdict::Uncertain { missing_info, .. } => {
                self.record(
                    node_id,
                    NodeOperation::Verify,
                    format!("needs information: {missing_info}"),
                );
                self.node_mut(node_id)?.status = NodeStatus::WaitingForInfo;
                Ok(None)
            }
            VerificationVerdict::Reject { failure_class, .. } => {
                if matches!(
                    failure_class,
                    FailureClass::MissingInfo | FailureClass::SpecAmbiguity
                ) {
                    self.record(
                        node_id,
                        NodeOperation::Verify,
                        format!("needs information after reject: {failure_class:?}"),
                    );
                    self.node_mut(node_id)?.status = NodeStatus::WaitingForInfo;
                    return Ok(None);
                }
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
        if let Some(verdict) = self.deterministic_verification_verdict(node_id, artifact_id)? {
            return Ok(verdict);
        }

        let result = if let Some(surface) = self.verification_surface(artifact_id)? {
            self.run_agent_with_surface(node_id, NodeOperation::Verify, surface, cancellation)
                .await?
        } else {
            self.run_agent(node_id, NodeOperation::Verify, cancellation)
                .await?
        };
        let NodeOperationOutput::Verified {
            verdict: worker_verdict,
        } = result.output
        else {
            return Ok(VerificationVerdict::Accept);
        };

        self.node_mut(node_id)?.verification_attempts += 1;
        Ok(worker_verdict)
    }

    fn deterministic_verification_verdict(
        &self,
        node_id: NodeId,
        artifact_id: ArtifactId,
    ) -> Result<Option<VerificationVerdict>, EngineError> {
        let Some(change) = &self.artifact(artifact_id)?.workspace_change else {
            return Ok(None);
        };
        let node = self.node(node_id)?;
        if !node.capabilities.allow_write
            && (!change.changed_paths.is_empty() || !change.side_effects.is_empty())
        {
            return Ok(Some(VerificationVerdict::Reject {
                failure_class: FailureClass::UnsafeSideEffect,
                reason: "read-only node produced workspace change".to_string(),
            }));
        }

        if change
            .side_effects
            .iter()
            .any(|effect| effect.starts_with("conflict:"))
        {
            return Ok(Some(VerificationVerdict::Reject {
                failure_class: FailureClass::MergeConflict,
                reason: "workspace merge surface conflict".to_string(),
            }));
        }

        if node.capabilities.allow_write {
            let out_of_scope = change.changed_paths.iter().any(|path| {
                !crate::common::workspace::path_allowed(
                    &node.workspace.write_scope,
                    std::path::Path::new(path.as_str()),
                )
            });
            if out_of_scope {
                return Ok(Some(VerificationVerdict::Reject {
                    failure_class: FailureClass::UnsafeSideEffect,
                    reason: "changed path outside write scope".to_string(),
                }));
            }
        }

        Ok(None)
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
            let (status, recorded_class) = if attempts >= max_attempts {
                (NodeStatus::Rejected, FailureClass::BudgetExhausted)
            } else {
                (NodeStatus::Pruned, failure_class)
            };
            self.record(
                node_id,
                NodeOperation::Verify,
                format!("rejected terminally: {recorded_class:?}"),
            );
            self.node_mut(node_id)?.status = status;
            return Ok(None);
        }

        // execution-quality failure: skip Specify, route directly back to Execute
        self.record(
            node_id,
            NodeOperation::Execute,
            format!("retrying execute after {failure_class:?}"),
        );
        self.node_mut(node_id)?.candidate = None;
        self.execute(node_id, cancellation).await?;
        self.verify_and_maybe_commit(node_id, cancellation).await
    }

    fn commit(&mut self, node_id: NodeId, artifact_id: ArtifactId) -> Result<(), EngineError> {
        let key = self.node(node_id)?.key.clone();
        self.memo_table.insert(key, artifact_id);
        let node = self.node_mut(node_id)?;
        node.status = NodeStatus::Committed;
        node.accepted_artifact = Some(artifact_id);
        self.record(node_id, NodeOperation::Commit, "committed");
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
                size: template.size,
                scope_assessment: template.scope_assessment,
                workspace: template.workspace,
                capabilities: template.capabilities,
                budget: template.budget,
                policy: template.policy,
                children: Vec::new(),
                status: NodeStatus::New,
                plan: template.plan,
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
        info!(
            node_id,
            operation = ?operation,
            objective = %input.objective,
            terminal_tools = ?input.terminal_tool_set,
            "starting agent run"
        );
        let started_at = Instant::now();
        let worker_result = self.agent.run(input, cancellation.clone()).await;
        let duration_ms = started_at.elapsed().as_millis();
        check_cancelled(cancellation)?;
        let usage = worker_result.usage.clone();
        let events = worker_result.events.clone();
        let terminal_payload = worker_result
            .terminal_call
            .as_ref()
            .map(|call| call.arguments.clone());
        let result = match harness.decode_result(worker_result) {
            Ok(result) => result,
            Err(error) => {
                warn!(
                    node_id,
                    operation = ?operation,
                    duration_ms,
                    terminal_tool = ?error.terminal_tool,
                    error = %error.message,
                    "agent run failed"
                );
                self.agent_runs.push(AgentRunRecord {
                    node_id,
                    operation,
                    report: error.message.clone(),
                    terminal_tool: error.terminal_tool.clone(),
                    terminal_payload,
                    duration_ms,
                    usage,
                    events,
                });
                self.record(node_id, operation, error.message.clone());
                return Err(EngineError::AgentProtocol(error.message));
            }
        };
        info!(
            node_id,
            operation = ?operation,
            duration_ms,
            terminal_tool = ?result.terminal_tool,
            "agent run completed"
        );
        self.agent_runs.push(AgentRunRecord {
            node_id,
            operation,
            report: result.report.clone(),
            terminal_tool: result.terminal_tool.clone(),
            terminal_payload,
            duration_ms,
            usage,
            events,
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

    fn verification_surface(
        &self,
        artifact_id: ArtifactId,
    ) -> Result<Option<WorkspaceSurface>, EngineError> {
        let Some(change) = &self.artifact(artifact_id)?.workspace_change else {
            return Ok(None);
        };
        let resources = change
            .resource_ids
            .iter()
            .filter_map(|id| self.workspace_resources.resource(*id).cloned())
            .collect::<Vec<_>>();
        if resources.is_empty() && change.provider == WorkspaceProvider::Memory {
            return Ok(None);
        }

        let git_worktree = resources
            .iter()
            .find_map(|resource| match &resource.metadata {
                WorkspaceResourceMetadata::GitWorktree(worktree) => Some((resource.id, worktree)),
                _ => None,
            });
        let git_branch = resources
            .iter()
            .find_map(|resource| match &resource.metadata {
                WorkspaceResourceMetadata::GitBranch(branch) => Some((resource.id, branch)),
                _ => None,
            });
        let git = git_worktree.zip(git_branch).map(
            |((worktree_resource_id, worktree), (branch_resource_id, branch))| {
                GitWorkspaceSurface {
                    repo_root: worktree.repo_root.clone(),
                    worktree_root: branch.worktree_root.clone(),
                    base_sha: branch.base_sha.clone(),
                    worktree_path: worktree.worktree_path.clone(),
                    branch_name: worktree.branch_name.clone(),
                    worktree_resource_id,
                    branch_resource_id,
                }
            },
        );

        Ok(Some(WorkspaceSurface {
            snapshot_id: 0,
            provider: change.provider,
            resources,
            changed_paths: change.changed_paths.clone(),
            conflicts: change.conflicts.clone(),
            git,
        }))
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


    /// Post-completion lifecycle hook: commit only those changed files that
    /// fall within the node's declared `write_scope`.
    ///
    /// This serves two purposes:
    /// (a) **Auto-commit** — when the workspace has git metadata (e.g., a
    ///     `GitFileSystem` worktree), the method stages and commits only
    ///     paths matching the node's write_scope. This ensures that changes
    ///     outside the write scope (e.g., transient by-products) are not
    ///     included in the commit history.
    /// (b) **Programmatic trigger** — tasks that want to commit their own
    ///     completed work within a custom write scope can call this method
    ///     (or the public `crate::common::workspace::commit_write_scope_paths`)
    ///     at any point before the workspace resources are released.
    ///
    /// # Graceful degradation
    ///
    /// When git is not configured for the workspace (provider is `FileSystem`
    /// or `Memory`, or the surface has no `git` metadata), the method logs
    /// a warning at the `info` level and returns `Ok(())`.
    fn post_completion_write_scope_commit(
        &mut self,
        node_id: NodeId,
        surface: &crate::common::workspace::WorkspaceSurface,
    ) -> Result<(), EngineError> {
        let write_scope = &self.node(node_id)?.workspace.write_scope;
        if write_scope.is_empty() {
            return Ok(());
        }

        // Check whether the surface has git metadata with a worktree path
        let git = match &surface.git {
            Some(git) => git,
            None => {
                info!(
                    "post-completion hook: no git surface for node {},                     skipping write-scope commit",
                    node_id,
                );
                return Ok(());
            }
        };

        let message = format!(
            "sikong write-scope commit for node {} \"{}\"",
            node_id,
            self.node(node_id)?.key.0,
        );

        match crate::common::workspace::commit_write_scope_paths(
            &git.worktree_path,
            &message,
            write_scope,
        ) {
            Ok((changed_paths, commit_sha)) => {
                if let Some(sha) = commit_sha {
                    info!(
                        "post-completion hook committed {} path(s) (sha={}) for node {}",
                        changed_paths.len(),
                        sha,
                        node_id,
                    );
                } else {
                    info!(
                        "post-completion hook: no write-scope changes to commit for node {}",
                        node_id,
                    );
                }
                Ok(())
            }
            Err(error) => {
                // Graceful degradation: log the error, do not fail the node
                warn!(
                    "post-completion hook git commit failed for node {}: {}",
                    node_id,
                    error,
                );
                Ok(())
            }
        }
    }
    fn node_mut(&mut self, id: NodeId) -> Result<&mut ProblemNode, EngineError> {
        self.nodes.get_mut(&id).ok_or(EngineError::MissingNode(id))
    }
}

// =========================================================================
// RAII guard that wraps a parallel branch Engine
// =========================================================================

/// RAII guard that owns a parallel branch's [`Engine`] and a workspace clone.
///
/// Ensures deterministic cleanup of workspace resources when the guard is
/// dropped without being consumed (i.e., on error or panic paths inside a
/// spawned parallel task).
///
/// # Usage
///
/// Inside a spawned parallel task, wrap the branch Engine in this guard:
///
/// ```ignore
/// let mut guard = BranchEngineGuard::new(engine, workspace);
/// guard.resolve(child_id, depth, &cancellation).await?;
/// let engine = guard.into_engine();  // consume guard, transfer ownership
/// Ok((child_id, engine))
/// ```
///
/// If the task panics or returns an error before `into_engine()` is called,
/// the guard's [`Drop`] implementation cleans up any active workspace resources
/// via [`Workspace::cleanup`].
struct BranchEngineGuard<W, A>
where
    W: Workspace + Send + 'static,
    A: AgentRunScheduler + Send + 'static,
{
    engine: Option<Engine<W, A>>,
    workspace: Option<W>,
}

impl<W, A> BranchEngineGuard<W, A>
where
    W: Workspace + Clone + Send + 'static,
    A: AgentRunScheduler + Clone + Send + 'static,
{
    /// Create a new guard that takes ownership of the branch Engine and a
    /// workspace clone used for cleanup.
    fn new(engine: Engine<W, A>, workspace: W) -> Self {
        Self {
            engine: Some(engine),
            workspace: Some(workspace),
        }
    }

    /// Resolve the child node through the wrapped Engine.
    async fn resolve(
        &mut self,
        child_id: NodeId,
        depth: usize,
        cancellation: &CancellationToken,
    ) -> Result<Option<ArtifactId>, EngineError> {
        let engine = self
            .engine
            .as_mut()
            .expect("BranchEngineGuard engine consumed");
        engine.resolve(child_id, depth, cancellation).await
    }

    /// Consume the guard, returning the inner Engine without cleanup.
    /// The caller takes responsibility for the Engine's resources.
    fn into_engine(mut self) -> Engine<W, A> {
        self.engine
            .take()
            .expect("BranchEngineGuard engine already consumed")
    }
}

impl<W, A> Drop for BranchEngineGuard<W, A>
where
    W: Workspace + Send + 'static,
    A: AgentRunScheduler + Send + 'static,
{
    fn drop(&mut self) {
        // Only clean up if the Engine was not consumed via into_engine().
        // This covers the error and panic paths.
        if let Some(mut engine) = self.engine.take()
            && let Some(ref mut workspace) = self.workspace
        {
            let resources = engine.workspace_resources.drain_all();
            for resource in &resources {
                if resource.state == WorkspaceResourceState::Active
                    && let Err(error) = workspace.cleanup(resource)
                {
                    warn!(
                        resource_id = resource.id,
                        error = %error,
                        "BranchEngineGuard: failed to clean up resource on drop"
                    );
                }
            }
        }
    }
}

// =========================================================================
// Free helper functions
// =========================================================================

fn remap_node(
    mut node: ProblemNode,
    node_map: &HashMap<NodeId, NodeId>,
    artifact_map: &HashMap<ArtifactId, ArtifactId>,
) -> Result<ProblemNode, EngineError> {
    node.id = remap_node_id(node.id, node_map)?;
    node.parent = node
        .parent
        .map(|id| node_map.get(&id).copied().unwrap_or(id));
    node.children = node
        .children
        .into_iter()
        .map(|id| remap_node_id(id, node_map))
        .collect::<Result<Vec<_>, _>>()?;
    node.candidate = node
        .candidate
        .map(|id| remap_artifact_id(id, artifact_map))
        .transpose()?;
    node.accepted_artifact = node
        .accepted_artifact
        .map(|id| remap_artifact_id(id, artifact_map))
        .transpose()?;
    Ok(node)
}

fn remap_artifact(
    mut artifact: Artifact,
    node_map: &HashMap<NodeId, NodeId>,
    artifact_map: &HashMap<ArtifactId, ArtifactId>,
) -> Result<Artifact, EngineError> {
    artifact.id = remap_artifact_id(artifact.id, artifact_map)?;
    artifact.node_id = remap_node_id(artifact.node_id, node_map)?;
    artifact.children = artifact
        .children
        .into_iter()
        .map(|id| remap_artifact_id(id, artifact_map))
        .collect::<Result<Vec<_>, _>>()?;
    artifact.workspace_change = artifact
        .workspace_change
        .map(|change| remap_workspace_change(change, node_map, artifact_map))
        .transpose()?;
    Ok(artifact)
}

fn remap_workspace_change(
    mut change: WorkspaceChange,
    node_map: &HashMap<NodeId, NodeId>,
    artifact_map: &HashMap<ArtifactId, ArtifactId>,
) -> Result<WorkspaceChange, EngineError> {
    change.resources = change
        .resources
        .into_iter()
        .map(|resource| remap_workspace_resource(resource, node_map, artifact_map))
        .collect();
    Ok(change)
}

fn remap_workspace_resource(
    mut resource: WorkspaceResource,
    node_map: &HashMap<NodeId, NodeId>,
    artifact_map: &HashMap<ArtifactId, ArtifactId>,
) -> WorkspaceResource {
    resource.refs = resource
        .refs
        .into_iter()
        .filter_map(|resource_ref| remap_workspace_ref(resource_ref, node_map, artifact_map).ok())
        .collect();
    resource
}

fn remap_workspace_ref(
    resource_ref: WorkspaceResourceRef,
    node_map: &HashMap<NodeId, NodeId>,
    artifact_map: &HashMap<ArtifactId, ArtifactId>,
) -> Result<WorkspaceResourceRef, EngineError> {
    Ok(match resource_ref {
        WorkspaceResourceRef::RunningNode(id) => {
            WorkspaceResourceRef::RunningNode(remap_node_id(id, node_map)?)
        }
        WorkspaceResourceRef::CandidateArtifact(id) => {
            WorkspaceResourceRef::CandidateArtifact(remap_artifact_id(id, artifact_map)?)
        }
        WorkspaceResourceRef::ChildInputForCombine(id) => {
            WorkspaceResourceRef::ChildInputForCombine(remap_node_id(id, node_map)?)
        }
        WorkspaceResourceRef::MergeSurface(id) => {
            WorkspaceResourceRef::MergeSurface(remap_node_id(id, node_map)?)
        }
        WorkspaceResourceRef::DebugRetain => WorkspaceResourceRef::DebugRetain,
    })
}

fn remap_node_id(id: NodeId, node_map: &HashMap<NodeId, NodeId>) -> Result<NodeId, EngineError> {
    node_map
        .get(&id)
        .copied()
        .ok_or(EngineError::MissingNode(id))
}

fn remap_artifact_id(
    id: ArtifactId,
    artifact_map: &HashMap<ArtifactId, ArtifactId>,
) -> Result<ArtifactId, EngineError> {
    artifact_map
        .get(&id)
        .copied()
        .ok_or(EngineError::MissingArtifact(id))
}

fn inherit_child_defaults(
    parent: &ProblemNode,
    mut template: NodeTemplate,
) -> Result<NodeTemplate, EngineError> {
    let child_read_scope = template.workspace.read_scope;
    let child_write_scope = template.workspace.write_scope;
    template.workspace = parent.workspace.clone();
    if !child_read_scope.is_empty() {
        ensure_child_scopes_within_parent(
            "read_scope",
            &child_read_scope,
            &parent.workspace.read_scope,
        )?;
        template.workspace.read_scope = child_read_scope;
    }
    if !child_write_scope.is_empty() {
        ensure_child_scopes_within_parent(
            "write_scope",
            &child_write_scope,
            &parent.workspace.write_scope,
        )?;
        template.workspace.write_scope = child_write_scope;
    }
    template.capabilities = parent.capabilities.clone();
    template.budget = parent.budget.clone();
    if template.policy == NodePolicy::Explore {
        template.policy = parent.policy;
    }
    Ok(template)
}

fn ensure_child_scopes_within_parent(
    label: &str,
    child_scopes: &[String],
    parent_scopes: &[String],
) -> Result<(), EngineError> {
    let invalid = child_scopes
        .iter()
        .filter(|scope| !scope_allowed_by_parent(scope, parent_scopes))
        .cloned()
        .collect::<Vec<_>>();
    if invalid.is_empty() {
        Ok(())
    } else {
        Err(EngineError::AgentProtocol(format!(
            "G-SCOPE-WIDEN: child {label} outside parent workspace scope: {}",
            invalid.join(", ")
        )))
    }
}

fn scope_allowed_by_parent(child_scope: &str, parent_scopes: &[String]) -> bool {
    parent_scopes
        .iter()
        .any(|parent_scope| parent_scope_allows_child(parent_scope, child_scope))
}

fn parent_scope_allows_child(parent_scope: &str, child_scope: &str) -> bool {
    parent_scope == "**/*"
        || parent_scope == child_scope
        || crate::common::workspace::path_allowed(
            &[parent_scope.to_string()],
            std::path::Path::new(child_scope),
        )
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), EngineError> {
    if cancellation.is_cancelled() {
        Err(EngineError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parent_scope_allows_child tests ---

    #[test]
    fn parent_scope_allows_doublestar_wildcard() {
        assert!(parent_scope_allows_child("**/*", "anything"));
        assert!(parent_scope_allows_child("**/*", ""));
        assert!(parent_scope_allows_child("**/*", "src/main.rs"));
    }

    #[test]
    fn parent_scope_allows_exact_match() {
        assert!(parent_scope_allows_child("src/main.rs", "src/main.rs"));
        assert!(parent_scope_allows_child("AGENTS.md", "AGENTS.md"));
    }

    #[test]
    fn parent_scope_allows_narrower_directory_child() {
        assert!(parent_scope_allows_child(
            "src/**/*",
            "src/task_run/engine.rs"
        ));
        assert!(parent_scope_allows_child(
            "packages/**/*.ts",
            "packages/agent-host/src/protocol.ts"
        ));
    }

    #[test]
    fn parent_scope_rejects_outside_directory() {
        assert!(!parent_scope_allows_child("src/**/*", "lib/**"));
        assert!(!parent_scope_allows_child("src/**/*", "tests/"));
        assert!(!parent_scope_allows_child("design/**/*.md", "src/**"));
    }

    #[test]
    fn parent_scope_rejects_unrelated_exact_path() {
        assert!(!parent_scope_allows_child("src/main.rs", "src/lib.rs"));
    }

    #[test]
    fn scope_allowed_by_parent_matches_any_parent() {
        let parents = vec!["src/**".to_string(), "design/**".to_string()];
        assert!(scope_allowed_by_parent("src/task_run/**", &parents));
        assert!(scope_allowed_by_parent("design/README.md", &parents));
        assert!(!scope_allowed_by_parent("tests/foo.rs", &parents));
    }

    #[test]
    fn scope_allowed_by_parent_empty_parents_rejects_all() {
        let parents: Vec<String> = Vec::new();
        assert!(!scope_allowed_by_parent("src/main.rs", &parents));
    }

    #[test]
    fn scope_allowed_by_parent_single_parent() {
        let parents = vec!["src/**/*.rs".to_string()];
        assert!(scope_allowed_by_parent("src/main.rs", &parents));
        assert!(scope_allowed_by_parent("src/task_run/types.rs", &parents));
        assert!(!scope_allowed_by_parent("src/main.js", &parents));
    }
    use crate::core::task_run::node::PlanGroup;

    // --- plan_from_scope_assessment tests ---

    #[test]
    fn plan_from_assessment_tiny_becomes_fast_execute() {
        let assessment = ScopeAssessment::new("do it", WorkSize::Tiny, "tiny task");
        let plan = plan_from_scope_assessment(&assessment, &NodePlan::Execute);
        assert_eq!(plan, NodePlan::FastExecute);
    }

    #[test]
    fn plan_from_assessment_small_executes() {
        let assessment = ScopeAssessment::new("do it", WorkSize::Small, "small task");
        let plan = plan_from_scope_assessment(&assessment, &NodePlan::Execute);
        assert_eq!(plan, NodePlan::Execute);
    }

    #[test]
    fn plan_from_assessment_medium_executes() {
        let assessment = ScopeAssessment::new("do it", WorkSize::Medium, "medium task");
        let plan = plan_from_scope_assessment(&assessment, &NodePlan::Execute);
        assert_eq!(plan, NodePlan::Execute);
    }

    #[test]
    fn plan_from_assessment_large_with_execute_plan_becomes_needs_planning() {
        let assessment = ScopeAssessment::new("big task", WorkSize::Large, "needs decomposition");
        let plan = plan_from_scope_assessment(&assessment, &NodePlan::Execute);
        assert_eq!(plan, NodePlan::NeedsPlanning);
    }

    #[test]
    fn plan_from_assessment_large_with_needs_planning_becomes_needs_planning() {
        let assessment = ScopeAssessment::new("big task", WorkSize::Large, "needs decomposition");
        let plan = plan_from_scope_assessment(&assessment, &NodePlan::NeedsPlanning);
        assert_eq!(plan, NodePlan::NeedsPlanning);
    }

    #[test]
    fn plan_from_assessment_large_preserves_existing_group_plan() {
        let group = NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![NodeTemplate::memory_leaf("child", "work")],
        });
        let assessment = ScopeAssessment::new("big task", WorkSize::Large, "already planned");
        let plan = plan_from_scope_assessment(&assessment, &group);
        assert_eq!(plan, group);
    }

    #[test]
    fn plan_from_assessment_xlarge_with_execute_plan_becomes_needs_planning() {
        let assessment = ScopeAssessment::new("huge task", WorkSize::XLarge, "needs planning");
        let plan = plan_from_scope_assessment(&assessment, &NodePlan::Execute);
        assert_eq!(plan, NodePlan::NeedsPlanning);
    }

    #[test]
    fn plan_from_assessment_xlarge_preserves_existing_group_plan() {
        let group = NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Stage,
            items: vec![
                NodeTemplate::memory_leaf("step1", "first"),
                NodeTemplate::memory_leaf("step2", "second"),
            ],
        });
        let assessment = ScopeAssessment::new("huge task", WorkSize::XLarge, "already staged");
        let plan = plan_from_scope_assessment(&assessment, &group);
        assert_eq!(plan, group);
    }

    #[test]
    fn plan_from_assessment_tiny_ignores_needs_planning_current_plan() {
        let assessment = ScopeAssessment::new("tiny fix", WorkSize::Tiny, "trivial");
        let plan = plan_from_scope_assessment(&assessment, &NodePlan::NeedsPlanning);
        assert_eq!(plan, NodePlan::FastExecute);
    }
}
