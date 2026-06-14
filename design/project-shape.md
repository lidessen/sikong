# Project Shape

## Purpose

Sikong is a durable coordination system for agent-driven development. It should
coordinate many workers across one or more registered workspaces, while
delegating individual agent execution to `agent-loop`.

The current repository combines:

- Go binaries for user/process entrypoints.
- Bun workspace packages for agent/runtime and coordination logic.
- Local durable state under a Sikong home directory.

This document defines the intended project shape. Workspace management and the
coordination engine are defined separately in `workspace-management.md` and
`coordination-engine.md`.

## Core Boundary

There are three layers:

```text
Go CLI/daemon
  -> workspace coordination engine
    -> agent-loop runtime facade
```

`agent-loop` owns a single agent run and the simple `runTask` primitive. It is
not the multi-worker coordination layer.

The workspace coordination engine owns durable tasks, parent/child task graphs,
worker assignment, workspace context, event storage, inspection views, and wake
scheduling.

The Go layer owns process concerns: CLI entrypoints, daemon lifecycle, local IPC
or API serving, signal handling, and host integration. It should not duplicate
workflow reducers or agent runtime adapters.

## Repository Layout

Target layout:

```text
cmd/
  sikong/                 # Go CLI entrypoint
  sikongd/                # Go daemon entrypoint
internal/
  buildinfo/              # Go build/version metadata
  daemon/                 # daemon lifecycle and future IPC/API server
packages/
  agent-loop/             # backend-neutral agent runtime facade
  workspace/              # durable Sikong coordination engine, planned
design/
  README.md
  project-shape.md
  workspace-management.md
  coordination-engine.md
development-log/
```

`packages/workspace` should use package name `@sikong/workspace`.

The old package name `sikong` should remain associated with the CLI/binary
identity, not a TypeScript workspace package. This avoids confusing the Go
binary, npm launcher history, and the coordination library.

## Planned Workspace Package

`packages/workspace` should be split by ownership:

```text
packages/workspace/src/
  coordination/           # durable task graph, commands, reducer, scheduler
  store/                  # event, projection, chronicle, workspace, worker stores
  home/                   # Sikong home layout, config, and locking
  workspace/              # Workspace model, registry, resolution, and preferences
  worker/                 # Worker model, staffing, health, pooling
  engine/                 # wake runner and command tool orchestration
  runtime/                # Worker/run context -> AgentLoop, cwd, tools, hooks
  inspect/                # trace, overview, inspect wait read models
```

The coordination model is finalized at the high level in
`design/coordination-engine.md`: lead-initiated planning, planner-produced
`PlanDef`, ordered stages, stage review, final review, and worker execution
through `agent-loop.runTask`.

The important shape decision is that Sikong owns a fixed multi-worker
coordination protocol. It is not the old arbitrary workflow/stage/guard DSL and
not a copy of `agent-loop.runTask`.

## What Moves From sikong-old

Promote ideas and code only through these boundaries:

- Keep the append-only event log plus projections.
- Keep workspace as a first-class entity.
- Keep worker roster, staffing, and runtime/provider resolution.
- Keep wake inspection concepts such as trace, chronicle, and inspect wait.
- Keep worktree isolation as a runtime-boundary concern owned under workspace
  artifacts.
- Keep command tools as the structured way a worker updates durable state.

Do not copy old files wholesale. Several old files combine too many concerns and
should be split before or during migration.

## What Does Not Move Initially

Defer these until the coordination engine is stable:

- npm platform package release scripts.
- promotion evidence and local stable install scripts.
- multi-workspace orchestrator.
- visual design workflow tooling.
- release workflow.
- historical builtin workflow compatibility versions.
- full worker health and pooling policy.

## Process Boundary

The first implementation can let the Go CLI/daemon call a Bun workspace command
or long-running TypeScript service. That is an implementation detail.

The design constraint is stronger:

- Go may host and supervise.
- TypeScript workspace code owns coordination semantics.
- `agent-loop` owns runtime adapters and agent execution.

If a later implementation needs a persistent local service, define a small
structured API between Go and the workspace engine rather than importing
coordination semantics into Go.

## Caller Surfaces

Sikong has two caller surfaces over the same command handlers:

```text
External Agent
  -> sikong CLI
    -> command handlers
      -> workspace coordination engine

Client UI
  -> Client Agent
    -> Sikong tools
      -> command handlers
        -> workspace coordination engine
```

The CLI is for external agents and scripts. The UI-embedded `Client Agent`
should use typed tools instead of shelling out to the CLI.

Neither surface should duplicate coordination semantics. Both adapters should
call shared command handlers, and command handlers should call the workspace
coordination engine.

The `Client Agent` is not the internal `Task Lead`. The `Task Lead` remains a
Sikong task role managed by the engine.

## State Layout

The default durable home should remain outside source checkouts:

```text
~/.sikong/
  workspaces/<workspaceId>/workspace.yaml
  workspaces/<workspaceId>/preferences.yaml
  workspaces/<workspaceId>/worktrees/<taskId>/
  workspaces/<workspaceId>/state/events/<taskId>.jsonl
  workspaces/<workspaceId>/state/projections/<taskId>.json
  workers/<workerId>.yaml
  state/chronicle.jsonl
```

File-backed JSONL/projection storage is the first target. A database projection
can be added later if query pressure justifies it.

## Immediate Build Order

1. Add design docs for the project shape and coordination engine.
2. Create `packages/workspace` with only pure model/reducer tests.
3. Add file-backed stores.
4. Add home, workspace, preferences, and worker registries.
5. Add a minimal wake runner over `agent-loop.run`.
6. Add inspect/trace read models.
7. Wire the Go CLI to the workspace package.
8. Add runtime-provided cwd handling and git worktree allocation.

## Non-Goals

- Recreating the old `packages/sikong` package as-is.
- Making Go the owner of task-state semantics.
- Reintroducing a user-defined workflow DSL before the multi-worker
  coordination protocol is proven.
- Treating `agent-loop.runTask` as the top-level Sikong task engine.
