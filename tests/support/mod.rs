use std::{
    ffi::OsStr,
    fs,
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
};

use serde_json::{Value, json};
use siko::*;

#[derive(Debug, Clone, Default)]
pub struct TestAgentRunScheduler;

#[async_trait::async_trait]
impl AgentRunScheduler for TestAgentRunScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        _cancellation: CancellationToken,
    ) -> AgentRunResponse {
        let terminal_call = input
            .tools
            .iter()
            .find(|tool| input.terminal_tool_set.contains(&tool.name))
            .map(|tool| AgentToolCall {
                name: tool.name.clone(),
                arguments: mock_terminal_arguments(&input, &tool.name),
            });

        AgentRunResponse {
            report: format!("test agent worker completed {}", input.objective),
            tool_calls: terminal_call.clone().into_iter().collect(),
            terminal_call,
            usage: None,
            events: Vec::new(),
        }
    }
}

fn mock_terminal_arguments(input: &AgentRunRequest, tool_name: &str) -> Value {
    let plan = input
        .input
        .get("plan")
        .cloned()
        .and_then(|value| serde_json::from_value::<NodePlan>(value).ok());
    let node = input
        .input
        .get("node")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let intent = node
        .get("intent")
        .and_then(Value::as_str)
        .unwrap_or("mock output");

    match tool_name {
        "submit_specification" => mock_specification_args(intent, plan.as_ref()),
        "submit_plan_group" => match plan {
            Some(NodePlan::Group(group)) => json!({
                "mode": group.mode,
                "items": group.items.into_iter().map(|item| {
                    json!({
                        "key": item.key.0,
                        "intent": item.intent,
                        "read_scope": item.workspace.read_scope,
                        "write_scope": item.workspace.write_scope,
                        "size": item.size,
                        "reason": item.scope_assessment.as_ref().map(|assessment| assessment.reason.clone()),
                        "requires_prior_results": false,
                    })
                }).collect::<Vec<_>>(),
            }),
            _ => json!({
                "mode": PlanGroupMode::Parallel,
                "items": Vec::<NodeTemplate>::new(),
            }),
        },
        "submit_work" => json!({
            "output": intent,
        }),
        "submit_combination" => json!({
            "output": intent,
        }),
        "submit_verdict" => {
            let attempt = input
                .input
                .pointer("/node/verification_attempts")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize;
            verdict_arguments(verdict_for(intent, attempt))
        }
        _ => json!({}),
    }
}

fn mock_specification_args(intent: &str, plan: Option<&NodePlan>) -> Value {
    match plan {
        Some(NodePlan::Group(_)) | Some(NodePlan::NeedsPlanning) => json!({
            "next": intent,
            "size": "large",
            "reason": "This is closest to Large because the fixture already contains multiple child work items."
        }),
        _ => json!({
            "next": intent,
            "size": "small",
            "reason": "This is closest to Small because the test scheduler mirrors one local node with one terminal path."
        }),
    }
}

fn verdict_for(intent: &str, attempt: usize) -> VerificationVerdict {
    if intent.contains("always bad") {
        return VerificationVerdict::Reject {
            failure_class: FailureClass::BadOutput,
            reason: "bad output".to_string(),
        };
    }
    if intent.contains("missing-info reject") {
        return VerificationVerdict::Reject {
            failure_class: FailureClass::MissingInfo,
            reason: "missing source evidence".to_string(),
        };
    }
    if intent.contains("retry once") && attempt == 0 {
        return VerificationVerdict::Reject {
            failure_class: FailureClass::BadOutput,
            reason: "bad output".to_string(),
        };
    }
    if intent.contains("needs post-verify info") {
        return VerificationVerdict::Uncertain {
            missing_info: "missing citation".to_string(),
            reason: "needs source".to_string(),
        };
    }
    VerificationVerdict::Accept
}

fn verdict_arguments(verdict: VerificationVerdict) -> Value {
    match verdict {
        VerificationVerdict::Accept => json!({
            "verdict": "accept",
            "reason": "mock accepted",
        }),
        VerificationVerdict::Reject {
            failure_class,
            reason,
        } => json!({
            "verdict": "reject",
            "reason": reason,
            "failure_class": failure_class,
        }),
        VerificationVerdict::Uncertain {
            missing_info,
            reason,
        } => json!({
            "verdict": "need_information",
            "reason": reason,
            "missing_info": missing_info,
        }),
    }
}

#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub struct RecordingAgentRunScheduler {
    requests: Arc<Mutex<Vec<AgentRunRequest>>>,
}

#[allow(dead_code)]
impl RecordingAgentRunScheduler {
    pub fn requests(&self) -> Vec<AgentRunRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl AgentRunScheduler for RecordingAgentRunScheduler {
    async fn run(
        &mut self,
        input: AgentRunRequest,
        cancellation: CancellationToken,
    ) -> AgentRunResponse {
        self.requests.lock().unwrap().push(input.clone());
        TestAgentRunScheduler.run(input, cancellation).await
    }
}

// ---------------------------------------------------------------------------
// Shared test helpers extracted from duplicated definitions in test files
// ---------------------------------------------------------------------------

/// A temporary git repository for integration tests.
pub struct TestGitRepo {
    _temp: tempfile::TempDir,
    root: std::path::PathBuf,
    worktrees: std::path::PathBuf,
}

impl TestGitRepo {
    pub fn new() -> Self {
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

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn worktrees(&self) -> &Path {
        &self.worktrees
    }

    pub fn write(&self, path: &str, content: &str) {
        let path = self.root.join(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    pub fn git<I, S>(&self, args: I) -> String
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

/// Check if the `bun` runtime is available on the system.
pub fn bun_available() -> bool {
    Command::new("bun").arg("--version").output().is_ok()
}

/// Skip a test (return true) if `bun` is not available.
pub fn skip_without_bun(test_name: &str) -> bool {
    if bun_available() {
        return false;
    }
    eprintln!("skipping {test_name}: bun not found");
    true
}

/// Create a leaf `NodeTemplate` with a git workspace scoped to the given path.
pub fn scoped_git_leaf(key: &str, output: &str, path: &str) -> NodeTemplate {
    NodeTemplate {
        key: ProblemKey(key.to_string()),
        intent: output.to_string(),
        size: WorkSize::Small,
        scope_assessment: None,
        workspace: WorkspaceRequirement::git([path]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        plan: NodePlan::Execute,
    }
}
