# 0035 - Worker tool trace and abandoned-run cleanup facts

Status: Accepted
Date: 2026-06-12
Relates: 0033 (worker work-log review), 0032 (wake preemption)

## Context

Dogfood runs exposed two operator-facing gaps:

1. `sikong trace` made a worker look idle or suspicious when it had no text
   output, even though the worker was actively calling tools. The engine already
   records structural `tool_call_start` / `tool_call_end` facts, but the trace
   view only showed a summary and the latest progress entry.
2. A wake timeout can return control to Sikong after sending cancel/abort while
   the underlying runtime is still cleaning up or ignoring cancellation. The
   engine must not block forever, but the operator needs a factual cleanup
   record. ADR 0036 defines the runtime-level cleanup contract used for this
   record.

## Decision

- `trace` shows a compact tool timeline for the latest wake, not only text
  previews or aggregate counts. Each row is a structural tool fact: phase,
  start/end/error, tool name, call id, duration, and sanitized args/result/error
  preview when available.
- Latest wake status is derived from terminal wake events within the same wake:
  a later `wake.end` means ended, a later `wake.error` means error, otherwise
  wake activity without a terminal event means active.
- The engine records `wake.cleanup` when `boundedRun` times out and requests
  runtime cleanup. The cleanup record is the `CleanupResult` from ADR 0036:
  settled, cancelled-settled, or unsettled.

## Boundaries

The engine still records only structural facts. It does not infer whether the
worker made enough progress, whether the tool choices were semantically useful,
or whether the result should be accepted. Those decisions remain with lead or
reviewer agents reading the work log.

## Consequences

- Operators can distinguish "no text output" from "worker is using tools".
- Lingering backend cleanup becomes visible as a chronicle fact instead of an
  invisible suspicion.
- No runtime-specific process kill contract is added. Runtime adapters remain
  responsible for honoring cancel/abort where they can.
