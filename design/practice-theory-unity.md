# Practice-Theory Unity: Philosophical Foundations for the Dogfood Loop

**Status:** Current (✓)
**Governs:** Dogfood loop, autonomous-iteration scenario, development method
**Last Reviewed:** 2026-07-17
**Based on:** "On Practice" (实践论, 1937), "Oppose Book Worship" (反对本本主义, 1930),
            Sikong design philosophy, governance model, and development theory

---

## Purpose

This document maps the philosophical principles from Mao Zedong's "On Practice"
and "Oppose Book Worship" onto Sikong's dogfood loop and recursive engine
architecture. The purpose is not decorative — each principle has a concrete
behavioral implication for how the autonomous-iteration scenario operates, how
evidence is treated, and how the system improves itself.

The central thesis is:

> **Practice is the source, driving force, purpose, and criterion of truth.**
> Knowledge arises from practice, returns to guide practice, and is verified
> by practice. The dogfood loop is this cycle made operational.

---

## 1. Core Principles Map

### 1.1 From "On Practice" (实践论) — The Cognition-Practice Cycle

| Principle | Dogfood Mapping | Failure Mode (Without) | Healthy State (With) |
|-----------|----------------|----------------------|---------------------|
| **Perceptual knowledge (感性认识)** must precede rational knowledge | First inspect the current state before proposing any change — read transcripts, artifacts, design docs, code | Agent proposes an improvement based on abstract reasoning or generic best practices, not on actual project evidence | Every dogfood run begins with evidence collection: read the relevant surface, capture current behavior, observe the actual problem |
| **Rational knowledge (理性认识)** emerges from systematic investigation | After collecting evidence, synthesize findings into a structured assessment — identify patterns, contradictions, root causes | Agent jumps from observation straight to action (patch first, understand later) | The `Combine` phase explicitly identifies cross-cutting themes and the principal contradiction before proposing a solution |
| **Practice (实践) is the criterion of truth** | Every claim must be verified by practice — deterministic checks, focused live eval, rerun | Agent claims a fix works without verifying; or a report is accepted as true without deterministic evidence | `Verify` gates require falsifiable evidence: a test that would fail if the claim were wrong; cargo build; focused eval |
| **Perception → Reason → Practice → Perception again** | The dogfood loop is a spiral: investigate → analyze → propose → implement → verify → record learning → investigate again | One-shot improvement with no learning loop; repeating the same mistake because the previous run's evidence is not carried forward | Each dogfood cycle produces retrievable evidence that informs the next cycle. The development log is the accumulated rational knowledge. |
| **Theory serves practice, not the reverse** | Design documents and philosophical principles are actionable only when they change behavior in the loop | Philosophy becomes decoration — quoted in design reviews but never changes how the agent runs | Each principle in this document is indexed to a concrete behavioral change in the autonomous-iteration scenario |
| **Truth is discovered through struggle with error** | Contradictions (between evidence and claim, between design and implementation, between two eval results) are the engine of improvement | Agent smooths over contradictions to produce a tidy report; inconsistencies are buried | The scenario explicitly requires identifying and resolving contradictions. An unresolved contradiction is a blocker. |

### 1.2 From "Oppose Book Worship" (反对本本主义) — Investigation First

