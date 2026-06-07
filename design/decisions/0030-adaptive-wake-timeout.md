# 0030 — Adaptive wake timeout from deterministic work units

Status: Accepted
Date: 2026-06-07
Relates: 0010 (staleness circuit-breaker), 0014 (wake cost optimization), 0021 (effort level)

## Context

Sikong's default wake timeout was a fixed 90 seconds. That is too short for real
dogfood work: a lead may need to inspect a repository, design a plan, create
subtasks, or wait for ordinary build/test evidence. Stopping a run because it
crossed a fixed wall-clock value confuses normal execution with failure.

The replacement must not be a human-style project estimate such as "this should
take a few hours" or "this phase should take a day". Those estimates are not
auditable and tend to reflect a person's development habit rather than the
actual wake workload. Sikong needs a deterministic watchdog budget: enough time
for the current wake to do its visible work, but still bounded so a wedged
backend cannot hang the task forever.

## Decision

When the CLI does not pass `--wake-timeout`, Sikong computes an adaptive timeout
for each wake from deterministic work units. The calculation is local and
auditable:

1. Start with one agent turn base budget.
2. Add prompt-size units from the request, current fields, project memory, and
   child-team snapshot. This reflects context the worker must read in this wake.
3. Add output-field units for fields the stage is expected to write.
4. Add tool-surface units from the worker and Sikong command tools exposed in
   the wake.
5. Add acceptance units from explicit acceptance checks. Command checks add
   command-class budgets (`build`, `test`, `typecheck`, `lint`, `pack`, `smoke`);
   `projectGate` adds the standard project verification budget; cheap file/grep
   checks add small budgets.
6. Add child-team units for lead stages that must inspect or coordinate children.
7. Apply the resolved effort multiplier (`low`, `medium`, `high`, `max`).
8. Clamp the result to a bounded watchdog range.

This is not an estimate of project completion time. It is the maximum wall-clock
time for one wake before the engine treats the run as abnormal. The chronicle
records the computed timeout and component breakdown so operators can inspect
why a wake was given that budget.

`--wake-timeout <seconds>` remains an explicit override. Overrides are useful for
tests, emergency operations, or deliberately constrained smokes.

## Why this shape

- Deterministic: the same task/stage/workflow inputs produce the same timeout.
- Mechanistic: every addition comes from visible work units, not subjective
  "developer time".
- Bounded: adaptive budgets prevent premature cancellation without removing the
  runaway backstop.
- Inspectable: the chronicle records the budget calculation.
- Composable: effort, acceptance, and team structure influence timeout without
  changing worker selection or workflow guards.

## Alternatives considered

- **Keep 90 seconds and tell humans to pass `--wake-timeout`.** Rejected: this
  made normal dogfood work look broken and moved routine supervision burden onto
  the operator.
- **Ask the lead/model to estimate stage duration in natural language.**
  Rejected: hard to audit and likely to regress into human habit estimates.
- **Disable timeout for long tasks.** Rejected: a wedged backend would again be
  able to hang a task indefinitely.

## Consequences

- Normal design/delegation/verification wakes get more time when their visible
  workload is larger.
- Timeout failures become stronger signals because the engine has already
  budgeted for the current wake's work units.
- The constants are engine calibration constants, not product estimates. Future
  dogfood should tune them from observed wake durations and chronicle evidence.
