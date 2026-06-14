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
- orchestration driver that repeats projection load, next-action planning, and
  action execution until lead wait, worker wait, terminal, blocked, or action
  budget;
- process-backed orchestration action executor that sends one action through a
  daemon-supervised runner process and parses the runner result;
- daemon process-control CLI for status, start, and stop;
- CLI `task drive` entrypoint over the orchestration driver and process-backed
  executor;
- daemon-backed orchestration subprocess runner and process-spec/client helpers;
- compact task inspect view for next action and lead wait state;
- named runtime assembly registry for backend and tool-profile injection;
- initial parallel stage worker policy through `PlanStageDef.workerCount`.
- production runtime defaults for task cwd, adapter permissions, and AI SDK
  local inspection/execution tool profiles.
- workspace-owned git worktree allocation for `task create --repo`.
- runtime process start/finish facts and process-level `task cancel`.
- thin client-agent tool adapter over command handlers.
- client-agent context packet/work-log/turn facade and the first React+Vite
  client UI slice.

Not implemented yet:

- runtime process steer command surface.

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
runtime module or the named runtime assembly registry instead of being
serialized through JSON.
The runner request uses a data-only serializable action shape. Executable
fields such as tools, skills, MCP servers, hooks, loop factories, and `runTask`
enter through the runtime module or the named runtime assembly registry.

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
- live tool functions must enter through a runtime module or the named runtime
  assembly registry, not through serialized action JSON.

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

## Phase 5: Runtime Assembly Registry

Connect subprocess execution to named runtime/tool assembly without adding
agent role semantics.

Status: initial registry implemented in `packages/workspace/src/runtime`.

Deliverables:

- a named backend registry that creates an `agent-loop` instance for a runner
  request; _(implemented)_
- a named tool-profile registry that injects live tools into planning,
  execution, stage verification, and final verification actions inside the
  child process; _(implemented)_
- default backend registrations for `mock`, `ai-sdk`, `claude-code`, `codex`,
  and `cursor`; _(implemented)_
- default Sikong protocol profiles for plan submission, stage review, and final
  review tools; _(implemented)_
- default AI SDK local inspection/execution tool profiles, resolved from the
  task runtime cwd; _(implemented)_
- backend cwd and permission defaults for `claude-code`, `codex`, and `cursor`;
  _(implemented)_
- a runtime-module factory usable by `src/orchestration/runner.ts`;
  _(implemented)_
- a data-only `runtimeAssembly` runner request field that lets the subprocess
  use the default registry without a separate runtime module file;
  _(implemented)_
- tests proving hydrated actions carry live tools while runner request JSON
  stays free of role/kind fields. _(implemented)_

Constraints:

- registry keys are runtime assembly names, not planner/executor/verifier
  agent kinds;
- JSON requests remain data-only and never carry functions;
- production backends should use adapter-native sandbox and permission
  mechanisms rather than a unified Sikong tool surface.
- AI SDK local tools are explicit tool profiles because AI SDK needs a tool
  bundle; Claude Code, Codex, and Cursor use adapter-native cwd, sandbox, and
  permission options.

## Phase 6: Parallel Stage Workers

Add controlled parallelism after the serial orchestration path is stable.

Status: initial policy implemented in `packages/workspace/src/orchestration`.

Deliverables:

- an explicit per-stage worker concurrency policy;
  _(implemented as optional `PlanStageDef.workerCount`, default `1`)_
- orchestration support for starting multiple execution worker runs when policy
  allows; _(implemented)_
- stage verification over accumulated terminal worker results;
  _(implemented through existing stage verification prompt over worker runs)_
- concurrency tests proving event logs and projections remain stable.
  _(implemented at store level, plus orchestration tests for multi-worker
  stage scheduling)_

Constraints:

- per-task event locking remains the write-safety boundary;
- Go daemon concurrency remains process/resource based;
- stage workers do not transition stages themselves.

## Phase 7: Orchestration Driver

Add the small TypeScript loop that keeps a task moving across non-lead actions.

Status: implemented in `packages/workspace/src/orchestration/drive.ts`.

Deliverables:

- load the durable task projection before each action; _(implemented)_
- call `planNextOrchestrationAction` and execute the returned action through an
  injected executor or the default `executeOrchestrationAction`; _(implemented)_
