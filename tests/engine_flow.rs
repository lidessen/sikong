use std::{ffi::OsStr, fs, path::Path, process::Command};

use siko::*;

mod support;
use support::TestAgentRunScheduler;

fn engine() -> Engine<MemoryWorkspace, TestAgentRunScheduler> {
    Engine::new(MemoryWorkspace::default(), TestAgentRunScheduler)
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
        plan: NodePlan::NeedsInfo {
            need: "origin".to_string(),
            then: Box::new(NodePlan::Execute),
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
async fn parallel_group_resolves_children_and_combines_parent() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("design".to_string()),
        intent: "complete design".to_string(),
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
async fn stage_group_resolves_items_in_order_and_combines_parent() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("staged-design".to_string()),
        intent: "complete staged design".to_string(),
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
        .agent_runs()
        .iter()
        .position(|run| run.node_id == stage_a && run.operation == NodeOperation::Commit)
        .expect("stage a commit");
    let stage_b_spec = engine
        .agent_runs()
        .iter()
        .position(|run| run.node_id == stage_b && run.operation == NodeOperation::Specify)
        .expect("stage b specify");
    assert!(stage_a_commit < stage_b_spec);
    assert_eq!(
        engine.artifact(report.artifact.unwrap()).unwrap().text,
        "complete staged design"
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
async fn repeated_failure_prunes_after_budget() {
    let mut engine = engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("fail".to_string()),
        intent: "always bad".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget { max_attempts: 2 },
        plan: NodePlan::Execute,
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
async fn read_only_workspace_change_is_rejected() {
    let repo = TestGitRepo::new();
    repo.write("base.txt", "base\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-m", "initial"]);

    let mut engine = Engine::new(Workspaces::default(), WritingGitAgentRunScheduler);
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("read-only".to_string()),
        intent: "read only must not write".to_string(),
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
        workspace: WorkspaceRequirement::git(["packages/client/src/api.ts"]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    };
    let child_b = NodeTemplate {
        key: ProblemKey("b".to_string()),
        intent: "patch b".to_string(),
        workspace: WorkspaceRequirement::git(["packages/client/src/api.ts"]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    };
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("conflict".to_string()),
        intent: "combined patch".to_string(),
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
            };
        }

        TestAgentRunScheduler.run(input, cancellation).await
    }
}

struct TestGitRepo {
    _temp: tempfile::TempDir,
    root: std::path::PathBuf,
    worktrees: std::path::PathBuf,
}

impl TestGitRepo {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        let worktrees = temp.path().join("worktrees");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&worktrees).unwrap();
        run_git(&root, ["init"]);
        Self {
            _temp: temp,
            root,
            worktrees,
        }
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn worktrees(&self) -> &Path {
        &self.worktrees
    }

    fn write(&self, path: &str, content: &str) {
        let path = self.root.join(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn git<I, S>(&self, args: I) -> String
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        run_git(&self.root, args)
    }
}

fn run_git<I, S>(cwd: &Path, args: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new("git")
        .arg("-c")
        .arg("user.name=Sikong Test")
        .arg("-c")
        .arg("user.email=sikong-test@example.invalid")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git failed: {}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}
