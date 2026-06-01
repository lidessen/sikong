# ADR 0004: Worker Cancel Requires Lead Approval

Status: Accepted

Date: 2026-06-01

## Context

`cancel` is terminal: once a task is cancelled, the projection absorbs later
worker events. That is correct for a lead/PM decision, but too strong for a
worker intent. During dogfood, a worker was able to cancel a task after failing
to perform the requested edit. In a real development workflow, a worker can
recommend stopping work, but the lead should approve the cancellation and own
the reason.

## Decision

Keep the `cancel` command name, but make its effect source-sensitive:

- `lead` cancels emit `task.cancelled` and make the task terminal.
- `worker` cancels emit `cancellation.requested` and leave the task open.

The request event is durable audit evidence. A lead can inspect it and submit a
separate `cancel` command if the cancellation is approved.

## Consequences

Workers can no longer unilaterally terminate development tasks. Existing lead
CLI cancellation keeps working. Workflows may gate on `cancellation.requested`
if they want an explicit review stage later, but the builtin `general` workflow
continues to require a normal transition request for completion.

## Implementation Notes

- Add `cancellation.requested` to the task event type.
- Update the reducer so `cancel` from worker records the request event, while
  `cancel` from lead records `task.cancelled`.
- Projection folding treats `cancellation.requested` as audit-only.
- Tests should cover both worker request and lead approval semantics.

## Open Questions

- Should a future workflow expose a dedicated cancellation-review stage rather
  than leaving requests as audit-only events?
