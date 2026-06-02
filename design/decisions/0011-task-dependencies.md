# ADR 0011: Sibling Task Dependencies (`dependsOn`)

Status: Accepted

Date: 2026-06-02

Builds on / relates to: [0009](0009-lead-creates-team.md) (a lead delegates a team),
[0001](0001-stage-scoped-subtasks-block-advancement.md) (`childrenDone`).

## Context

The agent-proxy drill showed a lead fanning out a layered effort (proxy → capture →
control API → CLI → rules) as a flat set of **parallel** subtasks. Layers that
depend on each other ran concurrently from the same empty base and collided (two
subtasks both created `cmd/*/main.go` → merge conflict). The work is a
**dependency DAG**, not a parallel fan-out, and sikong had no way to express
ordering **between sibling tasks**.

sikong already has the parent→child relation (`childrenDone` gates the parent's
stage until its children are terminal). It lacks the sibling relation: "task B must
not start until task A is done."

## Decision

Add a first-class **task dependency** to subtask creation. It is a distinct concept
from `childrenDone` (see ADR discussion) — they compose — but is implemented on the
**shared** "are these tasks terminal?" predicate and the shared completion path.

1. `create_subtask` gains `key?` (a logical handle the lead assigns) and
   `dependsOn?: string[]` (keys of sibling subtasks created in the same delegate
   pass). The lead can't reference engine-minted ids, so dependencies are declared
   by key; the engine resolves keys → child task ids within the batch.

2. A child task carries the resolved `dependsOn: string[]` (task ids). The engine
   **does not run a task's wake until all its dependencies are terminal** (done or
   cancelled). A child with dependencies is created un-scheduled; it is scheduled
   when its last dependency terminates. A defensive guard also defers a wake whose
   deps aren't ready (e.g. if `run` schedules everything).

3. **Completion notification is generalized**: when any task terminates, the engine
   schedules its parent (existing) AND every task that `dependsOn` it whose
   dependencies are now all terminal. This is the same mechanism `childrenDone`
   relies on, extended.

4. `childrenDone` is unchanged. Composition: sibling `dependsOn` orders the DAG;
   the parent's `childrenDone` waits for the whole DAG before review/integration.
   A failed (cancelled) dependency still counts as terminal, so a dependent will be
   scheduled and can decide what to do given an upstream failure (it sees state).

## Why not collapse parent→child into `dependsOn`

They are the same relation ("wait for tasks to be terminal") at different
granularities, but force-fitting one into the other is worse than composing them:

- `childrenDone` references a **dynamic** set (whatever children the parent spawned;
  the parent doesn't know ids ahead of time) and gates a **stage transition**.
- `dependsOn` references an **explicit** set and gates **task start**.

So: keep both surfaces, share the predicate + completion path.

## Consequences

- A lead declares the whole DAG in one delegate pass (keys + dependsOn); the engine
  runs it in dependency order. A later layer starts from the integrated output of
  its prerequisites, avoiding the parallel-from-empty-base collisions.
- Deterministic ordering, not reliant on the lead manually sequencing rounds.
- New small surface in core (a generic dependency edge), no git/coding concepts.

## Implementation Notes

- types: `Command.create_subtask` + `key?`, `dependsOn?` (keys); `Task.dependsOn?`
  (resolved ids).
- reducer: `initTask`/projection thread `dependsOn`.
- command-tools: `create_subtask` tool gains `key` + `dependsOn`.
- engine: in the wake's create_subtask batch, mint all child ids first, build a
  key→id map, resolve each child's `dependsOn`, and create it un-scheduled when it
  has unmet deps (roots scheduled immediately); `persist` on terminal schedules
  ready dependents; `runWake` defers a wake whose deps aren't terminal (without
  burning the wake budget).
- builtin: `development-lead` delegate instruction tells the lead to declare layers
  with `key` + `dependsOn` instead of fanning out everything in parallel.
- tests: a 3-task chain runs in order; a diamond runs correctly; `childrenDone`
  resolves only after the whole DAG; a cancelled dep still releases its dependents.

## Open / Deferred

- Cross-effort dependencies (depending on non-sibling tasks by id) — not needed yet.
- Cycle detection: keys form a DAG by construction in one pass; a self/cyclic
  `dependsOn` simply never becomes ready (no deadlock of the engine, just that
  task) — add explicit detection only if it bites.
