use siko::*;
use std::{ffi::OsStr, fs, path::Path, process::Command};

#[test]
fn memory_workspace_forks_and_combines_without_conflicts() {
    let mut workspace = MemoryWorkspace::default();
    let requirement = WorkspaceRequirement::memory();
    let snapshot = workspace.snapshot(&requirement).unwrap();
    let instance = workspace.fork(&snapshot).unwrap();
    let delta = workspace
        .collect_delta(
            &instance,
            Vec::new(),
            vec!["captured design artifact".to_string()],
        )
        .unwrap();

    let integration = workspace.combine(std::slice::from_ref(&delta)).unwrap();

    assert_eq!(snapshot.provider, WorkspaceProvider::Memory);
    assert_eq!(instance.provider, WorkspaceProvider::Memory);
    assert_eq!(delta.provider, WorkspaceProvider::Memory);
    assert_eq!(integration.deltas, vec![delta.id]);
    assert!(integration.changed_paths.is_empty());
    assert!(integration.conflicts.is_empty());
}

#[test]
fn file_system_workspace_preserves_scope_and_does_not_merge_conflict_duplicate_paths() {
    let mut workspace = FileSystemWorkspace::default();
    let requirement = WorkspaceRequirement {
        provider: WorkspaceProvider::FileSystem,
        read_scope: vec!["src/*".to_string()],
        write_scope: vec!["target/report.txt".to_string()],
        git: None,
    };
    let snapshot = workspace.snapshot(&requirement).unwrap();
    let first = workspace.fork(&snapshot).unwrap();
    let second = workspace.fork(&snapshot).unwrap();
    let first_delta = workspace
        .collect_delta(&first, vec!["target/report.txt".to_string()], Vec::new())
        .unwrap();
    let second_delta = workspace
        .collect_delta(&second, vec!["target/report.txt".to_string()], Vec::new())
        .unwrap();

    let integration = workspace.combine(&[first_delta, second_delta]).unwrap();

    assert_eq!(snapshot.provider, WorkspaceProvider::FileSystem);
    assert_eq!(
        snapshot.scope,
        vec!["src/*".to_string(), "target/report.txt".to_string()]
    );
    assert_eq!(
        integration.changed_paths,
        vec![
            "target/report.txt".to_string(),
            "target/report.txt".to_string()
        ]
    );
    assert!(integration.conflicts.is_empty());
}

#[test]
fn git_file_system_workspace_reports_duplicate_path_conflicts() {
    let mut workspace = GitFileSystemWorkspace::default();
    let requirement = WorkspaceRequirement::git(["src/lib.rs"]);
    let snapshot = workspace.snapshot(&requirement).unwrap();
    let first = workspace.fork(&snapshot).unwrap();
    let second = workspace.fork(&snapshot).unwrap();
    let first_delta = workspace
        .collect_delta(&first, vec!["src/lib.rs".to_string()], Vec::new())
        .unwrap();
    let second_delta = workspace
        .collect_delta(&second, vec!["src/lib.rs".to_string()], Vec::new())
        .unwrap();

    let integration = workspace.combine(&[first_delta, second_delta]).unwrap();

    assert_eq!(snapshot.provider, WorkspaceProvider::GitFileSystem);
    assert_eq!(first.provider, WorkspaceProvider::GitFileSystem);
    assert_eq!(second.provider, WorkspaceProvider::GitFileSystem);
    assert_eq!(integration.conflicts, vec!["src/lib.rs".to_string()]);
}

