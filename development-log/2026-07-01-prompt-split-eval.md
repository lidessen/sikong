# Prompt Split Evaluation: Attention Layering Analysis

**Date**: 2026-07-01
**Source Files Analyzed**:

- `design/philosophy/prompt-guidance.md` (attention layering theory)
- `design/philosophy/development-philosophy.md` (design philosophy)
- `src/core/task_run/harness.rs` (operation prompt definitions)
- `src/harness/governance.rs` (governance gate definitions)

**Frame**: Attention layering (L0 = one agent loop run; L1 = task-run engine node tree; L2 = assistant/task-board; L3 = durable design memory)

---

## 1. Current Segment Catalog (Per Operation)

### Specify — 13 sections

| #   | Section                  | Tag             | Notes                                                                                                                                                                       |
| --- | ------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Role                     | **L0-required** | One-sentence operation responsibility                                                                                                                                       |
| 2   | Operation Context        | **L0-required** | Structured JSON injected directly                                                                                                                                           |
| 3   | Node To Specify          | **L0-required** | Operation-specific lens                                                                                                                                                     |
| 4   | Specification Standard   | **L0-required** | Rubric for the result                                                                                                                                                       |
| 5   | Attention Contract       | **L0-required** | Operation-specific attention boundary                                                                                                                                       |
| 6   | Governance Boundary      | **L2/L3 leak**  | Durable governance model — same text projected into every operation; engine already enforces via state machine and schema                                                   |
| 7   | Size Reading             | **L0-required** | Size-selection guidance specific to Specify                                                                                                                                 |
| 8   | Evidence Surface Reading | **L0-required** | Evidence-boundary guidance specific to Specify                                                                                                                              |
| 9   | Medium Versus Large      | **L0-required** | Disambiguation specific to Specify                                                                                                                                          |
| 10  | Boundary                 | **L0-required** | Info-gathering boundary specific to Specify                                                                                                                                 |
| 11  | Tool Use Discipline      | **L0-required** | Tool behavior specific to Specify                                                                                                                                           |
| 12  | Non Goals                | **L2/L3 leak**  | Defensive "do not" list — terminal `submit_specification` schema already constrains output; teaching the agent what NOT to do adds cognitive load without binding execution |
| 13  | Completion               | **L0-required** | Terminal tool names                                                                                                                                                         |

### Plan — 13 sections

| #   | Section                 | Tag             | Notes                                     |
| --- | ----------------------- | --------------- | ----------------------------------------- |
| 1   | Role                    | **L0-required** |                                           |
| 2   | Operation Context       | **L0-required** |                                           |
| 3   | Parent Problem          | **L0-required** |                                           |
| 4   | Planning Lens           | **L0-required** | (has some teaching prose — condense)      |
| 5   | Governance Boundary     | **L2/L3 leak**  | Same as Specify                           |
| 6   | Leverage Parent Context | **L0-required** |                                           |
| 7   | Divide And Attention    | **L0-required** | (has some teaching prose — condense)      |
| 8   | Group Shape             | **L0-required** |                                           |
| 9   | Planning Strategy       | **L0-required** | (has some teaching prose — condense)      |
| 10  | Plan Item Shape         | **L0-required** | Schema-like guidance for plan item fields |
| 11  | Recursive Decomposition | **L0-required** | Operation-specific policy                 |
| 12  | Non Goals               | **L2/L3 leak**  | Defensive list, same as Specify           |
| 13  | Completion              | **L0-required** |                                           |

### Execute — 10 sections

| #   | Section             | Tag             | Notes                         |
| --- | ------------------- | --------------- | ----------------------------- |
| 1   | Role                | **L0-required** |                               |
| 2   | Operation Context   | **L0-required** |                               |
| 3   | Work Item           | **L0-required** |                               |
| 4   | Workspace Rules     | **L0-required** | Operation-specific constraint |
| 5   | Self Contained Work | **L0-required** |                               |
| 6   | External Evidence   | **L0-required** |                               |
| 7   | Execution Standard  | **L0-required** |                               |
| 8   | Governance Boundary | **L2/L3 leak**  | Same as all others            |
| 9   | Local Autonomy      | **L0-required** |                               |
| 10  | Completion          | **L0-required** |                               |

