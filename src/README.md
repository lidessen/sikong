# Siko Rust Mainline Structure

This directory is the active Rust implementation. The older Go/Bun workspace
track is reference-only unless a task explicitly targets it.

## Top-Level Modules

- `engine.rs` is the recursive engine state machine. Keep the core node
  lifecycle here: specify, acquire, plan, execute, combine, verify, commit,
  retry, memoization, and cleanup orchestration.
- `engine_resources.rs` tracks workspace resource references and release state
  for the engine without mixing that bookkeeping into the state transitions.
- `node.rs` defines the problem tree, node templates, node plans, and artifacts.
- `types.rs` contains shared identifiers, statuses, verdicts, errors, events,
  and report types.
- `assistant/` contains assistant context/session/ACP behavior plus
  assistant-specific harness and tool definitions.
- `task_board/` contains the assistant-facing task board: task records, stores,
  statuses, events, persistence, queueing, cancellation, and task-level dispatch
  into the recursive engine.
- `task_run/` contains the single-task recursive run boundary: node-operation
  prompts, context packets, tool lists, terminal tool sets, and terminal result
  decoding. Engine operation prompt/tool differences live together here so the
  operation matrix is reviewable in one place.
- `workspace/` defines the workspace abstraction and concrete providers.
  Provider-specific filesystem or git facts should be captured here, not by
  agent terminal payloads.
- `agent_run/` contains the single agent run protocol and the agent run
  scheduling system.
- `config.rs`, `cli.rs`, and `main.rs` are application shell plumbing.

## Workspace Provider Layout

- `workspace/mod.rs` owns common provider traits and shared data structures.
- `workspace/workspaces.rs` is the provider dispatcher.
- `workspace/memory.rs` is an in-memory provider useful for pure reasoning and
  deterministic tests.
- `workspace/file_system.rs` represents file-scoped work without git-backed
  isolation.
- `workspace/git_file_system.rs` owns git workspace semantics: snapshots,
  worktrees, branch/commit resources, merges, conflicts, and cleanup.
- `workspace/git_cli.rs` is the narrow git CLI adapter. Keep raw git command
  construction and parsing there.

## Agent Run Layout

- `agent_run/run.rs` defines a single agent run: request, response, prompt
  sections, tool specs, terminal calls, and the request builder used by typed
  assistant or execution contexts.
- `agent_run/run_scheduler.rs` defines how agent runs are scheduled and
  executed. The current implementation is `ProcessAgentRunScheduler`, which
  launches an external process and speaks the run protocol over a Unix socket.

## Runtime Domain Layout

- `agent_run` is the single-run contract and run scheduling boundary. It should
  not grow assistant, task, execution, or workspace policy.
- `assistant` is the user-facing coordinator. It can inspect and manage tasks,
  but should not implement task queueing or node execution semantics.
- `task_board` is task management, persistence, and task-level queueing. It may
  dispatch a task to a `TaskEngineRunner`, but should not implement engine node
  operation semantics.
- `task_run` is single-task recursive execution through engine node operations.
  It owns the operation harness/tool matrix.
- `workspace` is the resource and filesystem/git boundary. It captures concrete
  changed paths and conflicts instead of trusting agent-reported paths.

## File Organization Rules

- Keep state transitions readable in `engine.rs`; split support mechanisms only
  when they can be tested or reviewed independently.
- Keep provider facts inside provider implementations. Do not add agent-reported
  filesystem facts to terminal tool payloads.
- Keep operation-specific task-run harness behavior under `task_run` rather
  than centralizing prompt strings in one generic registry.
- Prefer support modules only when they form a real review boundary. Avoid
  one-file directories and tiny files that only name a single type.
