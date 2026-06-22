/// CLI integration tests for the `siko` binary.
///
/// These tests invoke the compiled binary via `std::process::Command` and
/// assert properties of its stdout/stderr output.

use std::process::Command;

/// Helper: run `siko <args>` and return (stdout, stderr, exit_code).
fn run_siko(args: &[&str]) -> (String, String, i32) {
    let binary = std::env::current_exe()
        .ok()
        .map(|p| p.parent().unwrap().parent().unwrap().join("siko"))
        .unwrap_or_else(|| path_buf_from_env_var());

    let output = Command::new(&binary)
        .args(args)
        .output()
        .expect("failed to run siko binary");

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

    assert!(stderr.is_empty() || stderr.contains("warning:"),
        "stderr should be empty or only contain warnings; got: {stderr}");
    assert_eq!(code, 0, "siko metrics should exit with code 0");

    // Must be valid JSON
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("siko metrics output must be valid JSON");

    // Must contain expected top-level keys from MetricsFormatter
    assert!(
        parsed.as_object().map(|obj| obj.contains_key("counters")).unwrap_or(false),
        "output must contain 'counters' key"
    );
    assert!(
        parsed.as_object().map(|obj| obj.contains_key("timings")).unwrap_or(false),
        "output must contain 'timings' key"
    );
    assert!(
        parsed.as_object().map(|obj| obj.contains_key("costs")).unwrap_or(false),
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
