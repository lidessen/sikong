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
