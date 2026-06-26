# Governance Harness Migration Analysis

**Date:** 2026-06-21  
**Node:** task-run-split-eval, Execute node 1  
**Premise:** Layering is harness-driven and prompt-driven. Governance layer and gate definitions move from `core/` to `harness/`.

---

## 1. GovernanceLayer Move Impact

### 1.1 Every Code Location Referencing GovernanceLayer

| #   | File                           | Line(s) | Usage                                                                                                                                    | Classification                                           |
| --- | ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | `src/core/task_run/types.rs`   | 75–84   | `enum GovernanceLayer { Arch, Plan, Execute, Verify }` — type definition                                                                 | **Definition** (moves)                                   |
| 2   | `src/core/task_run/types.rs`   | 82–84   | `impl fmt::Display for GovernanceLayer`                                                                                                  | **Formatting** (moves with type)                         |
| 3   | `src/core/task_run/types.rs`   | 21–27   | `NodeOperation::governance_layer() -> Option<GovernanceLayer>` — maps Spec/Plan→Plan, Exec/Combine→Execute, Verify→Verify, Commit→None   | **Structural mapping** (moves because return type moves) |
| 4   | `src/core/task_run/types.rs`   | 420–424 | Unit test: `governance_layer_is_some_for_all_agent_operations`, `commit_has_no_governance_layer`, `display_implementations_are_readable` | **Tests** (move with type)                               |
| 5   | `src/core/task_run/harness.rs` | 13      | `use ... GovernanceLayer` — import                                                                                                       | **Import** (updates)                                     |
| 6   | `src/core/task_run/harness.rs` | 62      | `EngineAgentGovernancePacket { layer: GovernanceLayer, ... }` — packet struct field                                                      | **Serialization envelope** (moves or updates)            |
| 7   | `src/core/task_run/harness.rs` | 534     | `operation.governance_layer().unwrap_or(GovernanceLayer::Arch)` — packet construction                                                    | **Read site** (updates import path)                      |
| 8   | `src/core/task_run/mod.rs`     | 22      | `pub use ... GovernanceLayer` — re-export                                                                                                | **Re-export** (updates source path)                      |
| 9   | `src/lib.rs`                   | 25      | `pub use ... GovernanceLayer` — public API re-export                                                                                     | **Re-export** (updates source path)                      |

### 1.2 Dependency Chain: Who Uses GovernanceLayer Implicitly or Explicitly?

```
GovernanceLayer (type def, types.rs)
├── NodeOperation::governance_layer() → Option<GovernanceLayer> (types.rs:21)
│   ├── governance_packet() in harness.rs:530  [calls .governance_layer(), puts result in packet]
│   │   └── OperationHarness::build_agent_run() → AgentRunRequest [packet → prompt context]
│   │   └── operation_context_packet() → EngineAgentContextPacket [packet → JSON for agent]
│   └── governance_prompt() in harness.rs:540  [reads layer for authority text]
│       └── operation_prompt_sections() [injects governance text into agent prompt]
├── EngineAgentGovernancePacket { layer } in harness.rs:62
│   └── EngineAgentContextPacket { governance } in harness.rs:36
│       └── Serialized as JSON → agent receives it as Operation Context
├── impl Display for GovernanceLayer (types.rs:82)
│   └── governance_prompt() uses format!("{:?}", layer) [Display/Debug]
└── Tests (types.rs:420-424)
```

**Key finding:** GovernanceLayer is **never referenced by the engine orchestrator** (`engine.rs`), **never referenced by tool definitions** (`tools.rs`), **never referenced by the CLI** (`harness/cli.rs`), and **never referenced by assistant packing** (`harness/assistant/pack.rs`). The entire downstream of GovernanceLayer feeds **only** the agent prompt construction, which lives in `harness.rs`. The type never flows into any mechanical decision.

### 1.3 What Would Break If GovernanceLayer Moved?

If `GovernanceLayer` enum + `governance_layer()` method move from `core/task_run/types.rs` to a new harness module (e.g., `harness/governance.rs`):

