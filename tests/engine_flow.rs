use std::{
    fs,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use siko::*;

mod support;
use support::{TestAgentRunScheduler, TestGitRepo};

fn engine() -> Engine<MemoryWorkspace, TestAgentRunScheduler> {
    Engine::new(MemoryWorkspace::default(), TestAgentRunScheduler)
}

#[derive(Debug, Clone)]
struct EventfulAgentRunScheduler;

#[async_trait::async_trait]
impl AgentRunScheduler for EventfulAgentRunScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        _cancellation: CancellationToken,
    ) -> AgentRunResponse {
        let terminal_tool = input.terminal_tool_set[0].clone();
        let arguments = match terminal_tool.as_str() {
            "submit_specification" => serde_json::json!({
                "next": "record searchable execution events",
                "size": "small",
                "reason": "One local logging behavior."
            }),
            "submit_work" => serde_json::json!({
                "output": "searchable event record"
            }),
            "submit_verdict" => serde_json::json!({
                "verdict": "accept",
                "reason": "event record is present"
            }),
            other => serde_json::json!({ "unexpected": other }),
        };
        let call = AgentToolCall {
            name: terminal_tool,
            arguments,
        };

        AgentRunResponse {
            report: format!("eventful worker completed {}", input.objective),
            tool_calls: vec![call.clone()],
            terminal_call: Some(call.clone()),
            usage: None,
            events: vec![serde_json::json!({
                "source": "agent-loop",
                "event": "tool_call_start",
                "name": call.name,
                "objective": input.objective
            })],
        }
    }
}

#[tokio::test]
async fn simple_leaf_executes_verifies_and_commits() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate::memory_leaf("polish", "polished text"));

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    assert_eq!(engine.node(root).unwrap().size, WorkSize::Small);
    let scope = engine
        .node(root)
        .unwrap()
        .scope_assessment
        .as_ref()
        .unwrap()
        .clone();
    assert_eq!(scope.next, "polished text");
    assert_eq!(
        scope.reason,
        "This is closest to Small because the test scheduler mirrors one local node with one terminal path."
    );
    let artifact = engine.artifact(report.artifact.unwrap()).unwrap();
    assert_eq!(artifact.text, "polished text");
    assert_eq!(report.artifact_text.as_deref(), Some("polished text"));
    assert_eq!(
        engine
            .events()
            .iter()
            .map(|event| event.operation)
            .collect::<Vec<_>>(),
        vec![
            NodeOperation::Specify,
            NodeOperation::Execute,
            NodeOperation::Verify,
            NodeOperation::Commit,
        ]
    );
    assert_eq!(
        engine
            .agent_runs()
            .iter()
            .map(|run| run.operation)
            .collect::<Vec<_>>(),
        vec![
            NodeOperation::Specify,
            NodeOperation::Execute,
            NodeOperation::Verify,
        ]
    );
    assert_eq!(
        engine
            .agent_runs()
            .iter()
            .filter_map(|run| run.terminal_tool.as_deref())
            .collect::<Vec<_>>(),
        vec!["submit_specification", "submit_work", "submit_verdict",]
    );
}

#[tokio::test]
async fn engine_report_preserves_agent_run_events() {
    let mut engine = Engine::new(MemoryWorkspace::default(), EventfulAgentRunScheduler);
    let root = engine.insert_root(NodeTemplate::memory_leaf(
        "logs",
        "record searchable execution events",
    ));

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    assert_eq!(report.agent_runs.len(), 3);
    assert!(report.agent_runs.iter().all(|run| !run.events.is_empty()));
    assert_eq!(report.agent_runs[1].events[0]["event"], "tool_call_start");
    assert_eq!(report.agent_runs[1].events[0]["name"], "submit_work");
}

