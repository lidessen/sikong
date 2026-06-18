use std::io::{self, BufReader};
use std::path::{Path, PathBuf};

use clap::{CommandFactory, Parser, Subcommand};
use siko::{
    AcpServer, AgentAssistantLoop, AgentHostClient, AssistantSession, AssistantSessionConfig,
    DebugConfig, FileTaskStore, SikoConfig, run_acp_stdio_server,
};
use tracing::error;
use tracing_subscriber::EnvFilter;

pub fn run(args: impl IntoIterator<Item = String>) -> i32 {
    init_tracing();
    match Cli::try_parse_from(std::iter::once("siko".to_string()).chain(args)) {
        Ok(cli) => run_cli(cli),
        Err(error) => {
            let _ = error.print();
            error.exit_code()
        }
    }
}

fn run_cli(cli: Cli) -> i32 {
    match cli.command {
        Some(Command::Assistant { acp: true }) => match run_assistant_acp() {
            Ok(()) => 0,
            Err(error) => {
                error!(%error, "failed to run assistant ACP server");
                1
            }
        },
        Some(Command::Assistant { acp: false }) | None => {
            eprintln!("{}", Cli::command().render_help());
            0
        }
    }
}

#[derive(Debug, Parser)]
#[command(name = "siko")]
#[command(about = "Recursive agent engine prototype")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the assistant entrypoint.
    Assistant {
        /// Serve the Assistant Agent over ACP JSON-RPC stdio.
        #[arg(long)]
        acp: bool,
    },
}

pub fn run_assistant_acp() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .thread_name("siko-assistant")
        .enable_time()
        .build()?;
    runtime.block_on(run_assistant_acp_async())
}

