# Task Run Subsystem — Design-to-Code Delta Report

Generated: 2026-06-22
Target: `src/task_run/*` vs `governance-model.md` + `recursive-agent-engine.md`

## Summary

- **Total claims extracted**: 47 (19 from governance-model.md, 28 from recursive-agent-engine.md)
- **Matching claims**: 33 (70%)
- **Contradicted / diverged claims**: 7 (15%)
- **Undocumented code surfaces**: 14 items
- **Gate rule enforcement**: 7/8 hard gates are enforced in code

---

## 1. Matching Claims

### From `governance-model.md`

| Claim | Code location | Status |
|-------|--------------|--------|
| `NodeOperation` enum: Specify/Plan/Execute/Combine/Verify/Commit (6 variants) | `types.rs:12-19` | ✅ |
| `NodeOperation::governance_layer()`: Specify|Plan→Plan, Execute|Combine→Execute, Verify→Verify, Commit→None | `types.rs:21-29` | ✅ |
| `NodeOperation::active_hard_gates()` method exists, returns per-operation gates | `types.rs:31-59` | ✅ |
| `GovernanceLayer` enum: Arch/Plan/Execute/Verify (4 variants) | `types.rs:62-68` | ✅ |
| `GovernanceGate` enum: G-ARCH-ESCAPE through G-CHECK-FAIL (8 gates) | `types.rs:70-96` | ✅ |
| Gate ids are stable text labels: `#[serde(rename="G-*")]` | `types.rs:72-95` | ✅ |
| Commit engine-side, not a governance layer: `governance_layer()` returns `None` | `types.rs:27-28` | ✅ |
| Combine = parent execution/synthesis, not separate governance role | `types.rs:25` (Combine → Execute layer) | ✅ |
| G-SCOPE-WIDEN enforcement in child scope validation | `engine.rs:1178-1196` | ✅ |
| Governance boundary projected into operation prompts | `harness.rs:348-367` | ✅ |
| Operation context includes governance layer + hard gates | `harness.rs:60-70` | ✅ |
| Parallel dependency detection (G-PARALLEL-DEPENDENCY) | `tools.rs:39-48` | ✅ |
| G-PASS-WITH-HARD-VIOLATION enforcement | `tools.rs:260-272` | ✅ |

### From `recursive-agent-engine.md`

| Claim | Code location | Status |
|-------|--------------|--------|
| `NodePlan` enum: Execute/Split/Group(PlanGroup) | `node.rs:37-42` | ✅ |
| `PlanGroup` struct with `mode: PlanGroupMode` + `items: Vec<NodeTemplate>` | `node.rs:44-48` | ✅ |
| `PlanGroupMode`: Stage / Parallel | `node.rs:50-56` | ✅ |
| `WorkSize` enum: Tiny/Small/Medium/Large/XLarge (5 variants) | `node.rs:8-18` | ✅ |
| `ScopeAssessment` struct: next + size + reason | `node.rs:20-25` | ✅ |
| `NodeStatus` enum: New/Specified/WaitingForInfo/Planned/Running/Combining/Verifying/Accepted/Rejected/Pruned/Committed (11 variants) | `types.rs:166-178` | ✅ |
| `VerificationVerdict`: Accept / Reject{failure_class,reason} / Uncertain{missing_info,reason} | `types.rs:181-191` | ✅ |
| `AttemptRecord`: node_id + operation + verdict | `types.rs:227-231` | ✅ |
| Engine resolve flow follows: specify → plan/execute → combine → verify → commit | `engine.rs:138-203` | ✅ |
| No `Repair` operation; rejection flows to Specify | `engine.rs:684-721` | ✅ |
| `Fork` is not a `NodeOperation` (engine creates surfaces directly) | `engine.rs` (no Fork variant exists) | ✅ |
| `OperationHarness` wrapping `AgentOperationContext` | `harness.rs:34-36` | ✅ |
| Harness builds `AgentRunRequest` from context | `harness.rs:382-396` | ✅ |
| Child scope inheritance with widening check | `engine.rs:1150-1176` | ✅ |
| Deterministic verification checks (read-only→change, merge conflict, out-of-scope writes) | `engine.rs:639-682` | ✅ |
| Runtime profile selection (general vs code) | `harness.rs:458-472` | ✅ |
| No task-type operations as primitives (no Research/CodeChange/Debug) | No such variants | ✅ |
| Terminal tool validation: right tool for each operation | `harness.rs:407-455` | ✅ |

