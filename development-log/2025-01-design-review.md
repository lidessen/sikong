# Design Decisions Review

**Date:** 2025-01 (retrospective)
**Scope:** Six architectural design decisions in the Sikong recursive agent engine

---

## Decision 1: Recursive Node Lifecycle (Specify → Plan → Execute → Combine → Verify → Commit)

### What it is

Every problem node in the engine moves through a fixed six-operation lifecycle. The engine's `resolve()` method implements this as a recursive function with `#[async_recursion]`. Skip paths exist (memo table hit skips everything; retry with existing candidate skips Execute; no child artifacts skips Combine), but the canonical path is always the same sequence.

### Is this the simplest design?

**No, but it is appropriately simple for its domain.** The lifecycle is a textbook divide-and-conquer + dynamic programming pattern. It is easy to reason about, test, and debug. Each operation has a single responsibility and a single terminal tool. The recursion mirrors the conceptual model directly: if a problem is too big, split it; solve each part; combine; verify; commit.

The simplicity cost shows in the **mandatory overhead**: every leaf node requires at least 2 agent calls (Specify + Execute) and typically 3 (Specify + Execute + Verify). Even a "fix typo" task pays the same setup cost as "redesign the module." The escape hatch of memo-table hits only helps when the exact same problem key recurs.

### Any redundancy?

**Some.** Specify and Plan are both governance-Plan operations, but they are distinct engine operations with different terminal tools and scheduling. Specify always runs (even when the plan is pre-set to Execute). For nodes that come from a template with pre-set `NodePlan::Execute`, running Specify just to confirm the size feels like an unnecessary LLM call — the parent already decided the size during its Plan pass.

Similarly, Combine and Verify are operationally linked but always serialized. A qualified Combine could include a self-verification claim that Verify could check deterministically, but the current design forces two separate agent runs.

### More harm than good?

**No.** The lifecycle is the engine's core reliability mechanism. Its procedural nature (as opposed to the implicit model-internal planning of Claude Code or Codex) is what gives Sikong bounded termination, fault isolation, and deterministic verification. The cost is latency, but the alternative (unbounded model sessions) is worse for production reliability.

### Verdict: **Keep**

The lifecycle is the engine's key differentiator. The redundancy of mandatory operations could be addressed by the FastExecute path (see Decision 2), not by removing lifecycle phases.

---

## Decision 2: FastExecute Path

### What it is

`NodePlan::FastExecute` is a lightweight execution path for `WorkSize::Tiny` tasks. It runs the agent with the standard Execute operation but without creating a workspace surface. On success, it self-verifies by calling `commit()` immediately — skipping the standard Verify pass entirely. On failure, it falls back to creating an empty candidate so the standard Verify path can handle it.

### Is this the simplest design?

**Yes, for what it does.** The implementation is ~30 lines in `engine.rs`. The fallback path is straightforward. The self-verification is just an immediate `commit()` call with no extra LLM call.

However, the simplicity reveals a tension: **self-verification contradicts the governance model**. The governance doc says "Verify owns gates and acceptance" and "Execute must not ... accept unverified agent claims as durable facts." FastExecute does exactly that — it commits without independent verification. The justification is that tiny tasks are below the verification threshold, but this is a governance principle violated by pragmatism.

### Any redundancy?

**With the standard Execute path, yes.** FastExecute and Execute share most of their prompt structure. The only difference is that FastExecute skips workspace surface creation and skips Verify. The agent gets the same "atomic execution pass" role prompt. The engine branching on `fast_execute` vs `execute` creates two code paths that do almost the same thing.

### More harm than good?

**Probably not, but the governance gap needs monitoring.** For genuinely tiny tasks (typo fixes, one-line answers), the FastExecute path saves one LLM call per node. The risk is that the agent will claim self-verification for non-trivial outputs, which the engine will accept unverified.

The design doc's proposed `should_fast_path()` heuristic is not yet implemented — currently only `WorkSize::Tiny` maps to FastExecute, and that mapping happens in `plan_from_scope_assessment()` based on what the Specify pass reported. So the decision rests entirely on the LLM's size estimate, which could be wrong.

### Verdict: **Simplify**

