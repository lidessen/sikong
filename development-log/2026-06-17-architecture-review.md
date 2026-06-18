# Sikong Architecture Review & Improvement Recommendations

**Date:** 2026-06-17
**Scope:** Read-only architecture analysis across all major subsystems
**Author:** Architecture Review Work Unit

---

## Executive Summary

Sikong has a principled architecture — event-sourced coordination engine, clear Go/TypeScript boundary, role-separated agent protocol, and deliberately narrow tool surfaces. The design documents are unusually precise about what is in scope and (more importantly) what is deferred. However, several systemic risks affect execution reliability, observability, and developer productivity:

1. **Phase 16 (Task Lead + Stage Rounds) is unimplemented** — the core multi-worker protocol is designed but not wired. Current orchestration falls back to legacy preset scheduling.
2. **Process-backed execution has fragile error recovery** — failure modes mix process-fact recording with worker-run state in ways that can produce inconsistent projections.
3. **Client-agent interaction lacks steer support and timeout hardening** — the `waitClientAgentRun` race logic is brittle.
4. **No structured logging framework** — all diagnostics are ad-hoc string construction.
5. **Observation storage scales linearly** — observations grow unbounded in the event log.
6. **AI SDK tool profiles lack sandboxing** compared to Claude Code / Codex / Cursor adapter-native surfaces.

---

## Prioritized Recommendations

### P0 — Critical (blocking reliability or correctness)

#### P0.1 Deliver Lead + Stage Round Protocol (Phase 16)

**Description:** The target team workflow (Task Lead → Planner → Stage Workers → Reviewer → Final Review) is defined in the design (`coordination-engine.md`) but not implemented. The current preset-based orchestration (`tick.ts`) simulates this with inline prompt construction and direct command handler calls, but there is no dedicated Lead runtime, no requirement-spec → plan_requested engine trigger, no StageRoundDef event/projection wiring at the orchestration level, and no work-unit-level concurrency safety.

**Risk if not addressed:** Multi-worker tasks cannot execute. The orchestration driver runs single-worker presets only. The product cannot deliver its core promise.

**Entry files/modules:**

- `packages/workspace/src/coordination/types.ts:28-43` — StageRoundDef and StageWorkUnitDef are defined but `stage_round.planned`/`stage_round.completed` events are never emitted by command handlers.
- `packages/workspace/src/commands/task.ts` — missing `submitRequirementSpec` → auto-trigger `plan.requested` pipeline.
- `packages/workspace/src/orchestration/tick.ts:161-221` — `planRunningAction` and `planReviewingAction` are ready for rounds but receive no round-planned events.
- `packages/workspace/src/coordination/reducer.ts:122-145` — reducer handles `stage_round.*` events but nothing generates them.
- `packages/workspace/src/runtime/default-assembly.ts:10-34` — `RuntimeAssemblyProfile` has no "lead" profile wired.

**Immediate next step:** Implement `submitRequirementSpec` command handler → auto-emit `plan.requested`. Wire `plan_stage_round` → emit `stage_round.planned` with work units. Wire the lead protocol tool profile (`sikong-lead-protocol`) as a real Agent Loop run.

---

#### P0.2 Stabilize Process-Backed Error Recovery

**Description:** `executeOrchestrationActionProcess` in `process.ts` has a fragile pattern where process failure + worker run state recording are interleaved. When a process exits non-zero or times out, `recordProcessActionFailure` (line 381) queries the projection for running worker runs by matching `roundId + workUnitId` — but this can match stale runs from a previous round. The `failWorkerRun` call in `recordProcessActionFailure` (line 420) is called _after_ `recordRuntimeProcessFinished` (line 152), which means the projection is partially updated. Race between `monitorProcessRunning` (line 357) polling and the main wait loop is a tight window.

**Risk if not addressed:** Ghost "running" worker runs survive process crashes. Stale `roundId`/`workUnitId` matching produces incorrect terminal events. Projection state becomes inconsistent.

**Entry files/modules:**

- `packages/workspace/src/orchestration/process.ts:87-198` — main process execution with interleaved recording.
- `packages/workspace/src/orchestration/process.ts:381-432` — `recordProcessActionFailure` with fragile run matching.
- `packages/workspace/src/orchestration/process.ts:357-375` — `monitorProcessRunning` polling race.
- `packages/workspace/src/orchestration/process.ts:200-355` — `executeStageWorkerProcesses` concurrent launch + wait pattern.