#[tokio::test]
async fn stop_after_root_route_creates_children_without_executing_them() {
    let child_a = NodeTemplate::memory_leaf("docs", "audit design docs");
    let child_b = NodeTemplate::memory_leaf("runtime", "audit runtime code");
    let mut engine = engine().with_stop_after_route_depth(0);
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("route-only".to_string()),
        intent: "plan repository audit".to_string(),
        size: WorkSize::Large,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![child_a, child_b],
        }),
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Planned);
    assert_eq!(report.artifact, None);
    let root_node = engine.node(root).unwrap();
    assert_eq!(root_node.children.len(), 2);
    assert!(
        root_node
            .children
            .iter()
            .all(|child_id| { engine.node(*child_id).unwrap().status == NodeStatus::New })
    );
    assert_eq!(
        engine
            .agent_runs()
            .iter()
            .map(|run| run.operation)
            .collect::<Vec<_>>(),
        vec![NodeOperation::Specify, NodeOperation::Plan]
    );
    assert!(engine.events().iter().any(|event| {
        event.operation == NodeOperation::Plan && event.note == "stopped after plan at depth 0"
    }));
}

#[tokio::test]
async fn stop_after_root_route_does_not_execute_atomic_nodes() {
    let mut engine = engine().with_stop_after_route_depth(0);
    let root = engine.insert_root(NodeTemplate::memory_leaf("atomic", "answer directly"));

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Specified);
    assert_eq!(report.artifact, None);
    assert_eq!(
        engine
            .agent_runs()
            .iter()
            .map(|run| run.operation)
            .collect::<Vec<_>>(),
        vec![NodeOperation::Specify]
    );
    assert!(engine.events().iter().any(|event| {
        event.operation == NodeOperation::Specify
            && event.note == "stopped after specify at depth 0"
    }));
}

#[tokio::test]
async fn verify_receives_candidate_workspace_surface_for_file_system_nodes() {
    let saw_verify_surface = Arc::new(Mutex::new(false));
    let mut engine = Engine::new(
        FileSystemWorkspace::default(),
        VerifySurfaceScheduler {
            saw_verify_surface: Arc::clone(&saw_verify_surface),
        },
    );
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("verify-file-surface".to_string()),
        intent: "review local files".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::read_only_files(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    assert!(*saw_verify_surface.lock().unwrap());
}

#[tokio::test]
async fn information_gathering_work_executes_as_a_normal_node() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("provider-evidence".to_string()),
        intent: "identify the selected provider and model in the current runtime config"
            .to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    assert_eq!(
        engine
            .events()
            .iter()
            .map(|event| event.operation)
            .collect::<Vec<_>>(),
        vec![
            NodeOperation::Specify,
            NodeOperation::Execute,
            NodeOperation::Verify,
            NodeOperation::Commit,
        ]
    );
}

#[tokio::test]
async fn specify_can_rewrite_missing_context_into_evidence_work() {
    let mut engine = Engine::new(MemoryWorkspace::default(), EvidenceNextAgentRunScheduler);
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("provider-config".to_string()),
        intent: "Configure the production model provider selected by the user, but the provider choice is not present."
            .to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    });

    let report = engine.run(root).await.unwrap();

    let node = engine.node(root).unwrap();
    assert_eq!(
        node.intent,
        "Identify which provider and model are selected in the current runtime config."
    );
    assert_eq!(node.size, WorkSize::Tiny);
    assert_eq!(node.plan, NodePlan::Execute);
    assert_eq!(
        node.scope_assessment.as_ref().unwrap().reason,
        "The evidence-gathering work is tiny even though the broader setup depends on it."
    );
    assert_eq!(report.status, NodeStatus::Committed);
    assert_eq!(
        engine.artifact(report.artifact.unwrap()).unwrap().text,
        "Identify which provider and model are selected in the current runtime config."
    );
    assert_eq!(
        engine
            .agent_runs()
            .iter()
            .map(|run| run.operation)
            .collect::<Vec<_>>(),
        vec![
            NodeOperation::Specify,
            NodeOperation::Execute,
            NodeOperation::Verify,
        ]
    );
}

