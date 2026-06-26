# sikong

Sikong is a **Rust-based** recursive agent engine for self-improving autonomous task execution.

## Rust Mainline

The Rust crate (`Cargo.toml` → `src/`) provides:

- **`siko` binary** — recursive task engine with plan/resolve/specify/execute/verify/commit cycle
- **Workspace providers** — `FileSystem`, `GitFileSystem`, `Memory` for sandboxed task execution
- **Assistant loop** — LLM-driven agent with tool-calling and ACP JSON-RPC protocol
- **CLI** — `siko tui`, `siko send`, `siko task`, `siko acp`, `siko daemon`, `siko setup`, `siko metrics`

### Development

```bash
# Build the Rust binary
cargo build

# Run tests
cargo test

# Send a task through the daemon-owned assistant/task board
cargo run -- send "analyze this project"

# Open the daily terminal UI
cargo run -- tui

# Inspect task history and live progress
cargo run -- task list
cargo run -- task inspect <task-id>

# Serve ACP over stdio for editor/external clients
cargo run -- acp

# Manage the daemon explicitly when needed
cargo run -- daemon status
cargo run -- daemon stop
```

Release builds:

```bash
cargo build --release --bin siko
```

## Design

Start with [design/README.md](design/README.md).

## Project Structure

```text
.
├── src/                # Rust mainline (active)
│   ├── task_run/       # Recursive engine, operation harness, governance
│   ├── task_board/     # Assistant task records, stores, queue, views
│   ├── agent_run/      # Agent run protocol and scheduler
│   ├── workspace/      # Workspace providers, scope checks, resource facts
│   ├── interface/      # CLI, ACP assistant surface, daemon
│   └── common/         # Config, metrics, shared primitive types
├── tests/              # Rust integration tests
├── design/             # Architecture & design documentation
├── packages/
│   ├── agent-host/     # External agent process (Bun)
│   └── agent-loop/     # Agent loop and tool abstraction (Bun)
└── evals/              # Task-run eval scenarios
```

## Setup (Rust)

```bash
# Install Rust toolchain (if needed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build and run
cargo build --release
./target/release/siko --help
```

## Checks

```bash
# Rust checks
cargo check
cargo clippy
cargo fmt --check

# TypeScript checks (using Bun workspace)
bun run check
bun run typecheck
```

Internal live evals are hidden from normal help output. They are for focused
regression and diagnostic runs, not normal daily task intake:

```bash
SIKONG_DEV=1 SIKONG_RUN_LIVE_AGENT_TESTS=1 \
  cargo run -- eval task-run-split --scenario sikong-project-analysis --route-only
```
