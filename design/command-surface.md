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
- resolve workspace and home context;
- call stores and engine APIs;
- return structured success or error results.

The engine owns durable coordination semantics:

- event append and reduction;
- plan and stage lifecycle;
- worker scheduling;
- reviewer decisions;
- runtime execution through `agent-loop.runTask`.

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
  homeDir: string;
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
waitTask({ workspaceId?, taskId, timeout? })
steerTask({ workspaceId?, taskId, message })
cancelTask({ workspaceId?, taskId, reason? })
```

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
workspace_not_found
workspace_exists
preference_not_found
task_not_found
task_not_running
runtime_context_required
runtime_cwd_not_found
runtime_repo_not_found
task_wait_timeout
task_already_terminal
internal_error
```

Adapters may map errors to exit codes or tool failures, but the code string must
remain stable.

## Forbidden Shortcuts

The first command surface should not expose low-level reducer operations:

- no generic `appendEvent`;
- no manual `advanceStage`;
- no direct `completeWorkerRun`;
- no direct `acceptStageReview`;
- no direct `writeProjection`.

Those actions belong behind engine APIs. The public command surface stays at the
level of workspace, preferences, tasks, and inspect views.

## Implementation Order

1. Define handler input and output types.
2. Implement workspace and preference handlers over `@sikong/workspace`.
3. Add CLI adapter for workspace and preference commands.
4. Add tool adapter for the same handlers.
5. Add task event/projection handlers after the coordination reducer exists.
6. Add runtime-backed task execution once cwd and worktree resolution are ready.
