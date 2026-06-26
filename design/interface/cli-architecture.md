# CLI Architecture

**Status:** Current (✓) — 2026-06-22

**Governs:** `src/main.rs`, `src/cli.rs`, `src/config.rs`, `src/agent_run/run_scheduler.rs`

**Layer:** L1 — Command & Interface

---

## Purpose

The CLI is the primary human-facing entry point for Sikong. It parses commands,
loads configuration, resolves the agent-host process, and dispatches to engine
operations or assistant sessions. This document describes the architecture of
the Rust CLI, its command tree, configuration loading, agent host resolution,
the ProcessAgentRunScheduler protocol, and the dogfood command end-to-end flow.

---

## Entry Point

```
src/main.rs
  └─ fn main()
       └─ std::process::exit(cli::run(std::env::args().skip(1)))
```

`main.rs` is minimal: it imports the `cli` module, strips the program name from
arguments, and delegates to `cli::run()`. The existing `mod cli` at the top
declares the module.

```
src/cli.rs
  └─ fn run(args) -> i32
       └─ Cli::try_parse_from(args)          // clap CLI argument parsing
            └─ run_cli(cli) -> exit_code     // dispatch to command handlers
```

---

## Command Tree

```text
siko
 ├── assistant
 │    ├── prompt <message>   -- Send one message, run queued work
 │    │   [--wait-ms] [--workspace memory|current-git]
 │    │   [--allow-write] [--write-scope] [--json]
 │    ├── logs <task-id>     -- Print task logs
 │    │   [--json] [--full]
 │    ├── events <task-id>   -- Query agent-run events
 │    │   [--operation] [--event] [--tool] [--source] [--query] [--json]
 │    └── --acp              -- Serve over ACP JSON-RPC stdio
 │
 ├── eval
 │    ├── task-run-split     -- Full task-run eval scenarios
 │    │   [--task] [--scenario] [--scenario-file]
 │    │   [--artifact-dir] [--route-only] [--json]
 │    └── task-run-operation -- Isolated operation eval scenarios
 │        [--operation] [--scenario] [--json]
 │
 └── dogfood
      ├── run                -- Run dogfood scenario with optional dev-log
      │   [--scenario] [--scenario-file] [--artifact-dir]
      │   [--route-only] [--log] [--json]
      └── list               -- List built-in dogfood scenarios
```

### Parsing Structure

The CLI uses `clap` derive macros:

```rust
#[derive(Debug, Parser)]
#[command(name = "siko")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Assistant {
        #[command(subcommand)]
        command: Option<AssistantCommand>,
        #[arg(long)]
        acp: bool,
    },
    Eval {
        #[command(subcommand)]
        command: EvalCommand,
    },
    Dogfood {
        #[command(subcommand)]
        command: DogfoodCommand,
    },
}

#[derive(Debug, Subcommand)]
enum DogfoodCommand {
    Run { ... },
    List,
}

#[derive(Debug, Subcommand)]
enum AssistantCommand {
    Prompt { ... },
    Logs { ... },
    Events { ... },
}

#[derive(Debug, Subcommand)]
enum EvalCommand {
    TaskRunSplit { ... },
    TaskRunOperation { ... },
}
```

### Dispatch Flow

```text
run_cli(cli)
  │
  ├── Command::Assistant { acp: true, command: None }
  │   └── run_assistant_acp()
  │       └── ProcessAgentRunScheduler → ACP server over stdio JSON-RPC
  │
  ├── Command::Assistant { acp: false, command: Some(Prompt {..}) }
  │   └── run_assistant_prompt(...)
  │       └── resolve workspace → create AssistantSession → handle_message()
  │
  ├── Command::Assistant { acp: false, command: Some(Logs {..}) }
  │   └── print_assistant_logs(...)
  │
  ├── Command::Assistant { acp: false, command: Some(Events {..}) }
  │   └── print_assistant_events(...)
  │
  ├── Command::Eval { command: TaskRunSplit {..} }
  │   └── run_task_run_split_eval(...)
  │       └── select scenarios → Engine + judge → output
  │
  ├── Command::Eval { command: TaskRunOperation {..} }
  │   └── run_task_run_operation_eval(...)
  │       └── select scenarios → OperationHarness → worker + judge → output
  │
  └── Command::Dogfood { command: Run {..} }
      └── run_dogfood_run(...)
          └── select scenarios → Engine + judge → (optional dev-log) → output
```