---

## 2. Contradicted / Diverged Claims

### C-1: Iterative vs recursive engine implementation

- **Design claim** (`recursive-agent-engine.md:1025`): "The kernel loop is recursive in semantics, but **iterative in implementation** so it can be persisted and resumed."
- **Code reality**: The engine uses `#[async_recursion]` on `resolve()` (`engine.rs:138`) with fully recursive async calls. Parallel branches spawn child `Engine` instances via `JoinSet`. No loop/iterative persistence hook exists.
- **Impact**: The engine cannot be serialized and resumed mid-execution. A long-running task loses all progress if the process dies.
- **Severity**: Design requirement not implemented.

### C-2: ProblemNode field mismatch

- **Design claim** (`recursive-agent-engine.md:913-927`): `ProblemNode` has `spec: Spec`, `constraints: Vec<Constraint>`, `acceptance: Vec<AcceptanceRule>`.
- **Code reality** (`node.rs:86-103`): No `Spec`, `Constraint`, or `AcceptanceRule` types exist. Instead, code has `size: WorkSize`, `scope_assessment: Option<ScopeAssessment>`, `candidate: Option<ArtifactId>`, `accepted_artifact: Option<ArtifactId>`, `execution_attempts: u32`, `verification_attempts: usize`.
- **Impact**: Design overspecified formal modeling types; code uses simpler runtime heuristics. The `Spec` type was replaced with `ScopeAssessment` + `WorkSize`. The acceptance logic is implicit in the Verify pass rather than stored as structured rules.
- **Severity**: Moderate divergence — the code is simpler and functional but lacks the structured acceptance/constraint framework the design envisioned.

### C-3: ArtifactContentKind limited to Text

- **Design claim** (`recursive-agent-engine.md:1010-1013`): `ArtifactContentKind` has three variants: `Text`, `Json`, `FileRef`.
- **Code reality** (`node.rs:105-108`): Only `Text` variant exists. No `Json` or `FileRef`.
- **Impact**: Cannot produce structured JSON artifacts or file references natively. All agent output is treated as opaque text.
- **Severity**: Missing capability that constrains integration patterns (e.g., cannot use typed artifact payloads for structured data exchange).

### C-4: Memo key is a flat string, not composite hash