async fn run_assistant_acp_async() -> Result<(), Box<dyn std::error::Error>> {
    let config = SikoConfig::load()?;
    let debug = DebugConfig::from_env();
    let store = FileTaskStore::open(debug.data_dir().join("assistant").join("tasks.json"))?;
    let launch = resolve_agent_host_launch(&debug);
    let assistant_loop = AgentAssistantLoop::new(AgentHostClient::new(
        launch.command.clone(),
        launch.args.clone(),
    ));
    let session = AssistantSession::with_worker_factory(
        assistant_loop,
        {
            let launch = launch.clone();
            move || AgentHostClient::new(launch.command.clone(), launch.args.clone())
        },
        AssistantSessionConfig {
            max_parallel_tasks: config.assistant.max_parallel_tasks,
        },
    );
    let server = AcpServer::new(store, session);
    run_acp_stdio_server(server, BufReader::new(io::stdin()), io::stdout()).await?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentHostLaunch {
    command: String,
    args: Vec<String>,
}

fn resolve_agent_host_launch(debug: &DebugConfig) -> AgentHostLaunch {
    resolve_agent_host_launch_from(
        &|name| std::env::var(name).ok(),
        std::env::current_exe().ok().as_deref(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
        debug,
    )
}

fn resolve_agent_host_launch_from(
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

    if let Some(path) = sibling_agent_host_binary(current_exe) {
        return binary_launch(path);
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

fn non_empty_env(env: &dyn Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    env(name).and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn sibling_agent_host_binary(current_exe: Option<&Path>) -> Option<PathBuf> {
    let exe = current_exe?;
    let sibling = exe.parent()?.join(agent_host_binary_name());
    sibling.exists().then_some(sibling)
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

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs;

    fn env_lookup<'a>(env: &'a BTreeMap<&'a str, &'a str>) -> impl Fn(&str) -> Option<String> + 'a {
        |name| env.get(name).map(|value| value.to_string())
    }

    fn test_debug_config() -> DebugConfig {
        DebugConfig::default()
    }

    #[test]
    fn parses_assistant_acp_command() {
        let cli = Cli::try_parse_from(["siko", "assistant", "--acp"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Assistant { acp: true })
        ));
    }

    #[test]
    fn agent_host_launch_uses_command_override() {
        let env = BTreeMap::from([("SIKONG_AGENT_HOST_COMMAND", "/tmp/siko-agent-host")]);

        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            None,
            Path::new("/missing"),
            &test_debug_config(),
        );

        assert_eq!(
            launch,
            AgentHostLaunch {
                command: "/tmp/siko-agent-host".to_string(),
                args: Vec::new(),
            }
        );
    }

    #[test]
    fn agent_host_launch_uses_script_override_with_bun_command() {
        let env = BTreeMap::from([
            ("SIKONG_AGENT_HOST_SCRIPT", "/tmp/runtime-host.ts"),
            ("SIKONG_BUN_COMMAND", "/opt/bun"),
        ]);

        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            None,
            Path::new("/missing"),
            &test_debug_config(),
        );

        assert_eq!(
            launch,
            AgentHostLaunch {
                command: "/opt/bun".to_string(),
                args: vec!["/tmp/runtime-host.ts".to_string()],
            }
        );
    }

    #[test]
    fn agent_host_launch_prefers_sibling_release_binary() {
        let temp = tempfile::tempdir().unwrap();
        let exe = temp.path().join("siko");
        let host = temp.path().join(agent_host_binary_name());
        fs::write(&exe, "").unwrap();
        fs::write(&host, "").unwrap();
        let env = BTreeMap::new();

        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            Some(&exe),
            Path::new("/missing"),
            &test_debug_config(),
        );

        assert_eq!(launch, binary_launch(host));
    }

    #[test]
    fn agent_host_launch_uses_runtime_bundle_binary() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let host = bin.join(agent_host_binary_name());
        fs::write(&host, "").unwrap();
        let runtime_dir = temp.path().to_string_lossy().to_string();
        let env = BTreeMap::from([("SIKONG_RUNTIME_DIR", runtime_dir.as_str())]);

        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            None,
            Path::new("/missing"),
            &test_debug_config(),
        );

        assert_eq!(launch, binary_launch(host));
    }

    #[test]
    fn agent_host_launch_falls_back_to_dev_script() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp
            .path()
            .join("packages")
            .join("agent-host")
            .join("src")
            .join("runtime-host.ts");
        fs::create_dir_all(script.parent().unwrap()).unwrap();
        fs::write(&script, "").unwrap();
        let env = BTreeMap::new();

        let launch = resolve_agent_host_launch_from(
            &env_lookup(&env),
            None,
            temp.path(),
            &test_debug_config(),
        );

        assert_eq!(
            launch,
            AgentHostLaunch {
                command: "bun".to_string(),
                args: vec![script.to_string_lossy().to_string()],
            }
        );
    }

    #[test]
    fn agent_host_launch_uses_debug_command() {
        let debug = DebugConfig {
            agent_host_command: Some("/configured/siko-agent-host".to_string()),
            ..DebugConfig::default()
        };
        let env = BTreeMap::new();

        let launch =
            resolve_agent_host_launch_from(&env_lookup(&env), None, Path::new("/missing"), &debug);

        assert_eq!(
            launch,
            AgentHostLaunch {
                command: "/configured/siko-agent-host".to_string(),
                args: Vec::new(),
            }
        );
    }

    #[test]
    fn agent_host_launch_uses_debug_script_and_bun_command() {
        let debug = DebugConfig {
            bun_command: Some("/configured/bun".to_string()),
            agent_host_script: Some("/configured/runtime-host.ts".to_string()),
            ..DebugConfig::default()
        };
        let env = BTreeMap::new();

        let launch =
            resolve_agent_host_launch_from(&env_lookup(&env), None, Path::new("/missing"), &debug);

        assert_eq!(
            launch,
            AgentHostLaunch {
                command: "/configured/bun".to_string(),
                args: vec!["/configured/runtime-host.ts".to_string()],
            }
        );
    }
}
