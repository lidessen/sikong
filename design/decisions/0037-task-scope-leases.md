# 0037 - Task scope leases for parallel workspace execution

Status: Accepted
Date: 2026-06-12
Relates: 0009 (lead creates team), 0010 (optional subtask isolation), 0011 (task dependencies), 0034 (operator messages require lead review)

## Context

Sikong currently protects a workspace with a coarse write lock. That keeps JSONL
state safe, but it also serializes independent work: two tasks in one workspace
cannot be driven by separate `run` commands even if they touch unrelated parts of
the project.

The desired behavior is narrower: independent tasks should run concurrently, but
tasks that can interfere with each other must not. File paths are not enough to
decide that. Two tasks may edit different files while still changing one shared
contract, package export surface, database schema, test infrastructure, release
artifact, or project root state.

Sikong should keep the mechanism simple. The lead decides the semantic work
boundary. The engine only enforces declared conflicts.

## Decision

Introduce task scope leases. A lease is a small declarative resource claim:

```ts
type ScopeMode = "read" | "write";
type ScopeLease = { mode: ScopeMode; scope: string };
```

Scope strings are hierarchical, typed names. Examples:

- `project:semajsx-next`
- `package:packages/ui`
- `dir:packages/ui/src/primitives`
- `file:packages/ui/src/Switch.tsx`
- `api:ui-public-exports`
- `schema:app-db`
- `release:npm`
- `git:index`

The scheduler treats scopes mechanically:

- read/read never conflicts;
- write/write conflicts when scopes are equal or one is an ancestor of the other;
- read/write conflicts by the same equal-or-ancestor rule;
- unrelated typed scopes do not conflict.

The engine does not infer whether two scopes are semantically related. If two
tasks can affect the same behavior through different files, the lead must claim a
larger logical scope such as `package:packages/ui` or `api:ui-public-exports`.

## Defaults

The default must be conservative:

- A coding task without declared scopes claims `write:project:<projectId>`.
- A non-coding task without declared scopes claims `read:project:<projectId>`.
- A lead-created subtask may narrow its scopes when the lead can state the
  boundary.
- An isolated git-worktree subtask may claim a narrower write scope for project
  files, but still claims any shared logical scope it changes, such as package
  exports, release artifacts, or database schema.

This makes undeclared work safe by default and lets concurrency appear only where
the lead has explicitly bounded it.

## CLI and storage shape

The workspace-level write lock should no longer cover the whole duration of a
worker wake. Long-running work uses task scope leases instead.

Tasks store optional declared scopes as task data:

```ts
type TaskScopes = { read?: string[]; write?: string[] };
```

`create`, `create_subtask`, and future lead-edit commands may set or narrow this
field. A task's effective leases are derived from this field plus the conservative
defaults above.

Active lease records are workspace state, separate from task timelines:

```ts
type ActiveScopeLease = {
  taskId: string;
  wakeId: string;
  mode: ScopeMode;
  scope: string;
  ownerPid?: number;
  acquiredAt: number;
  expiresAt: number;
};
```

Lease records are best-effort durable facts with a short TTL. A healthy `run`
process refreshes the lease while the wake is active. A later scheduler may
reclaim expired leases before acquiring new ones. This avoids a crashed process
blocking independent work forever without requiring a full daemon.

Short metadata writes still need small critical sections:

- project, worker, workflow, and config edits keep a workspace metadata lock;
- task event appends require per-task expected-sequence protection;
- task projection writes are atomic and rebuildable from the event log;
- chronicle appends need an append-safe sequence strategy that works across
  concurrent writers.

The implementation first adds store-safe append semantics, then replaces the long
`run` lock with scope lease acquisition. Metadata writes still use the coarse
workspace lock.

## Scheduling

Before a wake starts, the engine resolves the task's effective leases and tries
to acquire them:

1. Load the live task projection.
2. Resolve declared leases, applying defaults if missing.
3. Check active leases in the workspace.
4. If compatible, acquire leases and start the wake.
5. If incompatible, leave the task pending and record a factual scheduling
   chronicle entry.
6. Release leases when the wake ends, errors, is cancelled, or times out.

Leases are task-level scheduling facts, not acceptance facts. A task can hold
the right scopes and still produce bad work. The lead still reviews evidence.

If a task cannot acquire leases, the engine does not classify it as blocked or
failed. It remains pending. The chronicle entry is only a scheduling fact, so a
lead can decide whether to wait, narrow scopes, add `dependsOn`, or cancel.

## Subtasks and dependencies

`create_subtask` should accept optional scope declarations. `dependsOn` remains
the right tool for known logical order. Scope leases are not a replacement for a
DAG:

- use `dependsOn` when B must start after A;
- use scope leases when A and B can run in either order but must not overlap;
- use both when a layered effort also shares a broad resource.

For development teams, the lead should prefer narrow scopes for isolated
children, but claim broad logical scopes whenever the child changes shared
contracts. This keeps parallelism explicit and reviewable.

## Non-goals

- No automatic semantic dependency detection.
- No static analysis of file imports, package graphs, or test impact.
- No optimistic merge engine.
- No priority scheduler, quota system, or worker pool in this decision.
- No change to the rule that one task has at most one active wake.

## Implementation order

1. Add task scope data and conflict rules with tests.
2. Add a small active-lease store with TTL/refresh/reclaim tests.
3. Harden event/projection/chronicle writes for concurrent task writers.
4. Replace the long `run` workspace lock with lease acquisition for task wakes.
5. Add CLI flags and `create_subtask` schema for explicit read/write scopes.

## Consequences

- Independent tasks in one workspace can eventually run concurrently without
  corrupting workspace state.
- Ambiguous work stays serialized by default.
- The concurrency contract is visible in task state and reviewable by the lead.
- Implementation must harden store writes before the public CLI can safely drop
  the coarse `run` lock.
