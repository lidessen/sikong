# Daemon And Runtime Processes

## Purpose

The Go CLI and daemon layer exists to own host process concerns. It must not
turn the TypeScript workspace engine into a single global Bun runtime that
serializes all work.

The previous single-instance shape caused parallelism problems. The new design
must preserve durable coordination while allowing independent process runs to
execute concurrently when resource limits allow it.

The daemon is not an agent orchestrator. It does not know what a planner,
worker, reviewer, or Task Lead means. Those roles belong to the TypeScript
workspace engine and Agent Lead.

## Process Model

There are two different process shapes:

### CLI One-Shot

```text
External Agent
  -> sikong CLI invocation
    -> one Bun command process
      -> one command handler request
      -> JSON result
```

This is acceptable for external-agent CLI use. Separate CLI invocations can run
as separate OS processes. The CLI must not keep a global Bun singleton.

The Go CLI may be a process adapter that locates the TypeScript command
entrypoint and forwards argv/stdin/stdout/stderr. It should not implement
coordination semantics.

### Daemon Supervisor

```text
sikongd
  -> local API / IPC server
  -> generic process supervisor
  -> many Bun child processes
       process run
       process run
       process run
```

The daemon is one Go supervisor process, not one Bun execution process. It may
start many Bun child processes and supervise their lifecycle.

The daemon receives process specs. It does not decide which task role should
run next.

```ts
type ProcessRunSpec = {
  runId: string;
  workspaceId: string;
  taskId?: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  labels?: Record<string, string>;
};
```

`labels` are non-semantic metadata for inspect and debugging only. Daemon logic
must not branch on labels such as `planner`, `worker`, or `reviewer`.

The local daemon API is HTTP on loopback by default. `sikongd` listens on
`127.0.0.1:8765` unless `SIKONG_DAEMON_ADDR` is set.

```text
GET  /health
POST /process-runs
GET  /process-runs?workspaceId=<id>&taskId=<id>&state=running|finished&limit=<n>
GET  /process-runs/:runId
GET  /process-runs/:runId/wait?timeoutMs=<ms>
POST /process-runs/:runId/cancel
GET  /scheduler/status
POST /scheduler/wake
POST /scheduler/pause
POST /scheduler/resume
GET  /tasks/runnable
POST /shutdown
```

All process endpoints return generic process snapshots. A snapshot can be
`running` or `finished`. Finished snapshots carry a `ProcessRunResult`.
Failed, timed-out, or cancelled process results remain process facts; they do
not automatically become task failures.

## Go Responsibilities

The Go daemon owns:

- local API or IPC serving;
- process lifecycle and signal handling;
- child-process spawning;
- cancellation, timeout, and kill behavior;
- resource-based concurrency limits;
- workspace/task/run process slots;
- stdout/stderr capture;
- local health and daemon status;
- safe shutdown.

The Go daemon does not own:

- task reducer semantics;
- plan/stage/review business logic;
- planner/worker/reviewer orchestration;
- Task Lead decisions;
- prompt construction;
- agent runtime adapters;
- `agent-loop.runTask` implementation.

## TypeScript Responsibilities

TypeScript owns:

- command handlers;
- coordination reducer and projection;
- Agent Lead orchestration;
- planner/worker/reviewer run semantics;
- generic `ProcessRunSpec` execution helper and Bun process-runner entrypoint;
- runtime context resolution;
- git worktree allocation policy;
- `agent-loop.runTask` integration;
- typed tool adapters for the Client Agent.

TypeScript command handlers should remain request-scoped and should avoid
global mutable scheduler state.

If TypeScript needs to start a runtime-backed run, it asks the Go daemon to
start a generic process using a `ProcessRunSpec`. TypeScript then interprets the
process result and appends domain events. The daemon returns process facts; it
does not append planner, worker, or review domain events by itself.

The Go daemon also owns the process-level scheduler. That scheduler is a
liveness mechanism, not the coordination source of truth: it scans durable task
projections, runs the workspace CLI `task tick` command for runnable tasks, and
wakes again when a tick finishes or when the Client Agent submits new work. Each
tick re-enters TypeScript command handlers, which derive the next action from
the current projection and append all task-domain events.

Scheduler-driven ticks are intended for long tasks. The default scheduler
process timeout is 2 hours and the default wait timeout is 2 hours plus 60
seconds. They are safety fallbacks, not normal turn boundaries. Local operators
may override them with `SIKONG_SCHEDULER_PROCESS_TIMEOUT_MS` and
`SIKONG_SCHEDULER_WAIT_TIMEOUT_MS`; `/scheduler/status` exposes the effective
values.

The TypeScript orchestration driver may repeatedly load projection state, plan
the next action, and request runtime-backed process runs until it reaches a
lead wait, worker-results wait, terminal state, blocked state, or action
budget. That driver remains a TypeScript client of the daemon process API; it
does not move orchestration semantics into Go.

