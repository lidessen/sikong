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

## Lower-Level Operating Method

The `agent-worker` skills summarize a lower-level method than the architecture
docs. That method should guide Sikong work too.

### Name The 30% Before Acting

Before a state-changing move, name the load-bearing constraint:

```text
30%: the current principal tension that must not be lost
```

The 30% is not a percentage calculation. It is the slow-changing skeleton that
determines whether the rest of the work is useful: target, system shape,
acceptance boundary, observation quality, authority, or continuity. Everything
else is the local 70% and should stay cheap to retry.

The reason this works is divide-and-conquer plus attention layering. Agent
development creates too many local details for one controller to govern
directly. A reliable system therefore separates the mainline from branches:
hold the top-level thread tightly, delegate or recurse into bounded
subproblems, and let those subproblems make local choices inside their own
contracts.

The 30% is the upper layer of the divide. It preserves the mainline:

- what problem is being solved;
- which boundary must not be crossed;
- what evidence would prove progress;
- what authority exists;
- what result must return upward.

The 70% is the lower layer. It is allowed to vary because local mistakes are
cheap when the parent boundary is intact. A helper can be renamed, a child can
choose a different inspection path, a patch can be retried, and a worker can
repair local output. Those changes are acceptable as long as they do not change
the parent target, acceptance boundary, authority, or evidence contract.

This is also why the system should not make the top layer watch every detail.
Full-detail governance is too expensive and eventually collapses into context
overload. The right control strategy is to constrain the parent layer and make
child autonomy safe:

```text
parent preserves mainline and acceptance
  -> child owns local execution
  -> child returns compressed evidence
  -> parent integrates or rejects
```

If a child discovers that a local detail now changes the parent boundary, that
detail is no longer 70%. It must return upward as a 30% candidate instead of
being handled locally.

If the 30% cannot be named, the next action is not implementation. Recover the
route first.

### Route By The Layer That Owns The Uncertainty

Use layers as ownership boundaries, not as mandatory phases:

| Layer     | Owns                                                                   |
| --------- | ---------------------------------------------------------------------- |
| `goal`    | direction, success criteria, STOP conditions, user-level tradeoffs     |
| `design`  | system shape, module boundaries, mechanism ownership, durable protocol |
| `fact`    | observations that can prove or falsify a progress claim                |
| `reframe` | category/lens replacement when the old vocabulary cannot guide work    |
| `harness` | project wiring, context entry, authority, handoff, future-agent setup  |

Sikong maps these layers onto its own artifacts:

- `goal`: user request, task-board intent, development-log target;
- `design`: `design/*.md`, Rust module boundaries, operation/tool protocol;
- `fact`: deterministic tests, local-real workspace tests, live eval
  transcripts, artifact sidecars;
- `reframe`: new engine model or capability model before it hardens into
  design;
- `harness`: `AGENTS.md`, runtime host launch/config, scenario fixtures,
  dogfood commands, handoff conventions.

Route to the smallest layer that owns the current uncertainty. Do not use
`design` for one failed local test. Do not keep patching execution when the
boundary assumption is wrong.

### Treat Work As A Steered System

For noisy or recurring work, use the control-loop frame:

```text
target -> observation -> gap -> smallest correction -> observe again
```

Before pushing harder, know:

- what system is being steered;
- what target state matters;
- how the current state is observed;
- which gap matters now;
- what authority exists to change it;
- what disturbance may move it away from target;
- what observation means the loop can stop.

If the target cannot be observed and current actions cannot change it, the work
is not steerable. Route to `fact`, `goal`, or `harness` before executing.

If the same correction fails twice without shrinking the gap, stop applying the
same force. Identify the failed assumption:

```text
Assumption:
Contradicting observation:
Smallest distinguishing check:
```

Then route by the result: noisy observation -> `fact`; wrong local correction
-> execution; wrong system shape -> `design`; wrong target -> `goal`; wrong
category lens -> `reframe`; missing context or authority -> `harness`.

### Facts Must Be Falsifiable

No progress claim survives without an observation that could have shown the
opposite.

Good evidence names the failure it would catch. A test that would still pass if
the claimed behavior were removed is not evidence. A live eval whose artifact
cannot be retrieved is not enough. A manual check without captured output is
not enough for future agents.

Use the closest useful evidence:

- deterministic tests for reducers, schemas, prompts, decoding, invariants;
- local-real integration tests for filesystem, git, sockets, subprocesses,
  daemon, storage;
