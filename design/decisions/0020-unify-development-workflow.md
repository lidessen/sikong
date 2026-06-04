# 0020 — Unify development + development-lead into one adaptive `development` workflow

Status: Accepted
Date: 2026-06-04
Amends: 0009 (lead creates a team)

## Context

Two workflows differ in essentially one thing: `development` does a bounded change
with one worker (`plan → design → implement → verify`), while `development-lead`
decomposes a larger effort into a team (`design → plan → delegate → review`). The
split forces the **intake router (or the human) to guess the scale upfront** — and
a solo `development` task that turns out large can't fan out without being
re-created as a lead. ADR 0009 introduced `development-lead` mainly to **gate
`create_subtask` to a "lead"**, which had a valuable side effect: it **bounded the
team tree to two tiers** (lead → workers; workers run `development`/`general`,
which can't fan out again), preventing teams-spawning-teams recursion.

## Decision

Collapse the two into **one adaptive `development` workflow** where **delegation is
optional and chosen at runtime**, not at routing time. After planning, the agent
either implements directly (small change) or delegates a team (large effort) —
scope is *discovered*, not guessed. `development-lead` is removed as a distinct
workflow; its id is kept as a **thin alias** to `development` for one release so
existing references/tasks don't break.

### Stages

1. **design** (`entry: always`) — refine the design; think adversarially for
   consequential decisions (diverge candidates + record `alternatives`), lightly
   for trivial ones. Set `design` (+ `alternatives` when consequential). → transition.
2. **plan** (`design` exists + transition) — bounded plan + acceptance criteria;
   this is where the agent decides **solo vs team** and says which in the plan.
3. **build** (`plan` exists + transition) — the adaptive stage. `create_subtask`
   IS available here. The agent EITHER:
   - implements directly → sets `implementation` + `changedFiles`; OR
   - delegates → `create_subtask` per layer (with `dependsOn`/`isolate` per ADR
     0010/0011), then requests transition to wait on the team.
4. **verify** (`(implementation exists OR childrenDone) + transition`) — verify own
   work adversarially (ADR 0015) AND/OR review+merge the team's results (merge
   isolated branches). Follow-up subtasks may be created here (multi-round). Set
   `verification` + `summary`. → transition.
5. **done** (`summary` exists + `childrenDone` + transition) — `childrenDone` is
   vacuously true when there are no children, so it gates both paths uniformly.

### The recursion bound (replaces ADR 0009's free gate — REQUIRED)

Because the merged workflow can fan out *and* children use the same workflow,
recursion is now possible. Restore the two-tier bound with a **generic engine
depth cap**: each task carries its ancestry depth; `create_subtask` is refused
(the tool errors, instructing the agent to do the work inline) beyond
`maxTeamDepth` (default **2**: a lead and its workers; a worker cannot open its own
team). The cap is a `WorkflowEngineOptions` field, engine-enforced, workflow-
agnostic — so it also bounds the `design` and `release` fan-out for free. This is
the one small net-new mechanism; everything else is subtraction + guard edits.

## Why this is safe / better
- One workflow, one mental model; scale is discovered at `build`, not guessed at
  intake. A growing solo task fans out in place instead of being re-created.
- The recursion risk ADR 0009 prevented is preserved — now generically (depth cap)
  rather than by having two workflows.
- `childrenDone` being vacuously-true unifies the solo and team `done` guards, so
  the branch is expressed without special-casing.

## Alternatives considered
- **Keep both (status quo).** Cleanest recursion bound, but keeps the brittle
  upfront solo-vs-team routing decision. Rejected — the whole point is to discover
  scope.
- **Merge with `create_subtask` always on, no cap.** Maximally flexible but
  re-opens unbounded team-spawns-team recursion (cost/depth blow-up). Rejected.
- **Make `development-lead` the survivor (delegation mandatory, optional direct).**
  Same end state but a worse default — most dev tasks are solo, so the common path
  shouldn't be "lead a team." Rejected in favor of solo-default + optional fan-out.

## Migration / blast radius
- Merge `DEVELOPMENT_WORKFLOW` + `DEVELOPMENT_LEAD_WORKFLOW` → one
  `DEVELOPMENT_WORKFLOW` (adaptive); register `development-lead` as an alias to it.
