# Sikong Architecture Review — Consolidated Findings

**Date:** 2026-06-17
**Stage:** Architecture Review & Analysis
**Rounds completed:** 3 (Coordination/Orchestration, Client/UI/Performance, Design Doc Integration)
**Files analyzed:** ~35 source files + 5 design docs + development log (~6000 total lines)

---

## Executive Summary

Sikong has a principled architecture: event-sourced coordination engine, clear Go/TypeScript boundary, role-separated agent protocol, and deliberately narrow tool surfaces. The design documents are unusually precise about what is in scope and (more importantly) what is deferred.

However, several systemic risks cut across all subsystems. The most critical is that **Phase 16 (Task Lead + Stage Rounds) is unimplemented** despite being the core product feature the design describes. The second most critical is the **complete absence of structured logging**, which makes debugging the multi-process architecture nearly impossible. Third, **process-backed error recovery has race conditions** that can produce inconsistent projections.

This document consolidates findings from three analysis rounds and the pre-existing architecture review (`architecture-review.md`). Each finding below links to the original round's finding number and file:line references.

---

## P0 — Critical (blocking reliability or correctness)

### P0.1 Phase 16 (Lead + Stage Round Protocol) Unimplemented

**Origin:** Round 1 (H10), architecture-review.md P0.1, implementation-plan.md line 483

**Description:** The target team workflow (Task Lead → Planner → Stage Workers → Reviewer → Final Review) is defined in `coordination-engine.md` but not wired in the orchestration layer. The current preset-based orchestration simulates this with inline prompt construction and direct command handler calls, but there is:

- No dedicated Lead runtime with `submitRequirementSpec` tool
- No `plan.requested` engine-trigger from spec submission
- No `stage_round.planned`/`completed` events emitted by command handlers
- No work-unit-level concurrency safety in orchestration scheduling
- No stage review rejection → round-planning loop

**Risk:** Multi-worker tasks cannot execute the designed protocol. The product cannot deliver its core promise. Single-worker presets only.

**Entry files:**

- `packages/workspace/src/coordination/types.ts:28-43` — `StageRoundDef` defined but never wired
- `packages/workspace/src/commands/task.ts` — missing `submitRequirementSpec` → auto-trigger `plan.requested`
- `packages/workspace/src/orchestration/tick.ts:161-221` — `planRunningAction`/`planReviewingAction` ready but no round-planned events received
- `packages/workspace/src/runtime/default-assembly.ts:10-34` — no "lead" profile wired
- `design/implementation-plan.md:483` — explicitly marked "not implemented"

---

### P0.2 Process-Backed Error Recovery Races

**Origin:** Round 1 (H1, H2, H9), architecture-review.md P0.2

**Description:** `executeOrchestrationActionProcess` in `process.ts` has fragile interleaving of process failure recording and worker-run state transitions. Key races:

1. **`recordProcessActionFailure` (line 381)** queries projection for running worker runs by matching `roundId + workUnitId` — but this can match stale runs from a previous round since `roundId` is not unique across rounds.
2. **`failWorkerRun` called _after_ `recordRuntimeProcessFinished`** (line 420 vs. line 152), meaning projection is partially updated during the window.
3. **`monitorProcessRunning` polling (line 357)** polls `getProcessRun` which can return inconsistent results if the daemon has already reaped the process.

**Risk:** Ghost "running" worker runs survive process crashes. Stale `roundId`/`workUnitId` matching produces incorrect terminal events. Projection state becomes inconsistent.

**Entry files:**

- `packages/workspace/src/orchestration/process.ts:87-198` — main process execution with interleaved recording
- `packages/workspace/src/orchestration/process.ts:381-432` — `recordProcessActionFailure` fragile run matching
- `packages/workspace/src/orchestration/process.ts:357-375` — `monitorProcessRunning` polling race

---

### P0.3 No Structured Logging Framework

**Origin:** Round 2 (P0.1), architecture-review.md P0.3

**Description:** The entire codebase uses ad-hoc string concatenation for diagnostic output. No structured logger, no log levels, no correlation IDs across process boundaries, and no machine-parseable output for monitoring. Examples:

- `worker-run.ts:324` — `taskResultReport` is ad-hoc string construction
- `process.ts:455` — `processFailureDetail` is free-form string
- `CommandResult` errors carry only `code` + `message` without log context
- `limited-capture.ts` — 256KB stdout/stderr capture with silent truncation (no warning emitted on truncation, except the `stdoutTruncated` flag which isn't displayed anywhere)
- `worker-run.ts:474-497` — observation text truncation at 420/520 chars with no diagnostics

**Risk:** Debugging multi-process execution (daemon → Bun child → agent-loop → LLM API) requires grepping unstructured stderr. Production incidents cannot be traced across process boundaries. Silent truncation everywhere loses diagnostic data.

**Entry files:**

- Throughout all `packages/workspace/src/` — `CommandResult.error.details` is the only structured error carrier
- `packages/workspace/src/process/run.ts:50-53` — stdout/stderr capture with truncation
- `packages/workspace/src/process/limited-capture.ts:1-46` — 256KB capture limit
- `packages/workspace/src/runtime/worker-run.ts:474-475` — observation text limits

---

### P0.4 Blocked State Has No Recovery Path

**Origin:** Round 1 (H3)

**Description:** The state machine declares a `"blocked"` state (state-machine.ts) but provides no recovery mechanism. Once a task enters blocked state, no automatic or manual recovery path exists. The only action is lead decision, but if the lead cannot resolve the block, the task is permanently stuck.

**Risk:** Production incidents that trigger blocked state require manual data-dir surgery to recover. No escalation path.

**Entry files:**

- `packages/workspace/src/coordination/state-machine.ts:120-140` — blocked state handling
- `packages/workspace/src/orchestration/tick.ts:440-460` — blocked action dispatch

---

## P1 — High (significant impact on developer velocity or UX)

### P1.1 State Projection O(n) Replay on Every Tick

**Origin:** Round 2 (P0.2)

**Description:** `FileTaskEventStore.appendManyAndRebuildProjection` at `store.ts:45-66` can fall through to full `reduceTaskEvents(allEvents)` replay — O(n) over the entire event log. Called on every scheduler tick and every client state poll. With 1000+ events, this becomes a bottleneck.

**Risk:** UI becomes sluggish for long-running tasks. Scheduler ticks take longer as event log grows. Linear scaling with no optimization.

**Entry files:**

- `packages/workspace/src/coordination/store.ts:45-66` — full replay path
- `packages/workspace/src/coordination/store.ts:132-156` — reads all events from disk per batch

---

### P1.2 SSE Stream Has No Backpressure or Timeout

**Origin:** Round 2 (P0.3), architecture-review.md P2.2

**Description:** `consumeTurnStream` at `api.ts:127-179` reads chunks and dispatches events synchronously with no flow control, no per-chunk timeout, no reconnect logic, and no partial-frame recovery. For very long turns with hundreds of events, this can cause OOM or UI jank.

**Risk:** Long client-agent turns (minutes of streaming progress) are vulnerable to network hiccups. Mid-stream disconnection loses all progress with no retry.

**Entry files:**

- `packages/client/src/api.ts:100-107` — `runTurnStream` fetch call
- `packages/client/src/api.ts:127-179` — `consumeTurnStream` with no timeout/reconnect
- `packages/client/src/api.ts:109-125` — `resumeTurnStream` (exists but no retry logic)

---

### P1.3 Terminal Protocol Tools Hard-Cancel Agent Runs

**Origin:** Round 2 (P1.1)

**Description:** When a lead protocol tool (`submit_plan`, `accept_plan`, etc.) is called by the worker, `run.cancel()` is called immediately at `worker-run.ts:204-224`. If the lead tool was invoked mid-run with other pending work, that work is lost with no recovery path.

**Risk:** Mid-run cancellation loses non-terminal work. No graceful shutdown path for protocol tool runners.

**Entry files:**

- `packages/workspace/src/runtime/worker-run.ts:204-224` — hard cancel on protocol tool call

---

### P1.4 Turn Resume Loses Activity History

**Origin:** Round 2 (P1.3)

**Description:** On page refresh mid-turn at `App.tsx:244-307`, only the SSE stream from the last event index is replayed. Previous `ClientTurnActivity` items are lost; the UI jumps from blank to potentially complete with no intermediate state.

**Risk:** Users lose visibility of in-progress work after accidental page refresh. Poor UX for long-running turns.

**Entry files:**

- `packages/client/src/App.tsx:244-307` — turn resume handler

---

### P1.5 Process Cancel Race With Daemon- vs TypeScript-Side State

**Origin:** Round 1 (H3), architecture-review.md P2.6, P2.10

**Description:** `executeOrchestrationActionProcess` starts a process and records `runtime_process.started`. If `cancel` is called before the process starts (still in `queued` state), `recordRuntimeProcessFinished` is called with `processStatus` "cancelled" — but the main loop may still try to `waitProcessRun`. The Go daemon shutdown sequence also doesn't drain child processes before exit, creating orphaned Bun processes.

**Risk:** Double-recording of runtime process results. Orphan child processes after daemon restart.

**Entry files:**

- `packages/workspace/src/orchestration/process.ts:136-173` — process lifecycle recording
- `packages/workspace/src/orchestration/process.ts:143-146` — `waitProcessRun` with 2h+60s default timeout
- `internal/daemon/` — daemon lifecycle and shutdown

---

### P1.6 Client Agent Turn Timeout / Abort Races

**Origin:** architecture-review.md P1.2

**Description:** `waitClientAgentRun` in `turn.ts:453-506` uses `Promise.race` between the run result, a timeout, and an external abort signal. If timeout fires after natural completion but before race settlement, `run.cancel` is called on an already-finished run, causing spurious cleanup. `shouldRunSettlementPass` (line 518) has text-based heuristic that can suppress valid outcomes.

**Risk:** Cancel signals to already-completed runs cause spurious cleanup. Users see "Turn cancelled" when it actually completed.

**Entry files:**

- `packages/workspace/src/client-agent/turn.ts:453-506` — `waitClientAgentRun` race
- `packages/workspace/src/client-agent/turn.ts:518-523` — `shouldRunSettlementPass` heuristic
- `packages/client/src/api.ts:127-179` — `consumeTurnStream` SSE parsing

---

### P1.7 Observation Storage Scales Linearly, Unbounded

**Origin:** architecture-review.md P1.1

**Description:** Worker run observations are stored inline in `TaskRunResult.observations` or separate `state/observations/` files. `WorkerObservationCollector` generates one observation per loop event (thinking, tool call start/end, usage, step) with 420-char text limit. For long agent runs, this produces thousands of observations. `compactWorkerRun` in `runner.ts:197-207` strips observations from projection silently rather than paginating.

**Risk:** Task event logs grow unbounded. JSONL files become gigabytes. Inspect views become unusable.

**Entry files:**

- `packages/workspace/src/runtime/worker-run.ts:78-96` — observation collection and flush
- `packages/workspace/src/orchestration/runner.ts:197-207` — `compactWorkerRun` strips observations silently
- `packages/client/src/task-detail.tsx:241-248` — observation loading in UI

---

### P1.8 Work Unit Schema Drifted From Design

**Origin:** architecture-review.md P1.3

**Description:** `StageWorkUnitDef` in `coordination/types.ts:34-42` has `instructions: string[]`, `deliverables: string[]`, and `outOfScope: string[]` — all required, all `minItems: 1`. The design document `coordination-engine.md:324-329` shows only `title`, `objective`, and optional `acceptance`. The implementation added fields the design deferred. Once Phase 16 data exists with this schema, changing it becomes a migration problem.

**Risk:** Future schema simplification requires data migration. The rigid required fields constrain how leads can describe work.

**Entery files:**

- `packages/workspace/src/coordination/types.ts:34-42` — extra required fields
- `packages/workspace/src/runtime/protocol-tools.ts:397-467` — `parseWorkUnit` with required array validation
- `design/coordination-engine.md:324-329` — design showing simpler schema

---

### P1.9 Client Error Classification Is Fragile String Matching

**Origin:** Round 2 (P1.9)

**Description:** `classifyTurnError` at `App.tsx:190-215` does substring matching on error messages. No error codes, no structured error hierarchy. Error UX will be inconsistent across locales.

**Risk:** Users in non-English locales see untranslated, incorrectly classified errors. Error handling is brittle to LLM output changes.

**Entry files:**

- `packages/client/src/App.tsx:190-215` — `classifyTurnError`

---

### P1.10 Synthetic Turn Progress With Hardcoded Timestamps

**Origin:** Round 2 (P1.2)

**Description:** All 5 phases in `turn-progress.ts:27-63` have fixed `startsAtMs` (0, 1200, 3500, 12000, 24000). For a slow turn (e.g., 60s agent phase), the UI shows "Prepare" for 12s before advancing. Only real SSE events override this.

**Risk:** Users see inaccurate progress for slow turns. The progress bar completes before the turn does.

**Entry files:**

- `packages/client/src/turn-progress.ts:27-63`

---

## P2 — Medium (important but not blocking)

### P2.1 Event Store Contention Under Concurrent Workers

- `store.ts:43-66` — per-task lock serializes projection rebuilds
- `store.ts:132-156` — full event file read per batch
- **Risk:** With 3-5 concurrent worker runs and ~1000 events each, rebuilds bottleneck on lock

### P2.2 UI Observation Overload (No Virtual Scrolling)

- `task-detail.tsx:241-248` — all observations loaded at once
- `task-detail-rows.tsx` — flat DOM rendering
- **Risk:** UI degrades on long-running tasks with many observations

### P2.3 Workspace Task List Uncached

- `context.ts:76-137` — full state rebuild per turn
- **Risk:** Every client-agent turn becomes slower as tasks grow

### P2.4 No Request Deduplication on Client

- `App.tsx:108-115` — multiple `getClientState` calls in-flight simultaneously
- **Risk:** Cascading timeout errors on slow API responses

### P2.5 Backend Cwd Resolution Silently Returns Undefined

- `assembly.ts:392-414` — `resolveRuntimeCwd` can return undefined
- **Risk:** Some backends proceed without cwd, producing confusing behavior

### P2.6 Parallel-Start Failure Orphans Processes (Round 1 H2)

- `process.ts:200-355` — `executeStageWorkerProcesses` concurrent launch + wait
- **Risk:** If one process fails during launch, others continue with no cleanup

### P2.7 No Work-Unit Idempotency Check (Round 1 H4)

- `process.ts:381-432` — no check if work unit already has a terminal run
- **Risk:** Double-runs on retry produce duplicate events

### P2.8 Earlier Round Failures Invisible at Stage Review (Round 1 H5)

- `tick.ts:260-290` — review triggered without reviewing earlier round results
- **Risk:** Stage review unaware of historic round failures

### P2.9 Round Progress Calculation Inconsistency (Round 2 P1.8)

- `task-detail.tsx:251` vs `task-detail-rows.tsx:106`
- **Risk:** UI shows different percentages depending on which component computes it

### P2.10 Tool Set Merging Has No Conflict Detection (Round 2 P2.2)

- `assembly.ts:103-183` — `mergeToolSets` overwrites on name collision
- **Risk:** Tool overrides happen silently without warning

### P2.11 AI SDK Local Tool Sandbox Inconsistency (architecture-review.md P2.7)

- `default-assembly.ts:22-28` — AI SDK tool profiles lack `allowedPaths`
- **Risk:** AI SDK workers have unrestricted file access

### P2.12 Daemon → TypeScript Error Propagation (architecture-review.md P2.4)

- `process.ts:174-192` — crashed process returns `internal_error` with only `runId`
- **Risk:** Silent child-process crashes indistinguishable from stuck processes

---

## Cross-Cutting Findings

| Concern                                                         | Affected Modules                                                         | Recommended Priority |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------- |
| No distributed tracing / correlation IDs                        | All process-boundary crossings                                           | P1                   |
| Ad-hoc text truncation masks errors (silent)                    | `worker-run.ts`, `process.ts`, `turn.ts`                                 | P1                   |
| `localeCompare` timestamp sort CPU-inefficient (x4 occurrences) | `task-detail.tsx`, `state-machine.ts`, `tick.ts`, `task-detail-rows.tsx` | P2                   |
| Test coverage mostly happy-path                                 | Coordination, orchestration, assembly                                    | P1                   |
| Single-file JSONL event log (no rotation)                       | `coordination/store.ts`                                                  | P2                   |
| No health check for agent-loop LLM connectivity                 | `assembly.ts`, CLI                                                       | P2                   |
| Client API 30s timeout conflicts with 2s poll interval          | `api.ts:11`, `App.tsx:110`                                               | P1                   |
| AI SDK `web_fetch` tool — exfiltration risk                     | `assembly.ts:374-382`                                                    | P2                   |

---

## Gap Analysis: Design Intent vs. Implementation

| Design Document Intent                                   | Implementation Status                                            | Finding |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ------- |
| Plan stages are ordered, dynamically planned by lead     | Phase 16 unimplemented; current path uses presets                | P0.1    |
| Lead owns plan/final decisions                           | Lead runtime not wired                                           | P0.1    |
| Stage review rejection → lead round planning loop        | Not implemented                                                  | P0.1    |
| Worker result protocol, not process-output convention    | Partially correct — `process.ts` still has some fragile path     | P0.2    |
| Event-sourced coordination                               | Correctly implemented for base events                            | —       |
| Read-only inspect views                                  | Correctly implemented                                            | —       |
| Go daemon is generic process supervisor                  | Correctly implemented                                            | —       |
| CLI is thin adapter over command handlers                | Correctly implemented                                            | —       |
| Workspace as state namespace, not agent cwd              | Correctly implemented                                            | —       |
| Work-item is user-facing, work-unit is stage-round child | Phase 16 unimplemented; distinction not live                     | P0.1    |
| StageWorkUnitDef minimal: title, objective, acceptance   | Drifted: instructions/deliverables/outOfScope added and required | P1.8    |
| Per-task event locking for concurrency                   | Correctly implemented                                            | —       |
| Process facts are not worker task results                | Correctly implemented                                            | —       |
| Planner/executor/verifier are preset wrappers, not roles | Correctly implemented                                            | —       |
| No agent role/kind fields in process specs               | Correctly implemented                                            | —       |

---

## 3-Phase Implementation Roadmap

### Phase A — Near-Term (Quick Wins, Risk Reduction)

**Estimated: 2-3 sprints**

| Order | Item                                       | Entry Point                                                          | Why This Order                             |
| ----- | ------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------ |
| 1     | P0.3: Structured logging framework         | New `logger.ts` module, `CommandContext` carries correlation ID      | Prerequisite for debugging everything else |
| 2     | P0.2: Stabilize process error recovery     | `process.ts:381-432` — use `runId` envelope, atomically batch events | Highest correctness risk                   |
| 3     | P1.1: State projection incremental rebuild | `store.ts:45-66` — track last-rebuilt event index                    | Scheduler tick performance                 |
| 4     | P1.5: Process cancel idempotency           | `process.ts:136-173` — no-op wait for cancelled IDs                  | Prevents ghost runs                        |
| 5     | P1.3: Terminal tool noop-on-completion     | `worker-run.ts:204-224` — check `finished` flag before cancel        | Reduces spurious user errors               |
| 6     | P1.8: Align work-unit schema with design   | `types.ts:34-42` — make extra fields optional                        | Zero-migration window closing              |
| 7     | P0.4: Blocked state recovery path          | `state-machine.ts` — add explicit recovery action                    | Production safety                          |

### Phase B — Medium-Term (Structural Improvements)

**Estimated: 3-5 sprints**

| Order | Item                                         | Entry Point                                                                            |
| ----- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1     | P0.1: Deliver Phase 16 — Lead + Stage Rounds | `default-assembly.ts`, `commands/task.ts`, `tick.ts`, new `stage_round` event handlers |
| 2     | P1.7: Observation storage/retrieval scaling  | `worker-run.ts:78-96` — separate file per run, pagination                              |
| 3     | P1.2: SSE stream resilience                  | `api.ts:127-179` — per-chunk timeout, reconnect logic                                  |
| 4     | P2.2: UI observation pagination              | `task-detail.tsx:241-248` — lazy load, "show more"                                     |
| 5     | P2.3: Workspace task list caching            | `context.ts:76-137` — TTL cache                                                        |
| 6     | P1.6: Client-agent timeout hardening         | `turn.ts:453-506` — `AbortSignal.timeout`, finished-flag guard                         |
| 7     | P1.4: Turn resume activity preservation      | `App.tsx:244-307` — persist activities to session storage                              |
| 8     | P2.4: Client request deduplication           | `App.tsx:108-115` — abort/coalesce pattern                                             |

### Phase C — Long-Term (Larger Architectural Changes)

**Estimated: 5-8 sprints**

| Order | Item                                                              | Entry Point                                 |
| ----- | ----------------------------------------------------------------- | ------------------------------------------- |
| 1     | P2.1: Event store performance — incremental projection, benchmark | `store.ts`                                  |
| 2     | Cross-cutting: Distributed tracing — correlation IDs end-to-end   | `CommandContext`, process-boundary          |
| 3     | Cross-cutting: Event log compression/rotation                     | `store.ts`                                  |
| 4     | Cross-cutting: Integration test harness                           | E2E CLI → daemon → worker with mock         |
| 5     | Cross-cutting: Observability dashboard                            | Metrics for task throughput, stage duration |
| 6     | P2.11: AI SDK OTel integration (token spend, latency)             | `assembly.ts`                               |
| 7     | P2.9: Decision-record traceability — ADR format                   | `decisions/` directory                      |

---

## Design-Doc-Level Recommendations

1. **ADR / Decision Records** — Move from unstructured development-log to structured ADR format with status (proposed/accepted/deprecated). Cross-reference `design/*.md` footers to relevant ADRs.

2. **Phase 16 Specification Freeze** — Before implementing Phase 16, audit the event schema (types.ts) and protocol-tools.ts against `coordination-engine.md`. The schema drift finding (P1.8) shows the current Types file is already out of sync with the design.

3. **Observation Policy Design** — Define a retention/compaction policy for observations before implementing Phase B step 2. Decide: are observations transient or durable? If transient, how long? If durable, what's the pagination contract?

4. **Error Taxonomy** — Design an error code hierarchy before adding logging infrastructure. P0.3 (structured logging) should produce errors with `error.code` strings, not just `internal_error`. Define codes for common failures: `worker_failed`, `worker_budget_exceeded`, `process_crashed`, `lead_timeout`, `invalid_plan`, etc.

---

## Suggested Validation Commands

Do not run these in this round. For a future test work unit or reviewer:

```bash
# Coordination reducer tests (coverage: state machine transitions)
bun --filter @sikong/workspace test -- --test-path-pattern "coordination"

# Orchestration tick + execution tests (coverage: action dispatch)
bun --filter @sikong/workspace test -- --test-path-pattern "orchestration"

# Runtime assembly tests (coverage: backend/tool profiles)
bun --filter @sikong/workspace test -- --test-path-pattern "runtime|assembly"

# Process runner tests (coverage: subprocess lifecycle)
bun --filter @sikong/workspace test -- --test-path-pattern "process"

# Client agent tests (coverage: turn/settlement/outcome)
bun --filter @sikong/workspace test -- --test-path-pattern "client-agent"

# Protocol tools tests (coverage: plan/round/review tool validation)
bun --filter @sikong/workspace test -- --test-path-pattern "protocol-tools"

# Full repository check
bun run check

# Static agent role/kind search (ensure no role/kind fields leak)
rg -n "AgentKind|PlannerAdapter|ReviewerAdapter|WorkerAdapter|role\\s*:|kind\\s*:" packages/workspace/src cmd internal design

# Performance benchmark (event store replay under load)
# Manual: create 1000+ events, measure rebuild time before/after incremental optimization
```

---

## Files Analyzed (Complete List)

### Coordination (Round 1)

- `packages/workspace/src/coordination/types.ts`, `index.ts`, `store.ts`, `state-machine.ts`
- `packages/workspace/src/coordination/coordination.test.ts`

### Orchestration (Round 1)

- `packages/workspace/src/orchestration/tick.ts`, `process.ts`, `summary.ts`
- `packages/workspace/src/orchestration/orchestration.test.ts`

### Runtime (Round 1 & 2)

- `packages/workspace/src/runtime/worker-run.ts`, `default-assembly.ts`, `assembly.ts`
- `packages/workspace/src/runtime/protocol-tools.ts`

### Process (Round 2)

- `packages/workspace/src/process/runner.ts`, `run.ts`, `limited-capture.ts`, `types.ts`

### Client UI (Round 2)

- `packages/client/src/api.ts`, `App.tsx`, `chat-panel.tsx`, `task-detail.tsx`
- `packages/client/src/task-detail-rows.tsx`, `observation-view.tsx`, `turn-progress.ts`, `types.ts`

### Design Docs

- `design/README.md`, `coordination-engine.md`, `client-ui-user-stories.md`
- `design/implementation-plan.md`

### Development Log

- `development-log/2026-06.md`, `development-log/2026-06-17-architecture-review.md`