Replace the two separate paths (FastExecute vs Execute) with a single Execute path that has an optional post-execution shortcut: if the node size is Tiny and there is no workspace change, skip Verify and commit directly. This eliminates the duplicate code path while keeping the efficiency gain. The self-verification concern is addressed by making the skip conditional on deterministic evidence (no workspace change) rather than on an LLM size estimate.

---

## Decision 3: Stage vs Parallel Group Mode

### What it is

`PlanGroupMode` has two variants: `Stage` (serial pipeline — children execute one after another, failure blocks subsequent children) and `Parallel` (concurrent — children execute in tokio `JoinSet` with independent Engine clones, combined via `merge_parallel_branch`). The planning LLM chooses the mode during the Plan pass.

### Is this the simplest design?

**Yes, and it is well-documented.** The efficiency-analysis.md devotes significant space to explaining why Stage must not be "adaptively parallelized" — the two modes serve fundamentally different needs. Stage is ordered phases where each step depends on the previous; Parallel is independent evidence surfaces.

The implementation is clean: Stage is a `for` loop, Parallel spawns into `JoinSet`. The `BranchEngineGuard` RAII pattern for parallel branch cleanup is well-engineered.

### Any redundancy?

**No.** The two modes are genuinely different and the code paths share no logic beyond the resolve loop that dispatches to them.

### More harm than good?

**No.** The design document's analysis of why Stage should not be parallelized is correct and well-argued. The Stage/Parallel choice is a planning-time decision, not an execution-time optimization. The design correctly rejects the temptation to make Stage "smart."

### Verdict: **Keep**

The Stage/Parallel distinction is one of the engine's strongest design decisions. The documentation in `efficiency-analysis.md` should be preserved as it prevents future engineers from reintroducing the "adaptive parallelism" mistake.

---

## Decision 4: Governance Model (Arch/Plan/Execute/Verify)

### What it is

