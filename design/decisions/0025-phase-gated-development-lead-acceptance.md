# 0025 - Phase-gated development with per-phase lead acceptance

Status: Accepted (revised 2026-06-06)
Date: 2026-06-05
Refines: 0020 (adaptive development), 0024 (worker evidence + lead decision), 0023 (the lead/conductor)

## Context

ADR 0024 makes final completion depend on worker-submitted evidence and a lead
accept/reject decision. Dogfood also showed that many failures are wrong early:
the design or decomposition can drift before implementation starts, and catching
that only at the final review wastes work.

The useful part of the phase-gated idea is not a new verifier mechanism. It is the
lead seeing each phase deliverable early enough to redirect the effort.

## Decision

Development can be organized as explicit phases. Each phase produces a concrete
deliverable, the worker submits evidence for that deliverable, and the lead records
the same `accepted` / `rejected` decision used by ADR 0024.

The engine does not need a separate "acceptance wake" primitive. A phase boundary
is just a normal workflow gate whose next stage requires lead acceptance.

### Phases

1. **Requirements / Product** - clarify target, scope, and acceptance criteria.
   Deliverable: requirement/product spec plus the criteria the later evidence must
   address. Lead accepts whether the target is right.
2. **Design / Implementation** - design the approach and build the change.
   Deliverable: design, implementation summary, changed files, and any intermediate
   evidence. Lead accepts whether the approach is on track.
3. **Verify / Accept** - run the project's checks and real-user smokes where
   relevant. Deliverable: structured evidence, including commands, exit codes,
   outputs, changed files, and artifacts. Lead accepts or rejects the result.
4. **Delivery** - integrate or ship after acceptance. Deliverable: committed,
   merged, or published artifact evidence. Outward-facing delivery still needs the
   explicit approval boundary from the release workflow.

### Mechanism

- Worker submits the phase deliverable as fields and/or `submit_evidence`.
- Worker requests transition when ready for review.
- Lead reviews the deliverable and records `acceptance_decision`.
- `acceptancePassed` admits the next phase only when the latest decision in the
  current stage is `accepted`.
- On rejection, the task stays open. The lead may adjust instructions, decompose
  differently, increase effort, create follow-up subtasks, or cancel.

There is no auto-accept fast path. If a phase is low-risk, the lead acceptance can
be quick, but it remains explicit.

## Relationship to other ADRs

- **0024** supplies the shared acceptance primitive: evidence plus lead decision.
- **0020** supplies the adaptive development workflow where solo/team execution is
  chosen at runtime.
- **0023** can later automate the lead role, but only inside the same accept/reject
  boundary.

## Consequences

- Wrong design or decomposition can be rejected before more implementation cost is
  spent.
- The mechanism stays small: no verifier worker, no separate acceptance wake, no
  automatic correction loop.
- Phase-gated development is a workflow shape, not a new engine subsystem.
