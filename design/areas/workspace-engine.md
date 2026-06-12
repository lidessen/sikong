# Workspace Engine Design

`sikong` is the coordination layer over `agent-loop`. Its job is to
turn work into deterministic workflow state changes while still letting agents
perform the flexible parts of a stage.

The current implementation is an M0/M1 kernel: workflow data model, reducer,
guard evaluator, JSONL-backed stores, project-scoped task state, and a minimal
wake engine. It is not yet the full durable multi-agent workspace.

## Core Model

### Workflow Definition

A `WorkflowDef` is serializable data:

- typed fields;
- ordered stages;
- declarative entry guards;
- stage guidance;
- optional skill/tool names for later resolution.

Editing a workflow creates a new version. A running task is pinned to the
workflow version it was created with.

### Task Timeline

A `Task` is a projection over an append-only event timeline. The timeline is
the source of truth; projections exist for fast reads and can be rebuilt.

Important event types:

- `task.created`
- `field.set`
- `transition.requested`
- `stage.entered`
- `note.appended`
- `subtask.created`
- `task.blocked`
- `task.unblocked`
- `cancellation.requested`
- `task.cancelled`

### Commands

Agents and leads propose state changes as commands:

- `set_field`
- `request_transition`
- `append_note`
- `create_subtask`
- `block`
- `unblock`
- `cancel`

Commands are not events. The reducer validates commands against the current
task and workflow, then emits events. Illegal commands are rejected or skipped
by the wake engine with an `onReject` hook.

Worker `cancel` commands request cancellation; they do not make the task
terminal. Lead `cancel` commands approve cancellation and emit the terminal
`task.cancelled` event.

### Guards

Guards are deterministic predicates over projected fields, current-stage event
types, and child statuses. They are data, not code, so agent-authored workflows
can be validated before registration.

Stage advancement is guard-driven. A task does not complete because an agent
claims completion; it completes by entering a terminal `done` stage admitted by
the workflow.

## Wake Engine

A wake is one bounded agent-loop run for the current task stage.

The wake cycle:

```text
load pinned task
  -> pre-advance if guards already allow it
  -> run one AgentLoop with current projection and command tools
  -> drain commands
  -> reduce commands into events
  -> post-advance by guards
  -> self-schedule if a new non-terminal stage needs work
```

The engine uses a per-task single-writer, coalescing mailbox. At most one wake
runs for a task at a time. Signals that arrive during a wake collapse into the
next wake.

This is an in-process guarantee. Durable production use still needs storage
level compare-and-set or expected-sequence semantics.

Wake diagnostics are observability facts, not progress judgments. The engine may
record elapsed time, tool calls, state command counts, text previews, errors, and
timeout components so a lead can inspect what happened. It must not use those
signals to classify whether a worker is making meaningful progress, doing good
work, over-exploring, or failing the task. Those judgments belong to a lead or
another reviewer agent reading the worker's work log, task fields, submitted
evidence, and chronicle context.

### Continuously steerable (lead-mediated, bounded lag)

The client can steer the system at any time, but task arrangement remains a lead
decision. External operators do not directly create, cancel, block, delete, or
reorder tasks. They submit durable operator messages (`steer`, `concern`,
`scope_limit`, `stop_requested`) for the lead to review.

These messages use a short-lock mailbox, separate from the main workspace write
lock, so an operator can correct a running `sikong run` without corrupting the
event log. A running wake may receive the message as live steer. A
`stop_requested` message may stop the current wake to save tokens, but it does
not make the task terminal or blocked.

When the lead wakes next, pending operator messages appear in the prompt. Before
changing task topology, especially by creating subtasks, the lead must acknowledge
the messages with `ack_lead_messages` and record whether the requested adjustment
is accepted, rejected, or deferred. The engine rejects `create_subtask` commands
while operator messages remain unacknowledged.

**Wake preemption.** When a lead or engine-sourced `cancel` (or `block`) is
submitted for a task that has an in-flight wake, the engine aborts the running
agent run instead of letting it finish (ADR 0032). Same-process submissions call
the per-task `stopWake` callback after the terminal/blocking event is appended.
Separate CLI processes are handled by the wake's control pump: it polls the event
log, notices lead/engine `task.cancelled` or `task.blocked`, then calls
`controller.abort()` and `run.cancel()` on the current phase's handle. The wake
post-phase loads the live task (now terminal/blocked) and drops all unprocessed
worker commands. Any partial file writes from the aborted run are orphaned —
acceptable for a cancelled task.

