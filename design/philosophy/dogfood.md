# Dogfood Development

This document defines how Sikong should use Sikong to improve Sikong.

The purpose is not to add another engine. Dogfood is an operating model built
on top of the recursive task-run engine, assistant packs, workspace providers,
live eval, and the project design log.

Dogfood uses `governance-model.md` as its authority boundary: Arch frames
system contracts, Plan routes evidence surfaces, Execute performs local work and
parent synthesis, and Verify gates acceptance. This document describes how that
model is exercised during self-development, not a separate dogfood workflow.

## Goal

Sikong should become useful for daily self-development:

- analyze the current Sikong repository and design;
- turn broad improvement intent into scoped work;
- write or repair design documents before code when the target is still
  ambiguous;
- propose and apply implementation changes in isolated workspaces;
- verify changes with deterministic checks and focused live eval;
- record the reusable learning so future runs improve the system instead of
  rediscovering the same problem.

The target is a reliable self-improvement loop, not autonomous unchecked
mutation. Sikong may produce recommendations and patches, but the main
workspace is updated only through the normal workspace commit/acceptance gates.

## Non-Goals

- Do not treat an agent-written report as accepted truth.
- Do not let live eval directly rewrite architecture without deterministic
  review.
- Do not create a separate dogfood state machine.
- Do not make dogfood depend on old Go/Bun task orchestration surfaces.
- Do not require every small code change to run a full repository self-audit.

## Layer Model

Dogfood uses the existing attention layers:

| Layer                   | Dogfood duty                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| L3 design/docs          | Durable target, architectural constraints, and reusable method feedback.                        |
| L2 assistant/task board | Operator-facing intake, active self-improvement task list, and mounted dogfood capability pack. |
| L1 task-run engine      | Recursive `Specify -> Plan -> Execute -> Combine -> Verify -> Commit` over one dogfood task.    |
| L0 agent run            | One bounded operation with injected context, dynamic tools, and terminal tool completion.       |

The dogfood loop should start at L3 when the desired behavior is not yet clear.
That means the first self-improvement task for a new area should often be a
design-document task, not a code patch.

## Dogfood Attention Contract

Every meaningful dogfood run must start by naming the attention boundary before
launching broad analysis or implementation work:

- **Mainline**: the top-level intent that must not drift during the run.
- **Owning layer**: which layer owns the current uncertainty: goal, design,
  fact, reframe, or harness.
- **Parent acceptance evidence**: what evidence lets the parent accept or
  reject the result without replaying every local decision.
- **Child autonomy boundary**: what the child may decide locally, and what it
  must not change without returning upward.
- **Upward artifact**: the compressed evidence, proposal, patch, verdict, or
  blocker that the parent will combine.

This is the dogfood form of divide-and-conquer. The parent layer preserves the
mainline, authority, and acceptance gate. Child runs own local investigation,
editing, and tactical choices inside their scoped problem. A child may adjust
its local path, but if it discovers that the parent target, boundary, or
acceptance contract is wrong, it should return that as an upward boundary
candidate or blocker instead of silently changing the mission.

Broad repository dogfood should therefore divide by evidence surface, not by
the parent trying to watch every file, transcript, and local choice. `Combine`
integrates accepted child artifacts and rejects weak evidence; it should not
import the full trace as durable truth.

Dogfood review should reject or return findings when:

- the run does not name the mainline, owning layer, and acceptance evidence;
- one worker is asked to inspect unrelated evidence surfaces that could be
  accepted independently;
- the parent layer is forced to monitor local details instead of accepting
  compressed artifacts;
- a child changes the parent mission, boundary, or acceptance gate without
  reporting that as an upward decision.

## Dogfood Task Types

Dogfood uses the same recursive engine for several recurring task shapes.

### Design Document Task

Use this when the user has a product or architecture direction but the concrete
implementation boundary is not stable.

Typical examples:

- define how Sikong should dogfood itself;
- clarify task-run splitting semantics;
- design assistant pack injection;
- document a workspace provider invariant.

Expected flow:

```text
Specify -> Plan if the design has independent surfaces
Execute children to inspect existing docs/code/eval evidence
Combine into one design document or design patch
Verify for consistency with current architecture
Commit after operator review
```

This is the preferred starting point for Sikong self-development because it
creates an explicit target before implementation workers start changing code.

### Repository Analysis Task

