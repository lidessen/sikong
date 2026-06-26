# Sikong Source Code Analysis Report

**Generated**: Analysis of `src/` excluding `src/task_run/engine.rs` and `src/cli.rs`
**Analysis date**: Executed by recursive engine node 2

---

## 1. Structure and Module Organization

### 1.1 Top-Level Layout

The Rust crate is organized into seven top-level modules, re-exported through `src/lib.rs`:

| Module         | Responsibility                                                | File Count              |
| -------------- | ------------------------------------------------------------- | ----------------------- |
| `agent_run`    | Agent run request/response types + external process scheduler | 3                       |
| `assistant`    | Assistant session, context, ACP server, tools, prompt packs   | 6                       |
| `config`       | Config loading (YAML + env), provider/backend resolution      | 1                       |
| `metrics`      | Counter/timing/cost collection with JSON snapshots            | 1                       |
| `task_board`   | Task queue, engine dispatch, task stores, event tracking      | 3                       |
| `task_run`     | Recursive engine, node operations, harness, types             | 6 (excluding engine.rs) |
| `workspace`    | Memory, filesystem, git-filesystem workspace providers        | 5                       |
| `main` + `lib` | Entry point and module wiring                                 | 2                       |

### ✅ Strength: Clean Module Boundaries

The module boundaries respect the documented AGENTS.md architecture. Each module owns a clear slice:

- `task_run` owns the recursive execution tree (plan → execute → combine → verify → commit)
- `task_board` owns the assistant-facing task queue and dispatch
- `assistant` owns the user-facing session and ACP protocol
- `workspace` owns resource lifecycle across three provider types

Cross-module dependencies flow in one direction: `task_board` imports from `task_run` for types; `assistant` imports from `task_board` and `workspace`. No circular imports exist.

### ⚠️ Observation: Re-export Surface in `lib.rs`

`lib.rs` re-exports 60+ public items across all major modules. This is a useful public API surface but makes it harder to see which types are truly public vs. internal. Several types (`AgentRunRecord`, `AttemptRecord`, `OperationEvent`) are serialization/event types that may not need to be top-level.

### ✅ Strength: Module `mod.rs` Pattern

Each module directory uses `mod.rs` for re-exports, keeping the module boundary clean. Internal sub-modules use `pub(crate)` visibility consistently.

---

## 2. Error Handling Patterns

### 2.1 Error Type Design

The codebase uses three distinct error patterns:

**a) `thiserror`-derived enums** (best practice):

- `ProcessAgentRunSchedulerError` — 16 variants with `#[error("...")]` and `#[source]` annotations
- `WorkspaceError` — 3 variants with contextual fields (`operation`, `cwd`, `path`)
- `EngineError` — 6 variants
- `AgentRunDecodeError` — simple wrapper

**b) Gateway type aliases**:

- `WorkspaceResult<T>` = `Result<T, WorkspaceError>` — clean pattern

**c) Ad-hoc String errors**:

- `AssistantTurnError { message: String }` — used across the assistant session layer
- `SessionReply { text: String, task_id: Option<TaskId> }` — dual-use as success/error
- Several functions return plain `String` errors through `Result<(), String>`

### ✅ Strength: Contextual Error Fields

`WorkspaceError::GitCommand` and `WorkspaceError::Io` carry `operation`, `cwd`/`path`, and `message` fields. This provides excellent debugging context without stack traces.

### ⚠️ Weakness: String-Only Errors in Assistant Layer

The `AssistantLoop::run_turn` trait returns `Result<AssistantTurn, AssistantTurnError>` where the error is just a `String`. This loses structured information about which part of the protocol failed. The `decode_assistant_turn` function maps multiple failure modes into a flat string, making it harder to distinguish "missing terminal tool" from "invalid arguments" from "wrong tool name" in the session layer.

### ⚠️ Weakness: Mixed Error/Success in SessionReply

`SessionReply` is used for both successful responses (with `task_id`) and error conditions (with error text). The caller must inspect the text to distinguish "task not found" from a valid reply. This is an implicit error channel.

### ✅ Strength: `EngineError::From<WorkspaceError>`

The `From<WorkspaceError>` implementation for `EngineError` follows the Rust convention for automatic error conversion, keeping the engine layer clean.

---

## 3. Type Design and API Surface

### 3.1 Type Hierarchy

The type system reflects a well-thought-out domain model:

**Node Operations**: `NodeOperation` enum (Specify, Plan, Execute, Combine, Verify, Commit) — governs which tools and governance rules apply.

**Governance Gates**: `GovernanceGate` enum with 8 gates, each with `id()` and `description()` methods. Operations declare which gates are active via `active_hard_gates()`.

**Work Sizing**: `WorkSize` enum (Tiny, Small, Medium, Large, XLarge) with `Default = Small`.

**Verification**: `VerificationVerdict` enum (Accept, Reject, Uncertain) with typed `FailureClass` for rejections.

### ✅ Strength: Discriminated Unions Over Booleans

- `NodePlan` is an enum (`Execute | NeedsPlanning | Group(PlanGroup)`) rather than a struct with a boolean flag
- `VerificationVerdict` encodes three states explicitly rather than using `Option<bool>`
- `WorkspaceProvider` is an enum rather than a string