| Principle | Dogfood Mapping | Failure Mode (Without) | Healthy State (With) |
|-----------|----------------|----------------------|---------------------|
| **"No investigation, no right to speak" (没有调查，没有发言权)** | Investigation must precede every proposal. No analysis, no change. | Agent writes recommendations based on model knowledge rather than current project evidence. "The engine should do X because that's generally best practice." | Every proposal must cite specific observations from the current repository. "The engine does X, which causes Y in situation Z — here is the evidence from the transcript." |
| **Oppose dogmatism (反对本本主义)** — don't apply theory mechanically | Principles must be adapted to the concrete situation. The architecture, not abstract philosophy, decides the method. | Dogfood runs follow a rigid template regardless of what the evidence shows. "We must always split into 4 children because the design says so." | The evidence surface determines the plan structure. Sometimes one atomic Execute is right. Sometimes two children. The evidence decides. |
| **Investigation solves the problem** — thorough investigation reveals the solution | The Specify/Plan phase is not a formality — it is the investigation that determines how work should be divided | Specify and Plan are done hastily to get to execution. Poor routing leads to context overflow or wrong decomposition. | The majority of thinking happens in Specify/Plan. Execution is straightforward because the investigation was thorough. |
| **Congfu (功夫) — the actual situation is the starting point** | The dogfood loop starts with the actual current state of the repository, not with a desired end state | "We need to implement M3 feature X" without checking what currently exists or what the actual blocking issues are | "Let's first see where the project actually is — what works, what doesn't, what the last dogfood run found" |
| **Social investigation method** — gather from multiple sources | Use parallel child nodes to investigate independent evidence surfaces. The combine phase synthesizes the multi-perspective view. | One agent tries to investigate everything, leading to context overflow and shallow coverage of each surface | Multiple agents each investigate one evidence surface deeply; the parent synthesizes their findings. This IS 人民史观 in action. |

### 1.3 From Sikong Design — The Engineering Expression

| Principle | Source | Dogfood Mapping |
|-----------|--------|-----------------|
| **人民史观 — Many ordinary agents > one super-agent** | product-vision.md §2½ | Decompose by evidence surface; let many small agents each handle one bounded task; combine their findings. This is the practical expression of "the masses have boundless creative power." |
| **Agents explore; system controls state; only verified evidence becomes durable fact** | development-philosophy.md | Each agent's output is a claim, not a fact. Verification gates (cargo build, deterministic checks, focused eval) are practice-as-criterion-of-truth. |
| **Scattered improvements fail even when correct** | development-theory.md | The autonomous-iteration scenario must produce one bounded change per cycle, not a scatter-shot of tiny fixes. Like the practice-theory cycle, each iteration closes one loop. |
| **Arch frames authority; Plan routes work; Execute solves local slices; Verify guards the gate** | governance-model.md | The governance layers map directly to the cognition-practice cycle: Arch is theory/frame, Plan is investigation/routing, Execute is practice, Verify is truth-testing. |
| **Attention boundary before action** | development-philosophy.md | "No investigation, no right to speak" applied: name the mainline, owning layer, and acceptance evidence before executing. |
| **Fix the mechanism, not the prompt** | product-vision.md Decision Rule 3 | When practice reveals a failure, repair the mechanism (schema, typing, deterministic check) not the prompt. This is rational knowledge correcting the practice structure. |

---

## 2. The Dogfood Loop as the Practice-Theory-Practice Cycle

The dogfood loop from `design/dogfood.md` is already a practice-theory-practice
cycle. Here is the explicit mapping:

```
Dogfood Loop Step                     Cognition Stage
──────────────────                    ───────────────

1. Name mainline and layer            →  Identify the principal contradiction
   (What are we trying to solve?       (What is the central problem that
    What layer owns the uncertainty?)    governs all others?)

2. Scope scenario                     →  Perceptual knowledge
   (Read the current state:             (Observe the concrete situation —
    transcripts, artifacts, code,        gather evidence from multiple
    design docs, eval results)           sources, do not theorize yet)

3. Run live eval                      →  Practice (first movement)
   (Execute the scenario,               (Engage with reality, produce
    collect fresh transcript             new evidence from action)
    and artifact evidence)

4. Inspect transcript and             →  Rational knowledge
   artifact sidecars                    (Analyze the evidence, identify
   (What patterns emerge?               patterns, contradictions,
    What contradictions appear?)        root causes. This is "思考" —
                                         processing perception into
                                         understanding)

5. Accept one bounded change          →  Theory → Practice transition
   (Propose a concrete fix             (Knowledge must return to
    for the principal contradiction)     practice to be useful.
                                         One bounded change = one
                                         contradiction resolved)

6. Apply in the main workspace        →  Practice (second movement)
   (Implement the change)               (Theory guides action)

7. Run deterministic checks           →  Practice is criterion of truth
   (cargo build, cargo test,           (Did the change work? The
    focused live eval)                   evidence decides, not the
                                         claim)

8. Rerun focused live eval            →  Verification through practice
   (Does the fix actually work         (The same conditions that
    in the conditions that              revealed the problem must
    revealed the problem?)              now show it is resolved)

9. Commit -> Record learning          →  New perceptual starting point
   (What did we learn?                  (The accumulated knowledge
    What remains? Next                   becomes the starting point
    principal contradiction?)            for the next cycle)
```