#[tokio::test]
async fn parallel_group_resolves_children_and_combines_parent() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("design".to_string()),
        intent: "complete design".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![
                NodeTemplate::memory_leaf("state-machine", "state design"),
                NodeTemplate::memory_leaf("data-model", "data model"),
            ],
        }),
    });

    let report = engine.run(root).await.unwrap();

    let artifact = engine.artifact(report.artifact.unwrap()).unwrap();
    assert_eq!(artifact.content_kind, ArtifactContentKind::Text);
    assert_eq!(artifact.children.len(), 2);
    assert_eq!(artifact.text, "complete design");
    assert_eq!(engine.node(root).unwrap().children.len(), 2);
    assert!(
        engine
            .agent_runs()
            .iter()
            .any(|run| run.node_id == root && run.operation == NodeOperation::Plan)
    );
    assert!(
        engine
            .agent_runs()
            .iter()
            .any(|run| run.node_id == root && run.operation == NodeOperation::Combine)
    );
}

#[tokio::test]
async fn planned_children_inherit_parent_workspace_and_capabilities() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("scoped-plan".to_string()),
        intent: "complete scoped plan".to_string(),
        size: WorkSize::Large,
        scope_assessment: None,
        workspace: WorkspaceRequirement {
            provider: WorkspaceProvider::FileSystem,
            read_scope: vec!["src/task_run/**".to_string()],
            write_scope: vec!["design/**".to_string()],
            git: None,
        },
        capabilities: CapabilityProfile::writable(),
        budget: Budget { max_attempts: 3 },
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![NodeTemplate::memory_leaf("child", "child work")],
        }),
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    let child = engine.node(root).unwrap().children[0];
    let child = engine.node(child).unwrap();
    assert_eq!(child.workspace.provider, WorkspaceProvider::FileSystem);
    assert_eq!(child.workspace.read_scope, vec!["src/task_run/**"]);
    assert_eq!(child.workspace.write_scope, vec!["design/**"]);
    assert!(child.capabilities.allow_write);
    assert_eq!(child.budget.max_attempts, 3);
}

#[tokio::test]
async fn planned_children_can_narrow_parent_workspace_scope() {
    let mut engine = engine();
    let mut child = NodeTemplate::memory_leaf("child", "child work");
    child.workspace.read_scope = vec!["src/task_run/**".to_string()];
    child.workspace.write_scope = vec!["design/task-run/**".to_string()];
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("scoped-plan".to_string()),
        intent: "complete scoped plan".to_string(),
        size: WorkSize::Large,
        scope_assessment: None,
        workspace: WorkspaceRequirement {
            provider: WorkspaceProvider::FileSystem,
            read_scope: vec!["src/**".to_string()],
            write_scope: vec!["design/**".to_string()],
            git: None,
        },
        capabilities: CapabilityProfile::writable(),
        budget: Budget { max_attempts: 3 },
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![child],
        }),
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    let child = engine.node(root).unwrap().children[0];
    let child = engine.node(child).unwrap();
    assert_eq!(child.workspace.provider, WorkspaceProvider::FileSystem);
    assert_eq!(child.workspace.read_scope, vec!["src/task_run/**"]);
    assert_eq!(child.workspace.write_scope, vec!["design/task-run/**"]);
    assert!(child.capabilities.allow_write);
    assert_eq!(child.budget.max_attempts, 3);
}

#[tokio::test]
async fn planned_children_cannot_widen_parent_workspace_scope() {
    let mut engine = engine();
    let mut child = NodeTemplate::memory_leaf("child", "child work");
    child.workspace.read_scope = vec!["secrets/**".to_string()];
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("scoped-plan".to_string()),
        intent: "complete scoped plan".to_string(),
        size: WorkSize::Large,
        scope_assessment: None,
        workspace: WorkspaceRequirement {
            provider: WorkspaceProvider::FileSystem,
            read_scope: vec!["src/**".to_string()],
            write_scope: Vec::new(),
            git: None,
        },
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![child],
        }),
    });

    let error = engine.run(root).await.unwrap_err();

    assert!(matches!(error, EngineError::AgentProtocol(_)));
    assert!(
        format!("{error:?}")
            .contains("G-SCOPE-WIDEN: child read_scope outside parent workspace scope")
    );
}

