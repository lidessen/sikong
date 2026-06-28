//! CLI integration tests for the `siko` binary.
//!
//! These tests invoke the compiled binary via `std::process::Command` and
//! assert properties of its stdout/stderr output.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use siko::{AssistantTaskEventRecord, AssistantTaskStatus, FileTaskStore, TaskStore};
use tracing::Level;

struct TempSikoData {
    dir: tempfile::TempDir,
    binary: PathBuf,
}

impl TempSikoData {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("temp data dir"),
            binary: siko_binary(),
        }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(&self.binary)
            .args(args)
            .env("SIKONG_DATA_DIR", self.path())
            .output()
            .expect("failed to run siko binary")
    }

    fn spawn(&self, args: &[&str]) -> std::process::Child {
        Command::new(&self.binary)
            .args(args)
            .env("SIKONG_DATA_DIR", self.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn siko binary")
    }
}

impl Drop for TempSikoData {
    fn drop(&mut self) {
        let _ = Command::new(&self.binary)
            .args(["daemon", "stop"])
            .env("SIKONG_DATA_DIR", self.path())
            .output();
    }
}

/// Helper: run `siko <args>` and return (stdout, stderr, exit_code).
fn run_siko(args: &[&str]) -> (String, String, i32) {
    output_parts(
        Command::new(siko_binary())
            .args(args)
            .output()
            .expect("failed to run siko binary"),
    )
}

fn siko_binary() -> PathBuf {
    std::env::current_exe()
        .ok()
        .map(|p| p.parent().unwrap().parent().unwrap().join("siko"))
        .unwrap_or_else(path_buf_from_env_var)
}

fn output_parts(output: Output) -> (String, String, i32) {
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);
    (stdout, stderr, exit_code)
}

fn path_buf_from_env_var() -> std::path::PathBuf {
    // Fallback: assume `siko` is on PATH
    std::path::PathBuf::from("siko")
}

#[test]
fn test_metrics_command_produces_valid_json() {
    let (stdout, stderr, code) = run_siko(&["metrics"]);

    assert!(
        stderr.is_empty() || stderr.contains("warning:"),
        "stderr should be empty or only contain warnings; got: {stderr}"
    );
    assert_eq!(code, 0, "siko metrics should exit with code 0");

    // Must be valid JSON
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("siko metrics output must be valid JSON");

    // Must contain expected top-level keys from MetricsFormatter
    assert!(
        parsed
            .as_object()
            .map(|obj| obj.contains_key("counters"))
            .unwrap_or(false),
        "output must contain 'counters' key"
    );
    assert!(
        parsed
            .as_object()
            .map(|obj| obj.contains_key("timings"))
            .unwrap_or(false),
        "output must contain 'timings' key"
    );
    assert!(
        parsed
            .as_object()
            .map(|obj| obj.contains_key("costs"))
            .unwrap_or(false),
        "output must contain 'costs' key"
    );

    // Should have some data populated (we added uptime_seconds counter)
    let counters = parsed["counters"].as_object().unwrap();
    assert!(!counters.is_empty(), "counters should not be empty");

    // Should have the uptime_seconds counter we added
    assert!(
        counters.contains_key("uptime_seconds"),
        "counters should contain 'uptime_seconds'"
    );

    // Output should be pretty-printed (contain newlines)
    assert!(
        stdout.contains('\n'),
        "expected pretty-printed JSON with newlines"
    );
}

#[test]
fn test_metrics_command_accepts_help_flag() {
    let (stdout, stderr, code) = run_siko(&["metrics", "--help"]);

    eprint!("{}", stderr);
    assert_eq!(code, 0, "siko metrics --help should exit with code 0");
    assert!(stdout.contains("metrics"), "help should mention 'metrics'");
}

#[test]
fn test_run_command_help_mentions_allow_write() {
    let (stdout, stderr, code) = run_siko(&["send", "--help"]);

    eprint!("{}", stderr);
    assert_eq!(code, 0, "siko send --help should exit with code 0");
    assert!(
        stdout.contains("allow-write"),
        "help should mention '--allow-write' flag; got: {stdout}"
    );
    assert!(
        stdout.contains("modify files"),
        "help description should mention file modification; got: {stdout}"
    );
}

#[test]
fn top_level_help_exposes_daily_entrypoints() {
    let (stdout, stderr, code) = run_siko(&["--help"]);

    eprint!("{}", stderr);
    assert_eq!(code, 0, "siko --help should exit with code 0");
    for command in ["send", "task", "tui", "acp", "daemon"] {
        assert!(
            stdout.contains(command),
            "top-level help should expose {command}; got: {stdout}"
        );
    }
}

