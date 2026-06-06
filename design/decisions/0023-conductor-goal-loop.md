# 0023 — The Conductor: a goal/project-driven autonomous loop (read-only orchestrator)

Status: Accepted
Date: 2026-06-05

## Context

sikong already has two nested loops: agent-loop's `loop.run` (one agent run) and
the wake-cycle / `runTask` "ralph" loop (drive one task to done). The whole session
has shown a THIRD loop done by hand — the lead/conductor: read state → decide →
spawn + drive worker tasks → review → schedule the next step → repeat toward a
goal. The owner wants that automated as a sikong agent: **a goal/project-driven
outer loop, driven by cron, steered by simple CLI messages.**

## Decision

Add a **Conductor** — a long-lived, goal-driven agent that orchestrates worker
tasks but never makes changes itself.

### The defining constraint: read-only + orchestration only

The Conductor's toolset is exactly:
- **project** — list/create/select projects.
- **task** — create tasks (workflow/worker/dependsOn/isolate), drive/run them,
  submit (transition/approve/cancel), and read task/overview/chronicle/usage/status.
- **read** — read file, grep, glob, AND a **read/observe shell** (owner-decided):
  it may run tests/builds/`git status` etc. to observe reality, but has no
  file-write tools, so any side effects are incidental (temp files), never source
  changes. This makes assessment far more capable (it can *see* if the build is
  green) while keeping the write-boundary intact.
- **research (查资料)** — web/doc lookup (search + fetch + library docs). The lead may
  need to look up unfamiliar APIs/patterns before rejecting evidence, adjusting
  instructions, or re-decomposing a stuck task. Read-only by nature (fetching
  information), so it stays inside the safety boundary.
- **cron** — schedule its own next wake (one-shot delay or recurring).

It has **NO write tools** (no editFile/writeFile/insertInFile/replaceInFile, no
write-capable bash). This is the load-bearing safety property:
- It **cannot change the codebase directly** — every change flows through a worker
  task (which has writes + a verify gate + approval). So an autonomous, cron-driven,
  persistent agent is safe to run unattended: worst case it creates work (bounded,
  below) and reads.
- It makes **"lead conducts, workers code" (ADR 0007/0008/0009) a structural
  invariant**, not a guideline — the conductor literally can't code.

### The loop

1. **Wake** — triggered by (a) a cron timer, (b) a spawned task completing
   (`childrenDone` re-wake), or (c) a new user CLI message.
2. **Assess** — read the goal + project state (overview, chronicle, usage, recent
   task results, relevant files) + any new user messages.
3. **Decide + act** — decompose the goal into the next task(s) and spawn them;
   drive/check in-flight tasks; review completed ones; record progress. For
   outward/irreversible actions (publish, promote, anything destructive) → propose
   and **wait for user approval** (reuse the approval primitive, ADR 0004/0016).
4. **Schedule next wake** — cron (e.g. "re-check in N min" / "daily"); plus the
   event re-wakes from (1b)/(1c).
5. **Loop** until the goal is **met** (report + idle), **blocked** (ask the user),
   or **stopped**.

### Interaction (deliberately minimal)

- `sikong conductor start <project> --goal "<goal>"` — start a conductor on a goal.
- `sikong tell <conductor> "<message>"` — steer: refine the goal, add a requirement,
  approve a gate, or stop. Queued to the conductor's mailbox; consumed next wake.
- `sikong conductor status <id>` — what it's doing / pending approvals / progress.

The user sends messages; the conductor pursues the goal between them, paced by cron.

### Mapping to sikong (first-class construct — owner-decided)

A Conductor is a **first-class entity** (not a task), purpose-built for the goal
loop: its own lifecycle (running/paused/met/blocked/stopped), its own store record
(goal, plan, progress, pending approvals, budget), and its own CLI. It still
**reuses the engine's machinery** where it fits: the wake mechanism, the
single-writer mailbox (user messages = commands), the worker-tools/stage-`tools`
gating (to enforce the read-only-orchestrator toolset), child-task completion as a
wake trigger, and ADR 0016's approval primitive. It spawns ordinary tasks; those
run on the existing engine unchanged.

**Net-new:**
1. The **Conductor construct** — entity + store + lifecycle + the assess/act loop
   driver. (More code than a task-with-workflow, but cleaner: tasks complete,
   conductors persist.)
2. A **cron/scheduler** in sikong — timed wakes (the loop's heartbeat).
3. The **read-only-orchestrator toolset** (project + task + read + read/observe
   shell + cron; no write).
4. The **CLI**: `conductor start/status/tell/stop` + the message mailbox + goal,
   with progress externalized (a shilu goal-log, inspectable + recovery-safe).
5. A **circuit-breaker + budget** for the autonomous loop (see safety).

### Autonomy boundary (owner-decided)

Spawn + drive worker tasks and read **freely** (autonomous); require **explicit
user approval** only for outward/irreversible actions (publish, promote, delete)
and when over the cost budget. The conductor proposes; the human disposes — but
the day-to-day decompose→spawn→review cycle needs no per-step permission.

### Three loops, now complete
`loop.run` (one run) ⊂ `runTask` (one task) ⊂ **Conductor** (one goal, many tasks).
ADR 0016's self-iteration becomes a *special case*: a Conductor whose goal is
"improve sikong."

## Safety (an autonomous cron loop needs bounds)

- **Read-only** bounds *damage* (can't corrupt the codebase) — the core safety.
- **Cost/runaway** is the remaining risk: cron + auto-spawn can burn tokens or
  spawn runaway tasks. Need a **budget** (token/cost cap per window) + a
  **circuit-breaker** (max tasks/wakes per period; idle when no progress / N
  no-op wakes in a row) + the existing `maxTeamDepth`.
- **Approval gate** for all outward/irreversible actions — the conductor proposes,
  the human disposes (no unattended publish/promote, per ADR 0016).

## Resolved (owner-decided 2026-06-05)
1. **Form** → **first-class Conductor construct** (not a task). See Mapping.
2. **Read/observe shell** → **allowed** (run tests/builds to assess; no write tools).
3. **Autonomy** → **spawn freely, gate outward actions**. See Autonomy boundary.

## Still open (settle at build time)
- **Wake triggers**: cron + child-completion + user message (lean: all three).
- **Scope**: per-goal, with at most one *active* conductor per project at a time.
- **Budget/heartbeat defaults**: cron cadence + cost cap before it pauses for the
  human (pick conservative defaults; tune from runs).

## Consequences
- sikong gains a self-driving, goal-oriented orchestrator that is safe-by-construction
  (read-only) and steered by one-line CLI messages.
- The lead/human role shifts to *setting goals + approving gates*, not driving tasks.
- The self-iteration loop (ADR 0016) and the design/release flows all become things
  a Conductor can pursue.