The Bun workspace package also provides a standalone process runner entrypoint:

```text
bun packages/workspace/src/process/runner.ts --spec <spec.json>
```

The runner reads a generic `ProcessRunSpec`, executes exactly one subprocess,
captures stdout/stderr/exit/timeout, prints one structured JSON result, and
exits. It has no agent kind or role field.

## Concurrency Rule

Do not implement the daemon as:

```text
Go daemon -> one long-running Bun engine -> serial task execution
```

Long-running or runtime-backed units must be independent child processes or a
bounded multi-process pool supervised by Go.

The daemon may keep lightweight Go state for leases, waits, and child process
tracking, but durable task state remains event-sourced under the workspace.
Any decision about which planner, worker, or reviewer should run next belongs
to the TypeScript engine, not to the daemon.

## Storage Safety

File-backed storage must be safe under daemon-managed concurrency.

Before enabling concurrent worker/reviewer writes to the same task log, event
append must use a per-task file lock or equivalent serialization. Projection
updates must be derived from the event log and written atomically.

Minimum file-backed rule:

```text
append task event:
  acquire lock for workspaces/<workspaceId>/state/events/<taskId>.jsonl
  append exactly one JSONL record or one same-task batch
  release lock
  rebuild or invalidate projection
```

The file-backed task event store uses a per-task lock file for append and
projection rebuild. Runtime-backed code should use the locked append/rebuild
API rather than appending events and rebuilding projections as separate steps.

## Request Shape

Even when the daemon supervises many child processes, public commands should
stay one request to one structured response:

```text
CLI/tool request -> command handler -> command result
```

If a command starts background execution, the result returns task/run identity
and current projection. Follow-up progress is observed through task inspect,
wait, trace, or monitor mechanisms.

## Daemon Implementation Order

1. Add file-backed per-task append locking.
2. Add the Bun-side generic process runner.
3. Make Go daemon spawn generic child processes from `ProcessRunSpec`.
4. Track child process lifecycle and cancellation in Go.
5. Add a small local daemon API for command handlers.
6. Let the TypeScript engine request runtime-backed processes and interpret
   their results.
7. Add wait/monitor wake behavior over event-log projections.

Item 1 is implemented in the Bun workspace package.
Item 2 is implemented in the Bun workspace package.
Items 3 and 4 are implemented in `internal/daemon` as a generic process
runner/supervisor.
Item 5 is implemented in `internal/daemon` as a small process-only HTTP API.
The API includes `/health` for status checks and `/shutdown` for graceful
daemon process-control shutdown.
The TypeScript process client is implemented in the Bun workspace package.
Item 6 is implemented as a process boundary: the TypeScript orchestration
action executor can run injected loop/task primitives and command handlers, and
`src/orchestration/runner.ts` can execute a serialized runner request inside a
daemon-managed Bun child process. The request JSON carries data only. Live
tools, loop factories, and runtime-specific permissions are assembled inside
the child process by a runtime module or the named runtime assembly registry.
The serializable runner request explicitly strips executable fields such as
tools, skills, MCP servers, hooks, loop factories, and `runTask`.

The current runner boundary is:

```text
TypeScript orchestration
  -> write runner request JSON
  -> create generic ProcessRunSpec
  -> daemon starts `bun ./src/orchestration/runner.ts --spec <request>`
  -> runner loads external runtime module or data-only runtimeAssembly config
  -> runner calls executeOrchestrationAction
  -> command handlers append task events when the action requires it
  -> process-backed executor parses the runner output envelope
```

The default runtime assembly registry provides the structural boundary, with
agent-loop backend names (`mock`, `ai-sdk`, `claude-code`, `codex`, and
`cursor`) plus Sikong's protocol profiles for plan submission, stage review,
and final review.

Runtime assembly also applies task runtime cwd and adapter-native permission
defaults inside the Bun child process:

- `claude-code`: set `cwd` and `allowedPaths` from task runtime cwd when not
  supplied by caller options;
- `codex`: set `cwd`, default `fullAuto: true`, and default
  `sandbox: "workspace-write"` when caller options do not override them;
- `cursor`: set `cwd` and default `sandboxEnabled: true` when caller options do
  not override them;
- AI SDK: expose explicit `ai-sdk-local-inspection` and
  `ai-sdk-local-execution` tool profiles because AI SDK needs a tool bundle.

The Go daemon still sees only a generic process spec and process result.
The TypeScript process-backed action executor treats stdout as the runner's
structured transport envelope only; task results still come from protocol tools
and command handlers inside the runner process.
It records runtime process start and finish facts in the task log so a separate
`task cancel` command can cancel daemon processes that are still running. These
facts remain process metadata and do not imply task success or failure.

The CLI `task drive` command is an adapter over this TypeScript driver and
process-backed action executor. The daemon scheduler uses the narrower
`task runnable` and `task tick` commands so scheduling stays in Go while domain
state transitions stay in TypeScript.