- `create_subtask` moves to the `build` (and `verify`) stage's `tools`.
- Add `maxTeamDepth` to the engine + enforce in the `create_subtask` handler;
  thread task depth through subtask creation.
- Update the intake router prompt (no more development vs development-lead choice).
- Update tests: the lead-specific tests fold into the adaptive workflow; add a
  depth-cap test (a 3rd-tier `create_subtask` is refused). Keep mock-loop sites.
- `design` and `release` keep their own ids (separate purposes) but inherit the
  depth cap automatically.

## Consequences
- Fewer workflows; routing simplifies; scope is adaptive.
- One generic safety knob (`maxTeamDepth`) governs all fan-out.
- ADR 0009 stands historically but its mechanism (lead-gated create_subtask) is
  superseded by stage-gated create_subtask + the depth cap.

## Decisions (resolved during design review)

The following design-level decisions were resolved during the design-review stage
and recorded here for implementors.

### Depth cap mechanism: `Task.depth` field

*Accepted: `Task.depth: number`* — a new field on the `Task` interface, stored in
the `task.created` event payload (`initTask` accepts it). Root tasks get `depth=0`;
`spawnSubtask` sets `parent.depth + 1`. The engine checks `depth >= maxTeamDepth`
before spawning and rejects (onReject) if exceeded.

- **Why this, not walk-parent-chain**: O(1) vs N store reads; depth is structural
  metadata that belongs on the type.
- **Why this, not ID-encoded depth**: uncouples the ID format from domain logic;
  survives ID generation changes.
- **Where checked**: `spawnSubtask` in `engine.ts` — also applies to `create_subtask`
  from the `submitCommand` path? No — `submitCommand` throws on `create_subtask`
  (`"worker-only command"`) so there's only one spawn path.

### `maxTeamDepth` default and type

`WorkflowEngineOptions.maxTeamDepth?: number` — default `2`, giving lead + workers
(workers cannot spawn their own team). Also bounds `design` and `release` fan-out
for free. Configurable at engine construction. Must be >= 1.

### `childrenDone` vacuously true

Change `guard.ts` from:
```
env.children.length > 0 && env.children.every(...)
```
to:
```
env.children.length === 0 || env.children.every(...)
```

No other registered workflow uses `childrenDone` besides
`DEVELOPMENT_LEAD_WORKFLOW` (which is being merged). This is what makes the
unified guard `{ childrenDone, summary exists, transition }` work for both
the solo path (vacuously satisfied — no children) and the team path (waits
for all children).

### Unified workflow stage structure

`design → plan → build → verify → done`

| Stage | Entry guard | outputFields | Tools (non-default) |
|---|---|---|---|
| design | always | design, alternatives | — |
| plan | design exists + transition | plan | — |
| build | plan exists + transition | implementation, changedFiles | +create_subtask |
| verify | (implementation exists OR childrenDone) + transition | verification, summary | +create_subtask |
| done | summary exists + childrenDone + transition | — | — |

Default tools (set_field, request_transition, block, cancel, append_note) are
always available except where `tools` is explicitly listed (build/verify) where
create_subtask is added.

### Field schema (merged)

```
request, design (string), alternatives (json),
plan (string), implementation (string), changedFiles (json),
verification (string), summary (string)
```

Solo path populates implementation + changedFiles + verification + summary.
Team path populates design + alternatives + plan + summary (children under
the hood). The `childrenDone` guard on `verify` entry allows verify to start
without implementation (team path).

### Alias strategy

`development-lead` kept as a workflow whose `id` is `"development-lead"` but
whose stages/fields match the unified `DEVELOPMENT_WORKFLOW`. Register it as:
```
registry.register({ ...DEVELOPMENT_WORKFLOW, id: "development-lead" })
```
Old `development-lead@v1` tasks stay pinned to the original version (separate
`DEVELOPMENT_LEAD_WORKFLOW` constant retained for the transition release). The
alias exists for one release, then removed.

The intake router automatically includes both ids — agents may pick either.
No routing changes needed because `development-lead` already maps to the same
stages. The intake prompt description for both should say "Development (adapts
to solo or team scope)."
