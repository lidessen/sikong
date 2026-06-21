# Prompt Guidance Theory

This document defines the prompt-shaping theory for Sikong's new Rust agent
engine. It borrows the useful core from the `agent-worker` harness method and
localizes it to Sikong's recursive task-run model.

The goal is not to create a new ceremony. The goal is to make every prompt keep
the right layer of attention, expose the right evidence, and leave ordinary
execution freedom to the agent loop.

## Core Idea

A prompt is a context projection, not a chat transcript.

Sikong should not ask one long-running conversation to remember everything,
execute everything, verify itself, and manage the operator relationship. Each
agent run receives a purpose-built projection of the larger system state:

- the current operation objective;
- the load-bearing constraints for that operation;
- the structured context packet needed for this run;
- the tools that can produce the terminal result;
- the evidence standard for the result.

Everything else stays outside the run. Full history, raw logs, unrelated files,
ambient repository state, and previous worker traces are not prompt material
unless the current operation explicitly needs them.

## Attention Layers

Sikong uses attention layers instead of one universal prompt.

| Layer | Sikong owner                  | Context shape                                       | Lifetime               | Prompt duty                           |
| ----- | ----------------------------- | --------------------------------------------------- | ---------------------- | ------------------------------------- |
| L0    | one agent-loop run            | focused operation context                           | one terminal tool call | execute one bounded operation         |
| L1    | task-run engine node tree     | events, artifacts, node state                       | one task run           | route, split, combine, verify, commit |
| L2    | assistant/task board          | recent conversation, task summaries, selected packs | one assistant session  | manage user intent and task portfolio |
| L3    | durable project memory/design | design docs, logs, decisions                        | across sessions        | preserve slow-changing system shape   |

Layer violations are prompt bugs:

- L0 prompts should not contain full task history when one operation context
  projection is enough.
- L1 should not import raw L0 tool traces when a compressed artifact and event
  record is enough.
- L2 should not behave like a traditional chat transcript; it should inspect
  durable stores through tools when older detail is needed.
- L3 docs should not contain volatile execution details that belong in logs,
  events, or test output.

## The 30/70 Rule

Every prompt should preserve the load-bearing 30% and let the agent own the
local 70%.

The load-bearing 30% is the constraint whose failure invalidates the run:

- for `Specify`: the user's full current intent and the size of the next useful
  work;
- for `Plan`: the main contradiction that determines whether the child group is
  stage or parallel;
- for `Execute`: the bounded local task, allowed workspace surface, and evidence
  needed to prove the result;
- for `Combine`: the parent intent and accepted child evidence that must be
  synthesized;
- for `Verify`: the candidate, node intent, and acceptance evidence;
- for `Assistant`: the latest user message, current focus, task board surface,
  and mounted capability packs.

The prompt should not micromanage the 70%:

- do not prescribe file-by-file steps unless those steps are the acceptance
  boundary;
- do not encode brittle phrase checks, regex-like success rules, or examples as
  hidden tests;
- do not force a worker to use a specific exploration sequence when the terminal
  schema and evidence standard already define success;
- do not route every local uncertainty to the user.

If ordinary execution discovers that a 70% detail has become load-bearing, the
agent should stop through the appropriate terminal result: concrete blocker,
`need_information`, invalid plan, or a report that names the structural issue.

## Prompt Section Shape

Agent prompts should be section lists with stable titles. A section is useful
only if it changes the model's decision or gives it evidence it cannot infer.

Recommended section order for operation prompts:

1. `Role`: one sentence naming the operation responsibility.
2. `Operation Context`: structured JSON packet injected directly, not hidden
   behind a context-reader tool.
3. operation-specific lens: the 30% constraint for this operation.
4. standard/rubric: what a good terminal result must satisfy.
5. non-goals/boundaries: what this run must not do.
6. `Completion`: which terminal tools end the loop.

Avoid these prompt smells:

- giant prose blobs with no stable section titles;
- duplicated context in both prompt and read-context tools;
- context-reader tools whose only purpose is returning the current packet;
- score-like fields for model self-assessment;
- examples that are so concrete they become accidental rules;
- long forbidden-example lists used to patch one failed live eval;
- old field names in prose after the schema has changed.

## Prompt Tuning Discipline

Bad model behavior is not automatically evidence that the prompt needs more
rules. Before adding prose, check the simpler failure modes:

- the prompt may be projecting too much context into the run;
- `Specify` or `Plan` may be making the task more specific than the raw intent;
- the terminal tool schema may be too loose;
- the engine state machine may be accepting a result that should be structurally
  invalid;