**Immediate next step:** Separate process-fact recording from worker-run state transitions. Use the event lock to record `worker_run.failed` atomically with `runtime_process.finished` in a single `appendManyAndRebuildProjection` call. Replace the fragile `roundId+workUnitId` match with an explicit `runId` passed through the process output envelope.

---

#### P0.3 Add Structured Logging Framework

**Description:** The entire codebase uses ad-hoc string concatenation for diagnostic output. There is no structured logger, no log levels, no correlation IDs across process boundaries, and no machine-parseable output for monitoring. Examples: `worker-run.ts` line 324 `taskResultReport`, `process.ts` line 455 `processFailureDetail`, and every `CommandResult` error carries only `code` + `message` without a log context.

**Risk if not addressed:** Debugging multi-process execution (daemon → Bun child → agent-loop → LLM API) requires grepping unstructured stderr. Production incidents cannot be traced across process boundaries. The `truncateText` pattern everywhere silently discards diagnostic information with no audit trail.

**Entry files/modules:**

- Throughout all `packages/workspace/src/` — `CommandResult.error.details` is the only structured error carrier.
- `packages/workspace/src/process/run.ts:50-53` — stdout/stderr capture with truncation.
- `packages/workspace/src/process/limited-capture.ts:1-46` — 256KB capture limit.
- `packages/workspace/src/runtime/worker-run.ts:474-475` — observation text limits (420/520 chars).

**Immediate next step:** Introduce a logger module with trace/event IDs. Use `CommandContext` to carry a correlation ID. Replace the `Bun.spawn` raw stdout pipe in `run.ts` with structured log lines. Add a `logger` field to `CommandContext`.

---

### P1 — High (significant impact on developer velocity or UX)

#### P1.1 Observation Storage / Retrieval Scaling

**Description:** Worker run observations (`WorkerRunObservation`) are stored inline inside `TaskRunResult.observations` (a legacy field) or in separate `state/observations/` files. The `WorkerObservationCollector` in `worker-run.ts:337-472` generates one observation per loop event (thinking, tool call start/end, usage, step, etc.) with a 420-char text limit. For long agent runs, this produces thousands of observations. The `compactWorkerRun` function in `runner.ts:197-207` strips observations from the projection serialized through JSON across process boundaries — but this means observations are silently lost rather than paginated.

**Risk if not addressed:** Task event logs grow unbounded. JSONL files become gigabytes for long-running tasks. `inspectTaskTrace` and `inspectTaskEvents` become unusably slow. The current `observationGroups` in `task-detail.tsx:241-248` loads all observations into memory.

**Entry files/modules:**

- `packages/workspace/src/runtime/worker-run.ts:78-96` — observation collection and flush.
- `packages/workspace/src/orchestration/runner.ts:197-207` — `compactWorkerRun` strips observations silently.
- `packages/workspace/src/coordination/types.ts:192-223` — observation type definitions.
- `packages/client/src/task-detail.tsx:241-248` — observation loading in UI.

**Immediate next step:** Implement observation pagination in the store layer. Store observations in a separate file per worker run (not embedded in events). Add a `limit` parameter to inspect commands. Remove the legacy `observations` field from `TaskRunResult`.

---

#### P1.2 Client Agent Turn Timeout / Abort Hardening

**Description:** `waitClientAgentRun` in `turn.ts:453-506` uses `Promise.race` between the run result, a timeout, and an external abort signal. If the timeout fires after the run naturally completed but before the race is settled, `run.cancel` is called on an already-finished run, kicking off a 2-second `cleanup` that is `void`ed. The `settlement` pass (line 174) repeats the same fragile pattern. `shouldRunSettlementPass` (line 518) has a text-based heuristic that can suppress valid outcomes.

**Risk if not addressed:** Cancel signals to already-completed agent loops cause spurious cleanup work. Timeout races produce inconsistent `RunResult` objects. Users see "Turn cancelled" when the turn actually completed.

**Entry files/modules:**

- `packages/workspace/src/client-agent/turn.ts:453-506` — `waitClientAgentRun` race.
- `packages/workspace/src/client-agent/turn.ts:518-523` — `shouldRunSettlementPass` heuristic.
- `packages/workspace/src/client-agent/turn.ts:131-141` — early return on cancelled status.
- `packages/client/src/api.ts:127-179` — `consumeTurnStream` SSE parsing (no timeout per chunk).

