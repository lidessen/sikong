# Agent Loop Design

This directory is the design entrypoint for the project. It records the core
mechanisms, ownership boundaries, and durable design rules that should guide
code changes.

Read this file before changing behavior. Then read the relevant area document:

| Area | Scope |
| --- | --- |
| [areas/runtime-loop.md](areas/runtime-loop.md) | `agent-loop`: runtime/provider boundary, adapter contract, run handle, hooks, capabilities, task supervisor |
| [areas/workspace-engine.md](areas/workspace-engine.md) | `sikong`: workflow definitions, task timelines, reducer/guard model, wake engine, subtask direction |

Design decisions live in [`./decisions`](./decisions). Write a
decision record before changing durable shape: module boundaries, state model,
event or command schemas, persistence semantics, scheduling mechanics, runtime
contracts, or user-visible workflow behavior.

## System Shape

The project has two layers:

1. `agent-loop` is the execution library. It normalizes multiple agent
   runtimes behind one streaming `AgentLoop` interface. Runtime engines and
   model providers are orthogonal: the runtime owns how a loop executes, while
   the provider owns credentials, endpoint facts, and runtime-specific launch
   configuration.
2. `sikong` is the coordination layer. It models work as workflow
   instances backed by append-only task timelines. Agents do not mutate task
   state directly; they emit commands through tools, and a deterministic
   reducer plus guard evaluator decides which events are recorded and whether a
   stage may advance.

The intended core is small:

```text
Runtime request -> AgentLoop -> BackendAdapter -> LoopEvent stream -> RunResult

WorkflowDef -> Task timeline -> Wake -> Commands -> Events -> Projection
                                      \-> Guard-driven stage advancement
```

Everything else should compile back into one of those mechanisms. If a proposed
feature cannot say which runtime request it shapes, which event it records,
which command it validates, which guard it affects, or which projection it
rebuilds, keep it out of the core until the mechanism is clear.

## Current Implementation Status

`agent-loop` is the mature layer. It has:

- a public `AgentLoop` interface;
- lazy-loaded backend adapters;
- capability-gated features;
- replayable `RunHandle` views;
- provider injection as data rather than parent-process environment mutation;
- an outer `runTask` supervisor for multi-round handoff over tools-capable
  loops.

`sikong` is an early coordination kernel. It has:

- serializable workflow definitions;
- event-sourced task timelines;
- deterministic command reduction;
- declarative guard evaluation;
- in-memory event/projection/registry stores;
- a minimal wake engine with single-writer, coalescing mailbox semantics.

It is not yet a production durable workspace. Persistence, multi-process write
coordination, child-status replay, subtask lifecycle closure, and management
surfaces are still open design/implementation work.

## Core Invariants

- Runtime adapters receive all per-run facts through `ResolvedRequest`.
  Constructors take construction options; no adapter should need mutable setter
  methods for a single run.
- Capability declarations must be honest. If a runtime cannot actually support
  tools, MCP, hooks, steering, usage, interrupt, or session resume, callers must
  see that before they rely on it.
- Provider credentials are data. Factories may resolve or inject credentials,
  but adapters must not mutate the parent process environment.
- `RunHandle` consumption is replayable. `textStream`, event iteration, `text`,
  `usage`, and `result` are independent views over the same run.
- Workflow tasks are pinned to one workflow version for their full lifetime.
- The task event timeline is the source of truth. Projections are rebuildable.
- Agents propose commands. Reducers and guards decide state.
- Stage advancement must be deterministic and replayable from durable evidence.

## Design Change Rule

Small implementation changes can land with focused tests. Durable shape changes
need a decision record first. Use the existing format in
[`./decisions/0000-template.md`](./decisions/0000-template.md).

A decision record is required for:

- changing public API contracts;
- changing `LoopEvent`, `RunInput`, `RunResult`, `Command`, `TaskEvent`, or
  workflow schema semantics;
- adding persistence or concurrency guarantees;
- changing task/stage/subtask lifecycle rules;
- adding a new runtime, provider family, workflow engine, or scheduler;
- changing how agents are allowed to affect durable state.

Accepted decisions should be reflected back into this design directory once
they become the active architecture.