#[tokio::test]
async fn parallel_group_executes_children_concurrently() {
    let state = Arc::new(ConcurrentAgentState::default());
    let mut engine = Engine::new(
        MemoryWorkspace::default(),
        ConcurrentAgentRunScheduler {
            state: state.clone(),
        },
    );
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("parallel".to_string()),
        intent: "combined concurrent work".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![
                NodeTemplate::memory_leaf("concurrent-a", "concurrent a"),
                NodeTemplate::memory_leaf("concurrent-b", "concurrent b"),
            ],
        }),
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    assert!(
        state.max_execute.load(Ordering::SeqCst) > 1,
        "parallel children did not overlap"
    );
}

#[tokio::test]
async fn parallel_group_merges_children_as_they_finish() {
    let mut engine = Engine::new(MemoryWorkspace::default(), StaggeredAgentRunScheduler);
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("staggered".to_string()),
        intent: "combined staggered work".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![
                NodeTemplate::memory_leaf("slow-child", "slow child"),
                NodeTemplate::memory_leaf("fast-child", "fast child"),
            ],
        }),
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    let children = engine.node(root).unwrap().children.clone();
    let slow_child = children[0];
    let fast_child = children[1];
    let fast_commit = engine
        .events()
        .iter()
        .position(|event| event.node_id == fast_child && event.operation == NodeOperation::Commit)
        .expect("fast child commit event");
    let slow_commit = engine
        .events()
        .iter()
        .position(|event| event.node_id == slow_child && event.operation == NodeOperation::Commit)
        .expect("slow child commit event");
    assert!(
        fast_commit < slow_commit,
        "parallel branches should be merged in completion order"
    );
}

#[tokio::test]
async fn stage_group_resolves_items_in_order_and_combines_parent() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("staged-design".to_string()),
        intent: "complete staged design".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Stage,
            items: vec![
                NodeTemplate::memory_leaf("stage-a", "stage a"),
                NodeTemplate::memory_leaf("stage-b", "stage b"),
            ],
        }),
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    let root_children = engine.node(root).unwrap().children.clone();
    assert_eq!(root_children.len(), 2);
    let stage_a = root_children[0];
    let stage_b = root_children[1];
    let stage_a_commit = engine
        .events()
        .iter()
        .position(|event| event.node_id == stage_a && event.operation == NodeOperation::Commit)
        .expect("stage a commit");
    let stage_b_spec = engine
        .events()
        .iter()
        .position(|event| event.node_id == stage_b && event.operation == NodeOperation::Specify)
        .expect("stage b specify");
    assert!(stage_a_commit < stage_b_spec);
    assert_eq!(
        engine.artifact(report.artifact.unwrap()).unwrap().text,
        "complete staged design"
    );
}

#[derive(Default)]
struct ConcurrentAgentState {
    current_execute: AtomicUsize,
    max_execute: AtomicUsize,
}

#[derive(Clone)]
struct EvidenceNextAgentRunScheduler;

#[async_trait::async_trait]
impl AgentRunScheduler for EvidenceNextAgentRunScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        _cancellation: CancellationToken,
    ) -> AgentRunResponse {
        let terminal_tool = input.terminal_tool_set.first().cloned();
        let node_intent = input
            .input
            .pointer("/node/intent")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("mock output")
            .to_string();
        let terminal_call = terminal_tool.map(|name| {
            let arguments = match name.as_str() {
                "submit_specification" => serde_json::json!({
                    "next": "Identify which provider and model are selected in the current runtime config.",
                    "size": "tiny",
                    "reason": "The evidence-gathering work is tiny even though the broader setup depends on it."
                }),
                "submit_work" => serde_json::json!({
                    "output": node_intent,
                }),
                "submit_verdict" => serde_json::json!({
                    "verdict": "accept",
                    "reason": "evidence work completed",
                }),
                _ => serde_json::json!({}),
            };
            AgentToolCall { name, arguments }
        });

        AgentRunResponse {
            report: format!("evidence-next scheduler completed {}", input.objective),
            tool_calls: terminal_call.clone().into_iter().collect(),
            terminal_call,
            usage: None,
            events: Vec::new(),
        }
    }
}