**Immediate next step:** Add `finished` flag to the run handle so `cancel` is a no-op on completed runs. Replace the timeout `setTimeout` with `AbortSignal.timeout` for cleaner composition. Move settlement heuristic to an explicit tool-call check rather than text presence.

---

#### P1.3 Work Unit Instruction / Deliverable Schema Drift

**Description:** The `StageWorkUnitDef` in `coordination/types.ts:34-42` has `instructions: string[]`, `deliverables: string[]`, and `outOfScope: string[]` — all required, all `minItems: 1`. However, the design document `coordination-engine.md:324-329` shows `StageWorkUnitDef` without these fields — only `title`, `objective`, and optional `acceptance`. The implementation added fields that the design deferred. These fields are serialized through the lead protocol tool (`plan_stage_round` in `protocol-tools.ts:597-621`) into StageRoundPlanned events. Once data exists with this schema, changing it becomes a migration problem.

**Risk if not addressed:** Future need to simplify the work unit schema requires a data migration. The rigid `instructions`/`deliverables`/`outOfScope` fields constrain how leads can describe work.

**Entry files/modules:**

- `packages/workspace/src/coordination/types.ts:34-42` — `StageWorkUnitDef` with extra required fields.
- `packages/workspace/src/runtime/protocol-tools.ts:397-467` — `parseWorkUnit` with required array validation.
- `packages/workspace/src/runtime/protocol-tools.ts:597-621` — `stageRoundSchema` with required arrays.
- `design/coordination-engine.md:324-329` — design showing simpler schema.

**Immediate next step:** Before Phase 16 data is written, align the schema with the design: make `instructions`/`deliverables`/`outOfScope` optional. This is a zero-migration window today.

---

#### P1.4 CLI `task drive` Entry-Point Discovery

**Description:** The orchestration driver entrypoint is `packages/workspace/src/orchestration/runner.ts` with a hardcoded relative path `./src/orchestration/runner.ts` in `process.ts:54`. The daemon starts `bun ./src/orchestration/runner.ts --spec <request>`. This path is relative to the package CWD, which must be set to `packages/workspace/`. If the binary is installed globally or through `bun link`, the CWD will not be correct. The `command` override exists but no auto-detection.

**Risk if not addressed:** `sikong task drive` fails when run from any CWD other than the workspace package root. Production deployments must pin CWD manually.

**Entry files/modules:**

- `packages/workspace/src/orchestration/process.ts:48-65` — `createOrchestrationProcessSpec` hardcoded path.
- `packages/workspace/src/orchestration/runner.ts:372-375` — `import.meta.main` entry.

**Immediate next step:** Resolve the runner path from the package installation root at build/install time. Store the absolute path in a config or environment variable (`SIKONG_RUNNER_PATH`). Fall back to `which bun` + `bun -e` to find the package.

---

#### P1.5 Missing Runtime Assembly Tests for Error Paths

**Description:** The `RuntimeAssemblyRegistry` and `defaultRuntimeAssembly` functions have extensive happy-path tests but no coverage for: unknown backend name, missing provider/model for AI SDK, missing task cwd for claude-code/codex, unknown tool profile name, or runtime backend option parsing failures. Error paths throw exceptions that are caught by `runOrchestrationRunner`'s catch-all (runner.ts:157-165) and returned as `invalid_input`.

**Risk if not addressed:** A misconfigured workspace or settings file causes a generic `invalid_input` error with no indication of which backend/profile failed. Debugging requires reading the process stdout.

**Entry files/modules:**

- `packages/workspace/src/runtime/assembly.ts:197-206` — `createLoop` throws on unknown backend.
- `packages/workspace/src/runtime/assembly.ts:211-216` — `resolveToolProfile` throws on unknown profile.
- `packages/workspace/src/runtime/assembly.ts:266-319` — `runtimeBackendOptions` throws on missing cwd.
- `packages/workspace/src/runtime/assembly.ts:355-357` — `createRuntimeProvider` throws on unknown provider.
- `packages/workspace/src/runtime/assembly.test.ts` — presumably missing error-path tests.

**Immediate next step:** Add tests for each error path. Wrap the catch-all in `runner.ts` to include the runtime assembly config in error details.

---

#### P1.6 Workspace Preference Injection into Leads/Workers