- reload durable projection after each action instead of keeping in-memory task
  state; _(implemented)_
- stop at lead wait, worker-results wait, terminal, blocked, or `maxActions`;
  _(implemented)_
- tests covering planning-to-lead-wait and stage-to-final-lead-wait.
  _(implemented)_

Constraints:

- the driver is TypeScript orchestration, not Go daemon policy;
- it does not own durable state beyond command-handler writes performed by
  actions;
- it must not interpret process stdout/stderr as task results.

## Phase 8: Process-Backed Action Execution

Connect one orchestration action to daemon-managed runner execution.

Status: implemented in `packages/workspace/src/orchestration/process.ts`.

Deliverables:

- write a data-only `OrchestrationRunnerRequest` for one action; _(implemented)_
- create a generic `ProcessRunSpec` for `src/orchestration/runner.ts`;
  _(implemented)_
- start and wait for the process through a daemon process client;
  _(implemented)_
- parse `OrchestrationRunnerOutput` from stdout into
  `OrchestrationExecutionResult`; _(implemented)_
- fail when the process fails, times out, or returns invalid JSON.
  _(implemented)_

Constraints:

- process stdout is only the runner transport envelope, not a worker task
  result convention;
- process specs remain free of agent role/kind fields;
- the daemon still supervises generic processes only.

## Phase 9: CLI Drive Entry Point

Expose the projection-driven orchestration loop to external agents.

Status: implemented in `packages/workspace/src/cli`.

Deliverables:

- `sikong task drive <taskId>` command; _(implemented)_
- default daemon client using `SIKONG_DAEMON_ADDR` or `127.0.0.1:8765`;
  _(implemented)_
- default runtime assembly profile names for protocol tools, plus AI SDK local
  tool profiles when `--backend ai-sdk` is selected; _(implemented)_
- process-backed execution only for runtime-backed actions, with local handling
  of wait/terminal/review-start actions; _(implemented)_
- CLI tests using a fake daemon process client. _(implemented)_

Constraints:

- CLI remains an adapter over orchestration APIs; it does not own scheduling
  semantics;
- no long-lived Bun singleton is introduced;
- daemon process specs remain generic.

## Phase 10: Read-Only Task Wait

Expose a small polling command for external agents that need to wait until a
durable task reaches the next observable boundary.

Status: implemented in `packages/workspace/src/commands` and
`packages/workspace/src/cli`.

Deliverables:

- `waitTask({ taskId, workspaceId?, timeoutMs?, intervalMs? })` command handler;
  _(implemented)_
- `sikong task wait <taskId> --workspace <workspaceId> [--timeout-ms <n>]`;
  _(implemented)_
- wait boundaries reuse compact task semantics: lead wait, worker-results wait,
  terminal, or blocked; _(implemented)_
- command/CLI tests proving an already submitted plan returns immediately.
  _(implemented)_

Constraints:

- `task wait` is read-only polling and must not start workers, trigger reviews,
  or mutate task projection;
- it is not a scheduler and does not introduce long-lived process-local state.

## Phase 11: Daemon Process-Control Adapter

Expose daemon health/start/stop controls to external agents without adding
coordination semantics to the Go layer or CLI adapter.

Status: implemented in `internal/daemon`, `packages/workspace/src/process`,
and `packages/workspace/src/cli`.

Deliverables:

- `sikong daemon status [--daemon <url>]`; _(implemented)_
- structured success result with daemon base URL and health payload;
  _(implemented)_
- `POST /shutdown` on the daemon local API; _(implemented)_
- `sikong daemon start [--daemon <url>]`, which starts `sikongd` in the
  background when health is not already available and waits for health;
  _(implemented)_
- `sikong daemon stop [--daemon <url>]`, which requests graceful shutdown
  through the daemon API; _(implemented)_
- structured `daemon_error` for daemon client failures. _(implemented)_

Constraints:

- daemon commands are process-control only;
- they must not read task projections, start workers, or interpret orchestration
  state;
- shutdown stops the daemon process; task terminal decisions still belong to
  task command handlers and protocol tools.

## Phase 12: Task-Level Git Worktree Allocation

