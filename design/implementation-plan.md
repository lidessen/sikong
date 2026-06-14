# Implementation Plan

## Purpose

This document records the current implementation sequence for the Sikong
rewrite. It is intentionally a phase plan, not a workflow DSL. Each phase should
land a stable final-design module before the next phase integrates it.

The plan must preserve these fixed boundaries:

- Go daemon is a generic process supervisor, not an agent orchestrator.
- TypeScript owns task coordination and preset assembly.
- Worker is the only executable agent unit.
- Planner, executor, and verifier files are preset wrappers over worker runs,
  not code-level agent roles or kinds.
- Durable task state changes go through command handlers and terminal tools.
- Process stdout/stderr/exit/timeout are process facts, not task results.

## Current Baseline

Implemented:

- file-backed data dir, workspace registry, and workspace preferences;
- task events, reducer, file-backed event/projection stores, and per-task locks;
- task protocol command handlers for plan, worker terminal result, review, and
  final lead closure;
- external-agent CLI adapter over command handlers;
- Bun generic process runner;
- worker-run core over injected `agent-loop.runTask`;
- planner, executor, and verifier preset wrappers;
- pure orchestration tick that maps projection state to the next preset action
  or lead wait point;
- Go generic process runner/supervisor types and implementation with success,
  failure, timeout, cancellation, and parallel-run tests;
- daemon local process API and TypeScript process client over generic process
  specs/results;
- orchestration action executor that consumes pure `OrchestrationAction` values
  and calls existing loop, worker-task, and command-handler primitives;
- daemon-backed orchestration subprocess runner and process-spec/client helpers;
- compact task inspect view for next action and lead wait state.

Not implemented yet:

- named tool/preset registries for production runtime-module assembly;
- parallel stage worker policy.

## Phase 1: Go Generic Process Supervisor

Implement the final Go daemon process primitive.

Status: implemented in `internal/daemon`.

Deliverables:

- `internal/daemon` types for generic `ProcessRunSpec` and `ProcessRunResult`;
- a process runner that supports `command`, `args`, `cwd`, `env`, `stdin`,
  timeout, cancellation, stdout/stderr capture, exit code, and duration;
- concurrent process execution with resource-based limits;
- tests for success, non-zero exit, timeout, cancellation, and parallel runs.

Constraints:

- no planner/executor/verifier/lead concepts in Go;
- no role/kind fields in process specs;
- labels, if present, are debug metadata only and must not drive branching;
- Go does not append task events.

## Phase 2: Daemon Local API And TS Process Client

Expose the generic supervisor and let TypeScript request process runs.

Status: implemented in `internal/daemon` and
`packages/workspace/src/process/client.ts`.

Deliverables:

- a small local daemon API for process start, get/wait, cancel, and health;
- a TypeScript client that sends generic process specs and receives generic
  process results;
- tests using a mock or in-process daemon transport.

Constraints:

- the API schema is process-only;
- TypeScript interprets process facts; daemon does not interpret task state;
- failed process results do not automatically become failed task results.

## Phase 3: Orchestration Action Executor

Connect the pure orchestration tick to runtime execution.

Status: implemented in `packages/workspace/src/orchestration`.
The action executor exists, and daemon-backed subprocess execution is exposed
through `src/orchestration/runner.ts` plus generic `ProcessRunSpec` helpers.
Runtime/tool functions are assembled inside the subprocess by an explicit
runtime module instead of being serialized through JSON.
The runner request uses a data-only serializable action shape. Executable
fields such as tools, skills, MCP servers, hooks, loop factories, and `runTask`
enter through the runtime module or a future named registry.

Deliverables:

- an action executor that consumes `OrchestrationAction`; _(implemented)_
- planning action starts a loop-backed planning preset run whose durable state
  changes only through protocol tools; _(implemented)_
- stage action starts a worker task run through `runWorkerTask`; _(implemented)_
- stage review start action calls the review command handler; _(implemented)_
- verification actions start loop-backed verification preset runs whose durable
  state changes only through protocol tools; _(implemented)_
- `await_plan_decision` and `await_final_decision` return wait states and do not
  auto-accept anything. _(implemented)_
- daemon-backed child process entrypoints for these actions. _(implemented)_

Constraints:

- executor consumes preset output; it does not define agent roles;
- preset wrappers assemble prompt/tools/skills/context only;
- durable state writes still go through command handlers or terminal tools;
- lead decision points must remain explicit;
- live tool functions must enter through a runtime module or future named
  registry, not through serialized action JSON.

## Phase 4: Compact Inspect View

Make the current state easy for external agents and users to understand.

Status: implemented in command handlers and CLI as `inspect compact`.
The next-action summary is owned by the orchestration layer and reused by the
command-layer compact view.

Deliverables:

- a compact task view that reports task status, current stage, plan status,
  next orchestration action, whether it is waiting for lead, latest worker
  result, latest review feedback, and final recommendation; _(implemented)_
- CLI and command-handler access to the compact view. _(implemented)_

Constraints:

- do not expose code-level roles or agent kinds;
- the view is derived from events/projection and orchestration planning;
- it must not mutate task state.

## Phase 5: Parallel Stage Workers

Add controlled parallelism after the serial orchestration path is stable.

Deliverables:

- an explicit per-stage worker concurrency policy;
- orchestration support for starting multiple execution worker runs when policy
  allows;
- stage verification over accumulated terminal worker results;
- concurrency tests proving event logs and projections remain stable.

Constraints:

- per-task event locking remains the write-safety boundary;
- Go daemon concurrency remains process/resource based;
- stage workers do not transition stages themselves.

## Verification For Each Phase

Run at minimum:

```text
bun run check
```

Add focused tests in the module touched by the phase. Also run a static search
before handoff:

```text
rg -n "AgentKind|PlannerAdapter|ReviewerAdapter|WorkerAdapter|role\\s*:|kind\\s*:" packages/workspace/src cmd internal design
```

Expected matches are only explanatory documentation or non-agent UI/work-log
fields. There should be no code-level agent role or kind driving behavior.