### Combine — 9 sections

| #   | Section                   | Tag             | Notes |
| --- | ------------------------- | --------------- | ----- |
| 1   | Role                      | **L0-required** |       |
| 2   | Operation Context         | **L0-required** |       |
| 3   | Integration Inputs        | **L0-required** |       |
| 4   | Workspace Integration     | **L0-required** |       |
| 5   | Parent Synthesis Standard | **L0-required** |       |
| 6   | Governance Boundary       | **L2/L3 leak**  | Same  |
| 7   | Parent Attention          | **L0-required** |       |
| 8   | Non Goals                 | **L2/L3 leak**  | Same  |
| 9   | Completion                | **L0-required** |       |

### Verify — 9 sections

| #   | Section                | Tag             | Notes                                            |
| --- | ---------------------- | --------------- | ------------------------------------------------ |
| 1   | Role                   | **L0-required** |                                                  |
| 2   | Operation Context      | **L0-required** |                                                  |
| 3   | Candidate Under Review | **L0-required** |                                                  |
| 4   | Verification Lens      | **L0-required** |                                                  |
| 5   | Verdict Standard       | **L0-required** |                                                  |
| 6   | External Evidence Gate | **L0-required** |                                                  |
| 7   | Governance Boundary    | **L2/L3 leak**  | Same                                             |
| 8   | Boundary               | **L0-required** | (borderline — could merge with Verdict Standard) |
| 9   | Completion             | **L0-required** |                                                  |

---

## 2. Leak Summary

| Leak Pattern                                                                 | Operations Affected    | Proposed Action                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Governance Boundary**                                                      | ALL 5 operations       | **Delete from prompts entirely.** Governance is an engine-layer invariant, not agent instruction. The engine enforces gates via state machine and terminal tool decoding. Putting it in every prompt is L3 (durable design knowledge) projected into L0 (one run). The agent doesn't need to know gate IDs — it just needs to know which terminal tool completes the run. If the engine rejects an action, the agent retries. |
| **Non Goals**                                                                | Specify, Plan, Combine | **Delete from prompts.** Defensive "do not" lists teach the model that forbidden things are expected fields. The terminal tool schema already defines what the agent CAN do; that implicitly defines what it cannot. `submit_specification` doesn't accept plan items, so the agent can't submit them. Adding prose is teaching, not constraining.                                                                            |
| **Teaching prose in Planning Lens, Divide And Attention, Planning Strategy** | Plan                   | **Merge/condense.** These three sections contain ~80% operation-specific guidance and ~20% teaching about "why divide and conquer works." Keep only the actionable guidance: group mode rules, item shape schema, recursion policy. Move explanatory prose to design docs.                                                                                                                                                    |

---

## 3. Simplified Prompt Schemes

### Specify (proposed — 7 sections)

```text
1. Role
   You are the specification pass for one recursive engine node.

2. Operation Context
   [JSON packet injected directly]

3. Specification Objective
   Normalize node {id} into a precise problem statement.
   Current intent: {intent}
   Submit next as an intent-preserving rewrite that can be passed directly to Execute or Plan.

4. Size Selection
   Pick the smallest safe size by coordination cost while preserving the full current intent.
   tiny/small/medium — execute as one node
   large/x_large — planning required before execution
   Judge evidence boundaries before judging artifact shape. A single document can be large
   when built from independently verifiable evidence surfaces. A local change with
   supporting files is medium when evidence is only useful inspected together.

5. Constraint
   Information gathering is not a special route. If the intent cannot be worked without a
   missing user choice or external fact, make next the concrete gathering work and size it.
   Use tools only when needed to avoid mis-sizing or losing intent.

6. Tools
   submit_specification

7. Completion
   Finish by calling submit_specification.
```

