use siko::*;
use std::process::Command;

fn bun_available() -> bool {
    Command::new("bun").arg("--version").output().is_ok()
}

fn host_worker() -> AgentHostClient {
    AgentHostClient::new("bun", ["packages/agent-host/src/runtime-host.ts"])
}

fn memory_engine() -> Engine<MemoryWorkspace, AgentHostClient> {
    Engine::new(MemoryWorkspace::default(), host_worker())
}

fn workspace_engine() -> Engine<Workspaces, AgentHostClient> {
    Engine::new(Workspaces::default(), host_worker())
}

fn reject_bad_output() -> VerificationVerdict {
    VerificationVerdict::Reject {
        failure_class: FailureClass::BadOutput,
        reason: "bad output".to_string(),
    }
}

fn skip_without_bun(test_name: &str) -> bool {
    if bun_available() {
        return false;
    }
    eprintln!("skipping {test_name}: bun not found");
    true
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_simple_leaf_commits_with_terminal_tools() {
    if skip_without_bun("host_simple_leaf_commits_with_terminal_tools") {
        return;
    }

    let mut engine = memory_engine();
    let root = engine.insert_root(NodeTemplate::memory_leaf("simple", "simple result"));

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    assert_eq!(
        engine.artifact(report.artifact.unwrap()).unwrap().text,
        "simple result"
    );
    assert_eq!(
        engine
            .agent_runs()
            .iter()
            .filter_map(|run| run.terminal_tool.as_deref())
            .collect::<Vec<_>>(),
        vec![
            "submit_specification",
            "submit_work",
            "submit_verdict",
            "submit_commit",
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_acquire_can_rewrite_into_divide_then_commit() {
    if skip_without_bun("host_acquire_can_rewrite_into_divide_then_commit") {
        return;
    }

    let mut engine = memory_engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("research-plan".to_string()),
        intent: "research then plan".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        script: NodeScript::NeedsInfo {
            need: "source".to_string(),
            acquired: "source evidence".to_string(),
            then: Box::new(NodeScript::Divide {
                children: vec![
                    NodeTemplate::memory_leaf("research-a", "finding a"),
                    NodeTemplate::memory_leaf("research-b", "finding b"),
                ],
                combine_output: "combined findings".to_string(),
                verdicts: vec![VerificationVerdict::Accept],
            }),
        },
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    let root_node = engine.node(root).unwrap();
    assert_eq!(root_node.acquired, vec!["source=1"]);
    assert_eq!(root_node.children.len(), 2);
    assert_eq!(
        engine.artifact(report.artifact.unwrap()).unwrap().text,
        "combined findings"
    );
    assert!(
        engine
            .agent_runs()
            .iter()
            .any(|run| run.operation == NodeOperation::Acquire
                && run.terminal_tool.as_deref() == Some("submit_evidence"))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_nested_divide_resolves_children_recursively() {
    if skip_without_bun("host_nested_divide_resolves_children_recursively") {
        return;
    }

    let mut engine = memory_engine();
    let nested = NodeTemplate {
        key: ProblemKey("nested".to_string()),
        intent: "nested branch".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        script: NodeScript::Divide {
            children: vec![
                NodeTemplate::memory_leaf("nested-a", "nested a"),
                NodeTemplate::memory_leaf("nested-b", "nested b"),
            ],
            combine_output: "nested combined".to_string(),
            verdicts: vec![VerificationVerdict::Accept],
        },
    };
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("root-divide".to_string()),
        intent: "root branch".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        script: NodeScript::Divide {
            children: vec![NodeTemplate::memory_leaf("top-leaf", "top"), nested],
            combine_output: "root combined".to_string(),
            verdicts: vec![VerificationVerdict::Accept],
        },
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    assert_eq!(
        engine.artifact(report.artifact.unwrap()).unwrap().text,
        "root combined"
    );
    let root_children = engine.node(root).unwrap().children.clone();
    assert_eq!(root_children.len(), 2);
    assert_eq!(engine.node(root_children[1]).unwrap().children.len(), 2);
    assert_eq!(
        engine
            .agent_runs()
            .iter()
            .filter(|run| run.operation == NodeOperation::Divide)
            .count(),
        2
    );
    assert_eq!(
        engine
            .agent_runs()
            .iter()
            .filter(|run| run.operation == NodeOperation::Combine)
            .count(),
        2
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_reject_retries_until_accepted() {
    if skip_without_bun("host_reject_retries_until_accepted") {
        return;
    }

    let mut engine = memory_engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("host-retry".to_string()),
        intent: "retry once".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget { max_attempts: 2 },
        script: NodeScript::Leaf {
            output: "fixed output".to_string(),
            changed_paths: Vec::new(),
            side_effects: Vec::new(),
            verdicts: vec![reject_bad_output(), VerificationVerdict::Accept],
        },
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    assert_eq!(engine.node(root).unwrap().execution_attempts, 2);
    assert_eq!(
        engine
            .attempts_for(&ProblemKey("host-retry".to_string()))
            .iter()
            .filter(|attempt| matches!(attempt.verdict, Some(VerificationVerdict::Reject { .. })))
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_uncertain_verdict_moves_node_to_waiting_for_info() {
    if skip_without_bun("host_uncertain_verdict_moves_node_to_waiting_for_info") {
        return;
    }

    let mut engine = memory_engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("host-uncertain".to_string()),
        intent: "needs post-verify info".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        script: NodeScript::Leaf {
            output: "partial output".to_string(),
            changed_paths: Vec::new(),
            side_effects: Vec::new(),
            verdicts: vec![VerificationVerdict::Uncertain {
                missing_info: "missing citation".to_string(),
                reason: "needs source".to_string(),
            }],
        },
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::WaitingForInfo);
    assert!(report.artifact.is_none());
    assert!(
        engine
            .agent_runs()
            .iter()
            .any(|run| run.operation == NodeOperation::Acquire
                && run.terminal_tool.as_deref() == Some("submit_evidence"))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_unsafe_read_only_delta_prunes_node() {
    if skip_without_bun("host_unsafe_read_only_delta_prunes_node") {
        return;
    }

    let mut engine = workspace_engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("host-read-only".to_string()),
        intent: "read only must not write".to_string(),
        workspace: WorkspaceRequirement::read_only_files(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        script: NodeScript::Leaf {
            output: "report".to_string(),
            changed_paths: vec!["development-log/report.md".to_string()],
            side_effects: Vec::new(),
            verdicts: vec![VerificationVerdict::Accept],
        },
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Pruned);
    assert!(matches!(
        engine
            .attempts_for(&ProblemKey("host-read-only".to_string()))
            .first()
            .and_then(|attempt| attempt.verdict.as_ref()),
        Some(VerificationVerdict::Reject {
            failure_class: FailureClass::UnsafeSideEffect,
            ..
        })
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_git_merge_conflict_is_given_to_agent_instead_of_pruning_parent() {
    if skip_without_bun("host_git_merge_conflict_is_given_to_agent_instead_of_pruning_parent") {
        return;
    }

    let mut engine = workspace_engine();
    let child_a = scoped_git_leaf("host-a", "patch a", "packages/client/src/api.ts");
    let child_b = scoped_git_leaf("host-b", "patch b", "packages/client/src/api.ts");
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("host-conflict".to_string()),
        intent: "combine conflicting patches".to_string(),
        workspace: WorkspaceRequirement::git(["packages/client/src/api.ts"]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        script: NodeScript::Divide {
            children: vec![child_a, child_b],
            combine_output: "combined patch".to_string(),
            verdicts: vec![VerificationVerdict::Accept],
        },
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    assert_eq!(
        engine.artifact(report.artifact.unwrap()).unwrap().text,
        "combined patch"
    );
    assert!(
        engine
            .attempts_for(&ProblemKey("host-conflict".to_string()))
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

fn scoped_git_leaf(key: &str, output: &str, path: &str) -> NodeTemplate {
    NodeTemplate {
        key: ProblemKey(key.to_string()),
        intent: key.to_string(),
        workspace: WorkspaceRequirement::git([path]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        script: NodeScript::Leaf {
            output: output.to_string(),
            changed_paths: vec![path.to_string()],
            side_effects: Vec::new(),
            verdicts: vec![VerificationVerdict::Accept],
        },
    }
}
