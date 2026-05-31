# WakeSpace

A headless workflow engine for agent-driven project development.

WakeSpace models work as **workflow instances** with staged state machines, append-only
event timelines, and **wake loops** that drive `agent-loop` workers until a task
reaches a terminal stage. Agents do not mutate state directly — they call workflow
tools; a deterministic reducer records events and guards decide when stages advance.

This repository is a Bun workspaces monorepo with two packages:

| Package | Role |
| ------- | ---- |
| [`packages/wakespace`](packages/wakespace) | The product — a CLI-only npm package. Workflow engine, durable JSONL stores, project isolation, workers, and inspection commands. |
| [`packages/agent-loop`](packages/agent-loop) | The execution library (private). One unified `AgentLoop` over Claude Agent SDK, Codex, Cursor, and Vercel AI SDK, with **runtime ⊥ provider** — one credential can drive any compatible runtime. |

```text
WorkflowDef → Task timeline → Wake → agent-loop worker → Commands → Events → Projection
                                      ↘ Guard-driven stage advancement
```

## Install

```sh
npm install -g wakespace
```

The published package is a small launcher. `npm install` pulls the matching
platform binary (`wakespace-darwin-arm64`, `wakespace-linux-x64`, …) as an
optional dependency. Supported platforms: `darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `windows-x64`.

```sh
wakespace help
wakespace overview          # human-readable snapshot of projects, workers, tasks
wakespace create "fix auth" # agent-facing commands default to JSON; use --text for plain text
```

Workspace data lives under `.wakespace` by default. Override with `WAKESPACE_DIR`
or `--dir`.

See [`packages/wakespace/README.md`](packages/wakespace/README.md) for CLI
commands, live smokes, and release notes.

## Develop from source

Requires [Bun](https://bun.sh) 1.3+.

```sh
bun install
bun run typecheck   # tsc --noEmit in every package
bun run test        # vitest in every package
bun run build       # compile packages/wakespace/dist/wakespace
```

Per-package:

```sh
bun run --filter agent-loop test
bun run --filter wakespace build:cli
packages/wakespace/dist/wakespace help
```

Live provider smokes need credentials in an interactive shell (see
[`CLAUDE.md`](CLAUDE.md#credentials)). Example:

```sh
cd packages/wakespace
DEEPSEEK_API_KEY=... bun run smoke:deepseek-tools
```

Release gate before publishing:

```sh
bun run release:check
```

CI runs typecheck and tests on every push/PR, then builds and smoke-tests the
compiled CLI on macOS arm64 (`.github/workflows/ci.yml`).

## When to use which layer

**Use `wakespace`** when you want a durable, file-backed workspace an agent (or
human) drives through a CLI: create tasks, register workflows, assign workers,
run wakes, inspect chronicles.

**Use `agent-loop` directly** when you are building your own orchestration on
top of a normalized agent runtime — one `loop.run(input)` is one full loop;
`runTask` is the outer multi-round supervisor with handoff tools. The library
ships TypeScript source with no build step inside the monorepo.

## Design

Architectural source of truth lives under [`design/`](design/):

- [`design/README.md`](design/README.md) — system shape and invariants
- [`design/areas/runtime-loop.md`](design/areas/runtime-loop.md) — `agent-loop`
- [`design/areas/workspace-engine.md`](design/areas/workspace-engine.md) — `wakespace`
- [`design/decisions/`](design/decisions/) — durable ADRs

Durable shape changes (module boundaries, state model, persistence semantics,
runtime contracts, user-visible workflow behavior) need a decision record before
implementation.

## License

MIT — see [LICENSE](LICENSE).
