# Governance Model Placement Analysis

**Date:** 2025-07-08  
**Node:** task-run-split-eval, Execute node 1  
**Scope:** Where should `GovernanceLayer`, `GovernanceGate`, and `hard_gates` live — `core/` or `harness/`?

---

## 1. Per-File Inventory

### 1.1 `src/core/task_run/types.rs` — Type Definitions

| Symbol                                                             | Kind                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `GovernanceLayer` enum (Arch, Plan, Execute, Verify)               | Type definition                                                         |
| `GovernanceGate` enum (8 variants)                                 | Type definition                                                         |
| `GovernanceGate::id()` → `&'static str`                            | Static string accessor                                                  |
| `GovernanceGate::description()` → `&'static str`                   | Static string accessor                                                  |
| `NodeOperation::governance_layer()` → `Option<GovernanceLayer>`    | **Mechanical mapping** — maps each operation to its governance layer    |
| `NodeOperation::active_hard_gates()` → `&'static [GovernanceGate]` | **Structural gate list** — defines which gates are active per operation |

The gate lists in `active_hard_gates()` are:

| Operation | Active gates                                                         |
| --------- | -------------------------------------------------------------------- |
| Specify   | (none)                                                               |
| Plan      | ArchEscape, ParallelDependency, SynthesisChild, ScopeWiden, Protocol |
| Execute   | ArchEscape, ScopeWiden, Protocol, CheckFail                          |
| Combine   | UnsupportedFact, Protocol, CheckFail                                 |
| Verify    | PassWithHardViolation, Protocol, CheckFail                           |
| Commit    | (none)                                                               |

Both `governance_layer()` and `active_hard_gates()` are used structurally — the harness reads them to build the agent packet, but the mapping itself belongs to the operation semantics.

### 1.2 `src/core/task_run/harness.rs` — Packet Construction

| Usage                                                          | How governance is used                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `EngineAgentGovernancePacket { layer, hard_gates }`            | Struct that carries governance into agent context                                   |
| `EngineAgentGovernanceGatePacket { id, description }`          | Struct for serializing each gate                                                    |
| `governance_packet(operation)` → `EngineAgentGovernancePacket` | Calls `operation.governance_layer()` and `active_hard_gates()` to build packet      |
| `gate_packet(gate)` → `EngineAgentGovernanceGatePacket`        | Calls `gate.id()` and `gate.description()`                                          |
| `governance_prompt(operation)` → `String`                      | Builds a _prompt text_ from gate descriptions for injection into agent instructions |

**Critical finding:** `governance_prompt()` in harness.rs is the **only place** where the gate descriptions are turned into human-readable prompt text that steers agent behavior. The packet construction (`governance_packet`) is also in harness.rs, but it supplies structured data (JSON) that the agent prompt system uses.

### 1.3 `src/core/task_run/tools.rs` — Mechanical Gate Checks

| Gate                           | Where checked                                                                      | Mechanical?                            |
| ------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------- |
| **G-PROTOCOL**                 | `submit_plan_group`: rejects empty `items` list                                    | **Yes** — parameter validation         |
| **G-PARALLEL-DEPENDENCY**      | `submit_plan_group`: rejects parallel items with `requires_prior_results=true`     | **Yes** — structural constraint        |
| **G-PASS-WITH-HARD-VIOLATION** | `SubmitVerdictArgs::into_verdict()`: Accept + non-empty `hard_violations` → Reject | **Yes** — deterministic protocol check |

These are the **only three gates** that have actual mechanical enforcement in code. The enforcement is hardcoded as conditional logic against the gate variant, not by iterating over a dynamic list.

### 1.4 `src/core/task_run/engine.rs` — Orchestration

**No direct governance references.** The engine orchestrates operations (Specify → Plan → Execute/Combine → Verify → Commit) and calls `OperationHarness::new()` which internally reads the governance packet. The engine does **not** reference `GovernanceGate` or `GovernanceLayer` directly — it uses `NodeOperation` values, and the governance mapping is encapsulated in `types.rs` / `harness.rs`.