---

## Config Loading

Configuration comes from three sources, layered in order of precedence:

```text
Default values
   ↓ overridden by
Config YAML file
   ↓ overridden by
Environment variables
```

### SikoConfig (User Configuration)

Deserialized from a YAML file (default: `~/.sikong/config.yaml` or
`$SIKONG_DATA_DIR/config.yaml`, override with `$SIKONG_CONFIG_FILE`):

```rust
#[derive(Debug, Deserialize)]
struct SikoConfig {
    pub version: u32,
    pub assistant: AssistantConfig,
}

struct AssistantConfig {
    pub max_parallel_tasks: usize,   // default: 2
}
```

Loading chain:

```rust
impl SikoConfig {
    pub fn load() -> Result<Self, ConfigError> {
        let path = config_path_from_env();
        Self::load_from_path_and_env(&path)
    }

    pub fn load_from_path_and_env(path: &Path) -> Result<Self, ConfigError> {
        config::Config::builder()
            .set_default("version", 1)?
            .set_default("assistant.max_parallel_tasks", 2)?
            .add_source(config::File::from(path).required(false))
            .add_source(
                config::Environment::with_prefix("SIKONG_CONFIG")
                    .prefix_separator("__")
                    .separator("__"),
            )
            .build()?
            .try_deserialize()
    }
}
```

Environment override example:

```bash
SIKONG_CONFIG__ASSISTANT__MAX_PARALLEL_TASKS=4 cargo run -- ...
```

### DebugConfig (Environment Overrides)

Not from the YAML file. Loaded from environment variables only:

```rust
struct DebugConfig {
    pub data_dir: Option<PathBuf>,         // SIKONG_DATA_DIR
    pub runtime_dir: Option<PathBuf>,       // SIKONG_RUNTIME_DIR
    pub bun_command: Option<String>,        // SIKONG_BUN_COMMAND
    pub agent_host_command: Option<String>, // SIKONG_AGENT_HOST_COMMAND
    pub agent_host_script: Option<String>,  // SIKONG_AGENT_HOST_SCRIPT
}
```

These affect agent host resolution (see below), assistant store path, and
workspace selection.

### Config File Resolution

```text
$SIKONG_CONFIG_FILE                  → exact path (expanded if starts with ~/)
       ↓
$SIKONG_DATA_DIR/config.yaml         → override data dir
       ↓
$HOME/.sikong/config.yaml            → default
       ↓
.sikong/config.yaml                  → cwd fallback
```

### Environment Variable Reference

| Variable                      | Used By     | Purpose                                    |
| ----------------------------- | ----------- | ------------------------------------------ |
| `SIKONG_CONFIG_FILE`          | `config.rs` | Override config file path                  |
| `SIKONG_DATA_DIR`             | `config.rs` | Data directory (tasks, config)             |
| `SIKONG_RUNTIME_DIR`          | `config.rs` | Runtime bundle directory                   |
| `SIKONG_BUN_COMMAND`          | `config.rs` | Bun binary path                            |
| `SIKONG_AGENT_HOST_COMMAND`   | `config.rs` | Direct agent-host binary path              |
| `SIKONG_AGENT_HOST_SCRIPT`    | `config.rs` | Agent-host TypeScript script               |
| `SIKONG_AGENT_HOST_PROVIDER`  | `cli.rs`    | Provider override (`deepseek`, `kimi`)     |
| `SIKONG_AGENT_HOST_RUNTIME`   | `cli.rs`    | Runtime override (`ai-sdk`, `claude-code`) |
| `SIKONG_RUN_LIVE_AGENT_TESTS` | `cli.rs`    | Enable live eval mode (must be `1`)        |
| `SIKONG_CONFIG__*`            | `config.rs` | Config file field overrides                |

