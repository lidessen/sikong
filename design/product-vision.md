# Product Vision

**Status:** Current (✓)
**Governs:** All layers — strategic direction, roadmap, iteration decisions
**Last Reviewed:** 2026-06-22

## What Is Sikong?

Sikong is a Rust-controlled recursive task-run engine with a Bun agent execution
boundary, workspace providers for side-effect isolation, and a dogfood loop that
turns live evidence into bounded improvements.

The core task-run transition is:

```text
ProblemNode
  -> Specify
  -> Execute | Plan
  -> child Resolve...
  -> Combine
  -> Verify
  -> Commit
```

Sikong is not an AI coding assistant, not a chat product, not a CI/CD system,
and not a workflow DSL. It is a durable coordination system for agent-driven
development — a kernel that separates deterministic state control from
uncertain model behavior, then makes the combination simpler, more stable, and
more powerful than either alone.

---

## 1. North Star: Reliable Agent-Driven Development

Sikong's north star is a world where adding intelligent agents to a development
system makes it **simpler, more stable, and more powerful** — not more complex,
fragile, or opaque.

This means:

**Simpler.** The deterministic orchestration code is smaller, more testable, and
easier to reason about than the heuristic pipeline it replaces. Agents own gray
areas; the engine owns state transitions, resources, verification, and commit.
The system has no hidden prompt logic smuggling behavior into prose, no second
sources of truth, and no brittle switch statements that grow with every new
edge case.

**More stable.** The system's guarantees come from Rust code, not model
reliability. Agent output is a **claim**, not a fact. It must pass verification
gates before it becomes durable state. A hallucinated path, a wrong analysis, or
an invalid plan is rejected — not propagated. The system survives bad model
behavior without corrupting state.

**More powerful.** Sikong can handle situations deterministic code cannot:
novel input the author never anticipated, complex judgment calls, contextual
adaptation during execution, and natural communication that is structured enough
for machines and fluid enough for humans. This is not magic — it is a different
engineering trade: define boundaries and let an intelligent node navigate within
them.

The north star is not "fully autonomous development." It is **reliable
augmentation** — a system where an engineer trusts the agent loop the same way
they trust a compiler: not because it is always right, but because the system
catches mistakes before they become durable state.

### North Star Operating Principles

1. **Agents explore. The system controls state. Only verified evidence becomes
   durable fact.** — This is the irreducible core loop.

2. **Design around smaller context projections, explicit tools, typed completion
   contracts, replayable state, and reviewable evidence.** — Never design around
   a stronger model, a longer prompt, or a more elaborate chat history.

3. **The boundary between orchestration and agent must be explicit, typed, and
   testable.** — Terminal tools, schemas, and verification gates define the
   contract. Prompt prose does not carry load-bearing behavior.

4. **Divide-and-conquer plus dynamic programming is the problem-solving
   mechanism.** — The engine recursively resolves nodes: specify the problem,
   execute if atomic, plan a child group if not, combine accepted child results,
   verify the candidate, commit only verified results.

5. **Rust owns deterministic state. Bun owns bounded agent loops.** — Neither
   side crosses the boundary without going through a typed terminal tool or a
   workspace provider.

6. **Learning is reviewed evidence, not silent mutation.** — Repeated failures
   improve the system through dogfood evidence, not hidden policy changes.
   Adaptation must be reviewable, evidence-linked, and reversible.

---

## 2. Strategic Territory

Sikong operates at the intersection of three territories that no existing tool
owns together:

### Territory A: Deterministic Agent Orchestration

The engine layer that sits **above** the model and **below** the user interface.

Existing tools fall into two camps:
- **Chat-based coding assistants** (Claude Code, Cursor, GitHub Copilot): Tight
  model integration, single-conversation loop, weak orchestration, no durable
  state machine, no formal verification.
