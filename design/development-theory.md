# Development Theory: Iterative Development In A Layered Agent System

**Status:** Current (✓)
**Governs:** All layers — development method, debt management, iteration cadence
**Last Reviewed:** 2026-06-22

---

## Why Scattered Improvements Fail

Scattered improvements are individually valid changes that collectively erode the system.

Each change passes its own test. Each addresses a real concern. Each is reviewed
and committed. Yet after six such changes, the system is harder to reason about,
not easier. The tests still pass, but the architecture has silently drifted.

This happens for structural reasons, not personal failure:

**1. Attention dilution.** A focused change to a single module is evaluated
against local criteria — does it fix the bug? Does it pass the module tests?
But the cumulative effect across modules is never evaluated together because
no single change is large enough to trigger a cross-module review.

**2. Premature optimization spread.** A speed improvement in one subsystem
introduces a caching layer. A speed improvement in another subsystem introduces
a different caching layer. Neither is wrong alone. Together they create two
inconsistent caching strategies that future changes must navigate around.

**3. Governance hidden in code.** A change that adds a new CLI flag seems like
a trivial Interface (L1) improvement. But if that flag changes how the engine
selects its runtime profile, it is actually an Arch (L3) decision smuggled
through a low-level patch. The review surface never catches the category error
because the diff is small.

**4. Compound inconsistency.** Three independent teams or agent runs each
improve error handling. One adds structured error types, one adds string-based
error codes, one wraps everything in `anyhow`. Each is better than what was
there. But the three approaches now coexist, and the next engineer must learn
all three to handle errors in the system.

**5. The improvement trap.** The best time to fix known design debt is during
a related change. But if every local change "also" fixes nearby debt, the
scope expands without a governing budget. After enough such expansions, the
original change's purpose is lost in a sea of incidental cleanup.

The common pattern: individually valid + uncoordinated = collectively harmful.

---

## Development Dimensions

The system's attention layers define natural development dimensions. Each
dimension has its own improvement category, signal for when to engage,
and compounding mechanism.

### D1: Arch & Philosophy (L3)

**What belongs here:** System contracts, protocol definitions, governance
rules, design philosophy, layer boundaries, terminal tool schemas, workspace
semantics, dogfood policy.

**Signal that indicates need:**
- A new feature cannot be implemented without bending an existing protocol.
- The same kind of drift appears in three different places — meaning the
  governance or design rule is too weak to prevent it.
- A live eval judge flags a governance gate (`G-ARCH-ESCAPE`,
  `G-PROTOCOL`) and the root cause is a missing or ambiguous contract.
- A design document has a `Needs Review` or `Draft` status that blocks
  implementation decisions.

**How improvements compound:**
Arch improvements radiate to every downstream layer. Clarifying the workspace
provider contract fixes a whole class of potential bugs, not just the one that
motivated the change. Each clarified protocol definition removes one future
ambiguity from every agent run. The compounding factor is multiplicative:
one Arch fix can eliminate dozens of local workarounds.

```
Before: agent workaround → agent workaround → agent workaround
After:  Arch contract → clean execution → clean execution → clean execution
```

**Typical depth:** 1-3 design document revisions per quarter. Each revision
should be a separate design commit before any implementation follows.

**Done enough:** A `Specify`/`Plan` run against the changed contract produces
no `G-ARCH-ESCAPE` findings, and downstream implementation can proceed without
further protocol clarification.

### D2: Engine & Runtime (L2)

**What belongs here:** Task-run state machine, node operations, agent-host
protocol, workspace provider implementation, harnesses, terminal tool
implementations, eval framework, metrics engine.

**Signal that indicates need:**
- An agent run fails with a protocol error or malformed payload
  (`G-PROTOCOL`).
- A deterministic check in the engine is slow, brittle, or missing.
- The engine state machine produces an unexpected transition during a live
  eval.
- Token efficiency (M1) or time efficiency (M2) degrades across iterations.
- A new operation or harness is needed to support a task shape.

