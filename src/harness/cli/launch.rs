use std::path::{Path, PathBuf};

use super::DebugConfig;
use crate::SikoConfig;
use crate::common::config::non_empty_env;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentHostLaunch {
    pub command: String,
    pub args: Vec<String>,
}

pub fn resolve_agent_loop_launch(debug: &DebugConfig, max_steps: usize) -> AgentHostLaunch {
    let mut launch = resolve_agent_host_launch(debug);
    let config = SikoConfig::load().ok();

    let provider = std::env::var("SIKONG_AGENT_HOST_PROVIDER")
        .ok()
        .filter(|value| {
            value == "deepseek"
                || value == "kimi"
                || value == "claude"
                || value == "codex"
                || value == "cursor"
        })
        .unwrap_or_else(|| {
            config
                .as_ref()
                .map(|c| c.worker_provider())
                .unwrap_or_else(|| "deepseek".to_string())
        });
    let runtime = std::env::var("SIKONG_AGENT_HOST_RUNTIME")
        .ok()
        .filter(|value| {
            value == "ai-sdk" || value == "claude-code" || value == "codex" || value == "cursor"
        })
        .unwrap_or_else(|| {
            config
                .as_ref()
                .map(|c| c.worker_backend())
                .unwrap_or_else(|| "ai-sdk".to_string())
        });
    let model = std::env::var("SIKONG_AGENT_HOST_MODEL")
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| {
            config
                .as_ref()
                .and_then(|c| c.current_model())
                .map(|m| m.to_string())
        });

    // Claude-code runtime needs more steps for built-in tool chains (Read,
    // Write, Bash, Grep, etc.) before calling the terminal tool. The ai-sdk
    // runtime completes in 1-3 tool calls per agent run.
    let max_steps = if max_steps == 0 {
        match runtime.as_str() {
            "claude-code" => 64,
            "codex" | "cursor" => 48,
            _ => 24,
        }
    } else {
        max_steps
    };
    launch.args.extend(
        [
            "--worker",
            "agent-loop",
            "--provider",
            provider.as_str(),
            "--runtime",
            runtime.as_str(),
        ]
        .into_iter()
        .map(str::to_string),
    );
    if let Some(m) = &model {
        launch.args.push("--model".to_string());
        launch.args.push(m.clone());
    }
    launch.args.push("--max-steps".to_string());
    launch.args.push(max_steps.to_string());
    launch
}

