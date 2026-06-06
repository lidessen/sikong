# 0027 - Lead-authored per-task acceptance criteria

Status: Accepted (revised 2026-06-06)
Date: 2026-06-05
Extends: 0024 (grounded acceptance gates); complements 0008 (lead owns staffing/acceptance), 0025

## Context - a generic test gate can't catch a missing feature the worker tests around

Dogfooding exposed a hole in generic verification: when the implementing worker
also authors the tests, project-level checks can pass while the actual requested
behavior is still missing. Observed examples included a worker doing the easy
80%, dropping a specific hard case, and then producing green tests that matched
the incomplete implementation.

The fix is not to let the worker define what "done" means. The lead/client who
delegates the task must be able to attach acceptance criteria that survive into
the review boundary.

## Decision

A task carries optional, lead/client-authored `acceptance: AcceptanceCheck[]`.
These criteria are immutable by the worker and are presented as the expectations
the worker must address in its submitted evidence.

- **State:** `Task.acceptance?: readonly AcceptanceCheck[]`, set at creation.
- **Delegation:** `create_subtask({ acceptance })` lets a delegating lead attach
  the child-specific expectations the child must cover.
- **Top-level:** CLI `create --acceptance '<json>'` lets the human/conductor lead
  author criteria for a root task.
- **Gate:** `acceptancePassed` depends on the lead's accepted/rejected decision
  for the current acceptance-bearing stage. The criteria inform the evidence and
  review; the engine does not automatically run them.

### Stage criteria and task criteria

`StageDef.acceptance` describes workflow-level expectations for a stage, such as
"submit project gate evidence." `Task.acceptance` describes task-specific
expectations, such as "the `pushd`/`popd` cases classify allow."

Both sets are lead-authored review criteria. The worker must submit evidence that
addresses them, and the lead decides whether that evidence is enough.

### Worker cannot game it

The criteria live on the task/workflow and are not writable by the worker during
execution. The worker can submit evidence and request a transition, but only a
lead acceptance event can satisfy `acceptancePassed`.

## Consequences

- "All tests pass" from a worker that wrote the tests is no longer enough by
  itself; it is evidence the lead reviews against the externally authored
  criteria.
- Generic workflows can carry specific acceptance criteria without needing a
  bespoke workflow per task.
- The surface stays small: one optional Task field, one optional `create_subtask`
  param, one CLI flag, and the same lead decision event used by ADR 0024.