- **Workflow/automation systems** (CI/CD pipelines, task runners, DSL engines):
  Deterministic, durable, verifiable — but cannot handle gray-area judgment,
  contextual adaptation, or novel situations without exploding combinatorial
  complexity.

Sikong's strategic territory is the **kernel that bridges these camps**: a
deterministic Rust state machine that orchestrates bounded agent loops through
explicit terminal tool contracts. It is not another chat product and not another
workflow DSL.

### Territory B: Recursive Divide-and-Conquer

Most agent systems solve flat problems: one prompt, one answer, one turn. When
the problem is large, they either fail (context overflow), hallucinate (best-effort
completion under pressure), or rely on brittle manual decomposition.

Sikong's territory is **recursive decomposition with dynamic programming**:
- The engine decides whether a problem is atomic or needs decomposition.
- `Specify` assesses scope; the engine routes to `Execute` or `Plan`.
- `Plan` creates exactly one child group (`stage` for ordered phases, `parallel`
  for independent surfaces).
- Each child re-enters `Specify` with the same mechanism.
- `Combine` converges accepted child artifacts.
- `Verify` gates acceptance.
- `Commit` applies verified results to durable state.

This is not a fixed pipeline. It is a recursive kernel that adapts to the
problem's evidence boundaries.

### Territory C: Dogfood-Driven Self-Improvement

Sikong's most distinctive territory is using Sikong to improve Sikong through a
disciplined, reviewable dogfood loop:

```text
name mainline and layer -> scope scenario -> run live eval
  -> inspect transcript and artifact sidecars -> accept one bounded change
  -> apply in the main workspace -> run deterministic checks
  -> build/update runtime when needed -> rerun focused live eval
  -> commit -> record learning
```

This is not autonomous self-modification. It is a structured operating loop
where:
- The transcript is primary evidence; agent-written reports are candidate
  interpretations.
- Each loop makes one bounded change.
- Deterministic checks must pass before commit.
- The development log records every loop outcome.
- Repeated findings become design changes, not manual folklore.

### Why These Territories Together

Each territory is defensible alone. Together they create a compounding advantage:

- Deterministic orchestration makes recursive decomposition safe (Territory A + B).
- Recursive decomposition makes large self-improvement tasks tractable (Territory B + C).
- Dogfood feedback tightens orchestration and decomposition rules (Territory C + A).

No existing tool occupies this intersection. Sikong's moat is not model quality —
it is the **architecture of reliable agent coordination**.

---

## 3. Milestones

### M0: Foundation (Current — Rust Prototype)

**Status:** Delivered

- Rust recursive agent engine with `Specify`/`Plan`/`Execute`/`Combine`/
  `Verify`/`Commit` operations.
- Agent-run protocol over Unix socket JSONL RPC.
- FileSystem, Memory, and GitFileSystem workspace providers.
- Governance model with typed layers and hard gates.
- Live eval mode with judge agent and structured verdicts.
- Dogfood scenarios for project analysis, redundancy audit, and design doc
  drafting.
- Assistant loop with ACP protocol, task board, and Claude Code integration.
- Metrics collection (M1-M6 token/time efficiency).
- CLI commands for eval, dogfood, assistant, and metrics.

### M1: Developer Preview — Reliable Single-Task Execution

**Target:** A developer can give Sikong a bounded development task and trust the
result.

- **Deterministic verification gates** catch scope leaks, protocol violations,
  and unsupported facts **before** they reach durable state.
- **Side-effect ledgers** and workspace-provider change capture make every agent
  action auditable.
- **Route-only eval** (stop after `Specify`/`Plan`) lets operators validate
  routing quality without spending full execution tokens.
- **Memo table** prevents repeated equivalent work.
- **Attempt table** prevents infinite retry loops.
- **Clear failure feedback** distinguishes "the task cannot be completed" from
  "try again with different input."

**Signals of completion:**
- A first-time user can run `siko run "fix the bug in src/main.rs"` and get a
  correct, verified patch or a clear explanation of why it cannot be done.
