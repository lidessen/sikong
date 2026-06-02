# ADR 0009: A Lead Task Creates and Coordinates a Team (via Subtasks)

Status: Accepted

Date: 2026-06-02

Builds on: [0001](0001-stage-scoped-subtasks-block-advancement.md) (subtasks block
advancement — partially realized here), [0008](0008-wakespace-owns-staffing.md)
(auto-staffing). Borrows orchestration principles from Claude Code's dynamic
multi-agent workflow.

## Context

The client wants to select a workflow (e.g. the built-in development workflow) and
designate a 负责人 (lead); the lead should build and coordinate a team — research,
plan, decompose, delegate, follow up, synthesize — while the client only states,
accepts, and supervises (ADR 0008's three layers).

Claude Code's dynamic workflow gives the borrowable discipline: keep the
orchestration plan in durable state/stages (not in the lead's context window); run
each worker in a fresh, isolated context with one scoped job and a structured
return; split deterministic control (when/how-many/order → guards) from model
reasoning (what each worker does); the lead decides *who/when*, the worker decides
*how*; on each tick the lead reads the live state and re-plans by spawning or
cancelling — never by reaching into a running worker.

Wakespace already has the machinery: `create_subtask` (engine-minted child ids),
parent/child links, `childrenDone`/`childrenSucceeded` guards, parent re-wake when
a child reaches a terminal state, and capability-matched staffing. The only thing
missing is that a lead's wake cannot *see* its team, so it cannot review or re-plan.

## Decision

A "lead" is an ordinary task running on a lead workflow whose stages enable
`create_subtask`. The "team" is the child tasks it spawns; each child is a fresh
task auto-staffed against its own workflow's `workerRole` (ADR 0008). No new engine
mechanism — the lead is a task, the team is children, coordination is the existing
reduce → guard → re-wake loop.

1. **Surface the team to the lead.** A lead's wake prompt gains a read-only
   `## Team` section listing each child's id, workflow, status, and `summary` (or
   `request`). This is the one load-bearing addition; without it the lead is blind
   to its team. It is a projection read — no new state, fully replayable.

2. **One built-in development-oriented lead workflow** (`development-lead`):
   `plan` → `delegate` (enables `create_subtask`) → `review` (entry gated on
   `childrenDone`) → `done`. `workerRole: "coding"`. The lead plans, fans out child
   tasks (e.g. on the `development` workflow), is re-woken as they finish, reviews
   the Team section, and either spawns follow-ups or synthesizes a `summary`.

3. **Designation reuses existing plumbing.** The creator selects the workflow and
   may pin the lead worker (`createTask`'s `workerId`, honoured by `selectWorker`);
   unpinned, the workflow's `workerRole` auto-assigns a lead. No new mechanism.

4. **Join on `childrenDone`** (not `childrenSucceeded`): the lead always re-wakes
   and decides — even on a failed/cancelled child — rather than the stage stalling.

5. **`create_subtask` stays opt-in per stage** (enabled only on the lead
   workflow's `delegate` stage), so ordinary tasks cannot accidentally fan out.

## Consequences

- "Select a workflow + designate a lead → lead builds a team" works with a
  read-only prompt enrichment, one workflow definition, and existing CLI flags.
- Re-planning is task-level (spawn/cancel children between ticks), consistent with
  the steerability stance in `../areas/workspace-engine.md` — the lead never
  injects content into a running child.
- Children are fresh-context black boxes returning structured `summary` fields; the
  lead synthesizes, it does not merge their internal work.

## Implementation Notes

- `prompt.ts`: `buildSystem` takes an optional `team: TeamMember[]` and renders the
  `## Team` section only when present; long values elided via `renderValue`.
- `engine.ts`: a `teamSnapshots(task)` read (id, workflowId, status, summary,
  request from child projections) threaded into the `buildSystem` call.
- `builtin.ts` + `workspace.ts`: define and register `development-lead`.
- Tests: a lead spawns a child, the child completes with a `summary`, the lead
  re-wakes in `review`, sees the Team section, and synthesizes.

## Open / Deferred (kept simple on purpose)

- Child status/summary is read live from projections each wake; durable mirroring
  of child state onto the parent timeline (ADR 0001's audit/replay concern) is
  deferred until actually needed.
- No standing PM, no mid-task steering, no new command/guard/event, no rich
  routing, no cross-worker consensus, no parent→child staffing inheritance (children
  target a workflow that already carries its own `workerRole`).
- A distinct `"lead"` capability role is deferred; the lead reuses `"coding"`.