**Description:** Workspace preferences exist (defined in `client-agent.md:415-421`, implemented in `workspace/preferences.ts`) but are not automatically injected into Lead, Planner, Worker, or Reviewer prompts. The `OrchestrationInput` has `workspacePreferences?: readonly string[]` and the tick forwards them into `createPlanningPreset` etc., but the actual injection point in the prompt construction is unclear — `buildStageWorkerPrompt` does not reference preferences, and the Lead prompts in `tick.ts:343-361` build context from the projection only.

**Risk if not addressed:** Workspace preferences (verification commands, architectural constraints, generated-file rules) are invisible to workers. Teams cannot enforce project-level policy through preferences.

**Entry files/modules:**

- `packages/workspace/src/orchestration/tick.ts:108-130` — `planNextOrchestrationAction` receives `workspacePreferences` but only passes them to `createPlanningPreset`.
- `packages/workspace/src/runtime/worker-run.ts:231-285` — `buildStageWorkerPrompt` has no preference injection.
- `packages/workspace/src/runtime/presets/planner.ts` and `executor.ts` — preset builders may or may not inject preferences.

**Immediate next step:** Audit all preset builders for preference injection. Add preferences to `buildStageWorkerPrompt`. Include preferences in the Lead prompt projection context (`tick.ts:408-437`).

---

### P2 — Medium (important but not blocking)

#### P2.1 Event Store Contention Under Concurrent Workers

**Description:** `FileTaskEventStore.appendManyAndRebuildProjection` (store.ts:43-66) acquires a per-task lock, appends events, reads all events, applies them to the existing projection, and writes the projection atomically. For concurrent work units in the same stage round, each worker run appends its own batch. With the lock held per-batch, workers serialize on projection rebuild. The `rebuild` path reads all events from disk (store.ts:132-156) and reduces from scratch — O(n) per batch for n events.

**Risk if not addressed:** With 3-5 concurrent worker runs and ~1000 events per run, projection rebuilds become a bottleneck. Lock contention grows with concurrency.

**Entry files/modules:**

- `packages/workspace/src/coordination/store.ts:43-66` — lock + read-all + reduce pattern.
- `packages/workspace/src/coordination/store.ts:132-156` — full-event-file read per batch.
- `packages/workspace/src/data-dir/file-lock.ts` — lock implementation.

**Immediate next step:** Benchmark projection rebuild under concurrent load. Consider incremental projection (reading only new events since last rebuild, then applying). Measure before optimizing.

---

#### P2.2 SSE Stream Resilience for Long Turns

**Description:** `consumeTurnStream` in `api.ts:127-179` reads an SSE response body with a simple frame parser. It has no reconnect logic, no partial-frame recovery, no backpressure, and no timeout per chunk. The `response.body.getReader()` pattern blocks on `reader.read()` indefinitely. If the server closes the connection mid-stream, the error surfaces as a generic `TypeError: body is not readable`.

**Risk if not addressed:** Long client-agent turns (minutes of streaming progress) are vulnerable to network hiccups. Mid-stream disconnection loses all progress. The user sees a generic error with no retry mechanism.

**Entry files/modules:**

- `packages/client/src/api.ts:100-107` — `runTurnStream` fetch call.
- `packages/client/src/api.ts:127-179` — `consumeTurnStream` with no timeout/reconnect.
- `packages/client/src/api.ts:109-125` — `resumeTurnStream` (exists but no retry logic).

**Immediate next step:** Add a per-chunk timeout (e.g., 30s). Implement exponential backoff reconnect for `resumeTurnStream` when a `turn.completed` has not been received. Add SSE reconnection support on the server side.

---

#### P2.3 Task Detail UI — Observation Overload

**Description:** `TaskDetailMain` in `task-detail.tsx:241-248` groups observations by `runId` and renders all of them. A single worker run can produce hundreds of observations (thinking, tool_call_start, tool_call_end, usage, step events). The `WorkUnitExecutionDrawer` and `StageRoundCard` in `task-detail-rows.tsx` render these without virtualization or pagination.

**Risk if not addressed:** UI performance degrades on long-running tasks. The detail view becomes unresponsive when selecting a worker run with a large observation set. No lazy loading for observations in the UI.

**Entry files/modules:**

- `packages/client/src/task-detail.tsx:241-248` — observation loading in main component.
- `packages/client/src/task-detail-rows.tsx` — observation rendering.
- `packages/client/src/types.ts:357-393` — `WorkerRunObservationGroup` and `WorkerRunObservation`.

