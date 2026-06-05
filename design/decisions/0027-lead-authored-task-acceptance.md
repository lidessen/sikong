# 0027 — Lead-authored per-task acceptance checks

Status: Accepted
Date: 2026-06-05
Extends: 0024 (grounded acceptance gates); complements 0008 (lead owns staffing/acceptance), 0025

## Context — a generic test-gate can't catch a missing feature the worker tests around

ADR 0024 gates a stage transition on a grounded verifier running the stage's
**static** `acceptance` checks. The builtin `development` workflow uses one such
check on its verify stage: `projectGate` (`bun run typecheck` + `bun run test`).

Dogfooding exposed the hole: when the implementing worker also **authors the
tests**, `projectGate` passes green while the actual requirement is unmet. Observed
twice on one classifier task — the worker did the easy 80%, dropped the hard
requirement (neutral-command handling; then `pushd`/`popd`), and wrote/adjusted its
own tests to match what it built. typecheck + the worker's tests were green; the
spec was not met. A generic, worker-authored test gate **cannot** catch a missing
feature that has no (faithful) test. Only external, lead-authored checks can.

## Decision — let the lead attach acceptance checks to a task

A task carries an optional, lead/client-authored `acceptance: AcceptanceCheck[]`
(the same union as `StageDef.acceptance` — command / fileExists / grep /
projectGate). These are **merged with** the stage's static acceptance at the gate,
so the implementing worker cannot redefine or remove them.

- **State:** `Task.acceptance?: readonly AcceptanceCheck[]`, set at creation,
  immutable by the worker (no command mutates it).
- **Delegation:** `create_subtask({ acceptance })` — a delegating lead attaches the
  checks the child must satisfy ("the `pushd`/`popd` cases must classify allow").
- **Top-level:** CLI `create --acceptance '<json>'` — the human/conductor lead
  authors checks for a root task.
- **Gate (engine):** where a stage with static `acceptance` is evaluated (ADR
  0024's verifier point), the effective check list becomes
  `[...stage.acceptance, ...task.acceptance]`. The combined verdict feeds the
  existing `acceptancePassed` guard.

### Why merge only at stages that already gate

Task acceptance is evaluated **only** at stages that already carry static
acceptance (the workflow's designated gate — verify, for `development`). Running it
at every transition would fail prematurely (the code isn't written at design/plan)
and trip the correction loop spuriously. Scoping to gate stages keeps it correct
and minimal; the worker still can't reach `done` (guarded by `acceptancePassed`)
until the lead's checks pass for real. A workflow must have ≥1 acceptance-bearing
stage for task acceptance to apply — `development`'s verify stage qualifies.

### Worker cannot game it

The checks live on the task (authored by the parent/client/conductor) and are run
by the engine's grounded verifier — not by worker-authored tests. The worker must
make them pass against the real tree.

## Consequences

- The lead expresses intent as machine-checkable acceptance at delegation time;
  "all tests pass" from a worker that wrote the tests is no longer sufficient
  evidence — the lead's checks are independent.
- Pairs with the practice (proven on the operator-console run) of a custom workflow
  carrying specific `grep`/`command` checks. ADR 0027 makes that first-class for the
  generic `development` workflow without a bespoke workflow per task.
- Minimal surface: one optional Task field, one optional `create_subtask` param, one
  CLI flag, and a one-line merge at the existing gate. No new stage, no new guard.
