# ADR 0010: Optional Per-Subtask Isolation (git worktree) at the Worker Boundary

Status: Accepted

Date: 2026-06-02

Builds on: [0007](0007-coding-belongs-to-the-agent.md) (domain capability lives
outside core), [0008](0008-sikong-owns-staffing.md) (worker boundary),
[0009](0009-lead-creates-team.md) (a lead delegates a team).

## Context

When a lead delegates several subtasks that edit the **same** repository in
parallel, they conflict. The lead needs to run each in its own isolated working
copy. Isolation is git/development-specific — not all projects use git, not all
tasks need it — so it must NOT enter sikong core (the ADR 0007 boundary). It is
an **opt-in capability the lead requests per subtask**, honored at the worker
boundary.

What this isolation IS and ISN'T (important, to avoid a false sense of safety):

- It isolates workers **from each other** — each parallel child edits its own git
  worktree/branch, so they don't clobber one another, then their work is
  integrated back.
- It is **not** a system sandbox. A worktree is an ordinary directory; a worker
  with `bypassPermissions` bash can still touch the rest of the machine.
  Containing bash (OS sandbox / container) is a separate, larger concern and is
  **deferred** (run teams on projects/machines you trust, as you already trust the
  underlying coding agent).

## Decision

1. **Generic flag in core, opaque to the engine.** `create_subtask` gains an
   optional `isolate?: boolean`. The reducer records it on the child task
   (`Task.isolate`); the engine never interprets it — it only forwards isolated
   tasks to two optional worker-boundary hooks. No git concept enters core.

2. **Isolation implemented at the worker boundary (workspace.ts), git only.**
   - `isolateWorkspace(ctx, project) -> Project`: for an isolated task whose
     project root is a git repo, create (or reuse) a worktree at
     `<root>/.sikong/worktrees/<taskId>` on a per-child branch
     `sikong/<taskId>` off the project's current HEAD, and return a project
     rooted at the worktree (so the wake's cwd + allowedPaths + tools are scoped
     there). Non-git projects: return the project unchanged (no-op).
   - `releaseWorkspace(task, project)`: when an isolated task reaches a terminal
     state, commit its worktree to its branch (so the work is integrable) and
     remove the worktree directory, keeping the branch. Cancelled tasks: drop the
     worktree without keeping the branch.
   - The engine awaits these hooks but knows nothing about git/worktrees.

3. **Integration is the lead's job (sequential, no cross-task git race).** The
   `## Team` section marks each isolated child and its branch. The
   `development-lead` review stage instructs the lead to merge the child branches
   into the main checkout with git (it has bash), resolving conflicts, before
   synthesizing the summary. One lead merging sequentially avoids concurrent
   writes to the shared main checkout; per-child worktree creation is serialized by
   a small mutex at the boundary.

4. **System sandboxing is out of scope** (deferred): worktree is not a security
   boundary.

## Consequences

- Parallel coding teams can edit one repo without clobbering each other; the lead
  integrates. Non-git or non-isolated work is completely unaffected.
- sikong core gains only a generic boolean; all git lives in workspace.ts and
  the development-lead workflow text.
- New responsibility for the lead: merge + conflict resolution during review.

## Implementation Notes

- core: `Command.create_subtask.isolate?`, `subtask.created` payload, `initTask`/
  `createTask` → `Task.isolate`, `command-tools` create_subtask schema, the
  `TeamMember` snapshot gains `isolate`/`branch`.
- engine: two optional hooks `isolateWorkspace` / `releaseWorkspace`; the engine
  resolves the effective project through `isolateWorkspace` for isolated tasks
  before building the worker, and calls `releaseWorkspace` on terminal.
- workspace.ts: git-worktree implementation + a creation mutex; no-op off git.
- builtin: `development-lead` review instructions describe merging isolated
  children's branches; the lead spawns isolated children with `isolate: true` in
  delegate when the pieces touch the same code.
- tests: a real temp git repo exercises worktree create → child edits → terminal
  commit → branch present; engine test that `isolate` forwards through the hooks.

## Update (2026-06-02, live dogfood)

A development-lead run with two `isolate` children both editing one file confirmed
the end-to-end flow (both edits integrated into main; worktrees cleaned). It also
surfaced that the lead may **re-apply** the children's edits rather than `git
merge` their branches — so the branches were never git-`--merged` and a
merged-only GC would let them accumulate. Fix: `gcWorktrees` deletes
`sikong/<id>` branches keyed on **task liveness** (the task is no longer live),
not on git-merge detection. By GC time the lead has integrated however it chose, so
a spent branch is removed regardless; neither worktrees nor branches accumulate.

## Update (2026-06-02, agent-proxy drill)

A real greenfield drill (a `development-lead` building agent-proxy from DESIGN.md)
exposed two correctness gaps, now fixed:

- **GC must retain a child's branch/worktree until its PARENT effort terminates,
  not just until the child is done.** A child can finish before the lead has merged
  its branch; reclaiming on child-terminal alone destroyed branches the lead still
  needed. `reconcileWorktrees` now retains `live tasks ∪ tasks whose parent is live`
  (`retainedTaskIds`).
- **A stuck child must not wedge the lead.** A wake that itself fails (timeout / run
  error) on a CHILD is now retried `maxWakeRetries` times (default 1) and then
  terminally failed by the engine (an engine-sourced `cancel` → terminal, so the
  reducer now treats `source:"engine"` cancel as terminal), letting the parent's
  `childrenDone` resolve and the lead re-decide. Root tasks keep the plain behaviour
  (error reported, left in_progress for re-run). The `--wake-timeout` CLI flag lets
  heavy real builds have a larger per-wake budget.

## Open / Deferred

- Auto-merge at the boundary (vs lead-merge) — deferred; lead-merge keeps merges
  sequential and conflict resolution in an agent that can reason about it.
- OS-level sandboxing of bash — deferred (separate, larger).
- Worktree GC for crashed runs — best-effort cleanup on terminal for now.