pub fn resolve_agent_host_launch(debug: &DebugConfig) -> AgentHostLaunch {
    resolve_agent_host_launch_from(
        &|name| std::env::var(name).ok(),
        std::env::current_exe().ok().as_deref(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
        debug,
    )
}

pub fn resolve_agent_host_launch_from(
    env: &dyn Fn(&str) -> Option<String>,
    current_exe: Option<&Path>,
    manifest_dir: &Path,
    debug: &DebugConfig,
) -> AgentHostLaunch {
    if let Some(command) = debug
        .agent_host_command
        .clone()
        .or_else(|| non_empty_env(env, "SIKONG_AGENT_HOST_COMMAND"))
    {
        return AgentHostLaunch {
            command,
            args: Vec::new(),
        };
    }

    if let Some(script) = debug
        .agent_host_script
        .clone()
        .or_else(|| non_empty_env(env, "SIKONG_AGENT_HOST_SCRIPT"))
    {
        return bun_script_launch(env, debug, script);
    }

    // Prefer compiled agent-host binary (no Bun dependency).
    if let Some(path) = sibling_agent_host_binary(current_exe) {
        return binary_launch(path);
    }

    // Fall back to agent-host JS bundle (requires Bun)
    if let Some(sibling_dir) = sibling_agent_host_source_dir(current_exe) {
        let js_entry = sibling_dir.join("runtime-host.js");
        let ts_entry = sibling_dir.join("runtime-host.ts");
        let entry = if js_entry.exists() {
            js_entry
        } else {
            ts_entry
        };
        if entry.exists() {
            let bun_cmd = env("BUN")
                .or_else(which_bun)
                .unwrap_or_else(|| "bun".to_string());
            return AgentHostLaunch {
                command: bun_cmd,
                args: vec!["run".to_string(), entry.to_string_lossy().to_string()],
            };
        }
    }

    if let Some(runtime_dir) = debug
        .runtime_dir
        .clone()
        .or_else(|| non_empty_env(env, "SIKONG_RUNTIME_DIR").map(PathBuf::from))
    {
        let path = Path::new(&runtime_dir)
            .join("bin")
            .join(agent_host_binary_name());
        if path.exists() {
            return binary_launch(path);
        }
    }

    let dev_script = manifest_dir
        .join("packages")
        .join("agent-host")
        .join("src")
        .join("runtime-host.ts");
    if dev_script.exists() {
        return bun_script_launch(env, debug, dev_script.to_string_lossy().to_string());
    }

    bun_script_launch(
        env,
        debug,
        "packages/agent-host/src/runtime-host.ts".to_string(),
    )
}

fn sibling_agent_host_binary(current_exe: Option<&Path>) -> Option<PathBuf> {
    let exe = current_exe?;
    let sibling = exe.parent()?.join(agent_host_binary_name());
    sibling.exists().then_some(sibling)
}

fn sibling_agent_host_source_dir(current_exe: Option<&Path>) -> Option<PathBuf> {
    let exe = current_exe?;
    let dir = exe.parent()?.join("agent-host");
    dir.is_dir().then_some(dir)
}

fn which_bun() -> Option<String> {
    let candidates = [
        std::env::var("HOME")
            .map(|h| PathBuf::from(h).join(".bun/bin/bun"))
            .ok(),
        Some(PathBuf::from("/opt/homebrew/bin/bun")),
        Some(PathBuf::from("/usr/local/bin/bun")),
        Some(PathBuf::from("/usr/bin/bun")),
    ];
    for c in candidates.into_iter().flatten() {
        if c.exists() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    if let Ok(output) = std::process::Command::new("which").arg("bun").output()
        && output.status.success()
    {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return Some(path);
        }
    }
    if let Ok(output) = std::process::Command::new("bash")
        .args(["-c", "command -v bun"])
        .output()
        && output.status.success()
    {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return Some(path);
        }
    }
    None
}

fn binary_launch(path: impl Into<PathBuf>) -> AgentHostLaunch {
    AgentHostLaunch {
        command: path.into().to_string_lossy().to_string(),
        args: Vec::new(),
    }
}

fn bun_script_launch(
    env: &dyn Fn(&str) -> Option<String>,
    debug: &DebugConfig,
    script: String,
) -> AgentHostLaunch {
    AgentHostLaunch {
        command: non_empty_env(env, "SIKONG_BUN_COMMAND")
            .or_else(|| debug.bun_command.clone())
            .unwrap_or_else(|| "bun".to_string()),
        args: vec![script],
    }
}