**How improvements compound:**
Engine improvements are investment — they make every future task run more
reliable, faster, or cheaper. A caching fix in the agent-host protocol reduces
latency for all operations. A more precise harness prompt reduces wasted tokens
in every `Specify` and `Verify` run. Each improvement's benefit is multiplied
by the number of task runs that flow through it.

```
┌─────────────────────────────────────────────────────┐
│  One harness improvement × N task runs per week     │
│  = N × (tokens saved per run) compound savings      │
└─────────────────────────────────────────────────────┘
```

**Typical depth:** 3-10 focused patches per week, each verified by
deterministic tests and a focused live eval.

**Done enough:** The engine's core loop (Specify → Plan → Execute → Combine →
Verify → Commit) completes for the target task shapes without unexpected
transitions, and the metrics baseline for token/time efficiency is stable or
improving.

### D3: Interface & Command Surface (L1)

**What belongs here:** CLI commands and flags, eval scenario definitions, YAML
fixtures, structured output formats (JSON/JSONL), assistant pack injection, ACP
protocol extensions, task-board tools.

**Signal that indicates need:**
- A user or external agent reports difficulty invoking a capability.
- A CLI command produces unstructured output that must be parsed by another
  tool.
- An eval scenario is missing for a task shape that is now commonly run.
- The assistant cannot perform a task because a required tool or pack is not
  injected.
- A command handler duplicates logic that exists in another command.

**How improvements compound:**
Interface improvements reduce friction for every subsequent interaction. A
well-designed CLI flag convention means the next command is easier to add. A
clean JSON output format means the next metrics dashboard can reuse the same
schema. Compound improvements here are **ergonomic**: they reduce the mental
cost of using the system.

```
Poor interface: read docs → try flag → fail → read error → adjust → retry
Good interface: read help → run → done
```

**Typical depth:** 1-3 command improvements per week during active development,
fewer during stabilization.

**Done enough:** The CLI is discoverable (`--help` is sufficient), all
commands produce structured JSON output when requested, and the most common
eval and dogfood workflows are one-liners.

### D4: Client & Agent Loop (L0)

**What belongs here:** Individual agent-run prompt projections, operation
context packets, terminal tool usage patterns within one loop iteration,
tool selection and call ordering in single runs.

**Signal that indicates need:**
- An agent run produces a valid but poor-quality result — the right structure
  but wrong content.
- A specific operation repeatedly exceeds its token budget.
- The agent calls tools in an inefficient order (e.g., reading the same file
  twice).
- Cache effectiveness (M5) is low — the agent is re-reading context that
  should be cached.

**How improvements compound:**
L0 improvements are the fastest to realize but the most localized. A better
prompt projection for `Execute` saves tokens in every leaf execution. A tighter
terminal tool schema prevents a whole class of malformed submissions. The
compounding here is **frequency-weighted**: improvements to the most common
operations (`Execute`, `Specify`) matter more than improvements to rare ones.

```
Most common operations → most L0 improvement leverage
```

**Typical depth:** Fine-tuned continuously as patterns emerge from live evals.
Most improvements are prompt adjustments or schema tightenings.

**Done enough:** The operation harness produces an agent run that completes
within budget, the terminal tool is correctly selected, and the judge
verdict passes with no structural findings.

### D5: Meta — Method & Learning (Cross-Cutting)

**What belongs here:** Dogfood loop improvement, dev-log quality, review
checklist refinement, drift signal detection, method feedback from live evals,
development-theory updates.

**Signal that indicates need:**
- The same method feedback appears in consecutive dev-log entries (repeated
  learning).
- A live eval passes but the operator later discovers a flaw that the eval
  should have caught — meaning the method, not the mechanism, is wrong.
- The development log has handoff or blocked entries that never resolve.
- A design review checklist item is consistently skipped or weakly answered.

**How improvements compound:**
Meta improvements change how the system improves itself. A better review
checklist catches more drift before it accumulates. A clearer drift signal
prevents a whole category of scattered change. The compounding is **adaptive**:
the system gets better at getting better.