### 1.5 `src/harness/assistant/pack.rs` — Assistant Prompt Packing

**No governance references.** The assistant pack system has its own prompt section system (`AssistantPack`, `AssistantPackSet`) that is completely separate from the engine's `OperationHarness`. There is no reference to `GovernanceLayer`, `GovernanceGate`, or `hard_gates`.

### 1.6 `src/harness/cli.rs` — CLI Layer

**No direct governance references.** The CLI imports `CapabilityProfile`, `NodeOperation`, and other types, but does **not** reference `GovernanceLayer` or `GovernanceGate` directly. The CLI passes operation context to the engine, which internally handles governance.

---

## 2. Per-Gate Classification

### Category (A): Mechanical Constraint — engine _must_ enforce at runtime

| Gate                           | Classification | Evidence                                                                                                                               |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **G-PROTOCOL**                 | **Mechanical** | Enforced in `tools.rs` `submit_plan_group()`: rejects empty plan items. Also used as the gate identifier in `InvalidPlan` return type. |
| **G-PARALLEL-DEPENDENCY**      | **Mechanical** | Enforced in `tools.rs` `submit_plan_group()`: rejects parallel items with dependencies.                                                |
| **G-PASS-WITH-HARD-VIOLATION** | **Mechanical** | Enforced in `tools.rs` `SubmitVerdictArgs::into_verdict()`: Accept + hard_violations → Reject.                                         |

### Category (B): Prompt-Level Decorator — injected into LLM prompts, no mechanical effect

| Gate                   | Classification                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G-ARCH-ESCAPE**      | **Prompt-level**               | Description: "Local work modifies Arch-owned contracts without explicit authority." — no code enforces this. It exists as prompt text in `governance_prompt()` in harness.rs.                                                                                                                                                                                                                                                                                       |
| **G-SCOPE-WIDEN**      | **Prompt-level** (with caveat) | Description: "A child workspace scope widens beyond the parent scope." — no code enforces this. There is no runtime scope-widening check. The engine does check `out_of_scope` writes during deterministic verification (`deterministic_verification_verdict`), but that check is based on `write_scope` paths, not on the G-SCOPE-WIDEN gate.                                                                                                                      |
| **G-SYNTHESIS-CHILD**  | **Prompt-level**               | Description: "A parallel plan creates a child only to synthesize sibling findings; parent Combine owns synthesis." — no code enforces this.                                                                                                                                                                                                                                                                                                                         |
| **G-UNSUPPORTED-FACT** | **Prompt-level**               | Description: "Combine introduces facts not present in accepted child artifacts or parent context." — no code enforces this.                                                                                                                                                                                                                                                                                                                                         |
| **G-CHECK-FAIL**       | **Prompt-level**               | Description: "A deterministic check required for acceptance failed." — the _phrase_ is prompt-level. However, the engine _does_ have deterministic checks in `deterministic_verification_verdict()` (empty output, write-scope violations, merge conflicts). These checks exist but are **not** labeled with G-CHECK-FAIL; they use `FailureClass::IncompleteOutput`, `UnsafeSideEffect`, `MergeConflict`. So G-CHECK-FAIL as a _named gate_ is purely prompt text. |

### Summary

| Gate                       | Classification             | Has Runtime Code?                                                    |
| -------------------------- | -------------------------- | -------------------------------------------------------------------- |
| G-PROTOCOL                 | Mechanical ✅              | Yes — empty plan item check                                          |
| G-PARALLEL-DEPENDENCY      | Mechanical ✅              | Yes — parallel dependency check                                      |
| G-PASS-WITH-HARD-VIOLATION | Mechanical ✅              | Yes — accept+hard_violations→reject                                  |
| G-ARCH-ESCAPE              | Prompt-level               | No                                                                   |
| G-SCOPE-WIDEN              | Prompt-level (effectively) | No — scope checking exists but uses write_scope paths, not this gate |
| G-SYNTHESIS-CHILD          | Prompt-level               | No                                                                   |
| G-UNSUPPORTED-FACT         | Prompt-level               | No                                                                   |
| G-CHECK-FAIL               | Prompt-level               | Partially — deterministic checks exist but under different names     |