**Deleted**: Governance Boundary, Non Goals, Tool Use Discipline (merged into Constraint), Attention Contract (merged into Objective), Evidence Surface Reading + Medium Versus Large (merged into Size Selection)

---

### Plan (proposed — 7 sections)

```text
1. Role
   You are the planning pass for one recursive engine node.

2. Operation Context
   [JSON packet injected directly]

3. Planning Objective
   Plan node {id} by understanding the main contradiction first.
   Parent intent: {intent}

4. Group Rules
   - stage: ordered phases where each item changes understanding needed by the next
   - parallel: all items start from parent context, no sibling outputs needed
   - Do not add a synthesis/final-report child to parallel groups — parent Combine owns convergence

5. Item Shape
   Each plan item needs: key, intent, requires_prior_results (false for parallel).
   Include read_scope globs when child owns a narrower evidence surface.
   Use policy=decompose when a child is large enough for further decomposition (max 3 levels).
   Children always re-enter Specify — do not pre-expand their internal plan.

6. Constraints
   - Do not execute item work or combine results here.
   - Use tools only when boundary is genuinely ambiguous from parent context.
   - Child scopes may narrow the parent but must not widen it.

7. Tools
   submit_plan_group

8. Completion
   Finish by calling submit_plan_group.
```

**Deleted**: Governance Boundary, Non Goals.
**Merged**: Planning Lens + Divide And Attention + Planning Strategy → Group Rules.
**Merged**: Plan Item Shape + Recursive Decomposition → Item Shape.
**Merged**: Leverage Parent Context → into Constraint.

---

### Execute (proposed — 6 sections)

```text
1. Role
   You are the atomic execution pass for one recursive engine node.

2. Operation Context
   [JSON packet injected directly]

3. Work Objective
   Solve node {id} inside the allowed workspace and capability scope.
   Node intent: {intent}

4. Workspace Rules
   Respect read_scope, write_scope, provider details, and allow_write exactly.
   Submit only the work result; the workspace provider captures file changes and side effects.
   Write permission: {allow_write}

5. Constraints
   Produce the smallest complete artifact that satisfies this node from Operation Context
   and the allowed workspace surface. Self-contained analysis work does not need read_scope.
   If external evidence is required but unavailable, submit that evidence gap as the result.
   Own local execution; if the parent intent or boundary is wrong, submit that as the blocker.

6. Tools
   submit_work

7. Completion
   Finish by calling submit_work.
```

**Deleted**: Governance Boundary.
**Merged**: Self Contained Work + External Evidence + Execution Standard + Local Autonomy → Constraints.

---

### Combine (proposed — 6 sections)

```text
1. Role
   You are the parent execution pass resuming after child artifacts have been accepted.

2. Operation Context
   [JSON packet injected directly]

3. Integration Objective
   Synthesize {n} accepted child artifacts for parent node {id}.
   Parent intent: {intent}

4. Synthesis Standard
   Produce the parent-level artifact from accepted child evidence already in Operation Context.
   Do not paste child outputs together, restart child work, or introduce unsupported facts.
   Preserve what matters, discard local scaffolding, resolve contradictions against parent intent.
   If conflicts are present, resolve those paths in the parent artifact.

5. Constraints
   Act as the same parent that delegated the children, not as a new independent role.
   Accept compressed child artifacts as the evidence surface, not the full trace.
   Do not create new child nodes, re-run child investigation, or invent an Arch-level change.

6. Tools
   submit_combination

7. Completion
   Finish by calling submit_combination.
```

**Deleted**: Governance Boundary, Non Goals.
**Merged**: Parent Attention → Constraints.
**Renamed**: Parent Synthesis Standard + Workspace Integration → Synthesis Standard.

---

### Verify (proposed — 6 sections)