fn agent_host_binary_name() -> &'static str {
    if cfg!(windows) {
        "siko-agent-host.exe"
    } else {
        "siko-agent-host"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn env_lookup<'a>(env: &'a BTreeMap<&'a str, &'a str>) -> impl Fn(&str) -> Option<String> + 'a {
        |name| env.get(name).map(|value| value.to_string())
    }

    #[test]
    fn default_resolve_prefers_explicit_command() {
        let debug = DebugConfig {
            agent_host_command: Some("/custom/host".to_string()),
            ..DebugConfig::default()
        };
        let launch = resolve_agent_host_launch_from(&|_| None, None, Path::new("/missing"), &debug);
        assert_eq!(launch.command, "/custom/host");
    }

    #[test]
    fn agent_host_launch_uses_sibling_binary() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let host = bin.join(agent_host_binary_name());
        std::fs::write(&host, "").unwrap();
        let exe = bin.join("siko");
        let launch = resolve_agent_host_launch_from(
            &|_| None,
            Some(&exe),
            Path::new("/missing"),
            &DebugConfig::default(),
        );
        assert_eq!(launch, binary_launch(host));
    }

    #[test]
    fn agent_host_launch_prefers_compiled_over_script() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let host = bin.join(agent_host_binary_name());
        std::fs::write(&host, "").unwrap();

        let agent_host_dir = bin.join("agent-host");
        std::fs::create_dir_all(&agent_host_dir).unwrap();
        std::fs::write(agent_host_dir.join("runtime-host.ts"), "").unwrap();
        let exe = bin.join("siko");

        let launch = resolve_agent_host_launch_from(
            &|_| None,
            Some(&exe),
            Path::new("/missing"),
            &DebugConfig::default(),
        );
        assert_eq!(launch, binary_launch(host));
    }

    #[test]
    fn agent_host_launch_falls_back_to_dev_script() {
        let launch = resolve_agent_host_launch_from(
            &|_| None,
            None,
            Path::new("/missing"),
            &DebugConfig::default(),
        );
        assert!(launch.command == "bun");
        assert_eq!(
            launch.args,
            vec!["packages/agent-host/src/runtime-host.ts".to_string()]
        );
    }

    #[test]
    fn agent_host_launch_with_env_command() {
        let mut env = BTreeMap::new();
        env.insert("SIKONG_AGENT_HOST_COMMAND", "/env/host");
        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            None,
            Path::new("/missing"),
            &DebugConfig::default(),
        );
        assert_eq!(launch.command, "/env/host");
        assert!(launch.args.is_empty());
    }

    #[test]
    fn agent_host_launch_with_env_script() {
        let mut env = BTreeMap::new();
        env.insert("SIKONG_AGENT_HOST_SCRIPT", "/env/script.ts");
        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            None,
            Path::new("/missing"),
            &DebugConfig::default(),
        );
        assert_eq!(launch.command, "bun");
        assert_eq!(launch.args, vec!["/env/script.ts".to_string()]);
    }

    #[test]
    fn agent_host_launch_with_runtime_dir() {
        let temp = tempfile::tempdir().unwrap();
        let runtime_bin = temp.path().join("bin");
        std::fs::create_dir_all(&runtime_bin).unwrap();
        let host = runtime_bin.join(agent_host_binary_name());
        std::fs::write(&host, "").unwrap();

        let runtime_dir_str = temp.path().to_string_lossy().to_string();
        let mut env = BTreeMap::new();
        env.insert("SIKONG_RUNTIME_DIR", runtime_dir_str.as_str());
        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            None,
            Path::new("/missing"),
            &DebugConfig::default(),
        );
        assert_eq!(launch, binary_launch(host));
    }

    #[test]
    fn agent_host_launch_bun_command_override() {
        let mut env = BTreeMap::new();
        env.insert("SIKONG_BUN_COMMAND", "/custom/bun");
        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            None,
            Path::new("/missing"),
            &DebugConfig::default(),
        );
        assert_eq!(launch.command, "/custom/bun");
        assert_eq!(
            launch.args,
            vec!["packages/agent-host/src/runtime-host.ts".to_string()]
        );
    }

    #[test]
    fn agent_host_binary_name_is_not_empty() {
        let name = agent_host_binary_name();
        assert!(!name.is_empty());
        assert!(name.contains("siko-agent-host"));
    }

    #[test]
    fn binary_launch_creates_correct_launch() {
        let path = PathBuf::from("/usr/local/bin/siko-agent-host");
        let launch = binary_launch(path);
        assert_eq!(launch.command, "/usr/local/bin/siko-agent-host");
        assert!(launch.args.is_empty());
    }

    #[test]
    fn bun_script_launch_uses_sikong_bun_command_env() {
        let mut env = BTreeMap::new();
        env.insert("SIKONG_BUN_COMMAND", "/opt/bin/bun");
        let launch = bun_script_launch(
            &env_lookup(&env),
            &DebugConfig::default(),
            "test.ts".to_string(),
        );
        assert_eq!(launch.command, "/opt/bin/bun");
        assert_eq!(launch.args, vec!["test.ts".to_string()]);
    }

    #[test]
    fn bun_script_launch_falls_back_to_bun() {
        let launch = bun_script_launch(&|_| None, &DebugConfig::default(), "test.ts".to_string());
        assert_eq!(launch.command, "bun");
        assert_eq!(launch.args, vec!["test.ts".to_string()]);
    }

    #[test]
    fn resolve_agent_loop_launch_adds_worker_args() {
        let debug = DebugConfig::default();
        let launch = resolve_agent_loop_launch(&debug, 10);
        assert_eq!(launch.command, "bun");
        assert!(launch.args.contains(&"--worker".to_string()));
        assert!(launch.args.contains(&"agent-loop".to_string()));
        assert!(launch.args.contains(&"--provider".to_string()));
        assert!(launch.args.contains(&"--runtime".to_string()));
        assert!(launch.args.contains(&"--max-steps".to_string()));
        assert!(launch.args.contains(&"10".to_string()));
    }
}
