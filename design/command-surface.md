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
```

These task protocol commands are not generic reducer operations. They are the
validated command-layer landing points for planner tools, lead decisions,
worker terminal task tools, stage review, final review, and final lead closure.
Worker terminal result commands model the `agent-loop.runTask` terminal tool
contract and must not be replaced by stdout/stderr parsing.

### Inspect

```ts
inspectTaskSummary({ workspaceId?, taskId })
inspectTaskTrace({ workspaceId?, taskId, follow? })
inspectTaskEvents({ workspaceId?, taskId })
inspectTaskProjection({ workspaceId?, taskId })
```

## Error Codes

Use stable, lower-snake-case error codes. Initial examples:

```text
invalid_input
invalid_state
workspace_not_found
workspace_exists
preference_not_found
task_not_found
runtime_cwd_not_found
runtime_repo_not_found
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

Items 1, 2, 3, and the task protocol handlers from item 5 are implemented in
`packages/workspace/src/commands` and exposed through the CLI adapter. The
current task handlers can create a durable task, submit and accept/reject a
plan, record worker terminal results, run stage/final review state transitions,
close a task, and inspect summary/events/trace. `packages/workspace/src/runtime`
can run one injected `agent-loop.runTask` worker and record its terminal result
through those handlers. Preset wrappers can assemble planning, execution, and
verification worker runs from prompt, tools, skills, and context. The pure
orchestration tick can decide the next preset action from a projection, but it
does not write events or run processes. The command surface does not yet wait on
live execution, steer running loops, or cancel runtime processes.

File-backed event append is protected by a per-task lock. Runtime-backed command
handlers should use the locked append/rebuild store API so daemon-managed
parallel Bun child processes can write safely.