- The eval suite passes for the core operation matrix (Specify/Plan/Execute/
  Combine/Verify) across all scenario branches.
- No hard gate violation escapes into durable state during normal operation.

### M2: Concurrent Workflow — Multi-Task Coordination

**Target:** Sikong coordinates multiple tasks in the same workspace without
conflict.

- **Scope-lease-based commit** serializes workspace writes so concurrent task
  execution is safe.
- **GitFileSystem worktree isolation** lets each task run in its own branch.
- **Frontier scheduler** runs independent nodes concurrently.
- **Integration workspace** merges accepted branch deltas with conflict
  detection.
- **Conflict resolution** through recursive decomposition when integrations
  collide.

**Signals of completion:**
- Two independent tasks can execute concurrently in the same git repository
  without corrupting each other's state.
- The engine detects write-scope conflicts and either serializes or escalates
  for resolution.
- A multi-task dogfood scenario (e.g., fix two unrelated bugs) completes faster
  than serial execution.

### M3: Dogfood Reliability — Self-Improvement Loop Closes

**Target:** Sikong can reliably improve itself through the dogfood loop,
producing one bounded improvement per cycle.

- **Dogfood pack** for the assistant provides structured self-improvement
  context and tools.
- **Autonomous iteration scenario** (`evals/task-run/autonomous-iteration.yaml`)
  runs the full cycle: analyze → propose → verify → apply.
- **Design-first start** ensures conceptual work begins with design documents,
  not code patches.
- **Cheap routing eval** validates decomposition before expensive execution.
- **Patch-proposal mode** produces concrete patches with diff sketches and test
  commands.
- **Apply mode** (writable git workspace) applies verified patches directly.

**Signals of completion:**
- `siko dogfood run --scenario sikong-next-improvement` produces one bounded,
  verified improvement with retrievable evidence.
- The development log shows a closed loop for each dogfood cycle.
- Repeated dogfood findings are promoted into design documents or prompt
  guidance, not left as one-off eval noise.

### M4: Public Beta — Daily Development Use

**Target:** Sikong is useful for daily development work beyond Sikong itself.

- **Stable CLI** with discoverable commands and structured JSON output.
- **Assistant pack system** for injecting domain-specific capability surfaces.
- **Task-board persistence** across sessions and processes.
- **Daemon-backed execution** for long-running tasks.
- **Web UI** provides task inspection and activity stream.
- **Documentation** covers architecture, design philosophy, CLI reference, and
  dogfood procedures.

**Signals of completion:**
- An external developer can install Sikong, create a workspace, run a
  development task, and inspect the result without reading the design docs.
- The assistant can maintain a task board across multiple sessions.
- Dogfood runs against the Sikong repository produce bounded improvements
  without manual intervention.

### M5: Recursive Engine Maturity — Large-Goal Decomposition

**Target:** Sikong reliably decomposes large goals into independently solvable
subproblems.

- **Deep recursive decomposition** handles 2-3 levels of planning depth for
  complex tasks.
- **Evidence-surface routing** reliably identifies independent subproblems.
- **Parallel child execution** with efficient streaming of completed children.
- **Synthesis quality** ensures `Combine` produces coherent results from
  independently solved parts.
- **Policy packs** let task types (design, code_change, research, debug) define
  planning strategy without adding kernel operations.

**Signals of completion:**
- A task like "design and implement a new CLI command" reliably produces a
  decomposed plan with ordered or parallel child work.
- The judge passes cognitive-load evals that require multi-level decomposition.
- Policy packs allow task-type-specific behavior without engine changes.

---

## 4. Non-Goals

Sikong explicitly does not aim to be:

### Not a Chat Product

Sikong does not replace Claude Code, Cursor, GitHub Copilot, or any other
conversational coding assistant. The assistant layer exists for task intake and
status reporting, but the durable thinking happens in the recursive engine.
Conversation is input and presentation, not state.