---

## 3. Migration Recommendation

### 3.1 Where should `GovernanceLayer`/`GovernanceGate` types live after migration?

**Recommendation: Keep both in `core/` but move them to a dedicated file** (e.g., `src/core/governance.rs` or `src/core/task_run/governance.rs`).

**Rationale:**

- `GovernanceLayer` powers `NodeOperation::governance_layer()` which is a genuine structural mapping (mechanical).
- `GovernanceGate` powers `NodeOperation::active_hard_gates()` which is also structural.
- Three of the gates do have mechanical enforcement in `tools.rs`.
- The `InvalidPlan` variant in `NodeOperationOutput` uses `Option<GovernanceGate>` — this is a core type.
- However, the **descriptions** and **prompt text** (the `.description()` method and the `governance_prompt()` function) are purely prompt-level and belong in `harness/`.

**Proposed split:**

1. **In `core/`**: `GovernanceLayer` enum, `GovernanceGate` enum (without `.description()`), `NodeOperation::governance_layer()`, `NodeOperation::active_hard_gates()`.
2. **In `harness/`**: The descriptions, the `governance_prompt()` function, and the prompt-building logic.
3. **Alternative**: If the gate descriptions are never needed by `core/` mechanically, delete `.description()` entirely from core and move it to a harness-side lookup table.

### 3.2 Which gate checks stay in `core/` as concrete mechanical checks?

| Check                                                                   | Keep in core? | Where                                                                   |
| ----------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------- |
| Empty plan items → InvalidPlan (G-PROTOCOL)                             | ✅ Stay       | `tools.rs`                                                              |
| Parallel + requires_prior_results → InvalidPlan (G-PARALLEL-DEPENDENCY) | ✅ Stay       | `tools.rs`                                                              |
| Accept + hard_violations → Reject (G-PASS-WITH-HARD-VIOLATION)          | ✅ Stay       | `tools.rs`                                                              |
| Write-scope out-of-bounds check                                         | ✅ Stay       | `engine.rs` (as `FailureClass::UnsafeSideEffect`, not as G-SCOPE-WIDEN) |
| Empty output check                                                      | ✅ Stay       | `engine.rs` (as `FailureClass::IncompleteOutput`, not as G-CHECK-FAIL)  |

### 3.3 Which gates can be deleted entirely?

| Gate               | Action                        | Rationale                                                                                                                                                                                                                                     |
| ------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-ARCH-ESCAPE      | **Delete or move to harness** | No mechanical check. Only used in prompt text.                                                                                                                                                                                                |
| G-SYNTHESIS-CHILD  | **Delete or move to harness** | No mechanical check. Only used in prompt text.                                                                                                                                                                                                |
| G-UNSUPPORTED-FACT | **Delete or move to harness** | No mechanical check. Only used in prompt text.                                                                                                                                                                                                |
| G-CHECK-FAIL       | **Delete or rename**          | The name exists as prompt text, but the actual deterministic checks use different identifiers (`FailureClass`). If the intent is to have a catch-all "deterministic check failed" gate, it should be aligned with the actual failure classes. |

**Specifically:** G-ARCH-ESCAPE, G-SYNTHESIS-CHILD, and G-UNSUPPORTED-FACT have **zero mechanical enforcement**. They are pure prompt decorations that tell the LLM what not to do, but the engine never checks them. They could be:

- **(Option A)** Deleted entirely — the prompt text can be inlined into the operation prompt sections without a gate enum variant.
- **(Option B)** Moved to `harness/` as a prompt-level concept only — keep a harness-side table that maps operations to advisory text, not a core type.

