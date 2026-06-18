use siko::*;

mod support;
use support::TestAgentWorker;

fn engine() -> Engine<MemoryWorkspace, TestAgentWorker> {
    Engine::new(MemoryWorkspace::default(), TestAgentWorker)
}

fn reject_bad_output() -> VerificationVerdict {
    VerificationVerdict::Reject {
        failure_class: FailureClass::BadOutput,
        reason: "bad output".to_string(),
    }
}

#[tokio::test]
async fn simple_leaf_executes_verifies_and_commits() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate::memory_leaf("polish", "polished text"));

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    let artifact = engine.artifact(report.artifact.unwrap()).unwrap();
    assert_eq!(artifact.text, "polished text");
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
            NodeOperation::Commit,
        ]
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

#[tokio::test]
async fn acquire_rewrites_node_then_executes() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("trip".to_string()),
        intent: "plan trip".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        script: NodeScript::NeedsInfo {
            need: "origin".to_string(),
            acquired: "SHA".to_string(),
            then: Box::new(NodeScript::Leaf {
                output: "itinerary from SHA".to_string(),
                changed_paths: Vec::new(),
                side_effects: Vec::new(),
                verdicts: vec![VerificationVerdict::Accept],
            }),
        },
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Committed);
    assert_eq!(engine.node(root).unwrap().acquired, vec!["origin=1"]);
    assert!(
        engine
            .events()
            .iter()
            .any(|event| event.operation == NodeOperation::Acquire)
    );
}

#[tokio::test]
async fn divide_resolves_children_and_combines_parent() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("design".to_string()),
        intent: "design engine".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        script: NodeScript::Divide {
            children: vec![
                NodeTemplate::memory_leaf("state-machine", "state design"),
                NodeTemplate::memory_leaf("data-model", "data model"),
            ],
            combine_output: "complete design".to_string(),
            verdicts: vec![VerificationVerdict::Accept],
        },
    });

    let report = engine.run(root).await.unwrap();

    let artifact = engine.artifact(report.artifact.unwrap()).unwrap();
    assert_eq!(artifact.kind, ArtifactKind::Combined);
    assert_eq!(artifact.children.len(), 2);
    assert_eq!(artifact.text, "complete design");
    assert_eq!(engine.node(root).unwrap().children.len(), 2);
    assert!(
        engine
            .agent_runs()
            .iter()
            .any(|run| run.node_id == root && run.operation == NodeOperation::Divide)
    );
    assert!(
        engine
            .agent_runs()
            .iter()
            .any(|run| run.node_id == root && run.operation == NodeOperation::Combine)
    );
}

#[tokio::test]
async fn verify_reject_retries_leaf_until_accept() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("retry".to_string()),
        intent: "retry once".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget { max_attempts: 2 },
        script: NodeScript::Leaf {
            output: "eventual output".to_string(),
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
            .attempts_for(&ProblemKey("retry".to_string()))
            .iter()
            .filter(|attempt| attempt.operation == NodeOperation::Verify)
            .count(),
        2
    );
}

#[tokio::test]
async fn repeated_failure_prunes_after_budget() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("fail".to_string()),
        intent: "fail".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget { max_attempts: 2 },
        script: NodeScript::Leaf {
            output: "bad".to_string(),
            changed_paths: Vec::new(),
            side_effects: Vec::new(),
            verdicts: vec![reject_bad_output(), reject_bad_output()],
        },
    });

    let report = engine.run(root).await.unwrap();

    assert_eq!(report.status, NodeStatus::Pruned);
    assert!(report.artifact.is_none());
    assert_eq!(engine.node(root).unwrap().execution_attempts, 2);
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
async fn read_only_workspace_delta_is_rejected() {
    let mut engine = Engine::new(Workspaces::default(), TestAgentWorker);
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("read-only".to_string()),
        intent: "read only".to_string(),
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
    let mut engine = Engine::new(Workspaces::default(), TestAgentWorker);
    let child_a = NodeTemplate {
        key: ProblemKey("a".to_string()),
        intent: "edit api a".to_string(),
        workspace: WorkspaceRequirement::git(["packages/client/src/api.ts"]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        script: NodeScript::Leaf {
            output: "patch a".to_string(),
            changed_paths: vec!["packages/client/src/api.ts".to_string()],
            side_effects: Vec::new(),
            verdicts: vec![VerificationVerdict::Accept],
        },
    };
    let child_b = NodeTemplate {
        key: ProblemKey("b".to_string()),
        intent: "edit api b".to_string(),
        workspace: WorkspaceRequirement::git(["packages/client/src/api.ts"]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        script: NodeScript::Leaf {
            output: "patch b".to_string(),
            changed_paths: vec!["packages/client/src/api.ts".to_string()],
            side_effects: Vec::new(),
            verdicts: vec![VerificationVerdict::Accept],
        },
    };
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("conflict".to_string()),
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