Materialize git runtime context into a workspace-owned agent cwd without making
`WorkspaceDef` own repo paths.

Status: implemented in `packages/workspace/src/workspace` and
`packages/workspace/src/commands`.

Deliverables:

- resolve `task create --repo <path>` to a git repository root; _(implemented)_
- create a detached worktree at
  `workspaces/<workspaceId>/worktrees/<taskId>/`; _(implemented)_
- store the worktree path as `runtime.cwd` and the resolved repository root as
  `runtime.repoPath`; _(implemented)_
- keep `--cwd` as the non-git direct cwd path; _(implemented)_
- focused command test using a real temporary git repository. _(implemented)_

Constraints:

- do not add repo paths or allowed paths to `WorkspaceDef`;
- do not use the source repository itself as agent cwd for git work;
- do not solve branch naming, cleanup, or run-scoped worktrees in this slice.

## Phase 13: Runtime Process Facts And Cancel

Persist the minimal process-run facts needed for process-level cancellation.

Status: implemented in `packages/workspace/src/coordination`,
`packages/workspace/src/orchestration`, and `packages/workspace/src/cli`.

Deliverables:

- `runtime_process.started` and `runtime_process.finished` task events;
  _(implemented)_
- projection of runtime process runs by daemon process id; _(implemented)_
- process-backed orchestration executor records process start/finish facts;
  _(implemented)_
- summary, compact, and trace inspect views expose runtime process facts;
  _(implemented)_
- `sikong task cancel <taskId> [--daemon <url>]` cancels recorded running
  daemon process runs; _(implemented)_
- CLI test proving cancellation calls daemon cancel and records
  `processStatus: "cancelled"`. _(implemented)_

Constraints:

- process facts do not become worker terminal results;
- cancelling runtime processes does not automatically reject or complete the
  durable task;
- no long-lived Bun scheduler is introduced.

## Phase 14: Client Agent Tool Adapter

Expose the command surface to a UI/client-agent without shelling out to the CLI.

Status: implemented in `packages/workspace/src/tools`.

Deliverables:

- `createClientAgentTools({ ctx })` returns typed `agent-loop` tools for
  workspace, preference, task creation, and task inspect commands;
  _(implemented)_
- tool implementations call existing command handlers and return their
  structured `CommandResult` values; _(implemented)_
- task inspect tools include summary, compact, trace, events, and projection
  views; _(implemented)_
- tests prove the tool adapter can create/read workspaces, maintain
  preferences, create tasks, inspect task state, and return structured input
  errors. _(implemented)_

Constraints:

- this adapter is for the UI/client-agent surface, not planner, worker, or
  reviewer protocol tools;
- it must not expose low-level event append or stage mutation shortcuts;
- it does not introduce client-agent runtime, monitor, or steer behavior.

## Phase 15: Client Agent Context And UI

Expose the first UI-owned caller surface without introducing a chat-session
memory model.

Status: initial slice implemented in `packages/workspace/src/client-agent` and
`packages/client`.

Deliverables:

- file-backed client work log outside `WorkspaceDef`; _(implemented)_
- explicit `ClientAgentContextPacket` built from client work log plus focused
  workspace/task summaries; _(implemented)_
- per-turn `runClientAgentTurn` facade over `agent-loop.run` and
  `createClientAgentTools`; _(implemented)_
- local Bun client API adapter for browser JSON calls; _(implemented)_
- React+Vite client with one continuous activity stream, task cards, workspace
  switching, and secondary work-log/task detail views. _(implemented)_
- typed client message parts and a restricted dynamic UI part based on a small
  Sikong catalog; _(designed, not implemented)_
- a client-side renderer that maps the restricted catalog to native UI
  components and owns responsive/mobile layout decisions. _(designed, not
  implemented)_

Constraints:

- the UI transcript is presentation state only;
- `runClientAgentTurn` does not accept transcript history;
- raw task events stay in inspect/detail flows and are not injected into the
  main client-agent context packet;
- the local client API is an adapter over command handlers and client-agent
  facade, not a new coordination layer;
- dynamic UI specs must not expose arbitrary CSS, generated JSX/HTML, or direct
  command actions such as workspace/task creation;
- the current client API uses `mockLoop` as the dev default until a real
  client-agent runtime selection is wired.

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