1. **`NodeOperation` stays in core** but its `governance_layer()` method (which returns `Option<GovernanceLayer>`) must either:
   - **(Option A)** Be removed from `NodeOperation` and moved to a free function `fn governance_layer_for(op: NodeOperation) -> Option<GovernanceLayer>` in the harness module. This is cleanest — `NodeOperation` no longer depends on a harness type.
   - **(Option B)** Return `Option<&'static str>` from core (stringly-typed layer name) and let harness map strings to its enum. More decoupled but loses type safety.
   - **(Option C)** Stay in core but depend on the harness type — this inverts the dependency direction and is architecturally wrong.

2. **`active_hard_gates()`** on `NodeOperation` has the same problem: it currently returns `&'static [GovernanceGate]`. If `GovernanceGate` moves to harness, this method must also change.

3. **`EngineAgentGovernancePacket`** in `harness.rs` currently references `GovernanceLayer` — this is fine because both would be in harness.

4. **`EngineAgentContextPacket`** serializes the governance packet into JSON for the agent prompt. This all happens in `harness.rs`, so it's unaffected by the move.

### 1.4 Assessment

| Dimension             | Impact                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code changes required | `types.rs`, `mod.rs`, `lib.rs`, `harness.rs` — approximately 4 files with 20–30 changed lines                                                                                                                       |
| Semantic change       | `NodeOperation` loses its governance-awareness; governance becomes an external mapping                                                                                                                              |
| Risk                  | Low — GovernanceLayer has no mechanical consumers in core. The mapping from operation to layer is trivial (Spec/Plan→Plan, Exec/Combine→Execute, Verify→Verify) and can be a harness-side function or lookup table. |

---

## 2. GovernanceGate Move Impact

### 2.1 Three Mechanical Validations in `submit_plan_group`

Currently in `tools.rs`, the `submit_plan_group` method performs three mechanical checks that return `InvalidPlan`:

#### Check 1: Empty items (G-PROTOCOL)

```rust
// tools.rs:33-36
if args.items.is_empty() {
    return NodeOperationOutput::InvalidPlan {
        gate: Some(GovernanceGate::Protocol),
        reason: "plan group must contain at least one item".to_string(),
    };
}
```

#### Check 2: Parallel + requires_prior_results (G-PARALLEL-DEPENDENCY)

```rust
// tools.rs:40-46
if args.mode == PlanGroupMode::Parallel
    && args.items.iter().any(|item| item.requires_prior_results)
{
    return NodeOperationOutput::InvalidPlan {
        gate: Some(GovernanceGate::ParallelDependency),
        reason:
            "parallel plan items must be mutually independent; dependent synthesis belongs in the parent Combine pass"
                .to_string(),
    };
}
```

#### Check 3: Accept + hard_violations → Reject (G-PASS-WITH-HARD-VIOLATION)

Located in `SubmitVerdictArgs::into_verdict()` (tools.rs lines in the impl block):

```rust
// tools.rs: ~229-239
if self.verdict == VerdictDecision::Accept
    && self.hard_violations.as_ref().is_some_and(|v| !v.is_empty())
{
    return VerificationVerdict::Reject {
        failure_class: FailureClass::BadOutput,
        reason: format!(
            "accept verdict with hard violations violates G-PASS-WITH-HARD-VIOLATION: {}",
            self.hard_violations.unwrap_or_default().join(", ")
        ),
    };
}
```

Note: Check 3 is **not in `submit_plan_group`** — it's in `SubmitVerdictArgs::into_verdict()` which feeds into `submit_verdict`. The analysis in the node intent mentions "accept+hard_violations" as the third check, so I include it here alongside the two plan-group checks.

### 2.2 How They'd Return a Gate-Free InvalidPlan

Under the harness-driven premise, `GovernanceGate` moves out of core. `InvalidPlan` would lose its `gate: Option<GovernanceGate>` field. The goal is to preserve information without losing diagnostic value.

**Current variant:**

```rust
InvalidPlan {
    gate: Option<GovernanceGate>,
    reason: String,
}
```

**Proposed simplified variant:**

```rust
InvalidPlan {
    reason: String,  // "protocol: plan group must contain at least one item"
}
```