Preemption is limited to lead- and engine-sourced commands. External operator
`cancel`/`block` CLI inputs are not lead commands; they are mailbox messages for
lead review (ADR 0034). A worker-emitted
`cancel` is only a `cancellation.requested` event (ADR 0004): it may close the
current worker pass like other stage-closing command tools, but it does not
terminally cancel the task and does not use the external `submitCommand`
preemption path. The existing `boundedRun` wall-clock timeout remains the safety
net if the SDK ignores cancellation. On timeout, the engine calls
`run.cleanup({ hardKill: false })`, waits only for the configured grace window,
and records the resulting `wake.cleanup` fact as settled, cancelled-settled, or
unsettled.

The wake is the control tick. Before ADR 0032, the settling lag was at most one
wake (bounded lag, the original simple choice). With preemption, the settling
lag between a lead `cancel`/`block` and the task entering its new state is
reduced to the SDK cancellation latency (typically sub-second), saving token
waste on cancelled work.

## Stage-scoped Subtasks

Decision
[`0001-stage-scoped-subtasks-block-advancement`](../../docs/decisions/0001-stage-scoped-subtasks-block-advancement.md)
captures the current proposed direction:

- a task may create subtasks scoped to its current stage;
- a blocking current-stage child prevents parent stage advancement until the
  child is terminal;
- terminal child statuses are `done` and `cancelled`;
- blocked children are still open.

This rule belongs in the workflow engine, not in prompt text. The agent can
request a transition, but the engine must decide whether advancement is
admissible.

Implementation still needs to close the replay gap: parent stage advancement
must be based on durable evidence, not only an in-memory child projection.

## Store Boundaries

Current stores have in-memory and JSONL-backed implementations:

- `EventStore` assigns per-task `seq` and `ts`;
- `ProjectionStore` stores current task projections;
- `WorkflowRegistry` validates and stores workflow definitions.
- `JsonProjectStore` writes project definitions to
  `projects/<id>/project.yaml` and bounded project memory to
  `projects/<id>/memory.md`.
- workspace task stores route new task timelines and projections to
  `projects/<id>/state/`, while still reading legacy flat task state during
  dogfood migration.

Production stores should preserve these boundaries but add:

- append preconditions such as `expectedSeq`;
- atomic append plus projection update or recoverable projection rebuild;
- workflow-version retention;
- durable child-status evidence for parent advancement;
- indexed queries for project, workflow, parent, and status.

## Design Invariants

- A task is reduced only against the workflow id/version it was created with.
- Terminal statuses are absorbing: `done` and `cancelled` tasks reject further
  commands and ignore later mutation events during projection.
- Guards fail closed when comparisons are malformed.
- Current-stage event predicates only see events since the latest stage entry.
- Agents update durable state only through command tools and reducer validation.
- Stage advancement must remain deterministic under replay.

## Non-goals for the Current Kernel

- A public workflow authoring language beyond the `WorkflowDef` data model.
- Multi-process scheduling.
- External side-effect orchestration.
- Rich routing or model selection policy.
- Full subtask orchestration and parent/child settlement semantics.
- **Task-specific agent tooling / a coding (or any domain) Agent-Computer
  Interface.** Sikong coordinates a worker as a black box; it never teaches a
  worker *how* to do the work. File viewers, structured editors, host/test
  runners, edit policies, and "verify" semantics belong inside the agent
  (`agent-loop` tools, or a coding-agent runtime that carries its own interface),
  never in the engine, prompts, or workflow definitions. See decision
  [`0007-coding-belongs-to-the-agent`](../decisions/0007-coding-belongs-to-the-agent.md)
  (which supersedes the coding-ACI direction of `0006`). A worker's tools are
  supplied at the worker boundary; the engine merges them without knowing what
  they are.

Those can be added later, but they should compile into task events, commands,
guards, stores, wake scheduling, or projections rather than becoming a second
state system.