- provider-real live evals for model/tool behavior;
- artifact sidecars, logs, screenshots, traces, or review findings when those
  are the observable surface.

When facts are noisy, improve the observation before averaging them into a
vague confidence claim.

### Main Agent Holds The Skeleton, Workers Spend Context

The main agent owns steering context:

- the 30%;
- route and layer ownership;
- acceptance standard;
- risk and authority;
- review of compressed returns;
- durable record of what changed.

Workers own bounded execution detail:

```text
30%: structural constraint to preserve
Task: bounded local execution
Evidence: observable proof to return
Stop: when to stop instead of expanding scope
```

Worker results should return compressed evidence:

```text
Conclusion:
Evidence:
Risks:
Changed paths:
Stop hit:
```

Do not import full worker traces into the long-running context unless the
evidence is insufficient or the 30% itself is in doubt. A worker that discovers
a new load-bearing constraint should stop and report it as a 30% candidate
instead of continuing as if it were local 70%.

### Close Every Loop

Every session should stop in one of three states:

- **Closed**: claim matches evidence and the relevant artifact/log/commit is
  present.
- **Handoff**: current state, verified facts, next action, and next check are
  recorded.
- **Blocked**: blocking fact, missing authority, or required decision is named.

Do not leave work in a state where the next agent must infer whether the last
correction was observed.

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

### 1. Preserve The 30%, Keep The 70% Cheap

The system should spend most attention on slow variables and keep local detail
replaceable.

Preserve:

- goal line and acceptance criteria;
- design boundaries and protocol shape;
- fact evidence and verification model;
- harness entry context and authority;
- dogfood loop evidence.

Keep flexible:

- local helper names and code layout;
- exploration order;
- equivalent test style;
- wording inside non-load-bearing reports;
- first-pass implementation tactics.

When a local detail starts carrying callers, protocols, or acceptance meaning,
it has migrated into the 30%. Either ratify it through design or restore the
boundary.

### 2. Conversation Is Not State

Chat history is useful input, but it is not the system of record.

Use durable structures:

- Sikong: nodes, artifacts, workspace resources, operation events, agent run
  records, task-board state, design docs, development logs.
- Agent-worker: HarnessEvents, Contracts, Wakes, Resources, Handoffs, settled
  Facts, PromotionCandidates.

If a future feature needs old context, expose a bounded query tool or a
compressed artifact. Do not rebuild reliability around a giant rolling prompt.

### 3. Agent Output Is A Claim Until Accepted

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

### 4. Prompts Are Context Projections

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

### 5. Keep One Kernel, Many Projections

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

### 6. Divide Only When It Reduces Risk

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

### 7. Tools Are Capabilities, Not Hidden Control Flow

Tool availability should be explicitly injected by the harness or pack for the
current run.

Do not make the runtime infer business behavior from tool names. Terminal
semantics belong to the run's terminal tool set or active contract clause.
Tools should represent actions, bounded queries, or terminal submissions.

Avoid context-reader tools that only return the immutable current request.
Inject immutable context directly into the prompt/input packet.

### 8. Workspace Effects Belong To Workspace Providers

Agents should not report changed paths as truth.

The workspace layer should capture, verify, merge, and clean up effects:

- memory workspace for self-contained artifacts;
- filesystem workspace for current dirty-tree inspection;
- git filesystem workspace for isolated writable worktrees and commit
  resources.

Conflict resolution is workspace plus agent work, but the resource lifecycle
and changed-path facts belong to the provider.

### 9. Learning Is Reviewed Evidence, Not Silent Mutation

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

### 10. Tests Match The Claim

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
- a session ends after applying a correction but before observing whether the
  gap shrank;
- fast-loop noise rewrites slow artifacts such as goal, design, AGENTS, or
  runtime policy without repeated evidence;
- a worker changes the task's 30% instead of stopping and reporting the new
  load-bearing constraint.

## Review Checklist

Before accepting a non-trivial change, answer:

1. What is the current 30%?
2. Which layer owns the uncertainty: goal, design, fact, reframe, or harness?
3. What is the core state transition this change participates in?
4. What is the source of truth after this change?
5. What agent output remains only a claim?
6. What deterministic or local-real check proves the mechanism?
7. What provider-real eval proves the model/tool behavior, if any?
8. What artifact or event lets a future run understand this decision without
   replaying the whole conversation?
9. If this is an adaptation, where is the reviewable evidence?
10. If this adds a concept, why is it not just a projection?
11. Did the loop close as closed, handoff, or blocked?

If these answers are weak, the change should be redesigned before it grows.