- **Design claim** (`recursive-agent-engine.md:706-718`): `ProblemKey` must include normalized intent hash, spec hash, context snapshot hash, capability profile hash, and relevant input artifact hashes — a 5-component composite.
- **Code reality** (`types.rs:163`, usage in `engine.rs:147-150`): `ProblemKey(String)` — a single flat string supplied by the agent/template. No composite hashing or component-level memo key construction exists.
- **Impact**: Memo table deduplication relies entirely on the agent supplying the same key string. No automatic change-detection (a changed context or capability profile won't invalidate a stale memo entry).
- **Severity**: Fundamental feature missing — memo dedup is unreliable.

### C-5: FailureClass mismatch with design decision table

- **Design claim** (`recursive-agent-engine.md:1077-1085`): Decision table covers: missing information, same failure repeated, spec ambiguity, executor mismatch, unsafe side effect, budget exhausted, human decision required.
- **Code reality** (`types.rs:194-204`): `FailureClass` enum has: MissingInfo, SpecAmbiguity, IncompleteOutput, BadOutput, UnsafeSideEffect, MergeConflict, BudgetExhausted (7 variants).
- **Impact**: Code adds IncompleteOutput, BadOutput, MergeConflict that design doesn't mention. Design's "executor mismatch" and "human decision required" aren't in code. The handle_reject logic (`engine.rs:684-721`) only distinguishes four paths: MissingInfo/SpecAmbiguity → retry; UnsafeSideEffect/MergeConflict → Pruned; BudgetExhausted → Rejected; everything else → Pruned after max_attempts.
- **Severity**: Moderate — the design's richer branching (executor retry, human decision) is not implemented.

### C-6: No EngineTables struct or frontier

- **Design claim** (`recursive-agent-engine.md:696-701`): Dedicated `EngineTables` struct with `memo_table`, `attempt_table`, and `frontier: ReadyQueue<NodeId>`.
- **Code reality** (`engine.rs:34-47`): No `EngineTables` struct. Fields are directly on `Engine`. No `frontier` or `ReadyQueue` — the engine uses recursive `resolve()` calls and `JoinSet` for parallel children.
- **Impact**: No explicit ready-queue means the engine doesn't support the described frontier-based scheduling. Node readiness is determined implicitly by recursion depth and the resolve control flow.
- **Severity**: Moderate — the scheduling model diverges from the design.

### C-7: Governance gates undocumented in code comments

- **Design claim** (`governance-model.md`): Gate rules are described with semantic intent (e.g., G-SYNTHESIS-CHILD rationale).
- **Code reality**: While the 8 gates are present and descriptions are attached in `GovernanceGate::description()`, the code has no doc-comments explaining when gates fire or the governance-layer context that motivates them.
- **Impact**: Developers reviewing the code see gate definitions but not the governance reasoning behind them.
- **Severity**: Minor — code is functionally correct but lacks design rationale in comments.

---

## 3. Undocumented Code

Code that exists in `src/task_run/` but is not described in either design document.

### U-1: WorkspaceResourceRegistry (`resources.rs`)
Complete resource tracking and lifecycle management subsystem. Implements retain/release/releasable/mark_released/mark_failed_cleanup pattern for workspace resources. The design docs discuss workspace isolation and provider selection but never describe this reference-counted resource lifecycle mechanism.

### U-2: Parallel branch engine spawning (`engine.rs:338-451`)
`resolve_parallel_children` creates independent `Engine` instances per child, runs them concurrently via `JoinSet`, then merges results back via an ID remapping system. This is a significant architectural pattern not documented in either design doc.

### U-3: ID remapping system (`engine.rs:1033-1140`)
8 remapping functions (`remap_node`, `remap_artifact`, `remap_workspace_change`, `remap_workspace_resource`, `remap_workspace_ref`, `remap_node_id`, `remap_artifact_id`, `remap_workspace_change`) plus `merge_parallel_branch`. Handles collision-free merging of node/artifact IDs when parallel branch engines are merged back. Not described in any design doc.

### U-4: CancellationToken (`engine.rs:1219-1225`)
Threaded through all async methods. Provides cooperative cancellation. `EngineError::Cancelled` variant. Not described in design docs.

### U-5: `stop_after_route_depth` (`engine.rs:71-73`, used in `resolve()`)
Testing/debugging feature that stops engine traversal after a specified depth. Not described in design docs.

### U-6: EngineAgentContextPacket and all serialization types (`harness.rs:49-117`)
7 packet types: `EngineAgentContextPacket`, `EngineAgentGovernancePacket`, `EngineAgentGovernanceGatePacket`, `EngineAgentNodePacket`, `EngineAgentWorkspaceRequirementPacket`, `EngineAgentGitRequirementPacket`, `EngineAgentArtifactPacket`, `EngineAgentWorkspaceSurfacePacket`. These define the full wire-format representation of operation context. The design docs describe `AgentOperationContext` but not these serialization structures.

### U-7: PlanItemInput → NodeTemplate pipeline (`tools.rs:100-181`)
`PlanItemInput` struct, `into_node_template()`, and `plan_item_key()` provide a conversion pipeline from agent-submitted plan items to `NodeTemplate` structs with automatic key slug generation. Not in design docs.

### U-8: VerdictDecision::NeedInformation (`tools.rs:253-257`)
Three-value verdict input enum (Accept/Reject/NeedInformation) that maps to `VerificationVerdict`'s Uncertain variant. Not described in design docs.

### U-9: parse_failure_class (`tools.rs:291-304`)
String-to-enum parsing supporting multiple input formats (`snake_case`, `PascalCase`). Not in design docs.

### U-10: EngineReport and AgentRunRecord (`types.rs:206-257`)
Complete output data structures: `OperationEvent`, `AgentRunRecord` (with duration, usage, events), `EngineReport` (root node, status, artifact, events, agent_runs). Not described in design docs.

### U-11: Scope checking utilities (`engine.rs:1142-1217`)
Four functions: `path_allowed`, `ensure_child_scopes_within_parent`, `scope_allowed_by_parent`, `parent_scope_allows_child`, `scope_prefix`. Provide scope containment verification with glob-like pattern matching (`**/*`, prefix matching). Not mentioned in design docs.

### U-12: `inherit_child_defaults` (`engine.rs:1150-1176`)
Child scope inheritance logic: children inherit parent workspace/ capabilities/budget by default, with explicit child scope validated against parent scope (G-SCOPE-WIDEN). Not described in design docs.

### U-13: Resource lifecycle in execute/combine (`engine.rs:929-957`)
`retain_change_resources`, `release_change_resources`, `release_surface_resources` — retain/release pattern ensuring workspace resources live only as long as needed. Not described in design docs.

### U-14: Commit-time memo table update (`engine.rs:723-731`)
`commit()` writes to memo_table AND marks node Committed AND records accepted_artifact. The design describes memo table and commit as separate concepts but doesn't describe this combined update pattern.

---

## 4. Hard Gate Enforcement Audit

| Gate | Enforced | Enforcement mechanism |
|------|----------|----------------------|
| G-ARCH-ESCAPE | ✅ | Per-operation gate list (Specify/Execute/Combine/Verify) — agent prompt warns. No engine-side enforce check. |
| G-SCOPE-WIDEN | ✅ | `engine.rs:1178-1196` — deterministic check during child scope inheritance |
| G-PARALLEL-DEPENDENCY | ✅ | `tools.rs:39-48` — plan submission rejection |
| G-SYNTHESIS-CHILD | ✅ | Per-operation gate list (Plan) — agent prompt warns. Rejected during Plan via prompt guidance. |
| G-UNSUPPORTED-FACT | ✅ | Per-operation gate list (Combine) — agent prompt warns. |
| G-PASS-WITH-HARD-VIOLATION | ✅ | `tools.rs:260-272` — verdict decoding rejects Accept with hard violations |
| G-PROTOCOL | ✅ | `harness.rs:407-455` — wrong terminal tool, missing terminal tool, corrupt payload all rejected |
| G-CHECK-FAIL | ✅ | `engine.rs:639-682` — deterministic verification checks |

All 8 hard gates have engine-side or prompt-side enforcement. Gates 2, 3, 6, 7, 8 have deterministic code enforcement; gates 1, 4, 5 rely on agent prompt compliance.

---

## 5. Recommendations

1. **Memo key composability** (C-4): Replace `ProblemKey(String)` with a composite hash that includes at minimum intent hash + capability profile hash. This prevents stale memo hits when context changes.

2. **ArtifactContentKind expansion** (C-3): Add `Json` and `FileRef` variants to enable structured data exchange and file references in future operations.

3. **Iterative engine loop** (C-1): Consider a `ResumeFrom` mechanism or journal-based replay so mid-execution state survives process restarts. This is foundational for production reliability.

4. **Documentation alignment on ProblemNode** (C-2): Update the design doc or the code struct to reconcile — either drop the unimplemented `Spec`/`Constraint`/`AcceptanceRule` from the design or implement them.

5. **EngineReport surface in design**: The reporting/observability system (`EngineReport`, `AgentRunRecord`) is undocumented. Document it for consumers building on top of the engine.

6. **Parallel branch merging** (U-2, U-3): Document the ID remapping strategy. This is the trickiest part of the engine and has no design counterpart.

---

## 6. Files Audited

| File | Lines | Status |
|------|-------|--------|
| `src/task_run/types.rs` | 258 | Governance types, data types |
| `src/task_run/node.rs` | 119 | ProblemNode, NodeTemplate, Artifact |
| `src/task_run/engine.rs` | 1226 | Engine loop, resolve, execute, combine, verify, commit |
| `src/task_run/harness.rs` | 593 | OperationHarness, prompt construction, context packets |
| `src/task_run/tools.rs` | 305 | Terminal tool definitions, plan item validation |
| `src/task_run/resources.rs` | 73 | Workspace resource lifecycle tracking |
| `src/task_run/mod.rs` | 71 | Module exports, AgentOperationContext, NodeOperationOutput |