```
┌────────────────────────────────────────────────────────┐
│  Method feedback → checklist update → fewer drift bugs │
│  → more time for real improvements → more method        │
│  feedback → ...                                          │
└────────────────────────────────────────────────────────┘
```

**Typical depth:** One meta review per 2-3 development cycles. Heavy method
adjustments are rare (every 2-4 weeks); light adjustments are continuous.

**Done enough:** The dogfood loop produces retrievable artifacts, the dev-log
shows closed loops, and no drift signal from `development-philosophy.md` has
fired in the current cycle.

---

## Rhythm & Cadence

### The Rotation Pattern

Rotate through dimensions in a repeating cycle. The cycle has two phases:

**Phase A — Deep Work (days 1-3):** One dimension gets dedicated attention.
This is where structural improvements happen. Pick the dimension whose needs
signal is loudest.

1. **Day 1 — Investigate:** Run focused evals, inspect metrics, read the
   relevant design docs. Understand what needs improvement and what must stay
   stable. Produce a scoped proposal or boundary candidate.

2. **Day 2 — Implement:** Make the bounded change. Run deterministic checks.
   Run focused live eval. Record the result in the dev-log.

3. **Day 3 — Stabilize:** Re-run the impacted eval suite. Check metrics
   (M1-M6). Fix any regressions. Update design docs if the change affected
   contracts.

**Phase B — Shallow Rotation (days 4-5):** Touch each of the remaining
dimensions lightly. This is where small, bounded improvements live — fixes,
cleanups, prompt adjustments, interface polish.

```
┌─────────────────────────────────────────────────────────────┐
│  Week 1:  D2 Engine (deep)  │  D4 D1 D3 D5 (shallow)       │
│  Week 2:  D3 Interface (deep) │  D2 D1 D4 D5 (shallow)     │
│  Week 3:  D1 Arch (deep)     │  D2 D3 D4 D5 (shallow)      │
│  Week 4:  D5 Meta (deep)     │  D1 D2 D3 D4 (shallow)      │
└─────────────────────────────────────────────────────────────┘
```

### Depth Criteria

| Depth | Scope | Verification | Risk | When to use |
|-------|-------|--------------|------|-------------|
| **Shallow** | < 50 lines changed, 1-2 files | `cargo build`, 1 deterministic test | Low — revert is trivial | Phase B, bug fixes, prompt adjustments |
| **Medium** | 50-500 lines, 2-5 files | Full test suite, 1 focused live eval | Medium — needs review | New interface, new harness, protocol extension |
| **Deep** | 500+ lines, 5+ files, design doc | Full test suite, 3+ live evals, metrics baseline check | High — needs design review first | Arch change, new engine capability, new workspace provider |

### "Done Enough" Checklist

Before declaring a dimension cycle complete, answer:

1. Does the dimension still produce drift signals? (If yes, continue.)
2. Are the immediate improvement candidates exhausted? (If yes, rotate.)
3. Does another dimension have a louder signal than this one? (If yes, rotate.)
4. Has a full test suite passed? (Always required.)
5. Have the relevant metrics (M1-M6) been checked or updated? (Required for
   deep work.)

---

## Debt Budget

Not every improvement needs to happen now. The debt budget makes deferral
explicit and reviewable.

### What Debt Means

Debt is a deferred improvement that is tracked, not forgotten. A debt entry
records:

```text
Debt ID: D-2026-06-22-001
Dimension: D2 (Engine)
Description: Agent-host shutdown drain window is hard-coded to 500ms.
  Should be configurable or derived from active task count.
Current cost: Rare — only affects tasks still running during shutdown.
Future cost: Will increase as daemon-driven tasks become the primary path.
Signal: Dev-log entry 2026-06-21 notes "tasks that finish within the short
  shutdown window" — this is a latent flakiness source.
Pay down when: D2 deep work cycle, or when a related engine reliability
  change touches the agent-host boundary.
```

