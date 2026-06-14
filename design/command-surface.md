# Command Surface

## Purpose

The command surface is the shared application layer beneath both the CLI and
the UI tool adapter.

```text
External Agent
  -> CLI adapter
    -> command handlers
      -> Sikong engine

Client Agent
  -> tool adapter
    -> command handlers
      -> Sikong engine
```

This prevents the CLI and tools from becoming two separate products.

## Ownership

Adapters own transport concerns:

- CLI: argv parsing, stdout/stderr, exit codes, `--json` and `--text`.
- Tool adapter: tool schemas, permission context, typed return values, UI
  rendering hints.

Command handlers own application actions:

- validate command input;
- resolve workspace and data dir context;
- call stores and engine APIs;
- return structured success or error results.

Command handlers should be request-scoped. They must not rely on a global Bun
singleton scheduler or process-local mutable state for correctness.

The engine owns durable coordination semantics:

- event append and reduction;
- plan and stage lifecycle;
- worker scheduling;
- reviewer decisions;
- runtime execution through `agent-loop.runTask`.

The Go daemon does not own these semantics. If a command handler needs
runtime-backed execution, the TypeScript engine should request a generic
process run from the daemon and interpret the process result itself.

## Result Shape

All command handlers return a structured result:

```ts
type CommandResult<T> = { ok: true; data: T } | { ok: false; error: CommandError };

type CommandError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};
```

Adapters may render the result differently, but they should not reinterpret
business semantics.

## Context

Handlers receive an explicit context object:

```ts
type CommandContext = {
  dataDir: string;
  workspaceId?: string;
  outputMode?: "json" | "text";
  now?: () => Date;
};
```

Runtime execution inputs stay on the command input, not in `WorkspaceDef`:

```ts
type RuntimeInput = {
  cwd?: string;
  repoPath?: string;
};
```

If a task requires an agent cwd and no valid runtime cwd can be resolved, the
handler should return a structured error.
For git runtime context, `task create --repo` creates a workspace-owned worktree
and stores that path as the task runtime cwd.

## Initial Commands

### Workspaces

```ts
createWorkspace({ id, name });
listWorkspaces();
getWorkspace({ workspaceId });
deleteWorkspace({ workspaceId });
```

### Preferences

```ts
listWorkspacePreferences({ workspaceId })
addWorkspacePreference({ workspaceId, text, note? })
removeWorkspacePreference({ workspaceId, preferenceId })
```

### Tasks

```ts
createTask({ workspaceId, request, cwd?, repoPath? })
getTask({ workspaceId?, taskId })
listTasks({ workspaceId? })
driveTask({ workspaceId?, taskId, runtimeAssembly?, maxActions? })
waitTask({ workspaceId?, taskId, timeoutMs?, intervalMs? })
submitPlan({ workspaceId?, taskId, summary?, stages })
acceptPlan({ workspaceId?, taskId, planId, version, report })
rejectPlan({ workspaceId?, taskId, planId, version, report, requestedChanges? })
startWorkerRun({ workspaceId?, taskId, stageId?, workerId?, objective? })
completeWorkerRun({ workspaceId?, taskId, runId, summary, report?, note? })
failWorkerRun({ workspaceId?, taskId, runId, summary, report?, note? })
exceedWorkerRunBudget({ workspaceId?, taskId, runId, summary, report?, note? })
startStageReview({ workspaceId?, taskId, stageId? })
acceptStageReview({ workspaceId?, taskId, reviewId, report })
rejectStageReview({ workspaceId?, taskId, reviewId, report, requestedChanges? })
recommendFinalReview({ workspaceId?, taskId, reviewId, recommendation, report })
acceptTask({ workspaceId?, taskId, report })
rejectTask({ workspaceId?, taskId, report })
recordRuntimeProcessStarted({ workspaceId?, taskId, processRunId, actionType })
recordRuntimeProcessFinished({ workspaceId?, taskId, processRunId, processStatus, exitCode? })
```

These task protocol commands are not generic reducer operations. They are the
validated command-layer landing points for planner tools, lead decisions,
worker terminal task tools, stage review, final review, and final lead closure.
Worker terminal result commands model the `agent-loop.runTask` terminal tool
contract and must not be replaced by stdout/stderr parsing.

### Inspect

```ts
inspectTaskSummary({ workspaceId?, taskId })
inspectTaskCompact({ workspaceId?, taskId })
inspectTaskTrace({ workspaceId?, taskId, follow? })
inspectTaskEvents({ workspaceId?, taskId })
inspectTaskProjection({ workspaceId?, taskId })
```

Summary and compact inspect views should expose runtime process counts and the
latest runtime process fact. This lets external agents discover whether
`task cancel` has anything to cancel without reading the full projection.

## Error Codes

Use stable, lower-snake-case error codes. Initial examples:

```text
invalid_input
invalid_state
workspace_not_found
workspace_exists
preference_not_found
task_not_found
timeout
runtime_cwd_not_found
runtime_repo_not_found
runtime_repo_not_git
runtime_worktree_failed
daemon_error
internal_error
```

Adapters may map errors to exit codes or tool failures, but the code string must
remain stable.

## Forbidden Shortcuts

The command surface should not expose low-level reducer operations:

- no generic `appendEvent`;
- no manual `advanceStage`;
- no direct `writeProjection`.

Those actions belong behind engine APIs. Protocol actions such as
`submitPlan`, `completeWorkerRun`, and `acceptStageReview` are allowed because
they validate current state and append only the event sequence owned by that
specific protocol step.

## Implementation Order

1. Define handler input and output types.
2. Implement workspace and preference handlers over `@sikong/workspace`.
3. Add CLI adapter for workspace and preference commands.
4. Add tool adapter for the same handlers.
5. Add task event/projection handlers after the coordination reducer exists.
6. Add runtime-backed task execution once cwd and worktree resolution are ready.

Items 1, 2, 3, 4, and the task protocol handlers from item 5 are implemented.
`packages/workspace/src/commands` owns the command handlers, the CLI adapter
exposes them to external agents, and `packages/workspace/src/tools` exposes a
thin `createClientAgentTools` adapter for UI/client-agent usage. The current
task handlers can create a durable task, submit and accept/reject a plan, record
worker terminal results, run stage/final review state transitions, close a task,
inspect summary/compact/events/trace/projection, and wait on compact task
boundaries.
`packages/workspace/src/runtime` can run one injected `agent-loop.runTask`
worker and record its terminal result through those handlers. Preset wrappers
can assemble planning, execution, and verification worker runs from prompt,
tools, skills, and context. The pure orchestration tick can decide the next
preset action from a projection, and the orchestration driver can keep executing
non-lead actions until a wait, terminal, blocked, or action-budget boundary. The
CLI exposes this through `task drive` using daemon-managed generic process runs
for runtime-backed actions. The read-only `task wait` command polls the compact
view until the same externally visible wait boundaries. The command surface does
not yet steer running loops.

Daemon status is adapter-owned process control. `sikong daemon status` may call
the process client's health endpoint and return a structured command result, but
it must not inspect task projections or decide orchestration actions.
`sikong task cancel` is also process-control oriented: it cancels running
runtime process ids already recorded on the task and records finished process
facts. It does not replace task terminal decisions.

File-backed event append is protected by a per-task lock. Runtime-backed command
handlers should use the locked append/rebuild store API so daemon-managed
parallel Bun child processes can write safely.

The client-facing tool adapter also exposes `listTasks` and `waitTask` for task
cards and caller-visible wait boundaries. It does not expose low-level reducer
operations or internal planner/worker/reviewer protocol tools to the default
Client Agent surface.
