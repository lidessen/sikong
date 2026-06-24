# sikong

Sikong is a **Rust-based** recursive agent engine for self-improving autonomous task execution.

## Rust Mainline

The Rust crate (`Cargo.toml` → `src/`) provides:

- **`siko` binary** — recursive task engine with plan/resolve/specify/execute/verify/commit cycle
- **Workspace providers** — `FileSystem`, `GitFileSystem`, `Memory` for sandboxed task execution
- **Assistant loop** — LLM-driven agent with tool-calling and ACP JSON-RPC protocol
- **CLI** — `siko assistant`, `siko run`, `siko eval`, `siko dogfood`, `siko setup`, `siko metrics`

### Development

```bash
# Build the Rust binary
cargo build

# Run tests
cargo test

# Run the CLI
cargo run -- run "analyze this project"

# Run the assistant
cargo run -- assistant
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
│   ├── core/           # Engine, task run, agent run, board
│   ├── harness/        # CLI, assistant, tools, packs
│   └── common/         # Workspace providers, config, types, metrics
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
