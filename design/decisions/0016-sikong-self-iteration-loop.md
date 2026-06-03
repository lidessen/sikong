# 0016 — sikong self-iteration loop (sikong improves sikong)

Status: Accepted
Date: 2026-06-03

## Context

sikong has matured entirely by dogfood: it builds real projects (chiling, shilu,
semajsx) and each run surfaces improvements. So far those improvements were
hand-coded by the human/AI lead. That doesn't scale and isn't the goal. The goal:
a **standardized, local, observable, requirement-driven loop where the current
sikong builds the next sikong**, and the lead (human + AI) only curates and
accepts — the actual coding of sikong is done by sikong's own workers.

## Decision

A versioned self-iteration loop assembled from **existing primitives** (no heavy
new system). Four parts:

### 1. Record: telemetry + backlog (the "what to improve")

- **Telemetry** is already captured: the chronicle records per-wake usage/cost,
  errors, and diagnostics. Nothing heavy to add — just digest it.
- **Backlog** lives in **shilu** — a collection `sikong-backlog`, one entry per
  improvement (kinds: `pitfall` / `open-question` / `feature` / `decision`, with
  severity tags). Sources: (a) observed run effects (errors, cost spikes,
  shallow-test escapes, friction) and (b) lead/human notes. shilu's
  **digest-source processor can turn chronicle excerpts into candidate backlog
  entries**, which the lead curates. This makes shilu the durable record of both
  *effects* and *requirements* — the meta-loop.

### 2. Trigger

A cycle starts when the backlog crosses a simple threshold (≥N items, or a
high-severity item present, or a manual kick). No scheduler — keep it simple.

### 3. The cycle: a `self-iterate` workflow, run by the CURRENT sikong on itself

Project = `agent-loop/packages/sikong`. Stages (development-lead + a release
wrapper):

1. **analyze** — read the backlog + telemetry digest; choose this version's
   scope; record decisions + rejected alternatives (dialectic, ADR 0012).
2. **design → implement → verify** — the existing development-lead team pattern;
   durable changes get ADRs.
3. **candidate** — build a candidate binary (`dist/sikong-candidate`).
4. **gate (the linchpin)** — typecheck + tests **+ a SELF-SMOKE**: the candidate
   must run a canonical real task end-to-end and pass the adversarial real-path
   verify. (See "Why the gate is everything" below.)
5. **release** — bump version, update CHANGELOG, tag.
6. **approve + promote** — the cycle **HALTS here** and records an **approval
   request** (candidate version, changelog, gate + self-smoke evidence, diff
   summary, token cost). **Promotion requires an explicit lead approval** (e.g.
   `sikong release approve <candidate>`); only then does it atomically swap
   `dist/sikong` ← candidate (keep `dist/sikong.prev` for rollback), record the
   release in shilu, and close the backlog items. Reject → discard the candidate,
   current untouched. A new cycle does **not** start on its own.

### Approval gate (mandatory — no unsupervised self-iteration)

sikong may analyze, implement, build, and gate a candidate autonomously, but it
**cannot replace "current" or chain into another cycle without an explicit
external approval.** There is no continuous, unattended self-promotion: every
version that becomes "current" was seen and approved by the lead, with the
candidate + its evidence in front of them. Reuses the existing approval-request
pattern (cf. ADR 0004, worker-cancel-requires-lead-approval). This is the safety
boundary on a self-modifying system — the autonomy is in *producing* a candidate;
the *control* stays with the human/AI lead at promotion.

**Self-modification safety**: the *current* (stable) binary runs the cycle and
builds the *candidate*; the current binary is loaded in memory and never changes
mid-cycle. A broken candidate simply **fails the gate → no promotion → current
unchanged**, with `dist/sikong.prev` for instant rollback. There is no window in
which sikong can corrupt the engine that's driving its own improvement.

### 4. Roles

- **Lead (human + AI)**: curate/prioritize the backlog, trigger cycles, review the
  candidate + its self-smoke, accept the release — and conduct the *other*
  projects (chiling/shilu/semajsx) the same way. **The lead does NOT hand-code
  sikong.**
- **sikong's workers**: do the actual implementation.

## Why the gate is everything

Self-iteration is only safe if the promotion gate is **trustworthy**. The dogfood
has repeatedly shown workers ship green-but-shallow tests (ADR 0015's prompt-level
verify was insufficient — confirmed three times). A weak gate in a *self*-loop
compounds: a bad candidate promoted to "current" degrades every later cycle. So
the **first thing to build is the trustworthy gate**: the candidate proves itself
by *running a real task and being adversarially verified* (a dedicated verify/
reviewer agent that executes the user-facing smoke), not by a passing unit suite.
This is the same "real verify-gate mechanism" already flagged as the top
sikong-quality item — self-iteration makes it mandatory.

## Net-new vs reused

- **Reused**: development-lead workflow, the chronicle, shilu (backlog +
  knowledge), `build:cli`, ADRs.
- **Net-new (small)**: the `self-iterate` workflow wrapper (analyze + candidate +
  gate + promote stages), a thin **promote script** (build → gate → swap → keep
  prev), and the **candidate self-smoke** verify-gate.

## Consequences

- sikong becomes self-improving with human/AI oversight only at curate + accept.
- The lead's role shifts to orchestration across projects.
- Quality hinges entirely on the promotion gate — build it first and keep it honest.

## Build order (when accepted)

1. The **trustworthy promotion gate** (candidate self-smoke + adversarial verify
   agent) — prerequisite for everything.
2. The **promote script** (build candidate → gate → swap current → keep prev).
3. The **`self-iterate` workflow** (analyze/candidate/gate/promote stages).
4. Wire the **shilu `sikong-backlog`** + chronicle→backlog digest.