#[derive(Clone)]
struct ConcurrentAgentRunScheduler {
    state: Arc<ConcurrentAgentState>,
}

#[async_trait::async_trait]
impl AgentRunScheduler for ConcurrentAgentRunScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse {
        if input.terminal_tool_set == vec!["submit_work".to_string()] {
            let current = self.state.current_execute.fetch_add(1, Ordering::SeqCst) + 1;
            self.state.max_execute.fetch_max(current, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(50)).await;
            self.state.current_execute.fetch_sub(1, Ordering::SeqCst);
        }

        TestAgentRunScheduler.run(input, cancellation).await
    }
}

#[derive(Clone)]
struct StaggeredAgentRunScheduler;

#[async_trait::async_trait]
impl AgentRunScheduler for StaggeredAgentRunScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse {
        let intent = input
            .input
            .pointer("/node/intent")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if intent == "slow child" && input.terminal_tool_set == vec!["submit_work".to_string()] {
            tokio::time::sleep(Duration::from_millis(80)).await;
        }

        TestAgentRunScheduler.run(input, cancellation).await
    }
}

#[tokio::test]
async fn verify_reject_retries_leaf_until_accept() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("retry".to_string()),
        intent: "retry once".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget { max_attempts: 2 },
        plan: NodePlan::Execute,
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    assert_eq!(engine.node(root).unwrap().execution_attempts, 2);
    assert_eq!(
        engine
            .attempts_for(&ProblemKey("retry".to_string()))
            .iter()
            .filter(|attempt| attempt.operation == NodeOperation::Verify)
            .count(),
        2
    );
}

#[tokio::test]
async fn repeated_failure_rejected_after_budget() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("fail".to_string()),
        intent: "always bad".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget { max_attempts: 2 },
        plan: NodePlan::Execute,
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Rejected);
    assert!(report.artifact.is_none());
    assert_eq!(engine.node(root).unwrap().execution_attempts, 2);
    assert_eq!(engine.node(root).unwrap().status, NodeStatus::Rejected);
    assert!(
        engine
            .events()
            .iter()
            .any(|event| {
                event.operation == NodeOperation::Verify
                    && event.note.contains("BudgetExhausted")
            }),
        "budget-exhausted event should be recorded when budget is exceeded"
    );
}

#[tokio::test]
async fn missing_info_reject_waits_without_retrying_execute() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("missing-info".to_string()),
        intent: "missing-info reject".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget { max_attempts: 2 },
        plan: NodePlan::Execute,
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::WaitingForInfo);
    assert!(report.artifact.is_none());
    assert_eq!(engine.node(root).unwrap().execution_attempts, 1);
    assert_eq!(
        engine
            .agent_runs()
            .iter()
            .filter(|run| run.operation == NodeOperation::Execute)
            .count(),
        1
    );
}

#[tokio::test]
async fn unresolved_parallel_child_blocks_parent_combine() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("parent".to_string()),
        intent: "combine accepted child evidence".to_string(),
        size: WorkSize::Large,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![
                NodeTemplate::memory_leaf("ready-child", "ready child result"),
                NodeTemplate::memory_leaf("missing-child", "needs post-verify info"),
            ],
        }),
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::WaitingForInfo);
    assert!(report.artifact.is_none());
    assert!(engine.events().iter().any(|event| {
        event.operation == NodeOperation::Combine
            && event
                .note
                .contains("waiting for child information before combine")
    }));
    assert!(engine.agent_runs().iter().all(|run| !(run.node_id == root
        && matches!(
            run.operation,
            NodeOperation::Combine | NodeOperation::Verify
        ))));
}

#[tokio::test]
async fn unresolved_stage_child_stops_later_siblings() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("stage-parent".to_string()),
        intent: "combine ordered child evidence".to_string(),
        size: WorkSize::Large,
        scope_assessment: None,
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Stage,
            items: vec![
                NodeTemplate::memory_leaf("stage-ready", "ready child result"),
                NodeTemplate::memory_leaf("stage-missing", "needs post-verify info"),
                NodeTemplate::memory_leaf("stage-later", "later child must not run"),
            ],
        }),
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::WaitingForInfo);
    assert!(report.artifact.is_none());
    assert!(engine.node(4).is_ok());
    assert_eq!(engine.node(4).unwrap().status, NodeStatus::New);
    assert!(engine.agent_runs().iter().all(|run| run.node_id != 4));
}