Use this to find improvement opportunities across a broad area of Sikong.

Broad repository analysis should normally become `large` or `xlarge` during
`Specify` when it spans independently inspectable evidence surfaces such as:

- `src/task_run/**/*.rs`;
- `src/agent_run/**/*.rs`;
- `src/assistant/**/*.rs`;
- `packages/agent-host/src/**/*.ts`;
- `packages/agent-loop/src/**/*.ts`;
- `design/**/*.md`;
- deterministic tests.

The final artifact may still be one report. That does not make the evidence
collection atomic. Child workers should inspect scoped surfaces and produce
accepted artifacts; parent `Combine` owns the cross-surface recommendation.

### Patch Task

Use this when the target behavior is already clear enough to change code.

Expected flow:

```text
Specify the local behavior change
Plan stage group when understand -> edit -> verify must happen in order
Execute in isolated workspace instances
Verify diff scope and command evidence
Combine patches or reports when there are child artifacts
Commit only accepted workspace output
```

Patch tasks should use the `code` runtime profile only where coding tools are
useful. Control operations such as `Specify`, `Plan`, `Combine`, and `Verify`
should prefer the `general` profile unless the operation genuinely needs code
tooling.

### Verification Task

Use this when a prior dogfood run produced a suspicious result, high context
pressure, or a claimed fix without enough evidence.

Verification tasks should inspect transcripts, terminal payloads, timing,
token usage, tool calls, and deterministic command output. They should not
repeat full work unless the failure cannot be diagnosed from existing evidence.

## Design-First Start

When the user asks Sikong to improve itself and the request is conceptual,
start by creating or updating a design document.

The assistant should shape the task as:

```text
Improve Sikong's own design for <area>.
Start by inspecting the relevant design documents, current implementation
surface, and recent dogfood evidence. Produce a design patch or new design
document that can guide later implementation tasks.
```

For this repository, the current first dogfood design task is this document:
`design/dogfood.md`.

This task should become the operator-facing contract for later work:

1. run a task that updates or reviews this design;
2. verify the design against `recursive-agent-engine.md`,
   `assistant-agent-loop.md`, and `prompt-guidance.md`;
3. only then spawn patch tasks that implement the next missing mechanism.

## Dogfood Pack

Dogfood should be exposed as an assistant pack rather than hard-coded into the
assistant.

The pack should inject:

- a prompt section explaining the doc-first self-development loop;
- a compact list of active self-improvement tasks from the task board;
- access to recent dogfood eval summaries;
- tools to create dogfood tasks, inspect task status, and retrieve relevant
  eval transcripts;
- no direct authority to commit unverified workspace changes.

The pack should not decide the node operation. It supplies context and tools;
the task-run engine still applies `Specify`, `Plan`, `Execute`, `Combine`,
`Verify`, and `Commit`.

## Closed Development Loop

A complete daily dogfood cycle is an operating loop around one accepted
assistant task-board artifact. It is deliberately reviewable instead of fully
autonomous:

```text
name mainline and layer -> create bounded task with siko send
  -> inspect task history and artifacts with siko task inspect
  -> accept one bounded change
  -> apply in the main workspace -> run deterministic checks
  -> build/update runtime when needed
  -> rerun focused regression eval only when the changed surface needs it
  -> commit -> record learning
```

The loop has three modes.

### Review-Only Mode

Use this when Sikong is analyzing, reviewing, or drafting design text.

- Workspace: `current-file-system` when uncommitted docs/code must be visible;
  `current-git` when the task should inspect a clean `HEAD` snapshot.
- Capability: read-only.
- Output: report, design proposal, or markdown patch text.
- Acceptance: human owner reads the sidecar artifact and transcript before any
  file is edited.

Example:

```bash
siko send --no-allow-write "Sikong self-development task:
Mainline: review one bounded Sikong design or implementation surface.
Owning layer: design.
Parent acceptance evidence: file-backed findings and explicit blocker text if the boundary cannot be preserved.
Child autonomy boundary: investigate and propose; do not edit files.
Upward artifact: review report or patch proposal.

Request:
<bounded review request>"
```

### Patch-Proposal Mode

Use this when the target is close to implementation but direct workspace
mutation is not yet trusted for the slice.

- Workspace: normally `current-file-system` so proposals can reference the
  current dirty tree.
- Capability: read-only unless a dedicated isolated writable workspace is part
  of the scenario.