### Not a Workflow DSL

Sikong does not provide a user-configurable workflow language, stage guards,
arbitrary transitions, or dependency graph definitions. The coordination
protocol is fixed: `Specify` → `Plan` → `Execute`/`Combine` → `Verify` →
`Commit`. Methodology is supplied by planner output and policy packs, not by a
workflow definition file.

### Not Fully Autonomous Development

Sikong does not aim to replace human developers. It aims to **augment** them
with reliable, bounded, reviewable agent execution. The dogfood loop is
deliberately reviewable: the transcript is primary evidence, agent-written
reports are candidate interpretations, and deterministic checks gate every
commit.

### Not a CI/CD System

Sikong does not replace CI pipelines, build systems, or deployment automation.
It does not schedule recurring jobs, manage release artifacts, or enforce
deployment policies. It solves the different problem of **upstream development
work** — analysis, design, implementation, review — where the inputs are
ambiguous and the correct path is not known in advance.

### Not a Model Quality Play

Sikong's advantage does not come from using the strongest available model.
It comes from architecture: separating deterministic control from model
behavior, using typed contracts and verification gates, and treating agent
output as claims rather than facts. The system should work with any capable
model and improve as models improve, but model quality is a tailwind, not the
engine.

### Not a General Task Runner

Sikong does not aim to run any possible task. It solves `ProblemNode` instances
through a fixed set of node operations. Tasks that do not fit this model
(resource-intensive batch computation, real-time control, interactive creative
work) are outside scope.

### Not a Multi-Workspace Orchestrator (Yet)

The initial implementation targets single-workspace coordination. Multi-workspace
orchestration, cross-repository changes, and multi-team coordination are
deferred until the single-workspace kernel is proven.

---

## 5. How Direction Informs Daily Iteration Decisions

The north star, strategic territory, and milestones translate into concrete
decision rules for daily development:

### Decision Rule 1: Route Before Execute

Every meaningful change starts by identifying the owning layer:

| Layer | Question to ask |
|-------|-----------------|
| Arch | Is a protocol, contract, or governance rule ambiguous or missing? |
| Plan | Are we splitting at the right evidence boundaries? |
| Execute | Is the local change bounded and verifiable? |
| Verify | Are the acceptance gates catching what they should? |
| Meta | Is this a repeated finding that should become a design rule? |

**If the owning layer is unclear, do not implement. Route first.**

### Decision Rule 2: One Change Per Loop

Each development cycle should make one bounded change:

- One design document revision OR one code change — not both in the same commit.
- One dogfood finding promoted to design OR one eval scenario added — not both.
- One protocol tightening OR one new tool — not both.

This prevents scattered improvements that are individually valid but collectively
erode the system.

### Decision Rule 3: Fix the Mechanism, Not the Prompt

When behavior is bad, repair in this order:

1. Reduce over-projected context (most common failure).
2. Tighten schemas, typed decoding, workspace invariants, or deterministic
   checks.
3. Adjust qualitative prompt guidance.
4. Rerun the same live eval.

Avoid "do not invent X" prompt patches. If a detail is required, put it in the
input context or terminal schema. If it is not required, keep the prompt at the
right abstraction level.

### Decision Rule 4: Evidence Over Opinion

Every claim needs a falsifiable observation:

- "The engine handles concurrent tasks" is not evidence. A test that would fail
  if concurrent tasks conflicted is evidence.
- "The agent wrote good code" is not evidence. A deterministic check that the
  diff is scoped, tests pass, and no unrelated files changed is evidence.
- "The dogfood loop works" is not evidence. A development-log entry with
  retrievable artifact, deterministic check output, and recorded learning is
  evidence.

### Decision Rule 5: Decompose By Evidence Surface, Not By Document Structure

A task should split when it improves at least one of:

- Independent evidence collection (surfaces that can be inspected separately).
- Context pressure (too much context for one agent run).
- Conflict isolation (changes that could interfere).
- Failure blast-radius reduction (one child failing should not lose all
  progress).
