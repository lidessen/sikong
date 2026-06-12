# 0033 - Worker work-log review replaces automatic commit fallback

Status: Accepted

## Context

Sikong previously handled a worker wake that ended without durable stage state by
starting a constrained second pass with `commit_stage` / `block` / `cancel`.
That made missing state easier to recover from, but it also let code and the
same worker turn telemetry facts into semantic progress decisions.

The project boundary is now stricter: code may record facts about a worker run,
but progress, quality, repair, block, accept, and continue decisions belong to a
lead or reviewer agent reading the worker's work log.

## Decision

Replace the automatic commit fallback with a review-required work-log path.

When a worker wake ends without a stage commit signal, the engine records:

- `wake.diagnostics`: factual run summary, tool counts, text preview, errors
- `wake.review_required`: a compact work-log review request with reason,
  command kinds, output fields, sanitized tool facts, and worker text preview

The engine does not start another worker pass to choose `commit_stage`, `block`,
or `cancel`. It also does not treat the missing state command as a wake error by
itself. `sikong actions` surfaces the review-required entry for the lead, and
`sikong trace <task> --text` shows the work log.

## Boundaries

Allowed code judgments are structural facts:

- run ended / errored / timed out
- state commands were or were not recorded
- tool calls started / ended / errored
- a review-required work log exists

Disallowed code judgments are semantic worker-progress decisions:

- no progress / enough progress
- repair required
- worker is over-exploring
- result quality is sufficient
- block / accept / continue based on telemetry

Those decisions are made by the lead or another reviewer agent reading the work
log and any task evidence.

## Consequences

- Worker self-recovery is less automatic, but the responsibility boundary is
  simpler and auditable.
- Lead/reviewer workflows can still automate review, but that automation is an
  agent decision over a work log, not engine policy over counters.
- `wake.commit` remains readable for old chronicles, but new wakes should emit
  `wake.review_required` instead of starting a commit fallback.