### ⚠️ Weakness: Newtype Wrapping

`ProblemKey(pub String)` and `TaskId = String` both wrap/alias strings but inconsistently. `ProblemKey` is a newtype (offers type safety but no real abstraction), while `TaskId` is a type alias (no compile-time protection against mixing with other string IDs). The inconsistency is notable in `lib.rs` where some string types are newtypes and others are aliases.

### ✅ Strength: Serde + JsonSchema Derivation

Most domain types derive both `Serialize`/`Deserialize` and `JsonSchema`. This enables automatic JSON Schema generation for tool specifications via `schemars::schema_for!`.

### ⚠️ Weakness: Large Struct Mutation Through `&mut self`

The `ProcessAgentRunScheduler` struct has 7 fields, many optional (`Option<Child>`, `Option<OwnedWriteHalf>`, etc.). The `ensure_started` method transitions through several states. This is common for state-machine types but the struct exposes no explicit state enum — invariants are maintained implicitly.

---

## 4. Code Quality Observations

### 4.1 Macro Use

The custom `#[toolset]` proc macro in `crates/siko-macros/` is used in two places:

- `assistant/tools.rs` — `#[siko_macros::toolset(enum_name = "AssistantTool")]` on a trait
- `task_run/tools.rs` — `#[siko_macros::toolset(enum_name = "EngineTool", output = "...")]` on an impl block

The macro generates the enum, name/spec/decode methods, and optional decode_call method. This reduces boilerplate significantly: 7 tools × ~15 lines each ≈ 100 lines of generated code per toolset.

### ⚠️ Weakness: Macro Complexity

The proc macro handles two different input shapes (trait and impl block) and optional output types. The conditional `decode_impl` code path creates a branch where `decode_call` exists only for impl-block toolsets. This is functional but adds mental overhead.

### 4.2 String Handling

The codebase uses `String` extensively for:

- Task IDs (also aliased as `TaskId`)
- Error messages (string-based errors)
- Prompt sections (title/content as strings)
- Configuration values
- Workspace paths

This is appropriate for a domain that frequently serializes/deserializes across JSON boundaries.

### 4.3 Async Pattern

The codebase uses `async_trait` for the core traits:

- `AgentRunScheduler` — `run(&mut self, input, cancellation) -> AgentRunResponse`
- `AssistantLoop` — `run_turn(&mut self, context) -> Result<AssistantTurn, AssistantTurnError>`
- `TaskEngineRunner` — `run_task(&mut self, task_id, request, cancellation) -> Result<...>`
- `TaskStore` — synchronous trait (not async)

The mix of async and sync traits is purposeful: `TaskStore` operations are in-memory or atomic file writes that don't need async.

### ✅ Strength: Cancellation Patterns

The `CancellationToken` type (based on `Arc<CancellationState>`) provides cooperative cancellation across async boundaries. It wraps `AtomicBool` + `Notify`, following the standard Tokio cancellation idiom. The `ProcessAgentRunScheduler::read_response_or_cancel` method uses `tokio::select!` to properly interleave cancellation with I/O.

### ⚠️ Weakness: `tokio::select!` Loop in `cancelled()`

The `CancellationToken::cancelled()` method uses a loop with `tokio::select!`-like manual polling (via `notified().await` in a loop). This is a known pattern but risks a lost-notification race: if the notify happens between the `is_cancelled()` check and `.notified()`, the waiter hangs until the next notification. The loop mitigates this but creates a small window for spurious wake.

### 4.4 Test Coverage

The codebase has excellent test coverage:

- `config.rs`: 18 tests (expand_home, non_empty_env, config inheritance)
- `agent_run/run.rs`: 17 tests (CancellationToken, token usage, serde roundtrips)
- `agent_run/run_scheduler.rs`: 0 tests (external process boundary)
- `task_run/types.rs`: 4 tests (governance gates, display implementations)
- `task_run/node.rs`: 16 tests (scope assessment, work size, serde roundtrips)
- `task_run/tools.rs`: 13 tests (verdict args, plan item key, plan validation)
- `workspace/mod.rs`: 30+ tests (path glob, workspace requirement, workspace IDs)
- `workspace/store.rs`: 10 tests (path helpers)
- `metrics.rs`: 12 tests (collection, formatting)
- `task_board/store.rs`: ~10 tests (task title truncation, status mapping)

### ✅ Strength: Property-Based Edge Cases

Tests cover edge cases well: empty paths, zero values, special characters, UTF-8 truncation, NUL-separated paths, double-star glob patterns, overlapping scope patterns.

### ⚠️ Weakness: Missing Integration Tests

The `ProcessAgentRunScheduler` has no tests, likely because it requires an external process boundary. The `WorkspaceResourceRegistry` has unit tests but the integration between the engine and workspace providers is not tested at the harness level.

---

## 5. Architectural Pattern Adherence

### 5.1 Recursive Engine Architecture

The codebase faithfully implements the documented recursive engine pattern from AGENTS.md:

1. **Specify** → normalize intent, assess scope, size the work
2. **Plan** → decompose into stage/parallel child nodes
3. **Execute** → atomic work within scope
4. **Combine** → synthesize child artifacts
5. **Verify** → judge candidate against intent
6. **Commit** → engine-only terminal event

### ✅ Strength: Governance Layer Enforcement

Each `NodeOperation` declares its `governance_layer()` and `active_hard_gates()`. The harnesses inject these into prompts. The `submit_plan_group` tool in `tools.rs` validates `G-PARALLEL-DEPENDENCY` and empty-item protocol violations programmatically.

### ⚠️ Weakness: Governance Gate for Non-Agent Operations

`NodeOperation::Commit` panics when it reaches the harness layer (the operation is engine-only). This is correct behavior but panicking from production code paths (even unreachable ones) is a code smell. A `Result` or assertion would be safer.

### 5.2 Agent Protocol

The agent protocol flows through:

- `AgentRunRequest` → `ProcessAgentRunScheduler` → external process → `AgentRunResponse`
- The assistant uses `AgentAssistantLoop` to wrap `AgentRunScheduler` into `AssistantLoop`

### ✅ Strength: Protocol Versioning

`AgentRunRequest.protocol_version` is set to 1. This allows future protocol evolution without breaking existing agents.

### ⚠️ Weakness: Single Retry Strategy

The `AgentAssistantLoop` retries exactly once (for a total of 2 attempts) on decode failure. The retry injects an `assistant_tool_error` field into the input. This is functional but hardcoded; the `Budget` system in `task_run` has a more general retry mechanism that could be shared.

### 5.3 Workspace Resource Lifecycle

The `Workspace` trait defines five operations: `snapshot`, `open_surface`, `capture_changes`, `merge_changes`, `cleanup`. The `WorkspaceResourceRegistry` tracks resources by ID with reference counting.

### ✅ Strength: Explicit Resource Tracking

Resources carry a `WorkspaceResourceRef` list that tracks which node/artifact holds a reference. The `releasable_ids()` method finds resources that can be cleaned up. This prevents resource leaks in the git-filesystem provider where worktrees and branches are physical resources.

### ⚠️ Weakness: `FileSystemWorkspace` and `MemoryWorkspace` Are No-Ops

Both `FileSystemWorkspace` and `MemoryWorkspace` return empty change records. The actual filesystem mutation happens through the agent run (external process), not through the workspace abstraction. The workspace layer is fully wired for git operations but the filesystem path is essentially a pass-through.

---

## 6. Improvement Opportunities

### 6.1 High Priority

1. **Replace string errors in assistant layer with typed errors**: Convert `AssistantTurnError` from a wrapper struct to an enum with variants like `MissingTerminalTool`, `InvalidArguments { tool: String, error: String }`, `WrongTerminalTool { expected: String, got: String }`.

2. **Add tests for `ProcessAgentRunScheduler`**: Use a mock Unix socket server or in-memory channel to test the message protocol, connection retry, cancellation, and shutdown paths without an external process.

3. **Remove panic from `Commit` harness path**: Replace `panic!` with `unreachable!` or return a `Result` that the engine handles gracefully.

### 6.2 Medium Priority

4. **Unify string ID types**: Decide whether to use newtypes (`ProblemKey`) or type aliases (`TaskId`) consistently across the codebase.

5. **Extract `CancellationToken` into a shared utility**: The current implementation lives in `agent_run/run.rs` but is used by `task_board/board.rs`, `task_run/engine.rs`, and `assistant/session.rs`. It could be a standalone crate or a shared module.

6. **Reduce re-export surface in `lib.rs`**: Consider re-exporting only the types that external consumers need, using `pub(crate)` for internal types.

### 6.3 Low Priority

7. **Add doc tests for glob matching**: The `path_allowed` function already has excellent unit tests but adding `/// ``` ... ```` doc tests would make the API more discoverable.

8. **Consider `#[non_exhaustive]` for governance enums**: As the system evolves, adding new `GovernanceGate` or `FailureClass` variants should not be a breaking change for pattern matches.

9. **Consolidate `format_metrics` and `MetricsSnapshot::to_json_value`**: These two methods produce nearly identical JSON output. One could delegate to the other.

---

## 7. Summary

| Dimension              | Rating | Key Finding                                                                          |
| ---------------------- | ------ | ------------------------------------------------------------------------------------ |
| Module Organization    | ★★★★★  | Clean single-direction dependencies, well-documented boundaries                      |
| Error Handling         | ★★★★☆  | Excellent contextual errors in workspace layer; string errors in assistant layer     |
| Type Design            | ★★★★★  | Well-modeled domain with discriminated unions; minor inconsistency in ID types       |
| Code Quality           | ★★★★☆  | Strong test coverage, thoughtful async patterns; some state-machine complexity       |
| Architecture Adherence | ★★★★★  | Faithful implementation of recursive engine, governance, and agent protocol patterns |

**Overall**: The codebase is well-structured and thoughtfully designed. The recursive engine pattern is consistently applied. The main improvement areas are in error type discipline (string errors in the assistant layer) and integration test coverage for the external process boundary.