```text
1. Role
   You are the verification pass for one candidate artifact.

2. Operation Context
   [JSON packet injected directly]

3. Candidate Under Review
   Judge candidate output for node {id} against intent: {intent}

4. Verdict Standard
   Verdict must be exactly one of: accept, reject, need_information.
   Judge against node intent and available context, not extra requirements.
   accept: candidate satisfies intent and scope with available evidence.
   reject: same node can repair — name what must change and what evidence shows the gap.
   need_information: acceptance depends on a concrete missing fact not in Operation Context.
   Do not reject based on style preference alone.

5. Constraints
   When intent asks for external evidence, do not accept claims reconstructed from training
   knowledge — accept only cited observed evidence. Do not edit the artifact in verification.

6. Tools
   submit_verdict

7. Completion
   Finish by calling submit_verdict.
```

**Deleted**: Governance Boundary.
**Merged**: Verification Lens + External Evidence Gate + Boundary → Constraints.
**Merged**: Verdict Standard + External Evidence Gate guidance → Verdict Standard.

---

## 4. What To Delete (Summary)

| Section                       | Reason                                                                                                                                                                | Operations             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Governance Boundary           | Durable design knowledge (L3) projected into every L0 run. Engine enforces gates deterministically. Agent does not need gate IDs or authority-layer names to execute. | All 5                  |
| Non Goals                     | Defensive "do not" pattern — teaches model forbidden fields exist. Terminal schema already defines what is possible.                                                  | Specify, Plan, Combine |
| Tool Use Discipline (Specify) | Redundant with completion section and tool schema. Condensed into one constraint line.                                                                                | Specify                |

## 5. What To Merge/Consolidate

| Current Sections                                                              | Proposed Section      | Principle                                                                                 |
| ----------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| Planning Lens + Divide And Attention + Planning Strategy                      | Group Rules           | All three give rules for how to shape the child group. Merge into one actionable section. |
| Plan Item Shape + Recursive Decomposition                                     | Item Shape            | Both describe plan item structure and depth policy.                                       |
| Self Contained Work + External Evidence + Execution Standard + Local Autonomy | Constraints           | All are execution-time rules, not separate lenses. One constraint section is enough.      |
| Parent Attention                                                              | (into Constraints)    | Same role guidance for Combine.                                                           |
| Verification Lens + External Evidence Gate + Boundary                         | Constraints           | Same kind of constraint rules.                                                            |
| Evidence Surface Reading + Medium Versus Large                                | (into Size Selection) | Both disambiguate size choice. One section.                                               |
| Leverage Parent Context                                                       | (into Constraint)     | Tool-use boundary for planning.                                                           |

## 6. Net Reduction

| Operation | Current Sections | Proposed Sections | Reduction |
| --------- | ---------------- | ----------------- | --------- |
| Specify   | 13               | 7                 | -6        |
| Plan      | 13               | 8                 | -5        |
| Execute   | 10               | 7                 | -3        |
| Combine   | 9                | 7                 | -2        |
| Verify    | 9                | 7                 | -2        |

Total: from 54 sections → 36 sections (33% reduction in prompt surface area).

## 7. Design Rationale

The proposed scheme applies the core principle from `prompt-guidance.md`:

> **"A prompt is a context projection, not a chat transcript."**
> **"Prompt is for working, not teaching — agent only needs to know what to do for the current operation."**

Every deleted section is either:

- **Durable design knowledge** (Governance Boundary, explanatory prose about "why divide-and-conquer works") that belongs in L3 design docs, not in every L0 agent run.
- **Defensive prohibition** (Non Goals) that the terminal schema already enforces. Teaching the model what NOT to do creates the Slots Problem: forbidden examples make the model believe those fields are expected.
- **Redundant framing** (Tool Use Discipline) that duplicates information available in the Completion section and tool schema.

The merged sections consolidate related rules into one place, reducing section scanning without losing information. The "Constraints" section in each operation replaces 2-4 scattered boundary sections with one named location, following the principle: stable section titles, clear boundaries, no surprises.

The remaining sections map directly to the recommended order from prompt-guidance.md:

1. Role
2. Operation Context
3. operation-specific content (Objective, Standard/Rubric)
4. Constraints (boundaries)
5. Tools
6. Completion