### 3.4 Does `core/` still need to know about "governance" as a concept, or only the specific mechanical checks?

**`core/` needs to know about three specific mechanical checks (G-PROTOCOL, G-PARALLEL-DEPENDENCY, G-PASS-WITH-HARD-VIOLATION) plus the operation-to-layer mapping.** It does **not** need to know about "governance" as a unifying concept with descriptions and prompt text.

**What to keep in `core/`:**

- `GovernanceLayer` enum (as a simple tag for which layer an operation runs under)
- `GovernanceGate` enum (reduced to only the mechanically-enforced gates: Protocol, ParallelDependency, PassWithHardViolation, and maybe ScopeWiden if a mechanical check is added later)
- `NodeOperation::governance_layer()` and `NodeOperation::active_hard_gates()` (or rename to `mechanical_checks()`)
- The three concrete checks in `tools.rs`
- The `InvalidPlan { gate: Option<GovernanceGate> }` variant (but only using the reduced set)

**What to move to `harness/`:**

- `GovernanceGate::description()` — prompt text for steering LLM behavior
- `governance_prompt()` function in `harness.rs`
- `EngineAgentGovernancePacket` and `EngineAgentGovernanceGatePacket` — these are serialization envelopes for the agent context; they could stay in core as data carriers but the descriptions they carry are prompt-level
- The prompt-level-only gates (ArchEscape, SynthesisChild, UnsupportedFact, CheckFail, ScopeWiden if not mechanically checked)

---

## 4. Concrete Migration Outline

### Phase 1 (No-code-change analysis — this document)

### Phase 2: Core type reduction

1. Move `GovernanceGate` and `GovernanceLayer` to `src/core/governance.rs`.
2. Remove `description()` from `GovernanceGate` in core. Move the descriptions to a harness-side map.
3. Remove prompt-level-only gate variants (ArchEscape, SynthesisChild, UnsupportedFact) from the core `GovernanceGate` enum, or keep them but strip descriptions.
4. Keep `Protocol`, `ParallelDependency`, `PassWithHardViolation`, and potentially `ScopeWiden` (for future mechanical enforcement) in the core enum.
5. Ensure `NodeOperation::active_hard_gates()` returns only the mechanically-relevant subset.

### Phase 3: Harness-side prompt consolidation

1. Move `governance_prompt()` to `src/harness/governance_prompt.rs` or similar.
2. Create a harness-side mapping from `NodeOperation` → advisory text for the prompt-level gates.
3. `EngineAgentGovernancePacket` stays in the harness as a prompt-envelope type, or becomes simpler (just layer + mechanical gate IDs).

### Phase 4: Cleanup

1. Verify that `InvalidPlan { gate }` still works correctly with the reduced gate set.
2. Verify that the three mechanical checks in `tools.rs` still reference the correct gate variants.
3. Delete the `EngineAgentGovernanceGatePacket` description field or move it to harness-only.

---

## 5. Key Insight

The current code has a **layering leak**: `GovernanceGate::description()` exists on a core type but is only ever read by the harness's `gate_packet()` / `governance_prompt()` functions. This is the classic sign that descriptions belong in the presentation layer, not the domain layer.

The three mechanical checks (Protocol, ParallelDependency, PassWithHardViolation) are already correctly implemented in `core/task_run/tools.rs` — they don't need descriptions. The five prompt-level gates (ArchEscape, SynthesisChild, UnsupportedFact, CheckFail, ScopeWiden) have enumerant definitions and descriptions in core but are never checked by any mechanical logic — they are purely advisory text for the LLM.

**Recommended split ratio:** 3 gates stay in core (Protocol, ParallelDependency, PassWithHardViolation) + 1 optional (ScopeWiden if mechanical enforcement is added). 5 gates move to harness or are deleted.
