# Development Philosophy

This document summarizes the design philosophy that should guide future Sikong
development, using both this repository and `../agent-worker` as reference
systems.

The purpose is to prevent drift. A feature can pass tests and still move the
system away from the intended shape if it adds a second source of truth, makes
prompt prose carry load-bearing behavior, or turns agent output into accepted
state without an explicit verification boundary.

## Shared Direction

Both projects are attempts to build reliable agent engineering systems by
separating uncertain model behavior from deterministic control.

The shared philosophy is:

```text
Agents explore.
The system controls state.
Only verified evidence becomes durable fact.
```

Do not design around a stronger model, a longer prompt, or a more elaborate
chat history. Design around smaller context projections, explicit tools,
typed completion contracts, replayable state, and reviewable evidence.

## Sikong In One Sentence

Sikong is a Rust-controlled recursive task-run engine with a Bun agent
execution boundary, workspace providers for side-effect isolation, and a
dogfood loop that turns live evidence into bounded improvements.

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

Important consequences:

- Rust owns task state, node state, workspace resources, verification gates,
  and commit decisions.
- Bun owns one bounded agent loop at a time.
- Agent output is a candidate artifact until `Verify` accepts it.
- Workspace changes are resources owned by workspace providers, not facts
  reported by the agent.
- Broad work is divided only when division improves evidence quality, context
  load, conflict isolation, or acceptance clarity.
- Dogfood is not another engine. It is the operating loop that reviews
  artifacts, applies bounded changes, rebuilds runtime when needed, reruns
  focused eval, commits, and records learning.

## Agent-Worker In One Sentence

`agent-worker` is a contract-governed swarm harness where boundary demand
creates pressure, pressure opens contract obligations, bounded Wakes produce
claims, and settlement promotes accepted claims into durable facts.

Its irreducible loop is:

```text
BoundaryInput
  -> Signal / AttentionField
  -> Contract obligation
  -> Wake
  -> Claim + Resource evidence
  -> Settlement
  -> Fact | repair | integration | PromotionCandidate
```

Important consequences:

- Conversation is not the durable context carrier; semantic events and
  resources are.
- Wake completion is not fact acceptance.
- WorkItem-like records are scheduling projections, not acceptance sources.
- Quality, routing, repair, learning, and status must compile back into
  pressure, obligation, evidence, settlement, integration, or promotion
  evidence.
- Semantic decisions must not rely on regex, `includes(...)`, keyword lists,
  or fixed phrase matching. Use typed contracts, explicit schemas, verifier
  judgment, structural parsers, rubric resources, and settlement history.

Reference design anchors:

- `../agent-worker/design/DESIGN.md`
- `../agent-worker/design/decisions/009-attention-driven-system-protocol.md`
- `../agent-worker/design/decisions/022-contract-governed-swarm-kernel.md`
- `../agent-worker/design/decisions/026-irreducible-core-mechanisms.md`
- `../agent-worker/design/decisions/027-attention-field-dynamic-programming.md`
- `../agent-worker/design/decisions/028-dynamic-reducer-simplification.md`

## Shared Laws

### 1. Conversation Is Not State

Chat history is useful input, but it is not the system of record.

Use durable structures:

- Sikong: nodes, artifacts, workspace resources, operation events, agent run
  records, task-board state, design docs, development logs.
- Agent-worker: HarnessEvents, Contracts, Wakes, Resources, Handoffs, settled
  Facts, PromotionCandidates.

If a future feature needs old context, expose a bounded query tool or a
compressed artifact. Do not rebuild reliability around a giant rolling prompt.

### 2. Agent Output Is A Claim Until Accepted

The model may generate useful work, but it does not decide truth.

In Sikong:

- `submit_work` creates a candidate artifact.
- `submit_verdict` or deterministic verification accepts or rejects it.
- `Commit` records only accepted artifacts.

In agent-worker:

- `finish_current_work` fills a contract clause.
- settlement is the acceptance boundary.
- accepted settlement creates durable facts and downstream pressure.

This rule should fail closed. If decoding, schema validation, workspace
capture, verification, or settlement is ambiguous, the system should reject,
prune, repair, or request information rather than silently accept.

### 3. Prompts Are Context Projections

A prompt should project the current layer's load-bearing context, not dump the
system into the model.

Keep the 30/70 split:

- the system supplies the load-bearing 30%: objective, boundary, allowed
  workspace, available tools, terminal schema, acceptance evidence;
- the agent owns the local 70%: exploration order, implementation detail,
  wording, focused checks, and local reasoning.

When behavior is bad, repair in this order:

1. reduce over-projected context;
2. tighten schemas, typed decoding, workspace invariants, or deterministic
   checks;
3. adjust qualitative prompt guidance;
4. rerun the same live eval.

Avoid long forbidden-example lists. They are usually evidence that the prompt
or schema boundary is wrong.

