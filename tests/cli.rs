//! CLI integration tests for the `siko` binary.
//!
//! These tests invoke the compiled binary via `std::process::Command` and
//! assert properties of its stdout/stderr output.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

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
        self.spawn_with_env(args, &[])
    }

    fn spawn_with_env(&self, args: &[&str], env: &[(&str, &str)]) -> std::process::Child {
        let mut command = Command::new(&self.binary);
        command
            .args(args)
            .env("SIKONG_DATA_DIR", self.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in env {
            command.env(key, value);
        }
        command.spawn().expect("failed to spawn siko binary")
    }
}

fn wait_with_timeout(mut child: std::process::Child, timeout: Duration) -> Output {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if child.try_wait().expect("poll child process").is_some() {
            return child.wait_with_output().expect("wait for child process");
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    let _ = child.kill();
    let output = child.wait_with_output().expect("wait for killed child");
    panic!(
        "siko child process timed out; stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
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
fn json_help_includes_configuration_and_subcommand_details() {
    let (stdout, stderr, code) = run_siko(&["--json", "--help"]);

    eprint!("{}", stderr);
    assert_eq!(code, 0, "siko --json --help should exit with code 0");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("json help should be valid JSON");
    let help = parsed["data"]["help"]
        .as_str()
        .expect("json help should include data.help");
    assert!(help.contains("Daily workflow:"), "help was: {help}");
    assert!(help.contains("~/.sikong/config.yaml"), "help was: {help}");
    assert!(help.contains("SIKONG_CONFIG_FILE"), "help was: {help}");

    let (stdout, stderr, code) = run_siko(&["send", "--json", "--help"]);

    eprint!("{}", stderr);
    assert_eq!(code, 0, "siko send --json --help should exit with code 0");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("send json help should be valid JSON");
    let help = parsed["data"]["help"]
        .as_str()
        .expect("send json help should include data.help");
    assert!(
        help.contains("creates a durable task"),
        "send help was: {help}"
    );
    assert!(
        help.contains("siko send --wait-ms 0"),
        "send help was: {help}"
    );
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
    let task_id = create_task_with_status(
        &env,
        "completed inspect smoke",
        AssistantTaskStatus::Completed,
        "task.smoke",
    );

    let inspect = env.run(&[
        "task",
        "inspect",
        &task_id,
        "--json",
        "--no-follow",
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
fn task_inspect_no_follow_replays_active_task_without_blocking() {
    let env = TempSikoData::new();
    let task_id = create_task_with_status(
        &env,
        "active inspect smoke",
        AssistantTaskStatus::Running,
        "task.smoke",
    );

    let inspect = env.run(&["task", "inspect", &task_id, "--json", "--no-follow"]);
    let (stdout, stderr, code) = output_parts(inspect);
    assert_eq!(
        code, 0,
        "task inspect --no-follow should exit for active task; stdout={stdout} stderr={stderr}"
    );

    let records = stdout
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("inspect JSONL record"))
        .collect::<Vec<_>>();
    assert!(records.iter().any(|record| {
        record["type"].as_str() == Some("task_status")
            && record["status"].as_str() == Some("Running")
    }));
    assert!(records.iter().any(|record| {
        record["type"].as_str() == Some("task_event")
            && record["event"]["kind"].as_str() == Some("task.smoke")
    }));
}

#[test]
fn daemon_startup_recovery_is_observable_through_inspect_without_retrying_task() {
    let env = TempSikoData::new();
    let interrupted_id = create_task_with_status(
        &env,
        "interrupted before daemon restart",
        AssistantTaskStatus::Running,
        "task.smoke",
    );

    let send = env.run(&[
        "send",
        "--wait-ms",
        "0",
        "--json",
        "--no-allow-write",
        "Sikong CLI smoke task: create a new task after startup recovery.",
    ]);
    let (stdout, stderr, code) = output_parts(send);
    assert_eq!(
        code, 0,
        "send should start daemon and create a separate task; stdout={stdout} stderr={stderr}"
    );
    let send_json: serde_json::Value =
        serde_json::from_str(&stdout).expect("send should print JSON");
    assert_ne!(
        send_json["task_id"].as_str(),
        Some(interrupted_id.as_str()),
        "send should create a new task instead of reviving the interrupted one"
    );

    let inspect = env.run(&["task", "inspect", &interrupted_id, "--json", "--no-follow"]);
    let (stdout, stderr, code) = output_parts(inspect);
    assert_eq!(
        code, 0,
        "recovered task should be inspectable; stdout={stdout} stderr={stderr}"
    );

    let records = stdout
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("inspect JSONL record"))
        .collect::<Vec<_>>();
    assert!(records.iter().any(|record| {
        record["type"].as_str() == Some("task_status")
            && record["status"].as_str() == Some("Failed")
    }));
    assert!(records.iter().any(|record| {
        record["type"].as_str() == Some("task_event")
            && record["event"]["kind"].as_str() == Some("task.recovered")
            && record["event"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("interrupted active task"))
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
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":1,"clientInfo":{{"name":"Zed","version":"0.0.0-test"}}}}}}"#
        )
        .unwrap();
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":2,"method":"session/new","params":{{"cwd":"/tmp/zed-workspace","mcpServers":[]}}}}"#
        )
        .unwrap();
    }
    drop(child.stdin.take());

    let output = wait_with_timeout(child, Duration::from_secs(5));
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
        stdout.contains("agentInfo"),
        "missing ACP v1 agent info: {stdout}"
    );
    assert!(
        stdout.contains("agentCapabilities"),
        "missing ACP v1 capabilities: {stdout}"
    );
    assert!(
        stdout.contains(r#""id":2"#),
        "missing session response: {stdout}"
    );
    assert!(stdout.contains("sessionId"), "missing session id: {stdout}");
}

#[test]
fn acp_stdio_prompt_returns_update_and_stop_reason_without_wait_ms() {
    let env = TempSikoData::new();
    let mut child =
        env.spawn_with_env(&["acp"], &[("SIKONG_AGENT_HOST_COMMAND", "/usr/bin/false")]);
    {
        let stdin = child.stdin.as_mut().expect("child stdin");
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":1,"clientInfo":{{"name":"Zed","version":"0.0.0-test"}}}}}}"#
        )
        .unwrap();
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":2,"method":"session/new","params":{{"cwd":"/tmp/zed-workspace","mcpServers":[]}}}}"#
        )
        .unwrap();
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{{"sessionId":"session_1","prompt":[{{"type":"text","text":"hi from zed smoke"}}]}}}}"#
        )
        .unwrap();
    }
    drop(child.stdin.take());

    let output = wait_with_timeout(child, Duration::from_secs(5));
    let (stdout, stderr, code) = output_parts(output);
    assert_eq!(
        code, 0,
        "acp process should exit cleanly; stdout={stdout} stderr={stderr}"
    );
    let messages = stdout
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("jsonrpc line"))
        .collect::<Vec<_>>();
    assert!(
        messages.iter().any(|message| {
            message["method"] == "session/update"
                && message["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
                && message["params"]["update"]["content"]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("Assistant turn failed"))
        }),
        "missing session/update message: {stdout}"
    );
    let prompt_response = messages
        .iter()
        .find(|message| message["id"] == 3)
        .expect("prompt response");
    assert_eq!(prompt_response["result"]["stopReason"], "end_turn");
    assert!(
        prompt_response["result"].get("content").is_none(),
        "prompt response should not carry ACP message content: {prompt_response}"
    );
}