- Staged understanding (later work depends on earlier accepted output).

Do not split because the final answer has sections. Do not keep work atomic
just because the final artifact is one report. The evidence boundary decides.

### Decision Rule 6: Preserve the Kernel, Compose Projections

New capabilities must compile into the existing core loop. Ask:

- Which `NodeOperation` does this affect?
- Which artifact, workspace resource, event, or verification result does it
  produce?
- Is it part of `task_run`, `task_board`, `assistant`, `workspace`, or
  `agent_run` — or only a projection over those?

If the answer is "it is another planner, scheduler, learner, or quality engine,"
simplify it until it becomes a projection or remove it.

### Decision Rule 7: Dogfood Before Release

No new capability ships without dogfood evidence:

1. Run at least one dogfood scenario that exercises the new capability.
2. Record the transcript and artifact.
3. Name at least one concrete signal the next dogfood run should look for.
4. If the capability changes a prompt or protocol, run the focused eval before
   and after.

### Decision Rule 8: Close Every Loop

Every session ends in one of three states:

- **Closed**: Claim matches evidence and the relevant artifact/log/commit is
  present.
- **Handoff**: Current state, verified facts, next action, and next check are
  recorded.
- **Blocked**: Blocking fact, missing authority, or required decision is named.

Do not leave work where the next agent must infer whether the last correction
was observed.

### Applying These Rules: A Worked Example

**Situation:** A live eval shows the agent spending too many tool calls reading
files it already read.

**Analysis:**
1. **Route:** This is a context-projection issue (L0/L1 boundary), not a
   protocol issue (Arch) or a routing issue (Plan). Owning layer: Execute
   harness or agent-run prompt.
2. **One change:** Tighten the operation context to include file summaries
   that were previously injected as raw paths. Do not also redesign the
   workspace provider in the same change.
3. **Fix mechanism, not prompt:** The problem is missing context, not bad model
   behavior. Inject file content directly into the operation context instead of
   asking the agent to read files whose content is already known.
4. **Evidence:** Before: the transcript shows 8 Read tool calls for files whose
   content was already in the parent context. After: reduce to 2-3 Read calls
   for files that genuinely need fresh inspection.
5. **Close:** Record the change, the before/after transcript evidence, and the
   reduction in tool calls.

This is the daily operating rhythm: one bounded observation → one bounded
change → one piece of evidence → one closed loop.

---

## Appendix: Vision in One Diagram

```text
NORTH STAR: Reliable Agent-Driven Development
│
├── Strategic Territory ─────────────────────────────┐
│                                                     │
│  Deterministic      Recursive         Dogfood-      │
│  Orchestration  +   Divide-and-   +   Driven Self-  │
│  (Rust kernel,      Conquer          Improvement     │
│   typed contracts,  (Specify/Plan/   (reviewable     │
│   verification      Execute/Combine/  loop, bounded  │
│   gates)            Verify/Commit)    changes)       │
│                                                     │
└─────────────────────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     M0: Foundation  M1: Dev Preview  M2: Concurrent
     (Delivered)     (Single-Task     Workflow
                     Reliability)
          ┼              ┼              ┼
          ▼              ▼              ▼
     M3: Dogfood     M4: Public Beta  M5: Large-Goal
     Reliability    (Daily Use)      Decomposition
          ┼              ┼              ┼
          └──────────────┼──────────────┘
                         ▼
             Compounding advantage over time
```

The milestones build on each other. M0 (Foundation) enables M1 (single-task
reliability). M1 enables M2 (concurrent workflow). M2 enables M3 (dogfood
reliability). M3 enables M4 (public beta). M3 + M4 drive M5 (large-goal
decomposition).

Each milestone is gated by the one before it. No milestone requires a model
capability that does not already exist. Each milestone closes a specific gap
between the current state and the north star.
