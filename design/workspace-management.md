# Workspace Management

## Purpose

Sikong manages multiple workspaces from one local Sikong home.

A workspace is Sikong's project-level namespace for tasks, preferences, state,
and runtime artifacts. It replaces the earlier `project` term.

## Terminology

- Sikong home: the local durable data root, usually `~/.sikong`.
- Workspace: Sikong's project-level namespace under the home.
- Workspace directory: the Sikong-owned state directory at
  `~/.sikong/workspaces/<workspaceId>/`.
- Agent cwd: the runtime execution directory for one agent run. It is separate
  from the workspace directory.
- Worktree: a git worktree under the workspace directory, used as an agent cwd
  when a git runtime context needs isolated parallel work.
- Task: a durable coordination process that belongs to one workspace.
- Worker: a home-level hireable agent configuration.
- Workspace preferences: lead-maintained project preferences and conventions,
  separate from task progress.

Do not call the Sikong home a workspace. The home contains registered
workspaces.

## Home Layout

Default file-backed layout:

```text
~/.sikong/
  state/
    chronicle.jsonl
  workspaces/
    <workspaceId>/
      workspace.yaml
      preferences.yaml
      worktrees/
        <taskId>/
      state/
        events/<taskId>.jsonl
        projections/<taskId>.json
  workers/
    <workerId>.yaml
```

The home owns global locks, global chronicle state, workspace registry, worker
registry, and isolation artifacts. It does not own task semantics.

## Workspace Directory vs Agent Cwd

The workspace directory is a Sikong state namespace. It is not a source checkout
and not the default agent execution directory.

```text
Workspace dir = ~/.sikong/workspaces/<workspaceId>/
Agent cwd     = runtime-provided execution/materialized work area
```

Agent runs must receive an explicit runtime cwd from their run context or
runtime adapter. For git work, the cwd should be a workspace-owned worktree,
such as:

```text
~/.sikong/workspaces/<workspaceId>/worktrees/<taskId>/
```

If no valid agent cwd can be resolved, the run should fail and ask for clearer
runtime context. It should not silently use the workspace directory.

## Workspace Definition

The first `WorkspaceDef` should stay small:

```ts
type WorkspaceDef = {
  id: string;
  name: string;
};
```

Field rationale:

| Field  | Required | Why it exists                                 |
| ------ | -------- | --------------------------------------------- |
| `id`   | yes      | Stable task ownership and file layout key.    |
| `name` | yes      | Human-facing label for CLI and inspect views. |

Do not include these in the first `WorkspaceDef`:

- `defaultWorkflowId`: the old workflow DSL is replaced by `PlanDef`.
- `preferences`: preferences are accessed through a replaceable interface.
- `allowedPaths`, source paths, or repo paths: runtime context owns execution
  inputs.
- `defaultWorkerId` and `env`: worker selection and runtime environment belong
  outside the workspace definition.
- `sandbox`: runtime permission policy belongs to worker/runtime adapters.
- `integrations`, `skills`, or `mcp`: defer until runtime context needs them.

## Workspace Store

`WorkspaceStore` manages definitions only:

```ts
interface WorkspaceStore {
  get(id: string): Promise<WorkspaceDef | null>;
  put(workspace: WorkspaceDef): Promise<void>;
  list(): Promise<WorkspaceDef[]>;
  delete(id: string): Promise<void>;
}
```

The default implementation stores definitions under:

```text
workspaces/<workspaceId>/workspace.yaml
```

Deleting a workspace registration removes Sikong-owned metadata and runtime
artifacts only. It must not delete external source directories or repositories.
The first implementation should reject deletion while the workspace has live
tasks.

## Git Worktrees

Worktrees are runtime artifacts owned by a workspace. They support multiple
parallel feature-development or repair efforts for the same repo without
clobbering one checkout.

Git capability is inferred from the run context, not stored in `WorkspaceDef`.
When a run context points at a git repository, runtime may create a worktree
under the workspace directory and use that worktree as the agent cwd.

Runtime cwd policy:

- the resolved git repository is for user/manual operation and worktree creation
  only;
- every git-touching agent run receives a worktree cwd;
- worktrees are owned by the workspace under
  `workspaces/<workspaceId>/worktrees/`;
- coordination records task and worker results, while runtime owns worktree
  creation and cleanup.

The first implementation can keep the allocation policy simple:

```text
workspaces/<workspaceId>/worktrees/<taskId>/
```

If later stages need multiple concurrent writable workers for the same task, the
runtime can allocate run-scoped worktrees beneath that task:

```text
workspaces/<workspaceId>/worktrees/<taskId>/<runId>/
```

The key invariant is stable: when runtime resolves a git repository, agent
execution does not use that repository as cwd for git work. If no git
repository is identified in the run context, runtime should not create a
worktree.

## Workspace Preferences

Workspace preferences are long-lived project preferences, conventions, and
constraints. They are not the task timeline, not stage progress, and not a
place for transient worker notes. They are also not the client work log used by
the UI-embedded `Client Agent`.

Good preference entries:

- standard verification commands;
- code style or dependency constraints;
- architectural boundaries;
- operator preferences such as inspection before rerun;
- repository-specific generated-file or safety rules.

Do not store:

- current task progress;
- worker intermediate summaries;
- one-off investigation notes;
- unconfirmed guesses;
- long task reports;
- cross-workspace client-agent memory.

Preferences are modeled as a bound list object:

```ts
interface WorkspacePreferences {
  read(): Promise<WorkspacePreference[]>;
  write(preferences: WorkspacePreference[]): Promise<void>;
  append(preference: WorkspacePreferenceInput): Promise<WorkspacePreference>;
}

type WorkspacePreference = {
  id: string;
  text: string;
  note?: string;
  sourceTaskId?: string;
};

type WorkspacePreferenceInput = {
  text: string;
  note?: string;
  sourceTaskId?: string;
};
```

The object does not receive a `workspaceId`. It represents one already-resolved
preferences target.

An outer factory binds a `WorkspaceDef` to an implementation:

```ts
interface WorkspacePreferencesFactory {
  open(workspace: WorkspaceDef): WorkspacePreferences;
}
```

Default file-backed implementation:

```ts
class FileWorkspacePreferencesFactory implements WorkspacePreferencesFactory {
  constructor(private readonly homeDir: string) {}

  open(workspace: WorkspaceDef): WorkspacePreferences {
    return new FileWorkspacePreferences(
      join(this.homeDir, "workspaces", safe(workspace.id), "preferences.yaml"),
    );
  }
}
```

Default YAML shape:

```yaml
version: 1
preferences:
  - id: verify
    text: Run `bun run check` before handing off changes.
    note: This is the repository's aggregate local verification command.
    sourceTaskId: task_123
```

An external implementation such as `shilu` only needs to provide the same bound
object:

```ts
class ShiluWorkspacePreferences implements WorkspacePreferences {
  read(): Promise<WorkspacePreference[]> {}
  write(preferences: WorkspacePreference[]): Promise<void> {}
  append(preference: WorkspacePreferenceInput): Promise<WorkspacePreference> {}
}
```

This keeps `WorkspaceDef` independent from preferences provider configuration.

## Preferences Read Policy

Workspace preferences are lead-controlled context. Sikong should not
automatically inject them into every agent run.

Default read path:

- when a lead starts or resumes a task, it reads workspace preferences;
- the lead decides which preferences are relevant to the task;
- relevant context is copied into the planning request, task brief, or lead
  instructions as ordinary task context.

Planner, worker, stage reviewer, and final reviewer runs do not receive
workspace preferences automatically. They only see preference-derived context
when the lead deliberately includes it in the task context.

Preferences can also be read by explicit operator/API commands:

```text
sikong workspace preferences list <workspaceId>
sikong workspace show <workspaceId>
```

Reducers, projection builders, and runtime context builders must not read
preferences implicitly. They fold durable task events and construct run input
from explicit task context only.

## Preferences Write Policy

Workspace preferences are changed only through deliberate lead/operator edit
paths.

Allowed edit paths:

- explicit operator command, such as `workspace preferences edit` or
  `workspace preferences append`;
- lead preference edit at task completion;
- direct API call by a trusted host application.

Workers, planners, and reviewers should not update workspace preferences
directly.
They may report durable learnings in their task result or review report. At the
end of the task, the lead decides whether any of those learnings are worth
recording by editing or appending preference entries.

This keeps failed, partial, or speculative work from polluting long-lived
workspace context.

## Task-End Preference Maintenance

After final review, the lead may maintain preferences when a task produced
durable workspace knowledge:

```ts
type WorkspacePreferenceMaintenance = {
  taskId: string;
  preferences: WorkspacePreference[];
};
```

This is not automatic. The first implementation should support explicit
preferences edit/append commands and a lead-facing task-end preferences
maintenance path. It should not generate or apply preference changes without
lead/operator action.

## Workspace Resolution

Task creation resolves a workspace in this order:

1. explicit `--workspace`;
2. fail with guidance to create or select a workspace.

Do not keep a built-in `default` workspace pointing at `"."`. Workspace
selection should not depend on cwd or implicit home config in the first
implementation.

## Commands

Initial CLI surface:

```text
sikong home init
sikong workspace add <id> [--name <name>]
sikong workspace list
sikong workspace show <id>
sikong workspace set-default <id>
sikong workspace preferences list <id>
sikong workspace preferences edit <id>
sikong workspace preferences append <id>
sikong workspace remove <id>
```

Task creation should use:

```text
sikong task create --workspace <id> "<request>"
```

## First Implementation Slice

1. Add home layout helpers and safe workspace id validation.
2. Add `WorkspaceDef` and file-backed `WorkspaceStore`.
3. Add `WorkspacePreferences`, `WorkspacePreferencesFactory`, and file-backed
   `preferences.yaml`.
4. Add tests for add/list/get/remove and preference read/write/append.
5. Add workspace resolution from explicit id and default id.
6. Add workspace-owned worktree allocation from runtime-provided git context.
7. Thread `workspaceId` into task creation and coordination events.