### Budget Rules

1. **Track every deferral.** A deferred improvement without a debt entry is
   a forgotten improvement. Silent debt is the most expensive kind because it
   accumulates interest (workarounds, compat layers, retries) without anyone
   tracking the cost.

2. **Name the trigger for repayment.** Every debt entry must state the
   condition under which it should be paid: a specific dimension cycle, a
   related code change, a metrics threshold, or a signal from a live eval.

3. **Limit active debt to 5 entries.** More than 5 active debt entries means
   the system is accumulating faster than it can improve. When the limit is
   reached, no new debt may be deferred until an existing entry is paid down
   or explicitly closed as "no longer relevant."

4. **Debt must be visible in the dev-log.** The dev-log should include a
   "Residual" or "Debt" section in each entry. This ensures debt is reviewed
   during every development cycle.

5. **Debt is not shame.** A tracked, bounded, scheduled debt is a sign of
   disciplined prioritization. Untracked, unbounded, forgotten debt is a
   systemic risk.

### Deciding What To Defer vs. Do Now

```
Ask: Does this improvement fix a current failure mode?
  │
  ├── Yes → Do it now (current failure blocks other work)
  │
  └── No → Ask: Will this be cheaper to fix later?
       │
       ├── Yes → Defer with debt entry (track the trigger)
       │
       └── No → Ask: Is there a more urgent dimension?
            │
            ├── Yes → Defer with debt entry
            │
            └── No → Do it now (it will never be cheaper)
```

This decision tree prevents both over-deferral ("we'll fix it later" → never)
and over-implementation ("let's fix everything while we're here" →
scattered work).

---

## Putting It Together

The development theory in one diagram:

```
┌────────────────────────────────────────────────────────────┐
│  SIGNALS (metrics, eval findings, drift signals, dev-log)  │
│       │                                                     │
│       ▼                                                     │
│  DIMENSION SELECTION (which layer has the loudest signal?)  │
│       │                                                     │
│       ▼                                                     │
│  ROTATION (deep work or shallow pass)                       │
│       │                                                     │
│       ▼                                                     │
│  EXECUTION (bounded improvement + verification)             │
│       │                                                     │
│       ▼                                                     │
│  DEBT BUDGET (pay down, defer, or close)                    │
│       │                                                     │
│       ▼                                                     │
│  METHOD FEEDBACK (what did we learn about the process?)     │
│       │                                                     │
│       └───────────────→ BACK TO SIGNALS                     │
└────────────────────────────────────────────────────────────┘
```

Three rules to remember:

1. **Scattered improvements fail even when correct.** Always route an
   improvement to its owning dimension before implementing.

2. **Rotate deliberately.** Deep work on one dimension per cycle. Shallow
   passes on the rest. Never do deep work on more than one dimension at a
   time.

3. **Track every deferral.** A debt entry with a repayment trigger is
   responsible engineering. A forgotten improvement is technical debt in
   its classic, destructive form.

---

## Application: Assessing The Current State

Applying this theory to the project's current state:

| Dimension | Current Signal | Next Action |
|-----------|---------------|-------------|
| D1 Arch | Governance model is current. Design docs are linked and reviewed. | Shallow pass: verify no drift signals are firing. |
| D2 Engine | Recent work on cancellation notification, file store persistence, and Combine calibration is solid. Residual: shutdown drain window is hard-coded. | Deep pass candidate: configure the drain window or close the debt entry. |
| D3 Interface | CLI commands exist for eval, metrics, dogfood. Metrics framework (M1-M6) is documented but implementation may not be complete. | Medium pass: verify metrics CLI commands compile and produce useful output. |
| D4 Client/L0 | Operation harness prompts have been tightened through governance work. | Shallow pass: check that recent prompt changes did not increase token consumption (M1). |
| D5 Meta | Dogfood loop has retrievable artifacts. Dev-log is detailed. Method feedback is recorded. | Shallow pass: review whether method feedback from the last 3 entries has been acted on. |