#[tokio::test]
async fn memo_reuses_accepted_artifact_for_same_problem_key() {
    let mut engine = engine();
    let first = engine.insert_root(NodeTemplate::memory_leaf("same", "first"));
    let second = engine.insert_root(NodeTemplate::memory_leaf("same", "second"));

    let first_report = engine.run(first).await.unwrap();
    let second_report = engine.run(second).await.unwrap();

    assert_eq!(engine.memo_len(), 1);
    assert_eq!(first_report.artifact, second_report.artifact);
    assert_eq!(
        engine
            .artifact(second_report.artifact.unwrap())
            .unwrap()
            .text,
        "first"
    );
}

#[tokio::test]
async fn read_only_workspace_change_is_rejected() {
    let repo = TestGitRepo::new();
    repo.write("base.txt", "base\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-m", "initial"]);

    let mut engine = Engine::new(Workspaces::default(), WritingGitAgentRunScheduler);
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("read-only".to_string()),
        intent: "read only must not write".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::git_repo(
            repo.root(),
            repo.worktrees(),
            "HEAD",
            Vec::<String>::new(),
        ),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Pruned);
    assert_eq!(
        engine
            .agent_runs()
            .iter()
            .map(|run| run.operation)
            .collect::<Vec<_>>(),
        vec![NodeOperation::Specify, NodeOperation::Execute]
    );
    assert!(
        engine
            .attempts_for(&ProblemKey("read-only".to_string()))
            .iter()
            .any(|attempt| {
                matches!(
                    attempt.verdict,
                    Some(VerificationVerdict::Reject {
                        failure_class: FailureClass::UnsafeSideEffect,
                        ..
                    })
                )
            })
    );
}

#[tokio::test]
async fn git_combine_conflict_is_given_to_agent_instead_of_pruning_parent() {
    let mut engine = Engine::new(Workspaces::default(), TestAgentRunScheduler);
    let child_a = NodeTemplate {
        key: ProblemKey("a".to_string()),
        intent: "patch a".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::git(["packages/client/src/api.ts"]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    };
    let child_b = NodeTemplate {
        key: ProblemKey("b".to_string()),
        intent: "patch b".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::git(["packages/client/src/api.ts"]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    };
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("conflict".to_string()),
        intent: "combined patch".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::git(["packages/client/src/api.ts"]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![child_a, child_b],
        }),
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    let artifact = engine.artifact(report.artifact.unwrap()).unwrap();
    assert_eq!(artifact.text, "combined patch");
    assert!(
        engine
            .attempts_for(&ProblemKey("conflict".to_string()))
            .iter()
            .all(|attempt| {
                !matches!(
                    attempt.verdict,
                    Some(VerificationVerdict::Reject {
                        failure_class: FailureClass::MergeConflict,
                        ..
                    })
                )
            })
    );
}

#[tokio::test]
async fn engine_cleans_git_workspace_resources_after_run() {
    let repo = TestGitRepo::new();
    repo.write("base.txt", "base\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-m", "initial"]);

    let mut engine = Engine::new(Workspaces::default(), WritingGitAgentRunScheduler);
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("write-file".to_string()),
        intent: "write file".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::git_repo(
            repo.root(),
            repo.worktrees(),
            "HEAD",
            ["file.txt"],
        ),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    assert!(repo.worktrees().read_dir().unwrap().next().is_none());
    assert!(repo.git(["branch", "--list", "sikong/*"]).trim().is_empty());
}