- Output: concrete patch plan, diff sketch, test commands, and risk notes.
- Acceptance: the operator applies the accepted patch through the normal main
  agent/editor path, then runs deterministic checks.

This is the current default for daily self-development through `siko send`. It
lets Sikong do the local investigation and proposal work while the operator owns
the final edit and commit decision.

### Apply Mode

Use this only after patch-proposal and verification behavior is stable for the
target surface.

- Workspace: `current-git` or another git-backed isolated workspace.
- Capability: writable with explicit `write_scope`.
- Output: verified workspace change plus artifact evidence.
- Acceptance: Rust workspace provider captures changed paths and commit
  resources; the main workspace accepts only the verified result.

Apply mode is the desired end state, but it must not bypass transcript review,
deterministic checks, or commit discipline.

## Commit And Runtime Update Gate

After a dogfood artifact is accepted, the main agent applies the bounded change
and runs the smallest deterministic gate that covers the touched surface.

Use this default gate before commit:

```bash
cargo test
cargo clippy --all-targets -- -D warnings
bun run check
```

For targeted slices, a focused subset is acceptable during iteration, but the
final commit should name the commands that actually ran.

If the accepted change touches `packages/agent-host`, `packages/agent-loop`, or
Rust launch/configuration code for the external host, update the runtime host
before claiming the loop is closed:

```bash
bun --filter @sikong/agent-host test
bun --filter agent-loop test
bun run build:agent-host
```

The Rust CLI resolves the agent host in this order:

1. explicit debug/env command or script;
2. `siko-agent-host` beside the current executable;
3. `SIKONG_RUNTIME_DIR/bin/siko-agent-host`;
4. the development `packages/agent-host/src/runtime-host.ts` script.

That means release-style dogfood should set `SIKONG_RUNTIME_DIR` to a runtime
bundle containing the freshly built `bin/siko-agent-host`, then rerun the
focused scenario against that runtime. Development dogfood may use the source
script, but runtime-host changes are not proven until the compiled host is
rebuilt and exercised.

Commit only after:

- the accepted artifact or patch is retrievable from `siko task inspect`; eval
  sidecars under `--artifact-dir` are needed only for eval-based regression
  runs;
- deterministic checks pass for the touched surface;
- runtime host is rebuilt when runtime code changed;
- at least one focused live eval reruns the behavior that motivated the change
  when runtime, prompt, routing, or host behavior changed;
- `development-log/YYYY-MM.md` records the command, result, and remaining risk.

## Runtime And Cost Policy

Use cost-effective models for routine dogfood. DeepSeek through the Claude Code
runtime is the practical default for broad analysis and patch exploration when
it is good enough.

Escalate to a stronger coding runtime only when the task needs it, for example:

- deep multi-file refactors with fragile behavior;
- debugging a subtle runtime/tool protocol issue;
- complex UI implementation;
- final review of a high-risk patch.

A dogfood run that reaches context pressure before a terminal result is a
routing or context-projection problem, not just a model-effort problem. The
usual repair is to improve `Specify`, `Plan`, scope projection, or transcript
compression before increasing step limits.

## Evidence And Gates

Dogfood evidence has three tiers:

1. **Transcript evidence**: node operations, terminal tool calls, model/tool
   events, timing, usage, and workspace paths.
2. **Artifact evidence**: design patches, reports, diffs, command summaries,
   accepted child artifacts, and verification verdicts.
3. **Deterministic evidence**: Rust tests, Bun tests, formatting, lint, build,
   and workspace-provider checks.

The transcript is primary when diagnosing engine behavior. The agent-written
report is a candidate interpretation of that transcript.

Every meaningful dogfood loop should record:

- the user goal;
- the mainline, owning layer, child autonomy boundary, and upward artifact;
- the scenario or command;
- the routing outcome, especially `Specify.size` and `PlanGroup.mode`;
- the most important usage or latency signal;
- the change made;
- the verification evidence;
- the remaining risk or next task.

Use `development-log/YYYY-MM.md` for this record until a durable task-board
history replaces it.

## Live Eval Strategy

Dogfood live eval is an internal regression and diagnostic surface, not the
daily task intake path. Daily work should enter through `siko send` and be
reviewed with `siko task inspect`. Live eval should have two levels.

### Cheap Routing Eval

Use this before running expensive full tasks.

