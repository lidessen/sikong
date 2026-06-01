# ADR 0003: Global wakespace home

Status: Accepted

Date: 2026-06-01

## Context

The current CLI treats a workspace directory as a caller-chosen data root, with
the default at `./.wakespace`. That was useful for early dogfood, but it couples
coordination state to the repository checkout:

- every repository needs its own ignored `.wakespace/`;
- project memory and task history move with the checkout rather than the user;
- generated worktrees risk landing inside the source repository;
- multiple checkouts of the same project cannot share one durable project
identity cleanly.

`wakespace` should behave more like a user-level coordinator. Source repositories
remain project roots, but durable coordination state, project memory, and managed
worktrees should live under a stable user data root.

## Decision

Use `~/.wakespace` as the default global data root.

The root may be overridden by `WAKESPACE_HOME`. The legacy `--dir` /
`WAKESPACE_DIR` path remains an explicit store override for tests, isolated
smokes, and migration, but normal CLI use should resolve through the home root.

The target layout is:

```text
~/.wakespace/
  config.yaml
  workers/
    <workerId>.yaml
  state/
    chronicle.jsonl
  projects/
    <projectId>/
      project.yaml
      memory.md
      workflows/
        <workflowId>@<version>.yaml
      state/
        events/
          <taskId>.jsonl
        projections/
          <taskId>.json
        config.yaml
        .lock
      worktrees/
        <taskId>/
          <worktreeName>/
      artifacts/
        <taskId>/
```

Definitions:

- `project.yaml` is the structured project definition. It records at least
  `id`, `name`, `root`, and optional defaults such as workflow, worker, env, and
  permission mode. `root` is the source repository or working directory the
  worker should operate on.
- `memory.md` is free-form project context loaded into worker prompts with a
  bounded size. It is advisory context, not task state.
- `state/` under a project is the per-project task store. Task ids currently
  remain workspace-unique for CLI simplicity, while task files are grouped by
  project. Workspace-wide views aggregate across project stores.
- root `state/chronicle.jsonl` is the workspace activity log for aggregate
  inspection. A project-local chronicle can be added later if aggregate log
  volume becomes a problem.
- `worktrees/` is reserved for wakespace-managed git worktrees. Worktrees are
  created from `project.root`, but their filesystem location is outside the
  source checkout.
- `artifacts/` is reserved for generated files that are tied to a task but are
  not part of the source repository.
- `workers/` remains global because workers are user-level execution profiles.

## Consequences

- A normal repository no longer needs a checked-in or ignored `.wakespace/`
  directory for user state.
- Project state persists across cloned checkouts when the project id is reused
  and `project.root` is updated.
- Worktree cleanup and task cleanup have one obvious namespace:
  `~/.wakespace/projects/<projectId>/`.
- The current flat store layout must be adapted by a resolver layer rather than
  spreading path joins throughout the CLI.
- Existing `./.wakespace` dogfood directories should remain readable through
  explicit `--dir .wakespace` until a migration command exists.

## Implementation Notes

Implement this behind a small path resolver before moving store code:

```ts
resolveWakespaceHome(env, cwd, flags) -> home
resolveProjectPaths(home, projectId) -> {
  projectDir,
  projectFile,
  memoryFile,
  stateDir,
  workflowsDir,
  worktreesDir,
  artifactsDir,
}
```

Expected implementation slices:

1. Add path-resolution utilities and tests. Keep `--dir` as a legacy direct
   store root.
2. Move project definitions and markdown memory to
   `~/.wakespace/projects/<id>/`.
3. Open task event/projection stores through project-aware wrappers so new task
   state is written under `projects/<id>/state`, while legacy flat task state
   remains readable during dogfood migration.
4. Add a migration/import command for existing `.wakespace` directories.
5. Add worktree allocation and cleanup commands under project `worktrees/`.

## Open Questions

- Should task ids remain project-local, or should CLI output always prefix them
  as `<projectId>/<taskId>` in aggregate views?
- Should workflows be project-local only, or should there also be a global
  workflow library under `~/.wakespace/workflows/`?
- Should `memory.md` be a single file long-term, or should it grow into a small
  directory such as `memory/index.md` plus topic files once retrieval exists?
