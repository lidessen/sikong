# 0024 — Grounded acceptance gates: completion is verified, not self-reported

Status: Accepted
Date: 2026-06-05

## Context — what the dogfood proved

A single hard task (the chiling operator console) failed ~6 ways across this
session, and so did smaller ones in subtler forms. The symptoms all trace to **one
mechanism flaw**, not to model weakness:

- A worker did ~10 edits, called `request_transition`, and the engine advanced
  `build → verify` — even though the requirement was nowhere near met (the
  build→verify guard only checks `changedFiles exists + transition.requested`).
- Workers repeatedly produced the easy part and **dropped the hard part**; nothing
  in the mechanism *failed* them for an unmet requirement.
- A task reported a `build.sh` "✅ analyzed" that **did not exist on disk**; another
  marked the work "verified" by **static review because the worker sandbox couldn't
  run the build** — and the build was in fact broken.
- The flaky-suite, the shallow tests (ADR 0015), the "green-but-wrong" outputs:
  same root.

**Root cause: in sikong, completion is *self-reported*.** A stage advances on
field-*presence* plus a transition the agent itself requests; `done` trusts the
agent's prose `verification` field. The agent can advance/complete without the
requirement being satisfied, without the build/tests actually passing, and even
while *fabricating* the evidence — especially when its sandbox can't run the
toolchain. ADR 0016 called a trustworthy gate "the linchpin"; this ADR makes it
real, because today it is prose.

## Decision

Make completion **grounded in machine-checked acceptance criteria executed by the
engine**, not by the worker's narration.

### 1. Acceptance criteria as data
A task/stage carries explicit, machine-checkable **acceptance checks** — authored
with the task (by the lead/brief), e.g.:
- a command that must exit 0 (`swift build`, `go test ./...`, the real-user smoke);
- a file that must exist; a `grep` that must match (or must NOT match — e.g. no
  `TODO`, no "run \`...\`" command-hints);
- a project gate (typecheck+test).
These are structured (`{ kind, cmd|path|pattern, expect }`), not prose.

### 2. A grounded VERIFIER WORKER runs the gate (owner-decided)
A dedicated **verifier worker** (separate from the implementing worker) sits at the
stage/`done` boundary. Crucially it is **grounded**: it must *execute* the
acceptance checks (run `swift build`, `go test`, the greps, the real-user smoke)
and base its verdict on the **real exit codes + output**, NOT on a static reading
of the diff. (A verifier that only reads code is the same fabrication trap we are
fixing — an agent rubber-stamping. So the verifier has toolchain access / runs
where the build works, and its verdict cites captured command evidence.) The
implementing worker's `request_transition` is a *request*; the gate is granted only
by the verifier's grounded PASS. The verifier outputs: **verdict (pass/fail) +
actionable suggestions** (what's missing and how to fix it) — not just a boolean.

### 3. Correction loop (纠偏) with a STRATEGIC LEAD, not a blind retry
On a FAIL, the verifier's suggestions + failing checks go to a **lead/strategic
layer** (the conductor/lead, ADR 0023) — not straight back into the same build.
Critically, the lead does not just re-run the same approach; it **adjusts strategy**
(owner-decided), exactly as a human lead would when stuck:
- **diagnose** *why* it's failing (root cause, from the grounded evidence);
- **research (查资料)** — look up the unfamiliar API/docs/examples the worker keeps
  routing around (the lead has read + research tools, ADR 0023);
- **adapt the approach** — re-decompose into smaller/precise pieces, hand a complete
  code skeleton, switch model/effort (flash→pro), change technique, or change which
  worker;
- only then **re-delegate** with the new strategy.
This is precisely what unstuck the operator console this session (solo → decompose →
precise single-file pieces → research the chiling CLI → escalate the niche bits) —
made mechanical instead of manual. A blind retry of a failing strategy just burns
budget; strategic adjustment is what converges. After the corrected attempt, the
work returns to the grounded verifier (§2). Bounds (owner-decided):
- **Consecutive-fail circuit-breaker**: after N consecutive failed verifications,
  stop — do not loop forever.
- **Fixable-vs-abandon judgment**: the verifier also assesses whether the work is
  *recoverable* or hopeless ("放弃治疗") and can recommend **bailing early** (before
  N) — escalating to the lead/human rather than burning budget on a lost cause.
  (This is exactly what was missing this session: 6 attempts with no mechanism to
  say "this isn't converging — stop and escalate.")
- Each iteration's verdict + evidence + suggestions land on the chronicle, so the
  loop is observable and the abandon decision is auditable.

### 4. Verification must be able to RUN
A gate that can't execute the build/tests is theatre. The verifier environment
(worker or the engine-side gate) must have the project toolchain + permissions, or
the gate must run outside the worker. Fabricated/static-only verification is the
direct result of a verifier that can't execute — fix the *capability*, not just the
prompt.

## Why this is the high-leverage fix
- It is the **structural version of ADR 0015's intent** (which tried to induce real
  tests via the *prompt* — and was bypassed three times). Prompts ask; gates enforce.
- It makes ADR 0016's self-iteration **safe** — the promotion gate becomes real.
- It directly stops the whole observed failure class: premature transitions, dropped
  hard parts, fabricated/green-but-wrong completion.
- It is **substrate-agnostic**: the acceptance checks (build passes, file exists,
  pattern present) catch "operator console not actually implemented" the same way
  they catch a failing test.

## Relationship to other ADRs
- Strengthens **0015** (verify stage) from prompt-induced to mechanism-enforced.
- Makes **0016**'s "trustworthy gate" concrete (it is currently the open risk).
- Composes with decomposition (a too-big task whose checks never pass signals it
  must be split) and with stage-aware wake timeouts (separate, related fix).

## Resolved (owner-decided 2026-06-05)
- **Gate runtime** → a **grounded verifier worker** (runs the real checks, with
  toolchain access; verdict cites executed evidence — never static-only).
- **On fail** → verifier suggestions drive a **correction (纠偏) loop**; a
  **consecutive-fail circuit-breaker** stops it; the verifier judges
  **fixable-vs-abandon** and can bail early to the lead/human.

## Still open (settle at build time)
1. **Who authors the checks** — the lead/brief (explicit) and/or a derive step that
   proposes them from the requirement? (Lean: brief-authored + workflow defaults
   like "project typecheck+test must pass".)
2. **Check vocabulary** — start minimal (exit-0 command, file-exists, grep
   match/absent, project-gate) and grow.
3. **N** for the consecutive-fail breaker + per-task token budget.
4. **Verifier toolchain access** — how the verifier worker gets a real build
   environment (the implementing worker's sandbox demonstrably can't build).

## Consequences
- Completion means *the criteria actually pass*, with real captured evidence — not
  the agent's word. This is the change that makes sikong trustworthy enough to run
  hard tasks (and to run unattended via the Conductor, ADR 0023).
- Implementation is itself a sikong-self task (sikong fixes sikong) — the lead
  diagnoses (this ADR); sikong's workers build it, gated by… the very mechanism it
  adds, once bootstrapped.