It should validate:

- broad project analysis enters `Plan`;
- coherent local work stays atomic;
- `Plan` uses `parallel` only for sibling-independent evidence surfaces;
- child `read_scope` narrows broad git workspaces;
- no operation wastes calls reading context that is already injected.

This catches the most expensive failure mode: a broad self-development task
collapsing into one monolithic `Execute`.

Dogfood eval scenarios that are specific to one design or investigation should
live in YAML fixtures instead of being added to the CLI's built-in scenario
list. For example:

```bash
SIKONG_RUN_LIVE_AGENT_TESTS=1 SIKONG_AGENT_HOST_PROVIDER=deepseek \
SIKONG_AGENT_HOST_RUNTIME=claude-code RUST_LOG=siko=info \
cargo run --quiet -- eval task-run-split \
  --scenario-file evals/task-run/dogfood-doc-review.yaml \
  --artifact-dir /tmp/siko-dogfood-artifacts --json
```

Use `siko send` as the standing review-only entrypoint for deciding the next
self-development slice. A task should produce exactly one bounded patch
proposal, not a broad roadmap. The operator can then accept that proposal, apply
the bounded change in the main workspace, run deterministic checks, and rerun a
focused live eval only when the changed runtime or prompt behavior needs
regression evidence. `evals/task-run/dogfood-next-improvement.yaml` remains a
regression fixture for checking that behavior, not the normal intake path.

Use `current-file-system` when the task must see uncommitted or untracked files
in the current workspace. Use `current-git` when the task should inspect a clean
worktree based on `HEAD`.

`--artifact-dir` writes full accepted artifacts as markdown sidecars. The JSON
transcript keeps terminal payloads compact for judge/context cost; use sidecars
for human review, patch acceptance, and development-log excerpts.

### Full Task Eval

Use this after routing is believable.

It should validate:

- isolated worktree creation;
- real child execution;
- streamed completion of parallel children as they finish;
- parent combination after accepted child artifacts;
- verification and deterministic command evidence;
- no unverified main workspace mutation.

Full eval should be used sparingly because it spends model tokens and can take
minutes.

## Current Gap

Recent dogfood runs show that Sikong can start real repository analysis and can
use isolated git worktrees. Route-only evals can now stop after the root
routing decision, so broad project analysis no longer has to run expensive child
execution just to inspect whether `Specify` and `Plan` chose the right shape.

The next design and implementation priority is therefore:

1. make project-level self-development tasks reliably split by evidence
   surface;
2. keep child scopes narrow enough that parallelism reduces context pressure;
3. tighten live-eval judging so hard expectation violations, such as overly
   broad child scopes, cannot be reported as pass-only polish notes.

## Success Criteria

Sikong has a useful dogfood loop when:

- a request such as "analyze Sikong and suggest improvements" creates a scoped
  repository analysis task rather than one giant worker run;
- broad self-development names the mainline, current layer, parent
  acceptance evidence, child autonomy boundary, and upward artifact before
  execution;
- a request such as "design how Sikong should improve itself" starts with a
  design-document task;
- broad analysis produces accepted child artifacts before synthesis;
- patch work happens in isolated workspaces and commits only after verification;
- the assistant can keep a portfolio of self-improvement tasks without losing
  the latest user intent;
- repeated failures become design/prompt/runtime changes, not manual folklore.

## Implementation Sequence

1. Treat this document as the dogfood design contract.
2. Run review-only dogfood through `siko send` before editing broad design or
   runtime surfaces.
3. Use task-board evidence from `siko task inspect` to choose the next bounded
   self-development slice.
4. Add a route/plan-only dogfood eval for `sikong-project-analysis` and similar
   self-development requests. Initial support exists through
   `evals/task-run/dogfood-route-only.yaml` and `task-run-split --route-only`.
5. Improve `Specify` and `Plan` context projection until broad repository
   analysis reliably produces scoped child work.
6. Add a `DogfoodPack` for the assistant that injects this design summary,
   current self-improvement task state, and dogfood task tools. Initial support
   now injects the self-development operating model and reuses task-board tools;
   dogfood-specific eval transcript tools are still a later slice.
7. Add patch-mode dogfood scenarios that produce workspace changes plus
   deterministic verification evidence.
8. Promote repeated dogfood findings into design docs or prompt guidance; keep
   one-off eval noise in logs.