#[tokio::test]
async fn writable_node_outside_write_scope_is_rejected() {
    let repo = TestGitRepo::new();
    repo.write("base.txt", "base\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-m", "initial"]);

    let mut engine = Engine::new(Workspaces::default(), WriteOutsideScopeScheduler);
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("out-of-scope".to_string()),
        intent: "write unscoped file".to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::git_repo(
            repo.root(),
            repo.worktrees(),
            "HEAD",
            ["allowed.txt"],
        ),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Pruned);
    assert!(
        engine
            .attempts_for(&ProblemKey("out-of-scope".to_string()))
            .iter()
            .any(|attempt| {
                matches!(
                    attempt.verdict,
                    Some(VerificationVerdict::Reject {
                        failure_class: FailureClass::UnsafeSideEffect,
                        ..
                    })
                )
            })
    );
}

#[derive(Clone)]
struct WriteOutsideScopeScheduler;

#[async_trait::async_trait]
impl AgentRunScheduler for WriteOutsideScopeScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse {
        if input.terminal_tool_set == vec!["submit_work".to_string()] {
            let worktree_path = input
                .input
                .pointer("/workspace_surface/git_worktree_path")
                .and_then(serde_json::Value::as_str)
                .expect("git worktree path");
            // Write to a file outside the allowed write_scope ["allowed.txt"]
            fs::write(Path::new(worktree_path).join("unscoped.txt"), "written\n").unwrap();
            return AgentRunResponse {
                report: "wrote unscoped file".to_string(),
                tool_calls: vec![AgentToolCall {
                    name: "submit_work".to_string(),
                    arguments: serde_json::json!({
                        "output": "write unscoped file",
                    }),
                }],
                terminal_call: Some(AgentToolCall {
                    name: "submit_work".to_string(),
                    arguments: serde_json::json!({
                        "output": "write unscoped file",
                    }),
                }),
                usage: None,
                events: Vec::new(),
            };
        }

        TestAgentRunScheduler.run(input, cancellation).await
    }
}

#[derive(Clone)]
struct WritingGitAgentRunScheduler;

#[async_trait::async_trait]
impl AgentRunScheduler for WritingGitAgentRunScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse {
        if input.terminal_tool_set == vec!["submit_work".to_string()] {
            let worktree_path = input
                .input
                .pointer("/workspace_surface/git_worktree_path")
                .and_then(serde_json::Value::as_str)
                .expect("git worktree path");
            fs::write(Path::new(worktree_path).join("file.txt"), "written\n").unwrap();
            return AgentRunResponse {
                report: "wrote git file".to_string(),
                tool_calls: vec![AgentToolCall {
                    name: "submit_work".to_string(),
                    arguments: serde_json::json!({
                        "output": "write file",
                    }),
                }],
                terminal_call: Some(AgentToolCall {
                    name: "submit_work".to_string(),
                    arguments: serde_json::json!({
                        "output": "write file",
                    }),
                }),
                usage: None,
                events: Vec::new(),
            };
        }

        TestAgentRunScheduler.run(input, cancellation).await
    }
}

#[derive(Clone)]
struct VerifySurfaceScheduler {
    saw_verify_surface: Arc<Mutex<bool>>,
}

#[async_trait::async_trait]
impl AgentRunScheduler for VerifySurfaceScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        _cancellation: CancellationToken,
    ) -> AgentRunResponse {
        let name = input.terminal_tool_set[0].clone();
        let arguments = match name.as_str() {
            "submit_specification" => serde_json::json!({
                "next": "review local files",
                "size": "small",
                "reason": "single local review"
            }),
            "submit_work" => serde_json::json!({
                "output": "review local files"
            }),
            "submit_verdict" => {
                let has_root = input
                    .input
                    .pointer("/workspace_surface/file_system_root_path")
                    .and_then(serde_json::Value::as_str)
                    .is_some();
                *self.saw_verify_surface.lock().unwrap() = has_root;
                serde_json::json!({
                    "verdict": "accept",
                    "reason": "verified with workspace surface"
                })
            }
            _ => serde_json::json!({}),
        };
        let call = AgentToolCall { name, arguments };
        AgentRunResponse {
            report: "verify surface scheduler completed".to_string(),
            tool_calls: vec![call.clone()],
            terminal_call: Some(call),
            usage: None,
            events: Vec::new(),
        }
    }
}