Each check would prefix the `reason` with a machine-parseable tag that preserves the gate identity without using the enum:

| Check                    | Current gate                 | New reason format                                                                                                                 |
| ------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Empty items              | `G-PROTOCOL`                 | `"protocol: plan group must contain at least one item"`                                                                           |
| Parallel + dependency    | `G-PARALLEL-DEPENDENCY`      | `"parallel_dependency: parallel plan items must be mutually independent; dependent synthesis belongs in the parent Combine pass"` |
| Accept + hard_violations | `G-PASS-WITH-HARD-VIOLATION` | `"pass_with_hard_violation: accept verdict with hard violations: ..."`                                                            |

**Alternative (struct-level tag without enum):**

```rust
InvalidPlan {
    code: String,   // "protocol", "parallel_dependency", "pass_with_hard_violation", or empty
    reason: String,
}
```

This preserves the machine-readability of the gate ID without referencing `GovernanceGate` as a type. Downstream consumers (engine.rs, cli.rs) that currently match on `gate: Some(GovernanceGate::Protocol)` would instead match on `code == "protocol"`.

### 2.3 Check 3 Gate Label in the Verdict Path

Check 3 is special: it doesn't return `InvalidPlan` at all. It returns `VerificationVerdict::Reject` with a reason string that mentions "G-PASS-WITH-HARD-VIOLATION". Under a gate-free approach, the reason string would simply drop the gate name:

```rust
// Before:
"accept verdict with hard violations violates G-PASS-WITH-HARD-VIOLATION: ..."
// After:
"accept verdict with hard violations: ..."
```

The action (rejecting an Accept+hard*violations verdict) is the same. The diagnostic value is preserved because the reason still explains \_why* it was rejected. Downstream judge logic (eval scripts) that pattern-matches on gate names would need to switch to matching on the reason text or the verdict structure (`Accept` verdict with non-empty `hard_violations` always produces `Reject`).

### 2.4 Downstream Consumers of InvalidPlan

Two files consume `InvalidPlan`:

**`engine.rs:328`** — Builds a record message:

```rust
NodeOperationOutput::InvalidPlan { gate, reason } => {
    match gate {
        Some(gate) => format!("invalid plan {}: {reason}", gate.id()),
        None => format!("invalid plan: {reason}"),
    }
}
```

→ Simplified: `format!("invalid plan: {reason}")` — the reason already contains the tag prefix.

**`cli.rs:2433`** — Builds eval-readable output:

```rust
NodeOperationOutput::InvalidPlan { gate, reason } => match gate {
    Some(gate) => format!("invalid plan gate={} reason={}", gate.id(), ...),
    None => format!("invalid plan reason={}", ...),
}
```

→ Simplified: `format!("invalid plan reason={}", ...)` — again, the reason prefix carries the information.

### 2.5 Assessment

| Dimension         | Impact                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Information loss  | **None** — the reason string can carry a machine-parseable prefix identifying the gate                      |
| Code changes      | 3 check sites in tools.rs, 2 match sites (engine.rs, cli.rs), plus any eval scripts that match on gate enum |
| Eval judge impact | Neutral (see §4.1) — string matching on `code` is as reliable as enum matching                              |

---

## 3. Validation Logic Placement

### 3.1 After Removing Gate Labels from Core

The mechanical validation logic stays exactly where it is today — in `tools.rs` as pure parameter validation. The only change is what it returns.

**Before (current):**

```rust
// tools.rs (core/task_run/tools.rs)
use super::GovernanceGate;

fn submit_plan_group(args) -> NodeOperationOutput {
    if args.items.is_empty() {
        return InvalidPlan {
            gate: Some(GovernanceGate::Protocol),  // ← core type reference
            reason: "...",
        };
    }
    if args.mode == Parallel && items.any(requires_prior_results) {
        return InvalidPlan {
            gate: Some(GovernanceGate::ParallelDependency),  // ← core type reference
            reason: "...",
        };
    }
    // ... Planned { ... }
}
```

**After (simplified):**