**Immediate next step:** Add client-side pagination (show first 20, "load more" button) for observations. Move observation detail to a lazy-loaded pane. Add a backend `observations` query with `limit`/`offset` support.

---

#### P2.4 Missing Daemon → TypeScript Error Propagation

**Description:** When the daemon's Bun child process crashes (segfault, OOM, or Bun panic), `executeOrchestrationActionProcess` receives a process result with `state: "finished"` but `result: undefined`. Line 175-177 in `process.ts` returns `internal_error` with only the `runId`. The stderr from `process.ts:189` may or may not be captured depending on whether the process wrote to stderr before crashing.

**Risk if not addressed:** Silent child-process crashes are indistinguishable from "stuck" processes. Operators see `internal_error` with no actionable detail. `monitorProcessRunning` polls forever if the daemon loses track of a PID.

**Entry files/modules:**

- `packages/workspace/src/orchestration/process.ts:174-192` — process-finished result parsing.
- `packages/workspace/src/orchestration/process.ts:357-375` — `monitorProcessRunning` polling without max retries.
- `packages/workspace/src/process/run.ts:58-65` — `proc.exited` error handling.

**Immediate next step:** Add a process health check with max retries in `monitorProcessRunning`. Capture Bun child process crash output from stderr even when the process did not write before dying (daemon-side process-wait race handling). Add a max poll duration for the running monitor.

---

#### P2.5 Client Agent System Prompt Ambiguity

**Description:** The `CLIENT_AGENT_SYSTEM_PROMPT` in `turn.ts:71-99` tells the agent "Development work belongs inside Sikong Work Items" but does not explain _when_ to create a work item vs. answering directly. The boundary between "quick answer" and "create a task" is left to the model. The `formatClientAgentPrompt` (line 198-221) adds "Implementation, verification, and final task evidence are produced by the task orchestration agents" — but the agent has `createTask` and `waitTask` tools, making the boundary ambiguous.

**Risk if not addressed:** The client agent creates tasks for trivial lookups, or conversely answers implementation questions without creating work items. Expected behavior varies by model and prompt version.

**Entry files/modules:**

- `packages/workspace/src/client-agent/turn.ts:71-99` — system prompt.
- `packages/workspace/src/client-agent/turn.ts:198-221` — per-turn prompt.
- `packages/workspace/src/tools/client-agent-tools.ts:268-285` — `createTask` and `waitTask` tools.

**Immediate next step:** Add explicit decision rules to the system prompt: "Use createTask only when the request requires file changes, multi-step work, or coordination across agents. For information/status questions, answer directly."

---

#### P2.6 Runtime Process Cancel Idempotency

**Description:** `executeOrchestrationActionProcess` starts a process and records `runtime_process.started`. If `cancel` is called before the process starts (still in `queued` state), `recordRuntimeProcessFinished` is called with `processStatus` "cancelled" which updates the projection. But the `process.ts` main loop may still try to `waitProcessRun` on the cancelled process. The `monitorProcessRunning` function (line 357) polls `getProcessRun` — if the daemon has removed the cancelled process, `getProcessRun` could return `finished` or error.

**Risk if not addressed:** Double-recording of runtime process results. Projection state where `runtime_process.finished` appears before `runtime_process.running`. The cancel operation on the daemon side and the TypeScript side are not synchronized.

**Entry files/modules:**

- `packages/workspace/src/orchestration/process.ts:136-173` — process lifecycle recording.
- `packages/workspace/src/commands/task.ts` — `task cancel` command handler.
- `packages/workspace/src/coordination/reducer.ts:83-115` — runtime process event reducer.

**Immediate next step:** Make `waitProcessRun` tolerant of already-cancelled process IDs (return immediately). Add a check in `executeOrchestrationActionProcess` to skip `waitProcessRun` if the process was already cancelled. Record `runtime_process.running` only if not already `finished`.

---

#### P2.7 AI SDK Local Tool Sandbox Inconsistency

**Description:** Claude Code, Codex, and Cursor backends get adapter-native sandbox/permission profiles (`default-assembly.ts:46-63`). The AI SDK backend gets an explicit tool bundle (`createAiSdkLocalTools` in `assembly.ts:374-382`) that runs inside the Bun child process. The AI SDK tools include `readFile`, `viewFile`, `rg`, `grep`, `web_fetch`, `web_search` — but only the execution profile gets all tools; the inspection profile has a subset. There is no sandbox boundary for AI SDK tools — they run with process-level filesystem access.

