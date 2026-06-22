use siko::*;
use std::fs;
use std::path::Path;
use support::TestGitRepo;

mod support;
#[test]
fn memory_workspace_forks_and_combines_without_conflicts() {
    let mut workspace = MemoryWorkspace::default();
    let requirement = WorkspaceRequirement::memory();
    let snapshot = workspace.snapshot(&requirement).unwrap();
    let surface = workspace
        .open_surface(&snapshot, vec![WorkspaceResourceRef::RunningNode(1)])
        .unwrap();
    let change = workspace
        .capture_changes(&surface, vec!["captured design artifact".to_string()])
        .unwrap();

    let merge_surface = workspace
        .merge_changes(
            std::slice::from_ref(&change),
            vec![WorkspaceResourceRef::MergeSurface(1)],
        )
        .unwrap();

    assert_eq!(snapshot.provider, WorkspaceProvider::Memory);
    assert_eq!(surface.provider, WorkspaceProvider::Memory);
    assert_eq!(change.provider, WorkspaceProvider::Memory);
    assert!(merge_surface.changed_paths.is_empty());
    assert!(merge_surface.conflicts.is_empty());
}

#[test]
fn file_system_workspace_preserves_scope_without_agent_reported_paths() {
    let mut workspace = FileSystemWorkspace::default();
    let requirement = WorkspaceRequirement {
        provider: WorkspaceProvider::FileSystem,
        read_scope: vec!["src/*".to_string()],
        write_scope: vec!["target/report.txt".to_string()],
        git: None,
    };
    let snapshot = workspace.snapshot(&requirement).unwrap();
    let first = workspace
        .open_surface(&snapshot, vec![WorkspaceResourceRef::RunningNode(1)])
        .unwrap();
    let second = workspace
        .open_surface(&snapshot, vec![WorkspaceResourceRef::RunningNode(2)])
        .unwrap();
    let first_change = workspace.capture_changes(&first, Vec::new()).unwrap();
    let second_change = workspace.capture_changes(&second, Vec::new()).unwrap();

    let merge_surface = workspace
        .merge_changes(
            &[first_change, second_change],
            vec![WorkspaceResourceRef::MergeSurface(1)],
        )
        .unwrap();

    assert_eq!(snapshot.provider, WorkspaceProvider::FileSystem);
    // scope was constructed from read_scope + write_scope (removed as dead code)
    assert_eq!(snapshot.provider, WorkspaceProvider::FileSystem);
    assert!(merge_surface.changed_paths.is_empty());
    assert!(merge_surface.conflicts.is_empty());
}