#[test]
fn send_auto_starts_daemon_and_task_surfaces_read_created_task() {
    let env = TempSikoData::new();

    let initial = env.run(&["daemon", "--json", "status"]);
    let (stdout, stderr, code) = output_parts(initial);
    assert_eq!(
        code, 1,
        "fresh temp daemon should be stopped; stdout={stdout} stderr={stderr}"
    );
    let initial_json: serde_json::Value =
        serde_json::from_str(&stdout).expect("daemon status should print JSON");
    assert_eq!(initial_json["data"]["running"], false);

    let send = env.run(&[
        "send",
        "--wait-ms",
        "0",
        "--json",
        "--no-allow-write",
        "Sikong CLI smoke task: verify send creates a durable task.",
    ]);
    let (stdout, stderr, code) = output_parts(send);
    assert_eq!(
        code, 0,
        "send should succeed; stdout={stdout} stderr={stderr}"
    );
    let send_json: serde_json::Value =
        serde_json::from_str(&stdout).expect("send should print JSON");
    let task_id = send_json["task_id"]
        .as_str()
        .expect("send JSON should include task_id")
        .to_string();
    assert!(!task_id.is_empty(), "task id should not be empty");

    let status = env.run(&["daemon", "--json", "status"]);
    let (stdout, stderr, code) = output_parts(status);
    assert_eq!(
        code, 0,
        "daemon should be running after send; stdout={stdout} stderr={stderr}"
    );
    let status_json: serde_json::Value =
        serde_json::from_str(&stdout).expect("daemon status should print JSON");
    assert_eq!(status_json["data"]["running"], true);

    let list = env.run(&["task", "list", "--json"]);
    let (stdout, stderr, code) = output_parts(list);
    assert_eq!(
        code, 0,
        "task list should succeed; stdout={stdout} stderr={stderr}"
    );
    let tasks: serde_json::Value = serde_json::from_str(&stdout).expect("task list JSON");
    assert_eq!(tasks.as_array().map(Vec::len), Some(1));
    assert_eq!(tasks[0]["id"], task_id);

    let show = env.run(&["task", "show", &task_id, "--json"]);
    let (stdout, stderr, code) = output_parts(show);
    assert_eq!(
        code, 0,
        "task show should succeed; stdout={stdout} stderr={stderr}"
    );
    let shown: serde_json::Value = serde_json::from_str(&stdout).expect("task show JSON");
    assert_eq!(shown["id"], task_id);
    assert!(shown["events"].as_array().is_some_and(|events| {
        events
            .iter()
            .any(|event| event["kind"].as_str() == Some("task.created"))
    }));

    let events = env.run(&["task", "events", &task_id, "--json"]);
    let (stdout, stderr, code) = output_parts(events);
    assert_eq!(
        code, 0,
        "task events should succeed; stdout={stdout} stderr={stderr}"
    );
    let events_json: serde_json::Value = serde_json::from_str(&stdout).expect("task events JSON");
    assert!(
        events_json.as_array().is_some_and(|events| {
            events
                .iter()
                .any(|event| event["event"]["kind"].as_str() == Some("task.created"))
        }),
        "events should include task.created; got: {events_json}"
    );
}

#[test]
fn task_inspect_replays_completed_task_without_following() {
    let env = TempSikoData::new();
    let store_path = env.path().join("assistant").join("tasks.json");
    let mut store = FileTaskStore::open(&store_path).expect("open task store");
    let task_id = store.create_task("completed inspect smoke".to_string());
    store.record_task_event(
        &task_id,
        AssistantTaskEventRecord {
            level: Level::INFO,
            kind: "task.smoke".to_string(),
            source: "cli.test".to_string(),
            message: "inspect can replay completed records".to_string(),
            node_id: None,
            operation: None,
            payload: serde_json::json!({"surface": "task.inspect"}),
        },
    );
    store.set_task_status(&task_id, AssistantTaskStatus::Completed);
    drop(store);

    let inspect = env.run(&[
        "task",
        "inspect",
        &task_id,
        "--json",
        "--interval-ms",
        "100",
    ]);
    let (stdout, stderr, code) = output_parts(inspect);
    assert_eq!(
        code, 0,
        "task inspect should exit for completed task; stdout={stdout} stderr={stderr}"
    );

    let records = stdout
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("inspect JSONL record"))
        .collect::<Vec<_>>();
    assert!(records.iter().any(|record| {
        record["type"].as_str() == Some("task_status")
            && record["status"].as_str() == Some("Completed")
    }));
    assert!(records.iter().any(|record| {
        record["type"].as_str() == Some("task_event")
            && record["event"]["kind"].as_str() == Some("task.smoke")
    }));
}

#[test]
fn acp_stdio_initializes_session_through_binary_entrypoint() {
    let env = TempSikoData::new();
    let mut child = env.spawn(&["acp"]);
    {
        let stdin = child.stdin.as_mut().expect("child stdin");
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{}}}}"#
        )
        .unwrap();
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":2,"method":"session/new","params":{{}}}}"#
        )
        .unwrap();
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("wait for acp process");
    let (stdout, stderr, code) = output_parts(output);
    assert_eq!(
        code, 0,
        "acp process should exit cleanly; stdout={stdout} stderr={stderr}"
    );
    assert!(
        stdout.contains(r#""id":1"#),
        "missing initialize response: {stdout}"
    );
    assert!(
        stdout.contains(r#""id":2"#),
        "missing session response: {stdout}"
    );
    assert!(stdout.contains("sessionId"), "missing session id: {stdout}");
}