---

## Agent Host Resolution

The agent-host process is the Bun-side execution layer that runs model API calls,
local agent loops, and tool calls. There are two resolution functions.

### `resolve_agent_host_launch(debug)`

Returns the base `AgentHostLaunch` (command + args) for any agent-host use:

```rust
fn resolve_agent_host_launch(debug: &DebugConfig) -> AgentHostLaunch {
    resolve_agent_host_launch_from(
        &|name| std::env::var(name).ok(),
        std::env::current_exe().ok().as_deref(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
        debug,
    )
}
```

Resolution order (first match wins):

```text
1. DebugConfig.agent_host_command or SIKONG_AGENT_HOST_COMMAND
   → direct binary path, no extra args
2. DebugConfig.agent_host_script or SIKONG_AGENT_HOST_SCRIPT
   → bun <script-path> (or SIKONG_BUN_COMMAND <script-path>)
3. Sibling binary next to current executable
   → <current-exe-dir>/siko-agent-host (or .exe on Windows)
4. SIKONG_RUNTIME_DIR/bin/siko-agent-host
   → if the runtime bundle binary exists
5. packages/agent-host/src/runtime-host.ts (dev script)
   → bun <manifest-dir>/packages/agent-host/src/runtime-host.ts
6. Fallback: bun packages/agent-host/src/runtime-host.ts
```

### `resolve_agent_loop_launch(debug, max_steps)`

Extends the base launch with agent-loop-specific args:

```rust
fn resolve_agent_loop_launch(debug: &DebugConfig, max_steps: usize) -> AgentHostLaunch {
    let mut launch = resolve_agent_host_launch(debug);
    // Add worker arguments
    launch.args.extend([
        "--worker", "agent-loop",
        "--provider", "deepseek",     // or "kimi" from SIKONG_AGENT_HOST_PROVIDER
        "--runtime", "claude-code",   // or "ai-sdk" from SIKONG_AGENT_HOST_RUNTIME
        "--max-steps", "<N>",
    ]);
    launch
}
```

The resulting command is something like:

```
bun packages/agent-host/src/runtime-host.ts --worker agent-loop --provider deepseek --runtime claude-code --max-steps 24
```

### When Each Is Used

| Function                    | Used By                                                             | Purpose                                                     |
| --------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `resolve_agent_host_launch` | Assistant ACP, assistant prompt                                     | General assistant agent runs                                |
| `resolve_agent_loop_launch` | Eval commands (`task-run-split`, `task-run-operation`), dogfood run | Operation-level and task-level agent loops with step limits |

---

## ProcessAgentRunScheduler Protocol

`ProcessAgentRunScheduler` manages a persistent child process (Bun agent-host)
and communicates with it over a Unix socket using newline-delimited JSON (JSONL).

```text
┌─────────────────────────────────┐
│          Rust Engine            │
│   ProcessAgentRunScheduler      │
│    (src/agent_run/run_scheduler)│
└──────────────┬──────────────────┘
               │ Unix socket (JSONL)
               ▼
┌─────────────────────────────────┐
│        Bun Agent Host           │
│   packages/agent-host/src/      │
│   runtime-host.ts               │
└─────────────────────────────────┘
```

### Lifecycle

```
1. ProcessAgentRunScheduler::new(command, args)
   └─ Creates temp dir for socket
   └─ Sets socket_path = <tempdir>/agent-host.sock

2. ensure_started() [lazy, on first run()]
   ├─ Removes stale socket if exists
   ├─ Spawns: <command> <args> --socket <socket_path>
   │          (stdin=null, stdout=null, stderr=inherit)
   ├─ connect_socket() — retry loop (100 attempts × 20ms)
   └─ Splits stream into reader/writer halves

3. run(request, cancellation)
   ├─ send_message(Run { id, request })
   ├─ read_response_or_cancel(id, cancellation)
   └─ return AgentRunResponse

4. shutdown() or Drop
   ├─ send_message(Shutdown { id })
   ├─ Graceful wait (500ms)
   ├─ Kill if still alive
   └─ Remove socket file + temp dir
```