- the verifier may be judging against details introduced by earlier operations
  instead of the original node intent and available context.

The preferred repair order is:

1. reduce the prompt to the current operation's load-bearing 30%;
2. move enforceable shape constraints into JSON Schema, typed Rust decoding, or
   deterministic engine checks;
3. keep the prompt guidance qualitative and intent-preserving;
4. rerun the same live eval before adding more wording.

Avoid "do not invent X, Y, Z" patches. They often teach the model that those
fields are expected and turn unknown details into template slots. If a detail is
required, make it part of the input context or terminal schema. If it is not
required, keep the prompt at the right abstraction level and let the artifact
say less.

## Operation Guidance

### Specify

`Specify` turns raw intent into the next useful unit of work.

It should answer:

- What is the next work text that preserves the user's stated responsibility?
- What is the size of that next work?
- Why does that size fit?

Information gathering is not a separate special mode. If the task is blocked by
missing facts, `Specify` should make the next work the concrete evidence-gathering
task and size that task. It should not emit `missing_info`, `route`, or hidden
control fields.

### Plan

`Plan` creates exactly one local child group.

It should use the main contradiction lens:

- use `stage` when one item changes the understanding needed by the next item;
- use `parallel` only when all items can start from the parent context and do
  not need sibling outputs;
- do not add a synthesis/final-report child to a parallel group, because parent
  `Combine` owns convergence.

Plan items are child responsibilities, not checklist rows. A child should be
large enough to re-enter `Specify` and solve its own local 70%.

### Execute

`Execute` is the short-lived L0 worker run.

It should inspect only the relevant context, perform local reversible work when
allowed, and submit the smallest complete result plus useful evidence. It should
not claim whole-task success, split the task, or infer facts from ambient
repository state that was not present in Operation Context.

### Combine

`Combine` converts child artifacts into one parent artifact.

It should extract, reconcile, and synthesize. It should not paste child outputs
together, restart execution, or defer because it wants more context. The
Operation Context is the complete available input for this pass.

### Verify

`Verify` is a claim test, not an editor.

It returns one of:

- `accept`: the candidate satisfies the node with available evidence;
- `reject`: the same node can repair the gap, and feedback names what must
  change;
- `need_information`: acceptance depends on a concrete missing fact.

Verification should avoid style-only rejection and avoid asking for more
information when the current candidate is simply incomplete.

## Compression And Evidence

Higher layers consume compressed evidence, not raw traces.

An L0 run may produce many tool calls and intermediate observations. L1 should
keep the durable parts:

- terminal tool name and arguments;
- candidate artifact or child artifact;
- verification verdict and reason;
- changed paths or workspace resource facts generated by the workspace provider;
- concise event notes and timing/token telemetry.

Do not promote raw logs, full transcripts, or large command output into higher
layers unless the exact text is required to understand a failure.

Good evidence is falsifiable and local:

- command/result pairs;
- file paths or artifact ids;
- explicit missing facts;
- conflict paths;
- terminal tool payloads;
- verifier findings.

Bad evidence is process noise:

- "I checked the code" without a path or result;
- "looks good" without acceptance grounding;
- repeated tool activity summaries;
- raw trace dumps with no claim.

## Assistant Prompt Packs

Assistant prompts should be assembled from packs. A pack is a bounded capability
surface:

- prompt sections that explain the pack's operating boundary;
- tools that let the assistant inspect or mutate that surface;
- terminal tools only at the assistant run boundary.

The core assistant prompt should stay small:

- latest user message;
- recent conversation window;
- current focus/task summary;
- mounted pack summaries;
- completion contract.

Older conversation, task detail, and workspace state should be queryable through
tools, not eagerly pasted into every turn.

## Design Rules For Future Prompts

1. Inject immutable per-run context directly as prompt/input context.
2. Use tools for actions, terminal submissions, or bounded queries over larger
   state.
3. Let JSON Schema constrain terminal tool arguments; do not duplicate schema
   validation in prose except to explain semantic boundaries.
4. Prefer qualitative fields such as `next`, `reason`, `findings`, and
   `evidence` over model-generated numeric scores.
5. Keep examples analogical. If a rule must be enforced, put it in schema,
   state machine logic, or a verifier.
6. Separate authoring and acceptance: execution can self-check, but final
   acceptance needs verifier evidence or a separate review pass.
7. When a prompt grows, identify which layer it is mixing. Move durable rules to
   design docs, large state to tools, and L0 traces to event/artifact records.
