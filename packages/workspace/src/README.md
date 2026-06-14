# @sikong/workspace Source Layout

This package owns Sikong's TypeScript coordination and local storage primitives.
The root `index.ts` is the public API surface; subdirectories group internal
ownership boundaries.

```text
src/
  index.ts                Public package exports.
  data-dir/               Local durable data directory layout and file helpers.
    layout.ts             Path helpers for workspaces, task logs, projections, worktrees.
    file-lock.ts          Cross-process file lock helper.
    yaml.ts               Small YAML file read/write helpers.
  workspace/              Workspace registry and workspace preferences.
    store.ts              WorkspaceDef and file-backed WorkspaceStore.
    preferences.ts        WorkspacePreferences and file-backed implementation.
    worktree.ts           Workspace-owned git worktree allocation helper.
  coordination/           Durable task event model.
    types.ts              PlanDef, TaskEvent, TaskProjection, review/run/process projections.
    reducer.ts            Pure event-to-projection reducer.
    store.ts              File-backed task JSONL event store and projection store.
  commands/               Shared command handlers for CLI and future typed tools.
    types.ts              CommandResult, CommandError, CommandContext.
    workspace.ts          Workspace create/list/get/delete.
    preference.ts         Preference list/add/remove.
    task.ts               Task create/show, plan, worker-result, review, inspect, and wait helpers.
  runtime/                Worker-run core and preset wrappers.
    worker-run.ts         Runs one injected agent-loop runTask worker and records its result.
    assembly.ts           Named backend/tool-profile registry for subprocess runtime modules.
    protocol-tools.ts     Sikong plan/review protocol tools over command handlers.
    presets/              Planner, executor, and verifier preset wrappers.
  orchestration/          Pure projection-to-next-action planning.
    tick.ts               Chooses which preset action should run or where lead must decide.
    drive.ts              Repeats tick + execute until wait, terminal, blocked, or max actions.
    process.ts            Wraps orchestration runner requests as generic process runs.
    runner.ts             Orchestration subprocess entrypoint and runtime assembly boundary.
  process/                Generic subprocess execution unit.
    types.ts              ProcessRunSpec and ProcessRunResult.
    run.ts                Bun.spawn-based subprocess runner.
    runner.ts             Standalone process-runner entrypoint.
  tools/                  Typed tools for UI/client-agent integration.
    client-agent-tools.ts Thin tool adapter over command handlers.
  cli/                    External-agent-facing CLI adapter.
    index.ts              Argv parsing and command dispatch.
```

`data-dir` is intentionally named after the local durable data root. It should
not be confused with a Sikong workspace or an agent execution cwd.