### Message Format (JSONL)

Messages are serialized as JSON objects separated by newlines.

**Rust → Host:**

```json
{"type":"run","id":"run_abc123","request":{...}}
{"type":"shutdown","id":"shutdown_def456"}
```

The `run` message wraps an `AgentRunRequest`:

```json
{
  "protocolVersion": 1,
  "objective": "Judge task-run split quality",
  "prompt": [{"title": "Role", "content": "..."}],
  "input": { "transcript": {...} },
  "tools": [{"name": "finish_eval", "description": "...", "inputSchema": {...}}],
  "terminalToolSet": ["finish_eval"],
  "runtimeProfile": "general",
  "effort": null
}
```

**Host → Rust:**

```json
{"type":"result","id":"run_abc123","result":{"report":"...","tool_calls":[...],"terminal_call":{...},"usage":{...},"events":[...]}}
{"type":"error","id":"run_abc123","message":"..."}
```

### AgentRunRequest Fields

| Field             | Type                   | Description                                                           |
| ----------------- | ---------------------- | --------------------------------------------------------------------- |
| `protocolVersion` | integer                | Compatibility version (currently 1).                                  |
| `objective`       | string                 | Concise label for the loop run (logs and summaries).                  |
| `prompt`          | `AgentPromptSection[]` | Ordered model-facing prompt sections (Role, Context, Rubric, Output). |
| `input`           | `JsonValue`            | Structured context packet (transcript, operation context, etc.).      |
| `tools`           | `AgentToolSpec[]`      | Dynamic tools available to the agent loop.                            |
| `terminalToolSet` | `string[]`             | Tool names that terminate the loop when called.                       |
| `runtimeProfile`  | `"general" \| "code"`  | Profile selecting system prompt and tool defaults.                    |
| `effort`          | `string \| null`       | Optional reasoning effort override.                                   |

### AgentRunResponse Fields

| Field           | Type                      | Description                                                        |
| --------------- | ------------------------- | ------------------------------------------------------------------ |
| `report`        | string                    | Free-text report from the agent loop.                              |
| `tool_calls`    | `AgentToolCall[]`         | All tools called during the loop.                                  |
| `terminal_call` | `AgentToolCall \| null`   | The terminal tool call that ended the loop.                        |
| `usage`         | `AgentTokenUsage \| null` | Token usage (input, output, cache).                                |
| `events`        | `JsonValue[]`             | Streamed events from the agent loop (tool calls, usage snapshots). |

### Cancellation

The scheduler supports cancellation via `CancellationToken`:

```rust
pub async fn run(&mut self, input: AgentRunRequest, cancellation: CancellationToken) -> AgentRunResponse
```

If cancelled mid-flight:

1. The `read_response_or_cancel` loop detects the cancellation signal.
2. The host process is terminated (`terminate()`).
3. An error response is returned.

### Safety

- **Socket retry:** 100 attempts × 20ms = 2 second timeout for socket readiness.
- **Graceful shutdown:** 500ms grace period, then forced kill.
- **Lazy start:** The child process is spawned on first `run()` call, not at `new()`.
- **Id-based multiplexing:** The message `id` field lets Rust correlate responses
  with requests when multiple requests are in-flight (responses for other IDs
  are skipped).

---

## Dogfood Command End-to-End Flow

The `dogfood run` command is the primary self-development mechanism. It runs a
real scenario through the engine, judges the result, and optionally logs the
outcome.

### Flow Diagram