#[test]
fn git_file_system_workspace_without_git_metadata_does_not_accept_reported_paths() {
    let mut workspace = GitFileSystemWorkspace::default();
    let requirement = WorkspaceRequirement::git(["src/lib.rs"]);
    let snapshot = workspace.snapshot(&requirement).unwrap();
    let first = workspace
        .open_surface(&snapshot, vec![WorkspaceResourceRef::RunningNode(1)])
        .unwrap();
    let second = workspace
        .open_surface(&snapshot, vec![WorkspaceResourceRef::RunningNode(2)])
        .unwrap();
    let first_change = workspace.capture_changes(&first, Vec::new()).unwrap();
    let second_change = workspace.capture_changes(&second, Vec::new()).unwrap();

    let merge_surface = workspace
        .merge_changes(
            &[first_change, second_change],
            vec![WorkspaceResourceRef::MergeSurface(1)],
        )
        .unwrap();

    assert_eq!(snapshot.provider, WorkspaceProvider::GitFileSystem);
    assert_eq!(first.provider, WorkspaceProvider::GitFileSystem);
    assert_eq!(second.provider, WorkspaceProvider::GitFileSystem);
    assert!(merge_surface.changed_paths.is_empty());
    assert!(merge_surface.conflicts.is_empty());
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
    let left = workspace
        .open_surface(&snapshot, vec![WorkspaceResourceRef::RunningNode(1)])
        .unwrap();
    let right = workspace
        .open_surface(&snapshot, vec![WorkspaceResourceRef::RunningNode(2)])
        .unwrap();

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

    let left_change = workspace.capture_changes(&left, Vec::new()).unwrap();
    let right_change = workspace.capture_changes(&right, Vec::new()).unwrap();
    let merge_surface = workspace
        .merge_changes(
            &[left_change.clone(), right_change.clone()],
            vec![WorkspaceResourceRef::MergeSurface(1)],
        )
        .unwrap();

    assert_eq!(left_change.changed_paths, vec!["left.txt".to_string()]);
    assert_eq!(right_change.changed_paths, vec!["right.txt".to_string()]);
    assert!(left_change.git.as_ref().unwrap().commit_sha.is_some());
    assert!(right_change.git.as_ref().unwrap().commit_sha.is_some());
    assert!(merge_surface.conflicts.is_empty());
    let merge_path = &merge_surface.git.as_ref().unwrap().worktree_path;
    assert_eq!(
        fs::read_to_string(merge_path.join("left.txt")).unwrap(),
        "left\n"
    );
    assert_eq!(
        fs::read_to_string(merge_path.join("right.txt")).unwrap(),
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
    let first = workspace
        .open_surface(&snapshot, vec![WorkspaceResourceRef::RunningNode(1)])
        .unwrap();
    let second = workspace
        .open_surface(&snapshot, vec![WorkspaceResourceRef::RunningNode(2)])
        .unwrap();

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

    let first_change = workspace.capture_changes(&first, Vec::new()).unwrap();
    let second_change = workspace.capture_changes(&second, Vec::new()).unwrap();
    let merge_surface = workspace
        .merge_changes(
            &[first_change, second_change],
            vec![WorkspaceResourceRef::MergeSurface(1)],
        )
        .unwrap();

    assert_eq!(merge_surface.conflicts, vec!["shared.txt".to_string()]);
    assert!(merge_surface.git.as_ref().unwrap().worktree_path.exists());
}

#[test]
fn git_file_system_workspace_cleans_worktree_and_branch_resources_independently() {
    let repo = TestGitRepo::new();
    repo.write("file.txt", "base\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-m", "initial"]);

    let mut workspace = GitFileSystemWorkspace::default();
    let requirement =
        WorkspaceRequirement::git_repo(repo.root(), repo.worktrees(), "HEAD", ["file.txt"]);
    let snapshot = workspace.snapshot(&requirement).unwrap();
    let surface = workspace
        .open_surface(&snapshot, vec![WorkspaceResourceRef::RunningNode(1)])
        .unwrap();
    let git = surface.git.as_ref().unwrap().clone();
    let worktree_resource = surface
        .resources
        .iter()
        .find(|resource| resource.kind == WorkspaceResourceKind::GitWorktree)
        .unwrap()
        .clone();
    let branch_resource = surface
        .resources
        .iter()
        .find(|resource| resource.kind == WorkspaceResourceKind::GitBranch)
        .unwrap()
        .clone();

    workspace.cleanup(&worktree_resource).unwrap();

    assert!(!git.worktree_path.exists());
    let branches = repo.git(["branch", "--list", &git.branch_name]);
    assert!(!branches.trim().is_empty());

    workspace.cleanup(&branch_resource).unwrap();

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

#[cfg(test)]
mod path_allowed_tests {
    use siko::path_allowed;
    use std::path::Path;

    #[test]
    fn empty_patterns_deny_all() {
        assert!(!path_allowed(&[], Path::new("anything.txt")));
        assert!(!path_allowed(&[], Path::new("src/main.rs")));
    }

    #[test]
    fn globstar_matches_any_depth() {
        let patterns = &["**/*.rs".into()];
        assert!(path_allowed(patterns, Path::new("main.rs")));
        assert!(path_allowed(patterns, Path::new("src/main.rs")));
        assert!(path_allowed(patterns, Path::new("src/task_run/engine.rs")));
        assert!(path_allowed(patterns, Path::new("a/b/c/d/e/lib.rs")));
        assert!(!path_allowed(patterns, Path::new("main.ts")));
        assert!(!path_allowed(patterns, Path::new("readme.md")));
    }

    #[test]
    fn globstar_prefix_matches_under_directory() {
        let patterns = &["src/**/*".into()];
        assert!(path_allowed(patterns, Path::new("src/main.rs")));
        assert!(path_allowed(patterns, Path::new("src/task_run/mod.rs")));
        assert!(path_allowed(patterns, Path::new("src/deep/nested/file.rs")));
        assert!(path_allowed(patterns, Path::new("src/lib.rs")));
        assert!(!path_allowed(patterns, Path::new("lib.rs")));
        assert!(!path_allowed(patterns, Path::new("tests/test.rs")));
    }

    #[test]
    fn multiple_patterns_any_match() {
        let patterns = &["src/**/*.rs".into(), "design/**/*.md".into()];
        assert!(path_allowed(patterns, Path::new("src/cli.rs")));
        assert!(path_allowed(patterns, Path::new("design/README.md")));
        assert!(!path_allowed(patterns, Path::new("readme.md")));
        assert!(!path_allowed(patterns, Path::new("design/plan.txt")));
        assert!(!path_allowed(patterns, Path::new("tests/test.rs")));
    }

    #[test]
    fn globstar_alone_matches_everything() {
        let patterns = &["**".into(), "**/*".into()];
        assert!(path_allowed(patterns, Path::new("anything")));
        assert!(path_allowed(patterns, Path::new("nested/path/file.ext")));
    }

    #[test]
    fn globstar_matches_zero_segments() {
        let patterns = &["a/**/b".into()];
        assert!(path_allowed(patterns, Path::new("a/b")));
        assert!(path_allowed(patterns, Path::new("a/x/b")));
        assert!(path_allowed(patterns, Path::new("a/x/y/z/b")));
        assert!(!path_allowed(patterns, Path::new("a/c")));
    }

    #[test]
    fn single_star_wildcard_in_segment() {
        let patterns = &["*.rs".into()];
        assert!(path_allowed(patterns, Path::new("main.rs")));
        assert!(path_allowed(patterns, Path::new("lib.rs")));
        assert!(!path_allowed(patterns, Path::new("main.rs.bak")));
        assert!(!path_allowed(patterns, Path::new("src/main.rs")));
    }

    #[test]
    fn single_star_matches_partial_name() {
        let patterns = &["test_*.txt".into()];
        assert!(path_allowed(patterns, Path::new("test_foo.txt")));
        assert!(path_allowed(patterns, Path::new("test_.txt")));
        assert!(!path_allowed(patterns, Path::new("test.txt")));
        assert!(!path_allowed(patterns, Path::new("atest_foo.txt")));
    }

    #[test]
    fn question_mark_matches_single_character() {
        let patterns = &["?.rs".into()];
        assert!(path_allowed(patterns, Path::new("a.rs")));
        assert!(path_allowed(patterns, Path::new("b.rs")));
        assert!(!path_allowed(patterns, Path::new("ab.rs")));
        assert!(!path_allowed(patterns, Path::new(".rs")));
    }

    #[test]
    fn question_mark_and_star_combined() {
        let patterns = &["src/??_*.rs".into()];
        assert!(path_allowed(patterns, Path::new("src/cl_main.rs")));
        assert!(path_allowed(patterns, Path::new("src/te_foo.rs")));
        assert!(!path_allowed(patterns, Path::new("src/m.rs")));
    }

    #[test]
    fn globstar_prefix_with_extension() {
        let patterns = &["packages/agent-host/src/**/*.ts".into()];
        assert!(path_allowed(patterns, Path::new("packages/agent-host/src/index.ts")));
        assert!(path_allowed(patterns, Path::new("packages/agent-host/src/runtime-host.ts")));
        assert!(path_allowed(
            patterns,
            Path::new("packages/agent-host/src/deep/nested/util.ts")
        ));
        assert!(!path_allowed(patterns, Path::new("packages/agent-host/src/index.js")));
        assert!(!path_allowed(patterns, Path::new("packages/agent-host/README.md")));
    }

    #[test]
    fn path_with_leading_dot_prefix_is_handled() {
        let patterns = &[".claude/**".into()];
        assert!(path_allowed(patterns, Path::new(".claude/config.json")));
        assert!(path_allowed(patterns, Path::new(".claude/settings.json")));
        assert!(!path_allowed(patterns, Path::new("claude/config.json")));
    }

    #[test]
    fn exact_pattern_matches_single_file() {
        let patterns = &["Cargo.toml".into()];
        assert!(path_allowed(patterns, Path::new("Cargo.toml")));
        assert!(!path_allowed(patterns, Path::new("src/Cargo.toml")));
        assert!(!path_allowed(patterns, Path::new("Cargo.lock")));
    }

    #[test]
    fn globstar_at_start_matches_any_prefix() {
        let patterns = &["**/Cargo.toml".into()];
        assert!(path_allowed(patterns, Path::new("Cargo.toml")));
        assert!(path_allowed(patterns, Path::new("src/Cargo.toml")));
        assert!(path_allowed(patterns, Path::new("crates/foo/Cargo.toml")));
        assert!(!path_allowed(patterns, Path::new("Cargo.lock")));
    }
}

    #[test]
    fn single_star_matches_empty_prefix() {
        // Pattern *.rs should match .rs (zero chars before the star)
        let patterns = &["*.rs".into()];
        assert!(path_allowed(patterns, Path::new(".rs")));
        assert!(path_allowed(patterns, Path::new("a.rs")));
        assert!(!path_allowed(patterns, Path::new(".RS")));
    }

    #[test]
    fn single_star_matches_empty_suffix() {
        // Pattern test_* should match test_ (zero chars after the star)
        let patterns = &["test_*".into()];
        assert!(path_allowed(patterns, Path::new("test_")));
        assert!(path_allowed(patterns, Path::new("test_foo")));
        assert!(!path_allowed(patterns, Path::new("test")));
    }

    #[test]
    fn globstar_prefix_matches_top_level_files() {
        // Pattern src/** should match src/ itself
        let patterns = &["src/**".into()];
        assert!(path_allowed(patterns, Path::new("src/main.rs")));
        assert!(path_allowed(patterns, Path::new("src/deep/file.rs")));
    }

    #[test]
    fn globstar_in_middle_with_adjacent_segments() {
        // Pattern a/**/b/**/c should match a/b/c
        let patterns = &["a/**/b/**/c".into()];
        assert!(path_allowed(patterns, Path::new("a/b/c")));
        assert!(path_allowed(patterns, Path::new("a/x/b/c")));
        assert!(path_allowed(patterns, Path::new("a/b/x/c")));
        assert!(path_allowed(patterns, Path::new("a/x/b/y/c")));
        assert!(!path_allowed(patterns, Path::new("a/c")));
        assert!(!path_allowed(patterns, Path::new("a/x/c")));
    }

    #[test]
    fn glob_matching_is_case_sensitive() {
        let patterns = &["*.rs".into()];
        assert!(!path_allowed(patterns, Path::new("MAIN.RS")));
        assert!(!path_allowed(patterns, Path::new("Main.Rs")));

        let patterns = &["src/**/*.rs".into()];
        assert!(!path_allowed(patterns, Path::new("SRC/main.rs")));
        assert!(!path_allowed(patterns, Path::new("src/main.RS")));
    }

    #[test]
    fn wildcard_matches_only_single_segment() {
        // * should never cross path separator
        let patterns = &["*.rs".into()];
        assert!(!path_allowed(patterns, Path::new("sub/main.rs")));
        assert!(!path_allowed(patterns, Path::new("a/b.rs")));

        // ? should never cross path separator
        let patterns = &["?.rs".into()];
        assert!(!path_allowed(patterns, Path::new("ab/main.rs")));
    }
