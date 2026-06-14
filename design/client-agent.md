# Client Agent

## Purpose

Sikong may be used from a UI that runs a custom `Client Agent`.

The `Client Agent` is not the same thing as Sikong's internal `Task Lead`. It is
the agent embedded in the client experience. It understands the user's daily
multi-project work context and calls typed Sikong tools.

```text
Human
  -> Client UI
    -> Client Agent
      -> Sikong tools
        -> command handlers
          -> Sikong engine
            -> Task Lead / Planner / Worker / Reviewer
```

The CLI is for external agents. The UI-embedded `Client Agent` should use typed
tools instead of shelling out to the CLI.

## Role Names

Use these names consistently:

| Name             | Meaning                                                      |
| ---------------- | ------------------------------------------------------------ |
| `External Agent` | An agent outside Sikong that calls the CLI.                  |
| `Client Agent`   | The UI-embedded agent that calls typed Sikong tools.         |
| `Task Lead`      | Sikong's internal per-task decision owner.                   |
| `Planner`        | Sikong's internal planning worker.                           |
| `Worker`         | Sikong's internal stage execution worker.                    |
| `Reviewer`       | Sikong's internal stage or final review worker.              |
| `Human Operator` | A person supervising, debugging, or steering through the UI. |

## Client Interaction Model

The UI should be conversation-shaped, but the conversation transcript is not the
agent memory.

There are three separate records:

### UI Transcript

The transcript is presentation state: user messages, client-agent responses,
visible tool calls, task cards, and local UI continuity.

It is not loaded wholesale as model context and is not the source of truth for
task state.

### Client Work Log

The client work log is the durable cross-workspace context for the `Client
Agent`.

It may contain:

- task summaries;
- cross-project decisions;
- user working preferences;
- active project status;
- follow-up reminders and unresolved threads.

It should be bounded and curated. Raw task event logs should not be copied into
the client work log.

Candidate entry shape:

```ts
type ClientWorkLogEntry = {
  id: string;
  kind: "task_summary" | "decision" | "user_preference" | "project_status";
  summary: string;
  workspaceId?: string;
  relatedTaskIds?: string[];
  createdAt: string;
};
```

The client work log is outside `WorkspaceDef`. It belongs to the client layer or
local service layer that runs the `Client Agent`.

### Task Event Log

The task event log is detailed Sikong task telemetry. It is used for inspect
views, task cards, reviews, summaries, and debugging.

It does not automatically become `Client Agent` context. Summaries may be
written to the client work log after terminal or action-required task states.

## Workspace Preferences

Workspace preferences are different from the client work log.

They are workspace-scoped project preferences and constraints, such as standard
verification commands, architectural boundaries, generated-file rules, or
operator preferences.

They should be read or maintained deliberately through Sikong tools. They are
not a general-purpose memory stream.

## Tool Surface

The `Client Agent` should call typed tools, not CLI commands.

Initial tools:

```ts
createWorkspace({ id, name })
listWorkspaces()
getWorkspace({ workspaceId })

listWorkspacePreferences({ workspaceId })
addWorkspacePreference({ workspaceId, text, note? })
removeWorkspacePreference({ workspaceId, preferenceId })

createTask({ workspaceId, request, repoPath?, cwd? })
getTask({ workspaceId?, taskId })
waitTask({ workspaceId?, taskId, timeout? })
steerTask({ workspaceId?, taskId, message })
cancelTask({ workspaceId?, taskId, reason? })

inspectTaskSummary({ workspaceId?, taskId })
inspectTaskTrace({ workspaceId?, taskId })
inspectTaskEvents({ workspaceId?, taskId })
inspectTaskProjection({ workspaceId?, taskId })
```

The tool schemas should be narrow and typed. Tool results should be structured
objects that the UI can render into cards, details, or work-log candidates.

## Wait And Monitor

The client needs two task-following modes:

### Wait

The `Client Agent` waits for a task condition and resumes the current loop with
a compact terminal or action-required summary.

Use this when the user's current request depends on the task result.

### Monitor

The current client-agent loop ends or moves on. The UI keeps task cards updated,
and terminal summaries may be proposed for the client work log.

Use this when the task can continue in the background.

## Boundaries

The `Client Agent` may create and steer Sikong tasks, but it should not mutate
low-level task events, manually advance stages, or write worker-run terminal
records.

Sikong owns the internal `Task Lead`, planner, worker, reviewer, event reducer,
and runtime execution.

The client owns transcript rendering, client work-log curation, workspace
switching UX, and mapping tool results into visible task cards.