### 4. Keep One Kernel, Many Projections

New features must compile into the existing core loop.

For Sikong, ask:

- Which `NodeOperation` does this affect?
- Which artifact, workspace resource, event, or verification result does it
  produce?
- Is it part of `task_run`, `task_board`, `assistant`, `workspace`, or
  `agent_run`, or only a projection over those?

For agent-worker, ask:

- What pressure does this add?
- Which contract obligation does it open or inhibit?
- Which Wake claim or Resource evidence does it preserve?
- Which settlement fact, repair pressure, integration pressure, or promotion
  evidence does it produce?

If the answer is "it is another planner, scheduler, learner, quality engine,
memory engine, or repair engine," simplify it until it becomes a projection or
remove it.

### 5. Divide Only When It Reduces Risk

Decomposition is a strategy, not a ritual.

Split when it improves at least one of:

- independent evidence collection;
- context pressure;
- conflict isolation;
- failure blast-radius reduction;
- comparable candidate evaluation;
- staged understanding where later work depends on earlier accepted output.

Do not split because the final answer has sections. Do not keep work atomic
just because the final artifact is one report. The evidence boundary decides.

In Sikong, `Plan` creates exactly one local `stage` or `parallel` child group.
Children re-enter `Specify`; parent `Combine` performs convergence.

In agent-worker, decomposition is one attention-field transition such as
`fanout`, `quorum`, or `integrate`. Child results do not close the parent
without integration and settlement.

### 6. Tools Are Capabilities, Not Hidden Control Flow

Tool availability should be explicitly injected by the harness or pack for the
current run.

Do not make the runtime infer business behavior from tool names. Terminal
semantics belong to the run's terminal tool set or active contract clause.
Tools should represent actions, bounded queries, or terminal submissions.

Avoid context-reader tools that only return the immutable current request.
Inject immutable context directly into the prompt/input packet.

### 7. Workspace Effects Belong To Workspace Providers

Agents should not report changed paths as truth.

The workspace layer should capture, verify, merge, and clean up effects:

- memory workspace for self-contained artifacts;
- filesystem workspace for current dirty-tree inspection;
- git filesystem workspace for isolated writable worktrees and commit
  resources.

Conflict resolution is workspace plus agent work, but the resource lifecycle
and changed-path facts belong to the provider.

### 8. Learning Is Reviewed Evidence, Not Silent Mutation

Repeated failures should improve the system, but not by hidden policy mutation.

Sikong uses dogfood evidence:

```text
live eval -> transcript/artifact -> bounded change -> deterministic checks
  -> runtime rebuild when needed -> focused live eval -> commit -> log
```

Agent-worker uses PromotionCandidates:

```text
settlement history -> promotion evidence -> review -> accepted policy change
```

Both designs reject silent learning. Adaptation must be reviewable, evidence
linked, and reversible.

### 9. Tests Match The Claim

Use the smallest test band that proves the claim.

- Deterministic tests prove reducers, schemas, decoding, prompt rendering,
  workspace invariants, and protocol mapping.
- Local-real integration tests prove filesystem, git, socket, subprocess,
  daemon, and storage seams.
- Provider-real live eval/smoke tests prove real model/tool behavior and
  usefulness.

Provider-real failures should not directly rewrite architecture. First decide
whether the failure is mechanism, prompt/context projection, model mismatch,
provider behavior, or test fragility. Mechanism bugs need deterministic or
local-real regressions.

## Drift Signals

Treat these as design review failures:

- a new subsystem owns acceptance, routing, memory, learning, or repair
  independently of the core loop;
- a prompt rule carries behavior that should be schema, typed decoding,
  workspace invariant, or state transition;
- a worker output is committed because it sounds plausible;
- a judge returns a score, confidence number, or vague quality rating instead
  of structured evidence;
- fixed phrases, regexes, keyword includes, or hard-coded text snippets decide
  semantic quality;
- an operation reads context through a tool even though the immutable context
  was already known before the run;
- a child task or Wake can close the parent without integration and parent
  verification;
- runtime settings, CLAUDE.md, plugins, or ambient user configuration leak into
  the agent run instead of being mounted explicitly;
- legacy Go/Bun Sikong surfaces shape new Rust mainline behavior;
- dogfood runs pass without retrievable artifacts, deterministic checks, or a
  recorded learning entry.

## Review Checklist

Before accepting a non-trivial change, answer:

1. What is the core state transition this change participates in?
2. What is the source of truth after this change?
3. What agent output remains only a claim?
4. What deterministic or local-real check proves the mechanism?
5. What provider-real eval proves the model/tool behavior, if any?
6. What artifact or event lets a future run understand this decision without
   replaying the whole conversation?
7. If this is an adaptation, where is the reviewable evidence?
8. If this adds a concept, why is it not just a projection?

If these answers are weak, the change should be redesigned before it grows.