```rust
// tools.rs (core/task_run/tools.rs) — no GovernanceGate import
fn submit_plan_group(args) -> NodeOperationOutput {
    if args.items.is_empty() {
        return InvalidPlan {
            reason: "protocol: plan group must contain at least one item".to_string(),
        };
    }
    if args.mode == Parallel && items.any(requires_prior_results) {
        return InvalidPlan {
            reason: "parallel_dependency: parallel plan items must be mutually independent; ...".to_string(),
        };
    }
    // ... Planned { ... }
}
```

### 3.2 Simplified NodeOperationOutput Shape

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeOperationOutput {
    Specified {
        scope_assessment: ScopeAssessment,
    },
    Planned {
        group: PlanGroup,
    },
    InvalidPlan {
        /// Machine-parseable tag identifying the violation class.
        /// Examples: "protocol", "parallel_dependency", "pass_with_hard_violation", or empty.
        /// No longer references GovernanceGate enum.
        code: String,
        /// Human-readable explanation.
        reason: String,
    },
    Executed {
        output: String,
    },
    Combined {
        output: String,
    },
    Verified {
        verdict: VerificationVerdict,
    },
}
```

Alternatively, if `code` is over-engineered for three cases:

```rust
InvalidPlan {
    /// Human-readable explanation. If the reason starts with a known prefix
    /// like "protocol:" or "parallel_dependency:", it can be parsed downstream.
    reason: String,
}
```

The `code` variant is preferred for eval/CLI consumers that need deterministic classification without string parsing.

### 3.3 What Stays in Core vs. Moves to Harness

| Component                                                                          | Stays in core                                                      | Moves to harness                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `NodeOperationOutput::InvalidPlan` variant                                         | ✅ (with `code: String` instead of `gate: Option<GovernanceGate>`) |                                                              |
| Three mechanical checks (empty items, parallel+dependency, accept+hard_violations) | ✅ in `tools.rs`                                                   |                                                              |
| `GovernanceLayer` enum definition                                                  |                                                                    | ✅ to `harness/governance.rs`                                |
| `GovernanceGate` enum definition                                                   |                                                                    | ✅ to `harness/governance.rs`                                |
| `GovernanceGate::description()`                                                    |                                                                    | ✅ (already prompt-only)                                     |
| `NodeOperation::governance_layer()` method                                         |                                                                    | ✅ (moves to harness function `fn governance_layer_for(op)`) |
| `NodeOperation::active_hard_gates()` method                                        |                                                                    | ✅ (moves to harness as `fn active_hard_gates_for(op)`)      |
| `governance_prompt()` function                                                     |                                                                    | ✅ (already in harness.rs)                                   |
| `governance_packet()` function                                                     |                                                                    | ✅ (already in harness.rs)                                   |
| `EngineAgentGovernancePacket` struct                                               |                                                                    | ✅ (already in harness.rs)                                   |
| Tests for governance types                                                         |                                                                    | ✅ (move with types)                                         |

---

## 4. Migration Risk Assessment

### 4.1 Eval Judge Logic

**Assessment: Neutral → Positive**

| Risk               | Analysis                                                                                                                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current state      | Eval judges currently inspect `output.gate` as an enum variant (`Some(GovernanceGate::Protocol)`). This is type-safe but fragile: any change to the enum (renaming, adding/removing variants) breaks all eval scripts that reference specific variants.                                                                 |
| After migration    | Judges would inspect `output.code` as a string (`"protocol"`, `"parallel_dependency"`, `""`). String comparison is marginally less type-safe at compile time but more resilient to harness-side changes. If `code` is made a `&'static str` or a small enum in a shared `common/` module, type safety can be preserved. |
| Eval scripts in CI | If eval scripts are written in Rust (compiled against the crate), the enum removal is a compile break — they must update to string matching. If eval scripts are in Python/shell (parsing JSON output), string matching is actually easier and more stable.                                                             |
| Verdict            | **Neutral** — functional equivalent for machine consumers. **Positive** if eval scripts were already parsing JSON rather than compiled Rust, because string codes survive type changes without recompilation.                                                                                                           |

### 4.2 Dev-Log Readability

**Assessment: Positive**

