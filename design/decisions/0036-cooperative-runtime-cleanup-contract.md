# 0036 - Cooperative runtime cleanup contract

Status: Accepted
Date: 2026-06-12
Relates: 0032 (wake preemption), 0035 (worker tool trace and abandoned-run cleanup facts)

## Context

Sikong dogfood runs showed that a timed-out wake can return control to the
engine while the runtime is still settling after cancellation. The operator
needs to know whether the worker settled, ignored cancellation, or merely lacks
process-level facts. The engine also needs a bounded operation; it must not
wait forever and must not default to killing runtime processes.

`agent-loop` already exposes `cancel(reason)`, but cancellation is fire-and-
forget. That is not enough for a supervisor that needs to record a factual
cleanup outcome.

## Decision

- `RunHandle` exposes `cleanup(options)` in addition to `cancel(reason)`.
- `cleanup` is cooperative by default. `hardKill` defaults to `false`; callers
  must opt in, and adapters may still report that hard termination is not
  available.
- The executor provides a backend-neutral default:
  - request cancellation;
  - wait up to `graceMs` for `result` to settle;
  - return `cancelled_settled`, `settled`, or `unsettled`;
  - never reject for normal cleanup failure.
- `CleanupResult` records machine-readable facts: status, elapsed time,
  hard-kill intent, reason, runtime, result status when available, and optional
  PID or PID-unavailable reason.
- Runtime adapters may implement adapter-native cleanup only when they can add
  real native close semantics or process facts. They should not fabricate PIDs.
- Sikong uses `run.cleanup({ hardKill: false })` on wake timeout and records
  the returned `CleanupResult` as a `wake.cleanup` chronicle entry.

## Boundaries

This decision does not add a process-group reaper, zombie detector, or default
SIGKILL path. SDK runtimes that do not expose a process id report
`pidUnavailableReason`.

The lead or reviewer still decides task progress from work logs and evidence.
Cleanup status only describes runtime settlement after cancellation.

## Consequences

- Timeout handling becomes factual and bounded: settled, cancelled-settled, or
  unsettled.
- Sikong no longer needs to infer worker state from text silence or process
  suspicion.
- Future adapter-specific hard cleanup can be added behind the same explicit
  `hardKill` option without changing Sikong's workflow semantics.
