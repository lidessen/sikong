use siko::*;
use std::{ffi::OsStr, fs, path::Path, process::Command};

fn bun_available() -> bool {
    Command::new("bun").arg("--version").output().is_ok()
}

fn host_worker() -> ProcessAgentRunScheduler {
    ProcessAgentRunScheduler::new("bun", ["packages/agent-host/src/runtime-host.ts"])
}

fn memory_engine() -> Engine<MemoryWorkspace, ProcessAgentRunScheduler> {
    Engine::new(MemoryWorkspace::default(), host_worker())
}

fn workspace_engine() -> Engine<Workspaces, ProcessAgentRunScheduler> {
    Engine::new(Workspaces::default(), host_worker())
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
async fn host_acquire_can_rewrite_into_group_then_commit() {
    if skip_without_bun("host_acquire_can_rewrite_into_group_then_commit") {
        return;
    }

    let mut engine = memory_engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("research-plan".to_string()),
        intent: "combined findings".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::NeedsInfo {
            need: "source".to_string(),
            then: Box::new(NodePlan::Group(PlanGroup {
                mode: PlanGroupMode::Parallel,
                items: vec![
                    NodeTemplate::memory_leaf("research-a", "finding a"),
                    NodeTemplate::memory_leaf("research-b", "finding b"),
                ],
            })),
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
async fn host_nested_group_resolves_children_recursively() {
    if skip_without_bun("host_nested_group_resolves_children_recursively") {
        return;
    }

    let mut engine = memory_engine();
    let nested = NodeTemplate {
        key: ProblemKey("nested".to_string()),
        intent: "nested combined".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![
                NodeTemplate::memory_leaf("nested-a", "nested a"),
                NodeTemplate::memory_leaf("nested-b", "nested b"),
            ],
        }),
    };
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("root-group".to_string()),
        intent: "root combined".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        plan: NodePlan::Group(PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: vec![NodeTemplate::memory_leaf("top-leaf", "top"), nested],
        }),
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
            .filter(|run| run.operation == NodeOperation::Plan)
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
        plan: NodePlan::Execute,
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
        plan: NodePlan::Execute,
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
async fn host_unsafe_read_only_change_prunes_node() {
    if skip_without_bun("host_unsafe_read_only_change_prunes_node") {
        return;
    }

    let repo = TestGitRepo::new();
    repo.write("base.txt", "base\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-m", "initial"]);

    let mut engine = workspace_engine();
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("host-read-only".to_string()),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_git_workspace_surface_is_written_captured_and_cleaned() {
    if skip_without_bun("host_git_workspace_surface_is_written_captured_and_cleaned") {
        return;
    }

    let repo = TestGitRepo::new();
    repo.write("base.txt", "base\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-m", "initial"]);

    let mut engine = Engine::new(Workspaces::default(), host_worker());
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("host-git-write".to_string()),
        intent: "host writes git file".to_string(),
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
    let artifact = engine.artifact(report.artifact.unwrap()).unwrap();
    assert_eq!(artifact.text, "host writes git file");
    let change = artifact
        .workspace_change
        .as_ref()
        .expect("workspace change");
    assert_eq!(change.changed_paths, vec!["file.txt".to_string()]);
    assert!(change.git.as_ref().unwrap().commit_sha.is_some());
    assert!(
        change
            .side_effects
            .iter()
            .any(|effect| effect.starts_with("git_commit:"))
    );
    assert!(repo.worktrees().read_dir().unwrap().next().is_none());
    assert!(repo.git(["branch", "--list", "sikong/*"]).trim().is_empty());
    assert!(engine.agent_runs().iter().any(|run| {
        run.operation == NodeOperation::Execute
            && run
                .report
                .contains("tool calls read_operation_context -> submit_work")
    }));
}

fn scoped_git_leaf(key: &str, output: &str, path: &str) -> NodeTemplate {
    NodeTemplate {
        key: ProblemKey(key.to_string()),
        intent: output.to_string(),
        workspace: WorkspaceRequirement::git([path]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
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