A four-layer authority model derived from common law governance concepts. `Arch` owns system frame (not a node operation — it's the design authority). `Plan` owns routing and decomposition (maps to Specify + Plan operations). `Execute` owns local work and synthesis (maps to Execute + Combine). `Verify` owns gates and acceptance (maps to Verify operation). Each layer has hard gates that the engine enforces through prompt injection and schema validation.

### Is this the simplest design?

**No, and it over-engineers what should be a simpler operation contract.** The governance model adds a parallel taxonomy (`GovernanceLayer`, `GovernanceGate`, `hard_gates`) that sits alongside the existing operation taxonomy. Every operation must now answer "what governance layer am I?" and "what hard gates are active?" in addition to "what terminal tool do I use?"

The concept is elegant on paper but the implementation cost is measurable:

- Every operation has `governance_layer()` and `active_hard_gates()` methods
- Every agent run prompt includes a `Governance Boundary` section
- The operation context packet carries `governance.layer` and `governance.hard_gates`
- The harness serializes gate IDs and descriptions for every run
- The `governance-model.md` document is ~400 lines

### Any redundancy?

**Yes, significantly.** The governance layer is almost entirely redundant with the existing operation structure:

- `Specify` → Plan layer → but `specify` already has a `Specification Standard` prompt section
- `Plan` → Plan layer → but `plan` already has a `Planning Lens` prompt section
- `Execute` → Execute layer → but `execute` already has `Execution Standard`
- `Combine` → Execute layer → but `combine` already has `Parent Synthesis Standard`
- `Verify` → Verify layer → but `verify` already has `Verification Lens`

The governance boundary is injected as prompt text that the LLM reads. It adds no mechanical enforcement — the hard gates are checked by the verifier, not by the governance layer. The only mechanically-enforced gate is `G-SCOPE-WIDEN` (checked by the engine before child runs) and `G-PARALLEL-DEPENDENCY` (checked by `submit_plan_group` input validation).

The remaining six gates (`G-ARCH-ESCAPE`, `G-SYNTHESIS-CHILD`, `G-UNSUPPORTED-FACT`, `G-PASS-WITH-HARD-VIOLATION`, `G-PROTOCOL`, `G-CHECK-FAIL`) are either (a) enforced by other mechanisms, (b) checked only by the LLM verifier, or (c) aspirational with no enforcement at all.

### More harm than good?

**Potentially.** The governance model creates the illusion of a safety layer that is mostly aspirational. An engineer reading the code could believe that `G-ARCH-ESCAPE` prevents architecture drift, when in fact it is just a paragraph in the agent's prompt. The real protection against architecture drift is the Rust type system (the `NodeOperation` enum, the workspace trait, the tool set macros) — not the governance text.

Additionally, the governance model adds cognitive load without proportional benefit. Every new contributor must learn both the operation taxonomy AND the governance taxonomy, when in practice only the operations matter for understanding what the engine does.

### Verdict: **Simplify**

Replace the four-layer governance model with a simpler **operation contract** that is derived directly from the operation type:

1. Remove `GovernanceLayer` — it duplicates information already present in the operation.
2. Remove `active_hard_gates()` — keep only the mechanically-enforced gates as engine-side checks (scope widening, parallel dependency), embedded directly in the relevant validation functions.
3. Remove the `Governance Boundary` section from prompts — the existing operation-specific prompt sections (Verification Lens, Execution Standard, etc.) already tell the agent what it may and may not do.
4. Keep the governance-model.md as **historical reference** but mark it ✗ Superseded.

The real value of the governance work is in the specific mechanized gates (scope widening check, parallel dependency check, empty output check) — those should be kept and strengthened, but they don't need the governance taxonomy to function.

---

## Decision 5: Workspace Provider Abstraction

### What it is

The `Workspace` trait provides a uniform interface for different execution environments: `Memory` (ephemeral, no filesystem access), `FileSystem` (read/write to real filesystem, restricted by glob patterns), and `GitFileSystem` (git worktree isolation). Each provider handles snapshot, fork, execute, collect changes, combine, and commit lifecycle.

### Is this the simplest design?

**Yes, and it is well-isolated.** The trait is clean with clear methods. The separation between workspace concerns (where and how work executes) and problem concerns (what work to do) is one of the best parts of the architecture. The `WorkspaceResourceRegistry` + `WorkspaceResourceRef` lifecycle management (with RAII `BranchEngineGuard`) is robust.

The implementation surface is notably compact:

- `FileSystem` workspace: ~200 lines
- `GitFileSystem` workspace: ~200 lines
- `Memory` workspace: ~50 lines
- Resource registry: ~150 lines

### Any redundancy?

**Minor.** The `post_completion_write_scope_commit` hook in `engine.rs` duplicates logic that lives in the workspace layer. The hook exists because the engine needs to auto-commit write-scope changes after Execute/Combine completes, but the workspace trait's `commit` method is designed for the full verification pipeline, not for mid-lifecycle partial commits. This creates a bypass path where the engine calls `commit_write_scope_paths()` directly rather than going through `Workspace::commit()`.

### More harm than good?

**No.** The workspace abstraction is the foundation of Sikong's safety model. Without it, there would be no way to run independent agents in isolated environments, capture side effects, or verify that read-only tasks stay read-only. The abstraction is worth its weight.

### Verdict: **Keep**, with one simplification

Standardize the commit path. Either:

- Move `post_completion_write_scope_commit` into the `Workspace` trait as a new method (`partial_commit`), or
- Remove the auto-commit hook entirely and require all commits to go through the standard Verify → Commit pipeline.

The first option is more practical since the hook serves a real need (intermediate checkpoints during long agent runs), but it should be a first-class trait method, not an engine-side workaround.

---

## Decision 6: Operation Harness + Agent-Host Boundary + ACP Protocol

### What it is

Three related mechanisms form the communication layer:

1. **OperationHarness** — a Rust struct that owns operation context and builds `AgentRunRequest` for the Bun agent-host. Each operation type has a distinct prompt structure built from typed sections.

2. **Agent-host boundary** — Rust runs a Bun child process over a Unix socket using JSONL RPC. The `ProcessAgentRunScheduler` manages process lifecycle, sends `run` messages, and receives `result` responses. The agent-host is the only execution layer; Rust never calls LLMs directly.

3. **ACP (Assistant Agent Protocol)** — a JSON-RPC 2.0 protocol over stdio for external agents (Claude Code, Codex, custom agents) to interact with Sikong's assistant layer.

### Is this the simplest design?

**For the agent-host boundary, yes.** The Rust/Bun split is pragmatic: Rust is type-safe and deterministic (good for state machines and validation), Bun is good for async LLM calls with streaming (good for agent loops). The Unix socket JSONL RPC is simple and debuggable.

**For the OperationHarness, not entirely.** The prompt construction uses a `macro_rules!` macro (`operation_prompt!`) that is clever but makes prompt sections harder to read and maintain. Each operation prompt is built from ~10-15 distinct sections, all embedded in the macro invocation. Adding or debugging a prompt section requires understanding the macro's token manipulation.

**For the ACP protocol, yes.** JSON-RPC 2.0 is a well-known standard. The protocol surface is minimal (initialize, session/new, session/prompt, session/cancel). This is the right level of simplicity for an external integration surface.

### Any redundancy?

**Minor redundancy between OperationHarness and AssistantHarness.** Both implement `build_agent_run()` that produces the same `AgentRunRequest` shape. The duplication is acceptable because the two harnesses serve fundamentally different purposes (engine operations vs assistant conversations) and the shared wire format is the integration boundary, not code to be DRY'd.

The prompt construction macro (`operation_prompt!`) could be replaced with a simpler builder pattern without loss of expressiveness.

### More harm than good?

**The Bun dependency is a risk.** The current architecture requires:

- Bun installed and available
- `@sikong/agent-host` TypeScript source or compiled bundle
- Unix socket availability
- Process management (start, monitor, retry, kill)

This is four more moving parts than a pure-Rust solution. The design doc acknowledges this as "transitional" — the Rust mainline is "progressively replacing the Bun runtime bridge with native Rust execution." Until that migration completes, every Bun dependency adds deployment friction and failure modes (process crashes, socket failures, version mismatches).

The ACP protocol itself is clean and well-documented, but the integration pattern (external agent spawning `siko assistant --acp` as a subprocess) creates a two-process architecture for what could be a library call.

### Verdict: **Simplify** the prompt construction, **Keep** the architecture

1. **Replace `operation_prompt!` macro** with a plain Rust builder or constructor function. The macro saves ~50 lines of code but costs readability and maintainability. Each prompt section should be a `fn` that returns `AgentPromptSection`, composed with `vec![]`.
2. **Keep the Rust/Bun split** but accelerate the migration to native Rust execution. The Bun dependency adds real operational complexity.
3. **Keep the ACP protocol** as-is — it is a clean external integration surface.

---

## Summary

| Decision                                       | Verdict           | Key Action                                                                                     |
| ---------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| 1. Recursive Node Lifecycle                    | **Keep**          | No change needed; core differentiator                                                          |
| 2. FastExecute Path                            | **Simplify**      | Merge into single Execute path with conditional Verify skip based on workspace change evidence |
| 3. Stage vs Parallel Group Mode                | **Keep**          | No change needed; well-designed and documented                                                 |
| 4. Governance Model (Arch/Plan/Execute/Verify) | **Simplify**      | Remove redundant governance taxonomy; keep only mechanically-enforced gates                    |
| 5. Workspace Provider Abstraction              | **Keep**          | Formalize `partial_commit` in the trait instead of engine-side hook                            |
| 6. Operation Harness + Agent-Host Boundary     | **Simplify/Keep** | Replace prompt macro with builder; accelerate Bun→Rust migration; keep ACP as-is               |

### Cross-Cutting Observations

1. **Prompt inflation is the real cost.** Every agent operation serializes the full Operation Context JSON into the prompt. For deep recursion trees, repeated context serialization wastes tokens. A context diff or incremental context projection would save significant costs.

2. **The governance model adds complexity without proportional enforcement.** The mechanical gates (scope check, parallel dependency check) are valuable. The aspirational gates (Arch escape, unsupported fact) are just prompt text with no mechanical backing. Remove the aspirational gates and keep the mechanical ones.

3. **The workspace layer is the most under-appreciated part of the design.** It enables the engine's safety guarantees more than any other component. It should be treated as a first-class architectural element, not as a supporting detail.

4. **FastExecute reveals a governance inconsistency** that should be resolved by making the Verify skip conditional on deterministic evidence (no workspace changes), not on an LLM size estimate.
