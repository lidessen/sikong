# CLI

## Purpose

The Sikong CLI is an agent-facing local tool.

Its primary caller is an external agent running outside Sikong, such as Codex,
Claude Code, or another terminal automation agent. The CLI is not the primary
surface for Sikong's own UI-embedded `Client Agent`.

The CLI should feel closer to `agent-browser` than to a human administration
console: stable commands, structured output, no interactive prompts, and
predictable failure shapes.

## Callers

### External Agent

An external agent uses the CLI as a local tool surface:

```text
External Agent
  -> sikong CLI
    -> command handlers
      -> Sikong engine
```

The external agent is not automatically a Sikong `Task Lead`. It creates,
observes, waits for, steers, or cancels durable Sikong tasks.

### Human Operator

A human may run the same commands for debugging, but this is secondary. Human
readability should be provided through `--text` views instead of changing the
command contract.

### Scripts And CI

Scripts should rely on JSON output and stable exit codes. They should not parse
free-form text.

## Output Contract

Core commands emit JSON by default:

```json
{
  "ok": true,
  "data": {}
}
```

Failures use a stable shape:

```json
{
  "ok": false,
  "error": {
    "code": "workspace_not_found",
    "message": "Workspace not found.",
    "details": {}
  }
}
```

`--text` may render a human-friendly view, but it must not be the only way to
access command results.

The CLI must not ask interactive questions. If required input is missing, it
should fail with a structured error.

## Global Flags

```text
--home <path>          Override the Sikong home directory.
--workspace <id>       Select a workspace for workspace-scoped commands.
--json                 Force JSON output.
--text                 Force human-readable output.
```

`--json` and `--text` are mutually exclusive. If neither is present, core
commands use JSON.

## Command Shape

Use resource-first commands:

```text
sikong <resource> <action> [args] [flags]
```

Initial resources:

- `workspace`
- `preference`
- `task`
- `inspect`
- `daemon`
- `version`

## Workspace Commands

```text
sikong workspace create --id <id> --name <name>
sikong workspace list
sikong workspace show <workspaceId>
sikong workspace delete <workspaceId>
```

Workspace commands only manage Sikong-owned workspace metadata and directories.
They must not delete external repositories or source directories.

## Preference Commands

```text
sikong preference list --workspace <workspaceId>
sikong preference add --workspace <workspaceId> --text <text> [--note <note>]
sikong preference remove --workspace <workspaceId> <preferenceId>
```

Preferences are workspace-scoped long-lived project preferences. They are not
task progress, not UI transcript, and not the client work log.

## Task Commands

```text
sikong task create --workspace <workspaceId> --request <text> [--cwd <path>] [--repo <path>]
sikong task show <taskId> [--workspace <workspaceId>]
sikong task wait <taskId> [--workspace <workspaceId>] [--timeout <duration>]
sikong task steer <taskId> --message <text> [--workspace <workspaceId>]
sikong task cancel <taskId> [--workspace <workspaceId>] [--reason <text>]
```

`task create` starts a durable Sikong task. If `--repo` is supplied, runtime may
create a workspace-owned git worktree and use that as the agent cwd. If `--cwd`
is supplied, runtime may use that directory directly for non-git work.

If no valid runtime cwd can be resolved, task creation should fail rather than
silently using the workspace directory.

## Inspect Commands

```text
sikong inspect summary <taskId> [--workspace <workspaceId>]
sikong inspect trace <taskId> [--workspace <workspaceId>] [--follow]
sikong inspect events <taskId> [--workspace <workspaceId>]
sikong inspect projection <taskId> [--workspace <workspaceId>]
```

`task show` is the normal task status command. `inspect` commands expose deeper
diagnostic views for external agents and humans supervising a task.

## Daemon Commands

```text
sikong daemon status
sikong daemon start
sikong daemon stop
```

The daemon command group is a process control adapter. It should not contain
coordination semantics.

## Internal State Commands

Do not expose low-level state-machine commands in the first CLI:

- no `event append`;
- no `stage advance`;
- no `worker_run complete`;
- no manual stage-review mutation.

Those are engine-internal protocol operations. External agents should operate
through task-level commands and inspect views.

## Adapter Rule

CLI commands must call shared command handlers. They must not implement
workspace storage, task reduction, scheduling, or runtime execution directly.
