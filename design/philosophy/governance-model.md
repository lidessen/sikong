# Governance Model

Sikong's recursive engine needs more than the mechanical ability to split work.
It needs a small governance model that says which layer owns a decision, how far
delegation may go, and which gates must stop unauthorized drift.

This model is inspired by durable administrative systems, but it should remain
an engineering model. Do not introduce historical role names or a second engine
state machine. The governance model is an interpretation layer over the existing
task-run operations.

## Goal

Make divide-and-conquer finite, reviewable, and authority-aware:

- broad work can split by evidence surface;
- child work can act locally without constant parent supervision;
- local workers cannot introduce system-level changes by accident;
- verification can reject hard boundary violations instead of recording them as
  soft notes;
- repeated dogfood runs can improve the system without losing the mainline.

The core rule is:

```text
Arch frames authority.
Plan routes work.
Execute solves local slices and parent synthesis.
Verify guards the gate.
```

## Layers

### Arch

`Arch` owns the system frame.

It covers:

- user-level objective and non-goals;
- engine state machine semantics;
- task-run operation semantics;
- Rust/Bun agent-run protocol;
- workspace provider and resource ownership rules;
- terminal tool contracts;
- prompt method and dogfood policy;
- release and migration boundaries.

`Arch` is not a normal `NodeOperation`. It is the root/task/design authority
that constrains all node operations. A node may propose an Arch change, but it
must not smuggle one into local execution.

Examples of Arch changes:

- adding or removing a `NodeOperation`;
- changing what `Plan`, `Execute`, `Combine`, or `Verify` means;
- changing terminal tool schemas;
- changing workspace commit or merge semantics;
- introducing a new runtime profile or tool policy;
- changing dogfood acceptance rules.

The following inventory names each Arch-owned contract and its current
enforcement mechanism. Changes to these contracts must go through a design
proposal and review before implementation.

| Contract                                                                  | Enforced by                                                 | First defined             |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------- |
| `NodeOperation` enum (Specify/Plan/Execute/Combine/Verify/Commit)         | Rust type system, `types.rs`                                | recursive-agent-engine.md |
| `GovernanceLayer` / `GovernanceGate` types and gate ids                   | Rust type system, schema validation                         | governance-model.md       |
| Terminal tool schemas (`submit_*`, `finish_*`)                            | `#[toolset]` proc macro, JSON Schema generation             | recursive-agent-engine.md |
| Workspace provider semantics, resource lifecycle                          | `Workspace` trait, `WorkspaceResourceRegistry`              | workspace-management.md   |
| Agent-run protocol (Run/Shutdown messages, socket transport)              | `ProcessAgentRunScheduler` protocol encoding, `protocol.ts` | recursive-agent-engine.md |
| Runtime profiles (`general`, `code`) and tool deny lists                  | `agent-loop-worker.ts` runtime options                      | prompt-guidance.md        |
| Prompt method (attention boundary, governance projection)                 | Harness prompt sections in `harness.rs`                     | prompt-guidance.md        |
| Dogfood acceptance rules                                                  | `dogfood.md`, judge eval prompts                            | dogfood.md                |
| Engine state machine (resolve/specify/plan/execute/combine/verify/commit) | `engine.rs` control flow                                    | recursive-agent-engine.md |

Arch work should start as a design or proposal artifact, then be implemented as
a bounded patch after review.

### Plan

`Plan` owns routing, decomposition, and scope.

It maps to:

- `Specify`;
- `Plan`.

Responsibilities:

- preserve the raw user/task intent;
- decide whether the next work is atomic or needs a child group;
- choose `stage` for ordered phases and `parallel` for independent surfaces;
- assign child `read_scope`, `write_scope`, size, and acceptance hints;
- stop before execution.

Plan must not:

- inspect broad repository evidence just to do child work;
- execute child tasks;
- combine child findings before children exist;
- change engine, workspace, or tool semantics;
- turn an Arch problem into a local implementation patch.

If Plan discovers that the current task requires a governance change, it should
route to an Arch proposal, not mutate the system in place.

### Execute

`Execute` owns local work and parent synthesis.

It maps to:

- `Execute`;
- `Combine`.

`Combine` is not an independent governance layer. It is the parent node resuming
its execution responsibility after children return accepted artifacts. The same
parent that delegated work must synthesize the returned evidence.

Responsibilities:

- inspect the allowed local context;
- make local changes only inside the authorized workspace scope;
- run focused checks when available;
- return compressed evidence upward;
- synthesize accepted child artifacts into the parent-level result.

Execute must not:

- widen its workspace scope;
- change Arch rules unless the task was explicitly authorized as Arch work;
- turn local observations into new durable facts without verification;
- silently replace the parent intent;
- re-investigate every child trace during Combine.