#[test]
fn git_file_system_workspace_commits_and_combines_real_worktrees() {
    let repo = TestGitRepo::new();
    repo.write("shared.txt", "base\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-m", "initial"]);

    let mut workspace = GitFileSystemWorkspace::default();
    let requirement = WorkspaceRequirement::git_repo(
        repo.root(),
        repo.worktrees(),
        "HEAD",
        ["left.txt", "right.txt"],
    );
    let snapshot = workspace.snapshot(&requirement).unwrap();
    let left = workspace.fork(&snapshot).unwrap();
    let right = workspace.fork(&snapshot).unwrap();

    fs::write(
        left.git.as_ref().unwrap().worktree_path.join("left.txt"),
        "left\n",
    )
    .unwrap();
    fs::write(
        right.git.as_ref().unwrap().worktree_path.join("right.txt"),
        "right\n",
    )
    .unwrap();

    let left_delta = workspace
        .collect_delta(&left, Vec::new(), Vec::new())
        .unwrap();
    let right_delta = workspace
        .collect_delta(&right, Vec::new(), Vec::new())
        .unwrap();
    let integration = workspace
        .combine(&[left_delta.clone(), right_delta.clone()])
        .unwrap();

    assert_eq!(left_delta.changed_paths, vec!["left.txt".to_string()]);
    assert_eq!(right_delta.changed_paths, vec!["right.txt".to_string()]);
    assert!(left_delta.git.as_ref().unwrap().commit_sha.is_some());
    assert!(right_delta.git.as_ref().unwrap().commit_sha.is_some());
    assert!(integration.conflicts.is_empty());
    let integration_path = &integration.git.as_ref().unwrap().worktree_path;
    assert_eq!(
        fs::read_to_string(integration_path.join("left.txt")).unwrap(),
        "left\n"
    );
    assert_eq!(
        fs::read_to_string(integration_path.join("right.txt")).unwrap(),
        "right\n"
    );
}

#[test]
fn git_file_system_workspace_reports_real_merge_conflicts() {
    let repo = TestGitRepo::new();
    repo.write("shared.txt", "base\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-m", "initial"]);

    let mut workspace = GitFileSystemWorkspace::default();
    let requirement =
        WorkspaceRequirement::git_repo(repo.root(), repo.worktrees(), "HEAD", ["shared.txt"]);
    let snapshot = workspace.snapshot(&requirement).unwrap();
    let first = workspace.fork(&snapshot).unwrap();
    let second = workspace.fork(&snapshot).unwrap();

    fs::write(
        first.git.as_ref().unwrap().worktree_path.join("shared.txt"),
        "first\n",
    )
    .unwrap();
    fs::write(
        second
            .git
            .as_ref()
            .unwrap()
            .worktree_path
            .join("shared.txt"),
        "second\n",
    )
    .unwrap();

    let first_delta = workspace
        .collect_delta(&first, Vec::new(), Vec::new())
        .unwrap();
    let second_delta = workspace
        .collect_delta(&second, Vec::new(), Vec::new())
        .unwrap();
    let integration = workspace.combine(&[first_delta, second_delta]).unwrap();

    assert_eq!(integration.conflicts, vec!["shared.txt".to_string()]);
    assert!(integration.git.as_ref().unwrap().worktree_path.exists());
}

#[test]
fn git_file_system_workspace_removes_worktree_and_branch() {
    let repo = TestGitRepo::new();
    repo.write("file.txt", "base\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-m", "initial"]);

    let mut workspace = GitFileSystemWorkspace::default();
    let requirement =
        WorkspaceRequirement::git_repo(repo.root(), repo.worktrees(), "HEAD", ["file.txt"]);
    let snapshot = workspace.snapshot(&requirement).unwrap();
    let instance = workspace.fork(&snapshot).unwrap();
    let git = instance.git.as_ref().unwrap().clone();

    workspace.dispose_instance(&instance).unwrap();

    assert!(!git.worktree_path.exists());
    let branches = repo.git(["branch", "--list", &git.branch_name]);
    assert!(branches.trim().is_empty());
}

#[test]
fn git_file_system_workspace_returns_error_for_invalid_repo() {
    let temp = tempfile::tempdir().unwrap();
    let mut workspace = GitFileSystemWorkspace::default();
    let requirement = WorkspaceRequirement::git_repo(
        temp.path(),
        temp.path().join("worktrees"),
        "HEAD",
        ["file.txt"],
    );

    let error = workspace.snapshot(&requirement).unwrap_err();

    assert!(matches!(error, WorkspaceError::GitCommand { .. }));
}

#[test]
fn workspaces_route_by_requirement_provider() {
    let mut providers = Workspaces::default();
    let memory = providers.snapshot(&WorkspaceRequirement::memory()).unwrap();
    let files = providers
        .snapshot(&WorkspaceRequirement::read_only_files())
        .unwrap();
    let git = providers
        .snapshot(&WorkspaceRequirement::git(["src/lib.rs"]))
        .unwrap();

    assert_eq!(memory.provider, WorkspaceProvider::Memory);
    assert_eq!(files.provider, WorkspaceProvider::FileSystem);
    assert_eq!(git.provider, WorkspaceProvider::GitFileSystem);
    assert_eq!(memory.id, 1);
    assert_eq!(files.id, 2);
    assert_eq!(git.id, 3);
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
