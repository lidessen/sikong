# 0025 — Phase-gated development with per-phase lead acceptance (验收)

Status: Accepted
Date: 2026-06-05
Refines: 0020 (adaptive development), 0024 (grounded gates), 0023 (the lead/conductor)

## Context

ADR 0024 makes the *end* verification real. But this session's failures were
often **wrong early** and only caught late: the operator console's design phase
never actually planned the operator console, yet implementation ground on for
attempts before the end-gate noticed. The fix the owner proposes: the lead
**perceives each phase's deliverable (产物) and accepts it (验收)** — advancing or
adjusting at every boundary, not just bookending the task. Catch the wrong design
*before* paying for the implementation.

## Decision

The development workflow is explicit **phases**, each producing a deliverable; at
**every phase boundary the engine wakes the LEAD to accept (验收)** the deliverable
and decide **advance or adjust (纠偏)** — and to configure the next phase's work.

### Phases (and their deliverable)
1. **需求产品 / Requirements–Product** — clarify what's being built, scope, and
   define the **acceptance criteria** (the ADR-0024 grounded checks). *Deliverable:*
   requirement/product spec + acceptance checks. *Lead accepts:* are the
   requirements + the checks the right target?
2. **设计实现 / Design–Implementation** — design the approach and build it.
   *Deliverable:* design + implementation (changedFiles). *Lead accepts:* does the
   design actually address the requirement, and is the implementation on track? —
   **this is the early catch** (a wrong design/decomposition is rejected here, before
   verification is wasted).
3. **验证验收 / Verify–Accept** — run the **grounded checks** (ADR 0024). *Deliverable:*
   verdict + real evidence. *Lead accepts* informed by the objective checks: pass →
   advance; fail → adjust back to design–impl with the feedback.
4. **交付 / Delivery** — integrate/ship (merge, commit, deploy). *Deliverable:* the
   delivered artifact. *Lead accepts:* delivered correctly → done.

### The mechanism: per-phase lead-acceptance wakes
This is the net-new system primitive. When a phase's worker(s) finish its
deliverable, the engine **wakes the LEAD** (a distinct *acceptance* wake, not a
worker wake) carrying that deliverable + any grounded evidence. The lead's verdict
**gates the transition** — it is not an auto-advance on field-presence:
- **Accept** → advance, and the lead **configures/deploys the next phase's work**
  (部署调整下阶段工作) — e.g. the decomposition, the checks, the effort/model.
- **Adjust (纠偏)** → send the phase back (re-spec / redo) or re-shape the next
  phase, applying the strategic-lead playbook (ADR 0024 §3: diagnose · research ·
  re-decompose · switch model/technique). Abandon only when strategy is exhausted.

This generalizes development-lead (which today only acts at *delegate* + a final
*review*) into a lead that is in the loop at **every** boundary.

### Large tasks
Each phase is itself decomposable: the lead fans the phase's work into subtasks
(bounded by `maxTeamDepth`), accepts the phase's combined deliverable, then advances
and configures the next phase. Phase division + lead-confirmed advancement is how a
big effort stays on-track instead of grinding solo.

## How it composes (the full 纠偏 model)
- **0024** supplies the *objective* layer — grounded checks run in Verify–Accept and
  authored as acceptance criteria in Requirements–Product.
- **0025** (this) supplies the *judgment + steering* layer — the lead accepts each
  phase's deliverable, catches wrong-early, and configures the next phase.
- **0023** supplies the *actor* — the Conductor/lead (read + research tools, no
  write) does the acceptance and strategic adjustment.
Together: objective checks gate facts; the lead gates judgment + steers strategy;
the conductor runs it autonomously, escalating to the human only at outward gates
or when abandoning.

## Why this is the right shape
- **Cheap failure**: a wrong design dies at the Design boundary, not after N wasted
  implementation+verify cycles (the operator-console pathology).
- **Lead = strategist made real**: the per-phase acceptance wake is the system hook
  that lets the lead "perceive 产物 → advance or adjust" — exactly the role the owner
  wants, instead of fire-and-forget delegation.
- It makes "the lead drives" a *mechanism*, not a manual habit (which is all it was
  this session — me re-driving by hand).

## Open questions (settle at build time)
1. **Who runs each phase** — a worker per phase (lead delegates) vs the lead doing
   light phases (requirements) itself? (Lean: lead delegates implementation; lead
   does requirements/acceptance directly.)
2. **Acceptance-wake shape** — reuse the existing wake with a lead-acceptance
   stage/role + the deliverable in context, vs a distinct mechanism.
3. **Auto-accept fast path** — when grounded checks pass cleanly + the phase is
   low-risk, may the lead auto-accept to avoid a wake every boundary? (Budget/latency.)

## Consequences
- Development becomes lead-steered phase-by-phase, with early correction and an
  objective end-gate — the structural cure for "wrong work that ships green."
- Implementation is a sikong-self effort, layered on ADR 0024's grounded gate.
