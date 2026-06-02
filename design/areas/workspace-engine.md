# Workspace Engine Design

`wakespace` is the coordination layer over `agent-loop`. Its job is to
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

### Continuously steerable (task-level, bounded lag, no preemption)

The client can steer the system at any time, but steering is at the **task** level
— never by editing a running task's content. A task is a stable unit of work (a
fixed setpoint); a worker runs its current task to completion or the task is
cancelled. New input is **not** injected into a running worker — that would mutate
the task's scope mid-flight. Instead the client (or, later, the PM) either:

- **enqueues a new task** — it runs at the next tick, after or alongside current
  work (`createTask`/`intake` + the pending queue); or
- **interrupts** — cancels (or supersedes) the current task, then starts a new one
  (a lead `cancel`).

External input (`submitCommand`, `intake`, `nudge`) is accepted whenever and lands
in the event timeline. Because each task is a single-writer with a coalescing
mailbox and every wake re-projects from the live log — re-loading the live task
before applying worker commands — a `cancel` that races an in-flight wake is
respected at the next tick (the wake's discarded work is simply not committed).

The wake is the control tick, so the settling lag is at most one wake. We do
**not** preempt an in-flight wake; bounded lag is the deliberate, simpler choice.
(Hard-aborting the in-flight run on a lead `cancel` — to save the discarded wake's
tokens — is an optional later optimization, not needed for correctness.)

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
  Interface.** Wakespace coordinates a worker as a black box; it never teaches a
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