When a local worker discovers an issue outside its authority, it should return a
boundary candidate:

```text
Boundary candidate:
- observed issue:
- why it exceeds this node:
- proposed owning layer:
- evidence:
- suggested next task:
```

### Verify

`Verify` owns gates and acceptance.

It maps to:

- `Verify`;
- live-eval judges;
- deterministic checks;
- code review.

Responsibilities:

- compare candidate output against the node contract;
- reject protocol violations;
- reject workspace scope violations;
- distinguish warnings from hard failures;
- require rework when a hard gate fails;
- preserve evidence for future runs.

Verify must not:

- implement the missing work;
- invent a new acceptance target;
- pass a result while listing a hard violation;
- accept unverified agent claims as durable facts.

## Operation Mapping

The engine keeps its current operations:

```rust
enum NodeOperation {
    Specify,
    Plan,
    Execute,
    Combine,
    Verify,
}
```

Governance is derived from operation responsibility:

```rust
enum GovernanceLayer {
    Arch,
    Plan,
    Execute,
    Verify,
}

impl NodeOperation {
    fn governance_layer(self) -> GovernanceLayer {
        match self {
            NodeOperation::Specify | NodeOperation::Plan => GovernanceLayer::Plan,
            NodeOperation::Execute | NodeOperation::Combine => GovernanceLayer::Execute,
            NodeOperation::Verify => GovernanceLayer::Verify,
        }
    }
}
```

`Arch` is supplied by task/root context and design authority, not by a normal
node operation.

This mapping avoids a second taxonomy. Existing operations stay meaningful, and
the governance layer explains what each operation may and may not own.

## State Versus Authority

Governance layers are authority boundaries, not engine states.

`Combine` remains a separate `NodeOperation` because the engine must schedule it
after accepted child artifacts exist, give it a distinct terminal tool, and
record a separate operation event. That does not make it a separate governance
authority. The parent that planned child work owns synthesis after those
children return. In governance terms, synthesis is still `Execute` because the
parent is producing its candidate artifact.

This distinction should guide implementation:

- add engine states when scheduling, terminal tools, or resource ownership
  differ;
- add governance concepts only when authority differs;
- do not add a new governance layer just because the state machine has a named
  step;
- do not collapse engine operations when their scheduling and terminal
  contracts differ.

### Commit Role

`Commit` applies a verified artifact to the memo table and marks the node
`Committed`. It is not a governance decision layer:

- the `Verify` operation already decided acceptance;
- `Commit` is engine-side durable application, not a new authority;
- `NodeOperation::governance_layer()` returns `None` for `Commit`,
  confirming it sits outside the four governance layers.

This means `Commit` must not introduce new checks, gates, or routing. If a
post-verification concern exists, it should be a `Verify` gate or an
Arch-level policy, not a `Commit` responsibility.

### Specify Routing Handoff

`Specify` belongs to the `Plan` governance layer because its job is to assess
scope and route: it submits a size class (`tiny`/`small`/`medium`/`large`/`xlarge`)
and a refined intent. The engine then decides whether the next operation is
`Execute` (for atomic sizes) or `Plan` (for large/xlarge).

This means `Specify` is governance-Plan even when the engine routes directly
to `Execute`. The routing authority stays with `Plan`; the execution authority
is only invoked when the engine issues an `Execute` operation. Readers should
not conflate "`Specify` is governance-Plan" with "`Specify` always plans."

## Authority Matrix

| Layer   | May decide                                      | Must not decide                                | Returns upward                       |
| ------- | ----------------------------------------------- | ---------------------------------------------- | ------------------------------------ |
| Arch    | system shape, contracts, durable policy         | local implementation detail without delegation | design, policy, authorized boundary  |
| Plan    | size, route, group mode, child scopes           | implementation, verification, protocol changes | planned children or atomic next work |
| Execute | local artifact, local patch, parent synthesis   | scope widening, Arch changes, final acceptance | artifact, evidence, boundary issue   |
| Verify  | accept/reject, hard gate result, rework request | implementation or new target definition        | verdict, gate evidence               |
| Commit  | durable application of accepted artifact        | new checks, gates, or routing                  | committed node (engine-side only)    |

