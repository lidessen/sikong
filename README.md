# sikong

Sikong is a **Rust-based** recursive agent engine for self-improving autonomous task execution. The Rust implementation in `src/` is the active mainline; an older Go/Bun workspace/client track remains in the repository as pre-cleanup reference material.

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

## Legacy Go/Bun Track (Reference Only)

The Go CLI (`cmd/sikong`, `cmd/sikongd`) and Bun workspace packages (`packages/agent-loop`, `packages/client`, `packages/workspace`) are preserved as reference material from an earlier implementation track. They are not actively maintained.

```bash
# Legacy development commands (Go/Bun)
bun run dev:cli
bun run dev:daemon
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
├── cmd/                # Legacy Go CLI (reference only)
├── internal/           # Legacy Go packages (reference only)
└── packages/           # Legacy Bun workspaces (reference only)
    ├── agent-loop/
    ├── agent-host/
    ├── client/
    └── workspace/
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

# Legacy Go/Bun checks
bun run check
bun run typecheck
bun run lint
bun run fmt:check
```