### The Spiral Nature

This is not a flat cycle. It is an ascending spiral:

- **Cycle 1:** Perceptual observation → surface pattern → simple fix
- **Cycle 2:** Deeper observation → structural pattern → design fix
- **Cycle 3:** Systemic observation → architectural pattern → protocol fix

Each cycle starts from the accumulated knowledge of the previous one. The
development log (`development-log/YYYY-MM.md`) is the store of rational
knowledge that prevents each new cycle from starting from scratch.

---

## 3. Three Concrete Changes to Autonomous-Iteration

### Change A: Investigate Before Action (No Investigation, No Right to Speak)

**Current behavior:** The scenario produces 3-4 parallel analysis children that
immediately analyze different aspects (code, tests, design, docs). But it does
not require each child to first investigate the current state of its surface
before making claims.

**Change:** Add an explicit "Investigation" requirement to the scenario task
description that precedes all analysis. Before any child makes a claim, it must:

1. Read at least 3 specific files or evidence sources relevant to its surface.
2. Cite concrete observations from those sources.
3. Only then propose findings.

Add this as a required step in the task description:

```yaml
== INVESTIGATION REQUIREMENT (before any child analysis) ==
Each child must start by reading the current state of its evidence surface.
No claim may be made without citing at least one concrete observation from
the current project state. If the child cannot find evidence for a claim,
it must report "Not enough evidence to assess" rather than inventing a finding.
```

### Change B: Evidence at Every Step (Practice is the Criterion of Truth)

**Current behavior:** The combine phase synthesizes child findings and proposes
an improvement. But the improvement may be proposed without evidence that it
will actually fix the identified problem.

**Change:** Add an evidence requirement to the Combine and Verify phases:

```yaml
== EVIDENCE REQUIREMENT (Combine & Verify) ==
Every proposed improvement must be accompanied by:
- A falsifiable claim: "If we change X, then Y should improve."
- A specific test: "Run `cargo build` and check that Z compiles."
- A before/after comparison: "Currently Z takes 3s. After change, < 1s."
Proposals without falsifiable evidence must be rejected.
```

### Change C: Identify and Resolve Contradictions (矛盾论)

**Current behavior:** The scenario does not explicitly ask agents to find
contradictions — mismatches between:
- What the design says and what the code does
- What one evidence surface shows and another shows
- What the last dogfood run found and what this run finds

**Change:** Add a contradiction-finding requirement:

```yaml
== CONTRADICTION RESOLUTION (Plan & Combine) ==
Each plan must identify at least one contradiction: a place where evidence
from one surface contradicts evidence from another, or where design intent
differs from implementation reality. The combined proposal must resolve
this contradiction, not paper over it. An unresolved contradiction is a
blocker for acceptance.
```

---

## 4. How This Changes the Autonomous-Iteration Scenario

The updated `autonomous-iteration.yaml` (see `evals/task-run/autonomous-iteration.yaml`)
now requires:

1. **Investigate before action** — Every child must read the current state and
   cite evidence before proposing findings.

2. **Evidence for every claim** — No claim survives without falsifiable
   evidence. Proposals must name the test that would prove or disprove them.

3. **Find and resolve contradictions** — The plan must identify a principal
   contradiction. The combine must resolve it. An unresolved contradiction
   blocks acceptance.

4. **Practice-theory-practice cycle** — The scenario follows the full cycle:
   investigate (perceptual knowledge) → synthesize (rational knowledge) →
   implement (practice) → verify (practice is criterion of truth) → record
   learning (new starting point).

---

## 5. Principle Index

Each principle in this document has a concrete behavioral implication somewhere
in the system. This index ensures traceability:

| ID | Principle | Behavioral Implication | Location |
|----|-----------|----------------------|----------|
| PT-1 | Investigation precedes action | Read before propose: each child must read 3+ files before making claims | autonomous-iteration.yaml §Investigation Requirement |
| PT-2 | Practice is criterion of truth | Falsifiable evidence required for every claim; proposals must name the test | autonomous-iteration.yaml §Evidence Requirement |
| PT-3 | Resolve contradictions | Principal contradiction identified in Plan; resolved in Combine | autonomous-iteration.yaml §Contradiction Resolution |
| PT-4 | Perception → Reason → Practice → Perception | Full cycle: investigate → synthesize → implement → verify → record | autonomous-iteration.yaml task flow |
| PT-5 | One bounded change per cycle | Combine produces exactly one improvement; no scatter-shot | autonomous-iteration.yaml §Execution Rules |
| PT-6 | Many ordinary agents > one super-agent | Decompose by evidence surface into parallel children | autonomous-iteration.yaml §Plan |
| PT-7 | Theory serves practice | Design documents are actionable only when they change agent behavior | This document (PT index) |
| PT-8 | No dogmatism: evidence decides | Plan structure follows evidence surface, not template | autonomous-iteration.yaml §Scope Assessment |
| PT-9 | Fix mechanism, not prompt | When practice reveals failure, repair schema/check before prompt | development-philosophy.md |
| PT-10 | Close every loop | Each cycle ends in closed/handoff/blocked with retrievable evidence | development-philosophy.md |

---

## Appendix: Direct Quotes and Their Engineering Translation

### From "On Practice"

> "If you want to know the theory and methods of revolution, you must take part in revolution."
> → **Engineering:** If you want to know whether a design change works, you must apply it and verify it through practice (deterministic checks, focused eval).

> "All genuine knowledge originates in direct experience."
> → **Engineering:** All improvement proposals must originate in direct observation of the current project state (transcripts, artifacts, code inspection).

> "The perceptual and the rational are qualitatively different, but are not divorced from each other."
> → **Engineering:** Observation (perception) and analysis (reason) are distinct phases. Do not skip to analysis without observation. Do not stay in observation without synthesizing.

> "Practice, knowledge, again practice, and again knowledge. This form repeats itself in endless cycles, and with each cycle the content of knowledge is raised to a higher level."
> → **Engineering:** The dogfood loop is a spiral: each cycle starts from the accumulated knowledge of the previous one. The development log is the vehicle for this accumulation.

### From "Oppose Book Worship"

> "No investigation, no right to speak."
> → **Engineering:** A child agent must read the evidence surface before making any claim about it. No finding without prior reading.

> "Dogmatism is even more dangerous than blind practice."
> → **Engineering:** Following a rigid planning template (always 4 children, always parallel) without regard to what the evidence says is dogmatism. The evidence surface decides the plan structure.

> "Those who are against the investigation of the actual situation... either have a blind, chaotic way of doing things or are lazy and unwilling to use their brains."
> → **Engineering:** A scenario that always proposes the same kind of improvement regardless of what the evidence shows is lazy. Each cycle must discover what actually needs to change.

> "The outcome of investigation is... to solve the problem."
> → **Engineering:** The Specify/Plan phase is the investigation. If it does not solve the routing problem (atomic vs. decomposed, which children), the investigation is incomplete.

---

## Appendix: Mapping to Development Theory Dimensions

| Principle | Primary Dimension | Secondary Dimension |
|-----------|------------------|-------------------|
| Investigation before action | D4 (Agent Loop — prompt projection) | D3 (Interface — scenario definition) |
| Evidence at every step | D2 (Engine — verification gates) | D5 (Meta — method feedback) |
| Resolve contradictions | D5 (Meta — learning system) | D1 (Arch — governance rules) |
| Practice-theory-practice cycle | D5 (Meta — dogfood loop design) | D2 (Engine — task state machine) |
| One bounded change per cycle | D1 (Arch — development theory) | D3 (Interface — scenario structure) |

---

*This document should be read alongside `design/development-philosophy.md` and
`design/development-theory.md`. It does not replace them — it provides the
philosophical foundation that explains WHY those design rules exist.*