`Commit` is included in the matrix for completeness but is engine-side, not a
governance layer. See [Commit Role](#commit-role) above.

## Finite Decomposition

Recursive subdivision is allowed, but unbounded decomposition is not the
operating model.

Most work should fit within this depth:

```text
root Arch/task frame
  -> Plan
  -> child Execute
  -> optional child Plan for one still-large surface
  -> leaf Execute
  -> parent Execute/Combine
  -> Verify
```

Guidelines:

- prefer one planning level when the parent already names clear evidence
  surfaces;
- allow a second planning level when a child surface is still too large or has
  ordered phases;
- treat a third planning level as a design smell unless the task is explicitly
  a broad program of work;
- never split only because a model can split;
- stop splitting when the child has one local owner, one evidence boundary, and
  one acceptance loop.

The point of hierarchy is not infinite recursion. It is reducing top-level
attention cost while keeping each delegated unit governable.

## Gate Rules

Some findings are warnings. Others are hard gates.

Hard gates include:

- `G-ARCH-ESCAPE`: `Execute` modifies or proposes to modify Arch-owned
  contracts without explicit authority;
- `G-SCOPE-WIDEN`: a child workspace scope widens beyond the parent scope
  (mechanically enforced — engine rejects child scopes outside parent scope
  with a `G-SCOPE-WIDEN` error before the child run starts);
- `G-PARALLEL-DEPENDENCY`: `Plan` creates parallel children with sibling
  dependencies;
- `G-SYNTHESIS-CHILD`: `Plan` creates a child that is only a final synthesis
  item for a parallel group;
- `G-UNSUPPORTED-FACT`: `Combine` introduces new facts that do not come from
  accepted child artifacts or parent context;
- `G-PASS-WITH-HARD-VIOLATION`: `Verify` lists a hard expectation violation
  while returning pass;
- `G-PROTOCOL`: live eval reports a protocol violation, missing terminal tool,
  or malformed terminal payload;
- `G-CHECK-FAIL`: deterministic checks that are part of acceptance fail.

Warnings include:

- an imprecise but still valid child title;
- extra non-load-bearing explanation;
- a broader-than-ideal but still parent-contained read scope when the scenario
  did not require narrow scope as hard acceptance.

When a hard gate fires, the result should be rejected or routed to the owning
layer. It should not be accepted with a note.

Gate ids are intentionally stable text labels first. They do not require new
node state. Later, eval judges, verifier payloads, or development-log entries
can record these ids so repeated failures become searchable patterns.

## Dogfood Implications

Dogfood should use this model as its operating constitution:

1. run a read-only proposal when the next change may affect Arch or Plan;
2. implement one bounded slice after the owning layer is clear;
3. use route-only evals to inspect `Specify` and `Plan` cheaply;
4. run full evals only after routing quality is acceptable;
5. record every hard-gate failure as method feedback.

The dogfood loop should not rely on one huge worker to inspect all details. The
main loop preserves the Arch frame, Plan assigns evidence surfaces, Execute
returns compressed child evidence, and Verify rejects drift.

## Implementation Path

This design should be adopted incrementally:

1. Document the governance model and link it from the design entrypoint.
2. Add typed `GovernanceLayer` and `GovernanceGate` definitions in Rust.
3. Inject governance layer and active hard-gate metadata into operation context
   and operation prompts.
4. Tighten live-eval judges so hard gates cannot pass.
5. Add deterministic checks for known hard gates such as scope widening and
   parallel dependency violations.
6. Promote repeated semantic gate failures into schemas, deterministic checks,
   or structured judge expectations.

Do not add persistent node fields or new node states just to represent
governance. Governance is derived from operation responsibility. Structure
should follow only where it gives the engine an enforceable lever.

The first implementation layer is deliberately small:

- `NodeOperation::governance_layer()` derives `Plan`, `Execute`, or `Verify`
  authority for agent-run operations;
- `NodeOperation::active_hard_gates()` lists the hard gates relevant to the
  current operation;
- operation context includes `governance.layer` and `governance.hard_gates`;
- operation prompts include a `Governance Boundary` section built from the same
  typed definitions;
- invalid parallel plans that use sibling dependencies return
  `G-PARALLEL-DEPENDENCY` as structured output.

Further gates should be implemented only when they can be checked reliably.
For example, parent-contained scope checks can become deterministic; unsupported
facts in `Combine` may require judge support unless the artifact format becomes
structured enough for the engine to compare evidence provenance.

## Review Checklist

Use this checklist when reviewing future governance changes:

- Does the change reuse existing operations instead of creating a parallel
  workflow?
- Is `Combine` treated as parent execution/synthesis, not as a separate
  governance role?
- Can a local worker tell when it must stop and return a boundary candidate?
- Are hard gates represented as rejection conditions, not advice?
- Does the change reduce top-level attention cost without hiding local risk?
- Is the decomposition depth justified by evidence boundaries or ordered phases?
- Does the implementation preserve Rust as deterministic state owner and Bun as
  bounded agent-loop executor?
