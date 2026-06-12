# 0034 - Operator messages require lead review before task topology changes

Status: Accepted
Date: 2026-06-12
Relates: 0004, 0032, 0033

## Context

Crabbro dogfood exposed a bad control boundary: an external operator correction
arrived after the lead had already drifted into broad subtasks. Directly
cancelling child tasks from outside the lead would stop the immediate drift, but
it would also make the external controller the scheduler. Sikong's intended
shape is different: the lead owns task topology.

## Decision

External CLI control writes operator messages for the lead. It does not directly
create, cancel, block, or reorder tasks.

`submit <task> steer|cancel|block|concern|scope-limit|stop ...` writes a durable
lead-message mailbox entry without taking the main workspace write lock. A
running wake may receive the message as live steer, and `stop_requested` may stop
the current wake to save tokens, but the task state is not terminally changed.

The next lead wake receives pending operator messages in its prompt. Before
creating subtasks while messages are pending, the lead must call
`ack_lead_messages` with the message ids, a decision, and a response. The engine
rejects `create_subtask` commands that race ahead while messages remain
unacknowledged.

Lead- or engine-sourced internal commands may still preempt a wake as described
by ADR 0032. The difference is source of authority: external operator intent is
input to the lead; lead decisions mutate task topology.

## Consequences

- Operator correction is available even while a long-running `run` is active.
- External stop requests can halt token spend without cancelling the task.
- Task topology remains a lead responsibility.
- Broad delegation drift becomes reviewable and structurally gated instead of
  relying on prose instructions alone.
