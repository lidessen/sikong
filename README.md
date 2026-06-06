# Sikong (司空)

A headless workflow engine for agent-driven project development.

Sikong models work as **workflow instances** with staged state machines, append-only
event timelines, and **wake loops** that drive `agent-loop` workers until a task
reaches a terminal stage. Agents do not mutate state directly — they call workflow
tools; a deterministic reducer records events and guards decide when stages advance.

## Why Sikong

Open and openly available paid models are already strong enough to do meaningful
development work. The remaining bottleneck is increasingly an engineering
problem, not a reasoning problem: keeping work scoped, preserving state across
runs, assigning the right worker, capturing evidence, reviewing acceptance,
isolating parallel branches, and making progress inspectable and recoverable.

More reasoning alone does not solve those problems. If a worker forgets context,
tests the wrong thing, overwrites another worker's changes, or claims completion
without reviewable evidence, a smarter next token is not the missing primitive.
The missing primitive is an engineering system around the model.

Sikong is an attempt to practice that directly: solve engineering problems with
engineering mechanisms. Work becomes durable state, agent actions become validated
commands, progress is recorded as events, and acceptance is a lead decision over
submitted evidence rather than an agent's self-report.

This project also treats model choice as an engineering variable. Sikong is built
to prefer models that individual builders can afford to run. You can still use
frontier models such as Claude when you want to, but the project is designed to
prove that you should not need them by default. The point is not to chase the
most expensive reasoning; it is to build a system that can get reliable work out
of practical, high-value models.

This repository is a Bun workspaces monorepo with two packages:

| Package | Role |
| ------- | ---- |
| [`packages/sikong`](packages/sikong) | The product — a CLI-only npm package. Workflow engine, durable JSONL stores, project isolation, workers, and inspection commands. |
| [`packages/agent-loop`](packages/agent-loop) | The execution library (private). One unified `AgentLoop` over Claude Agent SDK, Codex, Cursor, and Vercel AI SDK, with **runtime ⊥ provider** — one credential can drive any compatible runtime. |

```text
WorkflowDef → Task timeline → Wake → agent-loop worker → Commands → Events → Projection
                                      ↘ Guard-driven stage advancement
```

## Install

```sh
npm install -g sikong
```

The published package is a small launcher. `npm install` pulls the matching
platform binary (`sikong-darwin-arm64`, `sikong-linux-x64`, …) as an
optional dependency. Supported platforms: `darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `windows-x64`.

```sh
sikong help
sikong overview          # human-readable snapshot of projects, workers, tasks
sikong create "fix auth" # agent-facing commands default to JSON; use --text for plain text
```

Workspace data lives under `~/.sikong` by default. Override the home with
`SIKONG_HOME`; use legacy `SIKONG_DIR` or `--dir` for explicit isolated
stores in tests, smokes, and migration.

See [`packages/sikong/README.md`](packages/sikong/README.md) for CLI
commands, live smokes, and release notes.

## Develop from source

Requires [Bun](https://bun.sh) 1.3+.

```sh
bun install
bun run typecheck   # tsc --noEmit in every package
bun run test        # vitest in every package
bun run build       # compile packages/sikong/dist/sikong
```

Per-package:

```sh
bun run --filter agent-loop test
bun run --filter sikong build:cli
packages/sikong/dist/sikong help
```

Live provider smokes need credentials in an interactive shell (see
[`CLAUDE.md`](CLAUDE.md#credentials)). Example:

```sh
cd packages/sikong
DEEPSEEK_API_KEY=... bun run smoke:deepseek-tools
```

Release gate before publishing:

```sh
bun run release:check
```

CI runs typecheck and tests on every push/PR, then builds and smoke-tests the
compiled CLI on macOS arm64 (`.github/workflows/ci.yml`).

## When to use which layer

**Use `sikong`** when you want a durable, file-backed workspace an agent (or
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
- [`design/areas/workspace-engine.md`](design/areas/workspace-engine.md) — `sikong`
- [`design/decisions/`](design/decisions/) — durable ADRs

Durable shape changes (module boundaries, state model, persistence semantics,
runtime contracts, user-visible workflow behavior) need a decision record before
implementation.

## License

MIT — see [LICENSE](LICENSE).
