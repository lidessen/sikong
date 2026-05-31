# ADR 0001: Stage-scoped subtasks block stage advancement

Status: Proposed

Date: 2026-05-31

## Context

`wakespace` models a task as a workflow instance with ordered stages,
durable fields, an append-only event timeline, and deterministic guard-based
advancement. The current workflow model already has `create_subtask`,
`blocksParent`, `childIds`, and a `childrenDone` guard shape, but the stage-level
semantics are not yet closed.

The missing decision is whether a task may delegate work inside the current
stage and whether unresolved delegated work should prevent that stage from
advancing.

## Decision

A task may create subtasks that are scoped to its current stage.

If any stage-scoped blocking subtask is still open, the parent task must not
advance out of that stage. The parent may request a transition, but the workflow
engine must deny or defer advancement until all blocking subtasks for the current
stage are terminal.

Terminal child statuses are `done` and `cancelled`. A blocked child is still
open.

## Consequences

- Delegation becomes a first-class workflow mechanism rather than an informal
  note or prompt convention.
- Parent advancement stays deterministic: the agent can propose progress, but
  the reducer/engine decides whether the stage may move.
- Stage boundaries become meaningful ownership boundaries. Work spawned in one
  stage cannot be silently ignored by moving to the next stage.
- The event model needs enough information to replay this rule from durable
  history, not only from an in-memory projection.

## Implementation Notes

This decision should be implemented in `packages/wakespace`.

Expected changes:

- Extend `subtask.created` payloads with the parent `stageId` at creation time.
- Expose a `create_subtask` command tool for stages that allow delegation.
- Preserve `blocksParent` semantics as the explicit switch for whether the child
  blocks parent stage advancement.
- Make advancement consult only blocking children created for the current parent
  stage.
- Record enough child status evidence on the parent timeline, or otherwise make
  the child-status lookup replay-safe before treating this as durable production
  behavior.
- Add reducer/engine tests for:
  - parent cannot advance while a blocking current-stage child is open;
  - parent can advance after all blocking current-stage children are terminal;
  - non-blocking children do not prevent advancement;
  - children from another stage do not block the current stage;
  - blocked children still block advancement.

## Open Questions

- Should `cancelled` always count as terminal for parent advancement, or should a
  workflow be able to require child `done` specifically?
- Should parent stage advancement create an explicit `transition.deferred` or
  `transition.rejected` event when children block it?
- Should stage-scoped child completion be mirrored onto the parent event log, or
  should the production store provide a transactional child-status snapshot?