```text
User: cargo run -- dogfood run --scenario simple-qa --log --json

  1. cli::run() → run_cli()
       └─ Command::Dogfood { Run { scenario, log, json, .. } }

  2. run_dogfood_run(scenario, log, json, ..)
       └─ select_task_run_split_eval_scenarios(None, scenario, scenario_file)
            └─ Filters built-in scenarios → Vec<TaskRunSplitScenario>

  3. tokio runtime::block_on(run_dogfood_run_async(...))

  4. For each scenario:
       ├─ resolve_agent_loop_launch(&debug, scenario.actor_max_steps())
       │    → e.g., "bun runtime-host.ts --worker agent-loop
       │             --provider deepseek --runtime claude-code
       │             --max-steps 24"
       │
       ├─ eval_task_workspace_requirement(&scenario)
       │    → WorkspaceRequirement + allow_write
       │
       ├─ Engine::new(Workspaces, ProcessAgentRunScheduler)
       │    → Creates engine with the resolved agent-host launch
       │
       ├─ if route_only: engine = engine.with_stop_after_route_depth(0)
       │
       ├─ root = engine.insert_root(eval_task_root_template(...))
       │    → Creates root ProblemNode with task, workspace, capabilities
       │
       ├─ report = engine.run(root).await
       │    → Full engine lifecycle:
       │       Specify → [Plan → children → Combine] → Verify → Commit
       │    → Returns EngineReport { status, artifact, agent_runs, events }
       │
       ├─ transcript = TaskRunSplitTranscript::from_engine(...)
       │    → Structured JSON transcript of the full run
       │
       ├─ artifact_files = write_task_run_artifacts(...)
       │    → Writes human-readable .md files to --artifact-dir
       │
       ├─ actor_usage = sum_agent_run_usage(&report.agent_runs)
       │    → Total token usage across all agent-loop runs
       │
       ├─ [JUDGE] resolve_agent_loop_launch(&debug, 6)
       │    → Creates a new ProcessAgentRunScheduler for the judge
       │    → judge_request(&transcript) builds AgentRunRequest with
       │      the transcript, finish_eval tool, and rubric prompt
       │    → judge.run(judge_request).await
       │    → decode_judgement(judge_response.terminal_call)
       │      → TaskRunSplitJudgement { passed, findings, evidence }
       │
       ├─ total_usage = sum_usage(actor_usage, judge_usage)
       │
       └─ if log: dogfood_write_devlog_entry(scenario, judgement, duration)
            → Appends to development-log/YYYY-MM-DD.md

  5. Output:
       ├─ if json: serde_json::to_writer_pretty(stdout, result)
       └─ else:    println("dogfood {id}: {PASSED|FAILED} ...")
```

### Dev-Log Entry Format

When `--log` is set, the dogfood command appends to a date-stamped dev-log file:

```markdown
## 2026-06-22 - Dogfood run

### 2026-06-22 - simple-qa

Scenario: Answer in two short paragraphs...

Verdict: PASSED

Findings:

- Engine correctly kept the task atomic.
- Final artifact covered both requested topics.

Duration: 12345ms
Expectation: This is a simple answer task...
```

### Dogfood vs Eval

| Aspect      | `eval task-run-split`             | `dogfood run`               |
| ----------- | --------------------------------- | --------------------------- |
| Purpose     | Regression testing                | Self-development            |
| Dev-log     | No                                | Yes (with `--log`)          |
| Judge       | Always                            | Always                      |
| Artifacts   | Optional (`--artifact-dir`)       | Optional (`--artifact-dir`) |
| Scenarios   | Built-in + YAML + custom `--task` | Built-in + YAML only        |
| Safety gate | `SIKONG_RUN_LIVE_AGENT_TESTS=1`   | Same                        |
| CLI         | `eval` subcommand                 | `dogfood` subcommand        |

Both share the same underlying `run_task_run_split_eval_async` engine path.
The difference is in the CLI entry point and the optional dev-log recording.

### Socket Protocol in the Dogfood Flow

Each `ProcessAgentRunScheduler` instance spawns its own Bun agent-host child
process with a unique Unix socket:

```
For the actor (1 scheduler):
  /tmp/siko-agent-host-XXXXXX/agent-host.sock

For the judge (1 scheduler):
  /tmp/siko-agent-host-YYYYYY/agent-host.sock
```

Each scheduler sends one `run` JSONL message and waits for the `result` response.
The `id` field in each message ensures responses are matched to requests even if
multiple in-flight messages were theoretically possible (currently serialized).
