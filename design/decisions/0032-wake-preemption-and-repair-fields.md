# 0032 — Wake preemption (lead cancel interrupts in-flight wake) + acceptance reason in prompt

Status: Accepted
Date: 2026-06-10
Relates: 0004 (worker cancel requires lead approval), 0024 (grounded acceptance gates), 0027 (lead-authored per-task acceptance), 0030 (adaptive wake timeout)

Update 2026-06-12: ADR 0034 narrows the external CLI boundary. Lead- and
engine-sourced `cancel`/`block` still preempt wakes as described here, but
external operator `submit cancel|block|stop` now writes lead-review messages
instead of directly mutating task state.

## Context

Two concrete operator pain points from dogfood runs:

1. **No way to stop an in-flight wake without killing the process.** When an operator submits a `cancel` command via `sikong submit <id> cancel`, the `task.cancelled` event is appended to the timeline and the next wake sees the terminal state — but the *current* in-flight wake finishes its entire agent run (potentially minutes, burning tokens) before the cancellation takes effect. The existing steer mechanism is advisory (the agent may or may not respond) and does not stop a wedged or runaway wake. The only reliable escape today is SIGTERM, which kills the entire engine.

2. **Worker cannot see why lead acceptance was rejected.** When a lead rejects a worker's submitted evidence with `sikong submit <id> reject <reason>`, the worker is re-woken on the next `nudge` or `run`. It sees `acceptanceStatus: "rejected"` from the guard/env but NOT the human-readable reason for the rejection. Without knowing *why* the evidence was rejected, the worker cannot repair the fields or resubmit correctly — it keeps emitting the same evidence, stuck until the lead surface-edits the field values directly.

## Decisions

### 1. Wake preemption on lead/engine cancel

**When a lead or engine-sourced `cancel` command is submitted for a task with an in-flight wake, the engine immediately aborts the running agent run** instead of letting it complete. This is a hard preemption, not a graceful request: the run is cancelled, an error result is synthesized, and the wake post-phase sees the terminal `task.cancelled` event and drops all worker commands from the aborted run.

**Mechanism:**
- The engine's per-task state (`StateEntry`) gains an optional `stopWake: (reason: string) => void` field.
- `runWake` sets `stopWake` to a function that calls `controller.abort(reason)` and `run.cancel(reason)` on the current phase's controller and run handle, **before** starting each phase (worker run, commit fallback).
- `runWake`'s `finally` block clears `stopWake`.
- `submitCommand` checks for an in-flight wake after appending the lead/engine `cancel` or `block` event: it reads `this.state.get(taskId)?.stopWake` and calls it if present. Writing the state event first ensures the wake post-phase re-loads a terminal/blocked live task and drops worker commands from the interrupted run.
- Cross-process CLI submissions use the same event timeline: the wake's control pump polls the task log while a run is active and stops the current phase when it observes lead/engine `task.cancelled` or `task.blocked`.
- The existing `boundedRun` timeout mechanism is the safety net: if the SDK ignores `run.cancel()`, the wall-clock timeout still terminates the run and produces the same errored result.

**What gets dropped:**
- The aborted run's diagnostics, tool calls, and text output are discarded — they were work on a cancelled task.
- The wake post-phase loads the live task (which includes the `task.cancelled` event) and skips all worker command application because `isTerminal(live.status)` is true.
- Any partial file writes the agent was mid-way through are orphaned. This is the same risk as any process interruption and is acceptable for a cancelled task.

**Block from lead also interrupts:** A `block` command from lead source produces `task.blocked`, which is also checked by the `!isTerminal(live.status) && live.status !== "blocked"` guard. For consistency, a lead `block` should also stop the in-flight wake. This is a natural extension of the same mechanism.

### 2. Acceptance rejection reason in per-wake prompt

**The lead's rejection reason is exposed to the worker in the per-wake prompt** so the worker knows what to repair.

**Mechanism (already implemented in the working tree diff):**
- `deriveAcceptanceReason(events)` scans the event timeline within the current stage (from most recent to oldest, stopping at `stage.entered`/`task.created`) and returns the `reason` payload from the latest `acceptance.accepted` or `acceptance.rejected` event.
- The engine wires `leadStatus.acceptanceReason` into `buildPrompt()`, which renders `latest acceptance reason: <reason>` in the per-wake message.
- The lead team status digest (`deriveLeadTeamStatus`) also propagates `acceptanceReason` so a lead task reviewing its children sees the rejection reasons too.
- Review-stage instructions already guide the worker to revise on rejection: e.g. "If the latest lead acceptance decision is rejected, FIRST revise the blueprint/docs according to the rejection reason."

## Why this shape

- **Hard preemption** matches the operator's mental model: "I cancelled the task, it should stop." Bounded lag (current behavior) is correct for correctness but wrong for UX — operators want a responsive escape hatch, not a "wait and hope it finishes."
- **Simple mechanism**: one callback stored on a state object, set and cleared in deterministic lifecycle paths. No new IPC, no new event types, no changes to the reducer or command schema.
- **No new commands**: the existing `cancel` (and `block`) commands from lead/engine are already terminal/blocking in the reducer. Preemption only changes WHEN the termination takes effect, not which commands produce it.
- **Acceptance reason is data, not a new channel**: it was already recorded in the event timeline (`acceptance.rejected` payload.reason). The fix is extracting it and projecting it into the prompt — no schema change.
- **Separate concerns**: preemption is a UX/token-savings mechanism; repair-fields is an information-flow mechanism. They interact minimally (a preempted wake won't see the rejection reason in the current run, but the next wake will).

## Consequences

- Operators get a responsive `sikong submit <id> cancel` that actually stops the wake.
- Token waste from cancelled but still-running wakes is eliminated.
- The engine state object gains a mutable callback reference. This is safe because JavaScript is single-threaded (no true concurrency between `submitCommand` and `runWake`'s lifecycle).
- Workers re-woken after a rejection see the reason and can target their repair.
- Worker `cancel` remains approval-only: it records `cancellation.requested`, may close the current worker pass like other stage-closing command tools, but does not terminally cancel the task and does not use the external `submitCommand` preemption path.
- The `block` from lead case also preempts, consistent with the guard logic.