**Risk if not addressed:** AI SDK workers have unrestricted file access (up to the OS user's permissions). No `allowedPaths` equivalent. The `web_fetch` tool introduces exfiltration risk for AI SDK runs.

**Entry files/modules:**

- `packages/workspace/src/runtime/default-assembly.ts:22-28` — AI SDK tool profiles.
- `packages/workspace/src/runtime/assembly.ts:359-382` — AI SDK local tool creation.
- `packages/workspace/src/runtime/assembly.ts:280-283` — claude-code path restriction only.

**Immediate next step:** Add a `allowedPaths` option to AI SDK local tools. Restrict `web_fetch` behind a feature flag or remove it from the default execution profile.

---

#### P2.8 No Workspace-Level Task List Caching

**Description:** `buildClientAgentContext` (context.ts:76-137) calls `listWorkspaces` + per-workspace `listTasks` on every client-agent turn. For workspaces with many tasks, this becomes an O(n \* m) read. The `buildWorkspaceIndex` (context.ts:155-177) calls `listTasks` for every workspace in parallel, reading all task files.

**Risk if not addressed:** As the number of tasks grows, every client-agent turn becomes slower. The settings dialog and workspace nav also reload state every time.

**Entry files/modules:**

- `packages/workspace/src/client-agent/context.ts:76-137` — full state rebuild per turn.
- `packages/workspace/src/client-agent/context.ts:155-177` — per-workspace task listing.
- `packages/client/src/api.ts:39-42` — `getClientState` uncached.

**Immediate next step:** Add in-memory TTL caching for workspace index and task cards (5s default). Add an `updatedSince` query parameter for incremental state.

---

#### P2.9 Development-Log Traceability

**Description:** The `development-log/2026-06.md` exists but the current file modification status shows this file is staged — it's being actively maintained. However, there is no automated trace from the event log to the development log. Architecture decisions documented in development-log entries are not cross-referenced in design docs.

**Risk if not addressed:** Knowledge about why certain design decisions were made is stranded in unstructured markdown. New contributors cannot discover the rationale without reading the full development log.

**Entry files/modules:**

- `development-log/*.md` — unstructured design rationale.
- `design/*.md` — design docs that reference implementation phases but not decision records.

**Immediate next step:** Add decision-record (ADR) links in design doc footers referencing relevant development-log entries. Consider a lightweight `decisions/` directory with structured ADR format.

---

#### P2.10 Go Daemon Graceful Shutdown Race

**Description:** The Go daemon (cmd/sikongd/main.go) manages child processes and an HTTP API server. The daemon design doc (`daemon-runtime.md:96-118`) specifies the Go daemon owns "process lifecycle and signal handling" and "safe shutdown". The actual `POST /shutdown` implementation may not wait for all child processes to finish, leaving orphan Bun processes. The TypeScript orchestration driver may have pending `waitProcessRun` calls that hang forever.

**Risk if not addressed:** Daemon restart leaves orphan child processes. Subsequent daemon start finds leaked PIDs. `waitProcessRun` timeout (default 2h+60s) is the only safety net.

**Entry files/modules:**

- `internal/daemon/` — daemon lifecycle and shutdown.
- `packages/workspace/src/orchestration/process.ts:143-146` — `waitProcessRun` with 2h+60s default timeout.
- `design/daemon-runtime.md:148-154` — scheduler timeout documentation.

**Immediate next step:** Add pre-shutdown child-process drain to the daemon shutdown sequence. Send SIGTERM to all supervised children, wait for graceful shutdown (with configurable timeout), then SIGKILL remaining. Notify waiting TypeScript clients of forced termination.

---

### Cross-Cutting Concerns

| Concern                                                        | Affected Modules                         | Priority |
| -------------------------------------------------------------- | ---------------------------------------- | -------- |
| Error message quality (generic `internal_error` with no delta) | All command handlers                     | P1       |
| No distributed tracing / correlation IDs                       | All process-boundary crossings           | P1       |
| Ad-hoc text truncation masks errors                            | `worker-run.ts`, `process.ts`, `turn.ts` | P1       |
| Test coverage for error paths                                  | Coordination, orchestration, assembly    | P1       |
| Single-file JSONL event log (no rotation/compression)          | `coordination/store.ts`                  | P2       |
| No health check for agent-loop LLM connectivity                | `assembly.ts`, CLI                       | P2       |

---

## 3-Phase Implementation Roadmap

### Phase A — Near-Term (Quick Wins / High-Risk Fixes)

**Duration estimate:** 2-3 sprints

Ordered by risk reduction:

1. **P0.3: Structured logging framework** — Introduce logger with correlation IDs across `CommandContext`. Prerequisite for debugging all other work.
2. **P0.2: Stabilize process error recovery** — Fix `recordProcessActionFailure` race, use `runId` envelope, atomically batch process + worker-run events. Highest correctness risk.
3. **P1.2: Harden client-agent timeout/abort** — No-op cancel on finished runs, replace `setTimeout` with `AbortSignal.timeout`. Reduces spurious user-facing errors.
4. **P1.3: Align work-unit schema with design** — Make `instructions`/`deliverables`/`outOfScope` optional before Phase 16 data exists. Zero-migration window.
5. **P1.6: Wire workspace preferences into worker/lead prompts** — Low effort, high impact on project-level policy enforcement.
6. **P2.7: Add AI SDK tool sandboxing** — Restrict `allowedPaths` for AI SDK local tools. Remove or flag `web_fetch`.
7. **P2.10: Daemon graceful shutdown drain** — Prevent orphan child processes.
8. **P2.6: Runtime process cancel idempotency** — Prevent double-recording and stale `waitProcessRun` calls.

### Phase B — Medium-Term (Structural Improvements)

**Duration estimate:** 3-5 sprints

1. **P0.1: Deliver Phase 16 (Lead + Stage Rounds)** — The core product feature. Includes:
   - Lead runtime with requirement-spec tool
   - `plan.requested` auto-trigger from spec submission
   - `stage_round.planned`/`completed` event wiring
   - Work-unit-level concurrency in orchestration
   - Stage review rejection → lead round-planning loop
   - Compact inspect for active round and work-unit status
2. **P1.1: Observation storage/retrieval scaling** — Separate file per run, pagination, remove legacy field.
3. **P1.4: Fix runner entry-point discovery** — Resolve absolute path at install time.
4. **P2.2: SSE stream resilience** — Per-chunk timeout, reconnect logic for long turns.
5. **P2.3: UI observation pagination** — Lazy-loaded observation detail, "load more" in task detail.
6. **P2.5: Sharpen client-agent system prompt** — Explicit decision rules for task creation.
7. **P2.8: Workspace task list caching** — TTL cache for client state.

### Phase C — Long-Term (Larger Architectural Changes)

**Duration estimate:** 5-8 sprints

1. **P2.1: Event store performance** — Incremental projection rebuild, benchmark-driven optimization, consider SQLite or similar for event storage.
2. **P2.9: Decision-record traceability** — ADR format, cross-reference design docs with decisions.
3. **Cross-cutting: Distributed tracing** — End-to-end correlation IDs from user message → client-agent → task orchestration → worker run → LLM API call.
4. **Cross-cutting: Event log compression/rotation** — Archive old events, compaction for terminal tasks.
5. **Cross-cutting: Integration test harness** — End-to-end test from CLI command through daemon to worker run with mock agent loop.
6. **Cross-cutting: Observability dashboard** — Metrics for task throughput, stage duration, worker success rate, LLM token usage per task.

---

## Validation Commands (Do Not Execute)

When implementing these recommendations, validate with:

```bash
# Coordination reducer tests
bun --filter @sikong/workspace test -- --test-path-pattern "coordination"

# Orchestration tick + execution tests
bun --filter @sikong/workspace test -- --test-path-pattern "orchestration"

# Runtime assembly tests
bun --filter @sikong/workspace test -- --test-path-pattern "runtime|assembly"

# Process runner tests
bun --filter @sikong/workspace test -- --test-path-pattern "process"

# Client agent tests
bun --filter @sikong/workspace test -- --test-path-pattern "client-agent"

# Protocol-tools tests
bun --filter @sikong/workspace test -- --test-path-pattern "client-agent-tools"

# Full check
bun run check

# Static role/kind search (ensuring no agent role fields leak)
rg -n "AgentKind|PlannerAdapter|ReviewerAdapter|WorkerAdapter|role\\s*:|kind\\s*:" packages/workspace/src cmd internal design
```