#[test]
fn acp_install_zed_dry_run_prints_settings_without_writing() {
    let env = TempSikoData::new();
    let settings_path = env.path().join("zed").join("settings.json");
    let command_path = env.path().join("bin").join("siko");
    let settings_arg = settings_path.to_string_lossy().to_string();
    let command_arg = command_path.to_string_lossy().to_string();

    let install = env.run(&[
        "acp",
        "install",
        "zed",
        "--settings-path",
        &settings_arg,
        "--command",
        &command_arg,
        "--dry-run",
        "--json",
    ]);
    let (stdout, stderr, code) = output_parts(install);
    assert_eq!(
        code, 0,
        "acp install zed --dry-run should succeed; stdout={stdout} stderr={stderr}"
    );
    assert!(
        !settings_path.exists(),
        "dry-run must not write Zed settings"
    );
    let output: serde_json::Value =
        serde_json::from_str(&stdout).expect("dry-run should print JSON");
    assert_eq!(output["status"], "ok");
    assert_eq!(output["data"]["client"], "zed");
    assert_eq!(output["data"]["dry_run"], true);
    assert_eq!(
        output["data"]["settings"]["agent_servers"]["siko"]["command"],
        command_arg
    );
    assert_eq!(
        output["data"]["settings"]["agent_servers"]["siko"]["args"],
        serde_json::json!(["acp"])
    );
}

#[test]
fn acp_install_zed_merges_existing_settings() {
    let env = TempSikoData::new();
    let settings_path = env.path().join("zed").join("settings.json");
    std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    std::fs::write(
        &settings_path,
        serde_json::json!({
            "theme": "Ayu Dark",
            "agent_servers": {
                "other": {
                    "type": "custom",
                    "command": "other-agent"
                },
                "siko": {
                    "env": {
                        "SIKONG_DATA_DIR": "/tmp/sikong-data"
                    }
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let command_path = env.path().join("bin").join("siko");
    let settings_arg = settings_path.to_string_lossy().to_string();
    let command_arg = command_path.to_string_lossy().to_string();

    let install = env.run(&[
        "acp",
        "install",
        "zed",
        "--settings-path",
        &settings_arg,
        "--command",
        &command_arg,
        "--json",
    ]);
    let (stdout, stderr, code) = output_parts(install);
    assert_eq!(
        code, 0,
        "acp install zed should succeed; stdout={stdout} stderr={stderr}"
    );

    let settings: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&settings_path).expect("read updated Zed settings"),
    )
    .expect("updated Zed settings should be JSON");
    assert_eq!(settings["theme"], "Ayu Dark");
    assert_eq!(settings["agent_servers"]["other"]["command"], "other-agent");
    assert_eq!(settings["agent_servers"]["siko"]["type"], "custom");
    assert_eq!(settings["agent_servers"]["siko"]["command"], command_arg);
    assert_eq!(
        settings["agent_servers"]["siko"]["args"],
        serde_json::json!(["acp"])
    );
    assert_eq!(
        settings["agent_servers"]["siko"]["env"]["SIKONG_DATA_DIR"],
        "/tmp/sikong-data"
    );
}

fn create_task_with_status(
    env: &TempSikoData,
    request: &str,
    status: AssistantTaskStatus,
    event_kind: &str,
) -> String {
    let store_path = env.path().join("assistant").join("tasks.json");
    let mut store = FileTaskStore::open(&store_path).expect("open task store");
    let task_id = store.create_task(request.to_string());
    store.record_task_event(
        &task_id,
        AssistantTaskEventRecord {
            level: Level::INFO,
            kind: event_kind.to_string(),
            source: "cli.test".to_string(),
            message: "inspect can replay stored task records".to_string(),
            node_id: None,
            operation: None,
            payload: serde_json::json!({"surface": "task.inspect"}),
        },
    );
    store.set_task_status(&task_id, status);
    task_id
}