| Aspect                       | Current                                                                                 | After migration                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| InvalidPlan messages         | `"invalid plan G-PROTOCOL: plan group must contain at least one item"`                  | `"invalid plan protocol: plan group must contain at least one item"`                                           |
| Gate descriptions in prompts | `"G-ARCH-ESCAPE: Local work modifies Arch-owned contracts without explicit authority."` | Same text, generated from harness-side lookup                                                                  |
| Traceability                 | Gate IDs are scattered: core enum + description on enum + prompt text in harness        | Gate IDs + descriptions all in one harness module; core does not need to know about governance concepts at all |

The improvement is that a developer reading a dev-log entry can see the string tag in the `InvalidPlan` reason and cross-reference it with the harness-side governance module, rather than jumping between core type definitions, harness prompt text, and tool implementations.

### 4.3 Future Extensibility

**Assessment: Positive**

| Scenario                                                       | Current friction                                                                                                                                                                 | After migration                                                                                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adding a new prompt-level gate (e.g., "G-ORDERING-CONSTRAINT") | Must: (1) add variant to core `GovernanceGate` enum, (2) add `id()` arm, (3) add `description()` arm, (4) add to `active_hard_gates()` if active, (5) add prompt text in harness | Must: (1) add entry to harness-side gate table with id+description, (2) add to harness-side active-gates list for relevant operations                          |
| Adding a new mechanical check                                  | Must: (1) add variant if new gate type, (2) implement check in tools.rs                                                                                                          | Must: (1) implement check in tools.rs using a `code: String` tag, (2) possibly add a harness-side prompt entry if the gate should be communicated to the agent |
| Changing a gate description                                    | Must: modify `GovernanceGate::description()` in core types.rs                                                                                                                    | Must: modify harness-side lookup table                                                                                                                         |
| Removing a prompt-level gate                                   | Must: remove enum variant from core, potentially breaking consumers that match exhaustively                                                                                      | Must: remove entry from harness lookup table — no core type change, no consumer breakage                                                                       |
| Adding a new operation (e.g., `Finalize`)                      | Must: add `governance_layer()` arm and `active_hard_gates()` arm                                                                                                                 | Must: add entry in harness-side mapping functions                                                                                                              |

The harness-driven model is strictly more extensible because it decouples the governance concept from the core type system. Adding, removing, or changing gate metadata requires changing only the harness module where governance lives, not the core types that engine logic depends on.

### 4.4 Summary Table

| Risk Dimension       | Rating       | Rationale                                                                                                          |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| Eval judge logic     | **Neutral**  | String-based codes are functionally equivalent; Rust-compiled judges need update, JSON-based judges are unaffected |
| Dev-log readability  | **Positive** | All governance metadata consolidated in one harness module; core traces become governance-free                     |
| Future extensibility | **Positive** | Adding/removing gates requires only harness changes; core types are insulated from governance evolution            |

---

## 5. Conclusion

Moving `GovernanceLayer` and `GovernanceGate` from `core/` to `harness/` is feasible with low risk under the premise that layering is harness-driven and prompt-driven. The key architectural insight is that:

1. **GovernanceLayer** has zero mechanical consumers in core — it feeds only prompt construction in `harness.rs`.
2. **GovernanceGate** has three mechanical consumers in core (the three checks in `tools.rs`) but those checks use gate labels only as return-value tags. The same checks can return a `code: String` tag without referencing the `GovernanceGate` enum.
3. **`NodeOperation::governance_layer()` and `active_hard_gates()`** are the only methods tying `NodeOperation` to governance types. Moving them to harness-side free functions decouples the operation semantics from the governance model entirely.
4. The three mechanical checks (empty items, parallel+dependency, accept+hard_violations) stay in `tools.rs` as pure parameter validation — only their return type signature changes.

**Migration cost:** ~4 files touched, ~20–30 lines changed, no behavioral change. The `InvalidPlan` variant loses the `gate` field and gains a `code: String` field (or the reason string carries a tag prefix). Eval judges that parse JSON output see an equivalent string field instead of an enum.

**Recommendation:** Proceed with migration. The decoupling improves extensibility, consolidates governance metadata in the harness layer, and removes an implicit cross-layer dependency where core types carried prompt-level description text.
