# Recursive Agent Engine

This document defines a lower-level engine model for Sikong than the current
stage/round/work-unit coordination protocol.

The current coordination model remains the product-facing protocol for task
inspection and UI. This document describes a future kernel that can implement
that protocol, and other protocols, through the same recursive problem-solving
mechanism.

## Goal

Build an agent engine that can safely solve large goals by recursively applying
divide-and-conquer plus dynamic programming:

```text
Resolve(node):
  specify the problem
  acquire missing information
  if the problem is atomic, execute it
  otherwise plan one local child group and resolve each item
  combine accepted child results
  verify the candidate result
  commit only verified results
```

The engine must support:

- simple one-shot tasks without over-planning;
- pure design and research tasks;
- coding tasks with scoped side effects;
- non-coding tasks such as travel planning or document analysis;
- multiple concurrent tasks in the same workspace;
- recursive subdivision, where each child node can be solved with the same
  mechanism as the parent;
- guaranteed bounded termination even when model behavior is poor.

The engine does not guarantee that every user goal succeeds. It guarantees that
execution is bounded, side effects are controlled, and unverified workspace
output does not pollute the main world.

## Control And Execution Split

The kernel should separate deterministic control from agent execution.

Rust owns the control layer:

- task, node, workspace-instance, and artifact state machines;
- dynamic programming tables;
- stage/parallel group scheduling;
- budgets, attempt ledgers, and retry ceilings;
- scope leases and commit ordering;
- deterministic verification gates;
- world snapshots and safe commit;
- durable event log and projection rebuild.

Bun owns the execution layer:

- model API calls;
- local agent loops;
- tool calls inside an allowed capability profile;
- streaming observations;
- returning typed artifacts to the Rust kernel.

Bun runners are untrusted producers. They never commit directly to the main
world. They return artifacts and side-effect ledgers; Rust decides whether those
artifacts can be verified and committed.

Prompt construction follows `prompt-guidance.md`. Each operation harness should
project only the context layer needed for that run, preserve the operation's
attention boundary, and let the agent loop own local execution detail inside the
terminal tool contract. Raw traces and full histories should return upward only
as compressed artifacts, events, verdicts, or workspace-provider facts.
Governance boundaries follow `governance-model.md`: `Specify` and `Plan` own
routing, `Execute` and `Combine` own local work and parent synthesis, and
`Verify` owns gates. Arch-level changes to protocols, workspace semantics, or
operation meanings require explicit design authority instead of being hidden in
local execution.
When live eval exposes a bad operation result, repair the prompt/tool boundary
in that order: simplify the prompt projection first, tighten terminal tool
schema or engine validation when a shape must be enforced, and avoid adding
long lists of forbidden invented details as prose patches.

Every `NodeOperation` is executed through the Bun agent-host boundary. Rust does
not special-case `Execute` as the only agent-backed operation. The operation
distinction stays in the engine layer: the engine selects the operation, gathers
the node/candidate/child-artifact context, and an engine-side harness turns that
operation context into a generic worker run input.

```text
ProblemNode + NodeOperation + candidate artifacts + child artifacts
  -> engine-side operation harness builds AgentRunRequest
  -> AgentWorker.run(generic run input)
  -> Bun agent-host receives the run over Unix socket JSONL RPC
  -> worker must end by choosing one required terminal tool
  -> engine-side operation harness decodes terminal tool name + arguments
  -> Rust applies the result to the deterministic state machine
```

The worker side is implemented by `@sikong/agent-host`, a Bun-side host process
that Rust starts and connects to over a Unix socket. The transport is JSONL RPC:
`run`, `shutdown`, plus streamed events and terminal results later. The host
receives a structured `AgentRunRequest`, registers the supplied tools, runs the
agent, and stops when the loop observes a call to one of the tools listed in
`terminalToolSet: string[]`. Terminal behavior belongs to the loop's built-in
terminal-tool check, not to special tool executor logic and not to an arbitrary
caller-provided stop predicate. Tools execute normally, the loop observes tool
calls, and the first terminal tool call becomes the returned terminal result.
Claude Code settings sources are always disabled for these runs. User,
project, and local Claude settings, CLAUDE.md files, plugins, memory, and
permission policy must not leak into engine operation context; anything the
agent can see must be supplied explicitly by the Rust harness as prompt,
structured input, MCP/tool specs, or runtime profile.

Runtime profiles stay coarse:

- `general`: Sikong control, assistant, verification, combination, and general
  work. Use a Sikong custom system prompt and no Claude Code built-in
  tools.
- `code`: work that should use Claude Code's coding prompt/tool behavior. Keep
  `settingSources: []`, use the Claude Code preset, and block orchestration
  escape tools such as sub-agent launchers and Claude plan mode. Do not block
  current Claude task-tracking tools (`TaskCreate`, `TaskUpdate`, `TaskGet`,
  `TaskList`) just because their names start with `Task`.

### Agent Run Protocol

A single Rust-to-agent run is not a task, node, or workspace by itself. It is
one generic model/tool loop invocation prepared by a Rust harness. The current
wire request is:

```ts
type AgentRunRequest = {
  protocolVersion: 1;
  objective: string;
  prompt: AgentPromptSection[];
  input: JsonValue;
  tools: AgentToolSpec[];
  terminalToolSet: string[];
  runtimeProfile: "general" | "code";
};

type AgentPromptSection = {
  title: string;
  content: string;
};

type AgentToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonValue;
};
```

Rust harnesses are typed context holders. Each harness owns the context for one
agent-loop invocation and builds the exact run request for that context:

```rust
struct OperationHarness {
    context: AgentOperationContext,
}

struct AssistantHarness {
    context: AssistantContext,
}

impl OperationHarness {
    fn build_agent_run(&self) -> AgentRunRequest;
}

impl AssistantHarness {
    fn build_agent_run(&self) -> AgentRunRequest;
}
```

The current harness families are:

- `OperationHarness`: owns `AgentOperationContext`, meaning the selected
  `NodeOperation`, problem node, candidate artifact, child artifacts, and
  workspace integration evidence. It builds an engine operation run.
- `AssistantHarness`: owns assistant/task context for one operator message,
  including current message, active task, and task list. It builds an assistant
  turn run.

Both harnesses assemble the same wire protocol shape: `protocolVersion`,
prompt, structured input, tool specs, and terminal tool set. The difference is
local to the concrete harness instead of hidden behind a generic wrapper.

Tool definitions live outside harnesses:

- `EngineTool`: submit tools available to engine operation runs, such as
  `submit_specification`, `submit_plan_group`, `submit_work`,
  `submit_combination`, and `submit_verdict`.
- `AssistantTool`: tools available to assistant turns, such as
  `query_messages`, task-board tools, and `finish_turn`.

The tool catalog defines names, descriptions, and input schemas. It does not
decide which terminal tools an operation should use. That choice stays with the
current harness and operation implementation.

Field meanings:

- `protocolVersion`: fail-fast compatibility version for the Rust/Bun contract.
- `objective`: concise label for this one loop run, suitable for logs and
  summaries.
- `prompt`: ordered model-facing harness sections. Each section has a stable
  title and content so the Bun loop can render the prompt predictably and tests
  can inspect role, operation/decision scope, context usage, boundaries, and
  completion requirements without parsing one long string.
- `input`: structured harness-owned context packet. For engine operations this
  is `EngineAgentContextPacket`, containing operation, node metadata,
  workspace requirement, candidate artifact, child artifacts, and integration
  conflict evidence. For assistant turns this is the pack-built assistant input
  object containing the current message, session conversation, and mounted pack
  context such as the task board.
- `tools`: dynamic tools made available to the loop. Tool definitions do not
  carry terminal semantics. Rust keeps tool definitions in a tool catalog; the
  harness selects concrete tools for the current context.
- `terminalToolSet`: explicit stop set. A tool call ends the loop only if its
  name appears here. This is a set, not a single terminal. A future operation
  can expose separate success/failure terminal tools without changing the run
  protocol.

The transport JSONL message wraps the request with a connection-local id:

```ts
type RuntimeClientMessage =
  | { type: "run"; id: string; request: AgentRunRequest }
  | { type: "shutdown"; id: string };
```

The response is:

```ts
type AgentRunResponse = {
  report: string;
  toolCalls?: Array<{
    name: string;
    arguments: JsonValue;
  }>;
  terminalCall?: {
    name: string;
    arguments: JsonValue;
  };
};
```

Rust validates the terminal result through the harness. If the worker ends
without a required terminal tool, or calls a terminal tool from the wrong
operation, Rust records a protocol violation and deterministic state transition
code decides what happens next.

The worker does not need to know whether the run is `Specify`, `Plan`,
`Execute`, `Combine`, `Verify`, or `Commit`; that protocol
distinction is made by the engine harness before and after the generic worker
run. The harness injects operation-specific terminal tools, sets the terminal
stop set, and rejects runs that end without an expected terminal tool. Rust
still owns state transition, workspace isolation, side-effect gates,
memo writes, and durable event recording. An agent can propose one local
stage/parallel child group, candidate artifact, verification verdict, or commit
report through terminal tool arguments; it cannot directly mutate the main
world.

The Rust prototype defines the `AgentRunScheduler` boundary. Rust-side tests
may use deterministic scheduler fixtures, but the real Bun mock belongs in
`@sikong/agent-host`, where it can exercise the same dynamic tool registration
and loop stop path as the production runner. `ProcessAgentRunScheduler` is the
Rust-side Unix socket scheduler for that host process; it is not the runtime
pool implementation. `AgentOperationContext` prepares operation-specific
context through `OperationHarness`, and terminal tool payload schemas are
defined by the operation tool catalog.

## Live Eval Mode

Live agent-loop evaluation is not a Rust unit test. It is an explicit eval mode
outside the default deterministic suite because it spends model tokens, depends
on credentials, and is judged probabilistically.

The minimal shape is:

```text
natural task request
  -> full single task run through real agent-loop
  -> transcript of nodes, operations, terminal tools, events, and report
  -> independent judge agent
  -> strict JSON judgement
```

The scenario input must not contain a concrete decomposition. The root task
starts as a normal task request. During `Specify`, the actor agent submits the
next useful unit of work plus a semantic size assessment. The engine maps
`tiny`, `small`, and `medium` to direct execution and maps `large` and `xlarge`
to decomposition. This keeps the divide decision inside the real agent loop
without requiring the agent to submit an engine route.

The first live eval is exposed as:

```bash
SIKONG_RUN_LIVE_AGENT_TESTS=1 KIMI_CODE_API_KEY=... \
cargo run -- eval task-run-split --json
```

Before running the full task eval, each operation can be evaluated in isolation:

```bash
# One operation scenario.
RUST_LOG=siko=info SIKONG_RUN_LIVE_AGENT_TESTS=1 \
cargo run -- eval task-run-operation --operation verify --scenario accept --json

# All scenarios for one operation.
RUST_LOG=siko=info SIKONG_RUN_LIVE_AGENT_TESTS=1 \
cargo run -- eval task-run-operation --operation plan --scenario all --json

# Full operation matrix. This is intentionally explicit because it spends many
# model calls: each scenario runs the operation actor and then a judge actor.
RUST_LOG=siko=info SIKONG_RUN_LIVE_AGENT_TESTS=1 \
cargo run -- eval task-run-operation --operation all --scenario all --json

# External YAML task-run scenario. Use this for dogfood tasks that should not be
# hard-coded into the CLI's built-in eval matrix.
RUST_LOG=siko=info SIKONG_RUN_LIVE_AGENT_TESTS=1 \
cargo run -- eval task-run-split \
  --scenario-file evals/task-run/dogfood-doc-review.yaml \
  --artifact-dir /tmp/siko-dogfood-artifacts --json
```

The operation matrix covers the important branch behavior before the full run:

- `Specify`: `execute`, `split`, `evidence-work`
- `Plan`: `stage`, `parallel`
- `Execute`: `simple-result`, `blocked-files`
- `Combine`: `normal`, `conflict`
- `Verify`: `accept`, `reject`, `uncertain`
- `Commit`: `report`

The operation judge is also tool-driven. The evaluation context is included in
the judge prompt, and the judge must end with `finish_eval`, so judge failures
are visible as the same terminal-tool protocol failures as actor runs.

### Dogfood Loop

Live eval is also the main dogfood mechanism for improving Sikong itself. A
dogfood loop is intentionally small:

1. Run one realistic scenario against the current repository or a task shaped
   like real Sikong work.
2. Classify the evidence before changing code:
   - protocol or runtime failures are engine/host bugs;
   - repeated tool-use, token, latency, or cwd problems are prompt/runtime
     surface issues;
   - agent-written product recommendations are only candidate findings and
     must be checked against the current architecture and file evidence.
3. Pick one bounded improvement that reduces the observed failure mode.
4. Prefer deterministic Rust checks, typed schemas, or workspace invariants
   before adding prompt prose.
5. Re-run the focused deterministic tests and, when the changed behavior is
   live-agent-facing, re-run the same live scenario.
6. Record the loop in `development-log/YYYY-MM.md`, including command, result,
   drift, and reusable method feedback.

This loop must not blindly implement the eval report. The eval agent is useful
because it explores the system like a user, but the engine owner still decides
which observations are current, architectural, and worth turning into code.

The current git-backed dogfood scenarios are:

```bash
# Broad project analysis against the current Sikong worktree.
SIKONG_RUN_LIVE_AGENT_TESTS=1 SIKONG_AGENT_HOST_PROVIDER=deepseek \
SIKONG_AGENT_HOST_RUNTIME=claude-code RUST_LOG=siko=info \
cargo run --quiet -- eval task-run-split --scenario sikong-project-analysis --json \
  --artifact-dir /tmp/siko-dogfood-artifacts \
  2>&1 | tee /tmp/siko-dogfood-project-analysis.log

# Find redundant design or implementation surfaces.
SIKONG_RUN_LIVE_AGENT_TESTS=1 SIKONG_AGENT_HOST_PROVIDER=deepseek \
SIKONG_AGENT_HOST_RUNTIME=claude-code RUST_LOG=siko=info \
cargo run --quiet -- eval task-run-split --scenario sikong-redundancy-audit --json \
  --artifact-dir /tmp/siko-dogfood-artifacts \
  2>&1 | tee /tmp/siko-dogfood-redundancy-audit.log

# Draft or repair project design documentation.
SIKONG_RUN_LIVE_AGENT_TESTS=1 SIKONG_AGENT_HOST_PROVIDER=deepseek \
SIKONG_AGENT_HOST_RUNTIME=claude-code RUST_LOG=siko=info \
cargo run --quiet -- eval task-run-split --scenario sikong-design-doc-draft --json \
  --artifact-dir /tmp/siko-dogfood-artifacts \
  2>&1 | tee /tmp/siko-dogfood-design-doc-draft.log
```

When investigating a slow or stuck live run, capture both Rust orchestration
logs and Bun agent-loop activity:

```bash
RUST_LOG=siko=info SIKONG_RUN_LIVE_AGENT_TESTS=1 \
cargo run -- eval task-run-split --json 2>&1 | tee /tmp/siko-task-run-split-live.log
```

Useful views:

```bash
# Agent-loop tool calls, usage snapshots, and final result.
rg '^\{' /tmp/siko-task-run-split-live.log \
  | jq -r 'select(.source == "agent-loop") | [.elapsedMs, .event, (.name // .terminalTool // ""), (.inputTokens // ""), (.totalTokens // ""), (.error // "")] | @tsv'

# Rust-side operation boundaries and failures.
rg 'starting agent run|agent host run completed|agent run completed|agent run failed|failed to run eval' \
  /tmp/siko-task-run-split-live.log

# Include text/thinking chunks when the model's reasoning stream is needed.
RUST_LOG=siko=info SIKONG_AGENT_LOOP_VERBOSE_TEXT=1 SIKONG_RUN_LIVE_AGENT_TESTS=1 \
cargo run -- eval task-run-split --json 2>&1 | tee /tmp/siko-task-run-split-live-verbose.log
```

The agent-host disables Claude Code built-in tools by default for real
agent-loop runs, so operation passes can only call the dynamic tools supplied by
Rust. For debugging tool leakage, set `SIKONG_AGENT_HOST_CLAUDE_BUILTINS=1`.

Its default task is intentionally broad: "Make a small agent runtime ready for
a developer preview." The judge passes only when the transcript shows a real
single task run with useful child nodes and the expected major operations, not
just a hand-authored plan payload.

## Standard Node Operations

The kernel has a small fixed set of standard operations it can apply to a
`ProblemNode`. These are not agent modes, product modes, or business task
types. They are node lifecycle operations.

Product concepts such as research, coding, debugging, release, review, repair,
and planning are policy packs or compositions, not node operations.

```rust
enum NodeOperation {
    Specify,
    Plan,
    Execute,
    Combine,
    Verify,
    Commit,
}
```

Use the following naming layers:

```text
NodeOperation = Specify / Plan / Execute / Combine / Verify / Commit
NodePolicy    = fast_path / design / research / code_change / debug / release
WorkspaceProvider = memory / file_system / git_file_system / temp_directory / browser / database
RuntimeRole   = specifier / planner / executor / combiner / verifier
```

This prevents the kernel from confusing "what operation is being applied to
this node" with "what kind of user task is this" or "which runtime backend
should execute it".

### Specify

`Specify` turns an ambiguous problem into a computable node.

Input:

- raw user goal or parent node;
- current world snapshot;
- prior evidence;
- failure history, if any.

Output:

- `ProblemNode` with intent, constraints, acceptance rules, capabilities,
  budget, stable memo key, and a scope assessment.

`Specify` does not ask the agent to estimate token counts. The agent submits the
next useful unit of work, chooses the smallest safe semantic size class for that
next work, and explains the assessment. It does not submit `execute`, `split`,
`stage`, `parallel`, `route`, or `needs_plan`; those are engine decisions.

```rust
enum WorkSize {
    Tiny,
    Small,
    Medium,
    Large,
    XLarge,
}

struct ScopeAssessment {
    next: String,
    size: WorkSize,
    reason: String,
}
```

The size classes are deliberately concrete enough for model-side analogy, but
they are based on coordination cost rather than a mechanical count of files,
modules, tests, or deliverables:

- `tiny`: answerable from the user request and injected context; no project
  exploration.
- `small`: one local problem, one primary area, usually 1-3 files, and one
  obvious verification path.
- `medium`: one coherent feature or coherent change package, several related
  files, implementation plus focused tests, and one main acceptance target.
- `large`: planning reduces risk because the work has ordered phases, shared
  context, evidence from earlier work feeding later work, multiple independently
  accepted deliverables, or separate responsibilities that deserve separate
  verification.
- `xlarge`: too broad for one reliable run, multiple independent areas, repo-wide
  exploration, or several targets that can interfere.

A prompt change plus focused harness tests plus one eval scenario can still be
`medium` when all pieces serve the same behavioral fix. Runtime implementation
plus host integration plus documentation plus smoke tests is usually `large`
because those are separate work packages with different acceptance surfaces.

The engine owns any token-window mapping and next-plan policy. A practical
default is: `tiny/small/medium` execute directly; `large/xlarge` enter `Plan`,
where the planner chooses `stage` or `parallel` from the current scope and
evidence. If the original goal is blocked by missing information, `next` should
be the concrete evidence-gathering work and `size` should describe that evidence
work, not the broader original goal.

`Specify` is used at the beginning and after failures. It is not a retry
operation;
it re-normalizes the problem with new evidence.

### Plan

`Plan` is the recursive decomposition step.

Input:

- parent `ProblemNode`;
- available evidence;
- attempt history;
- budget and concurrency policy.

Output:

- one local `PlanGroup`.

```rust
enum PlanGroupMode {
    Stage,
    Parallel,
}

struct PlanGroup {
    mode: PlanGroupMode,
    items: Vec<NodeTemplate>,
}
```

The planner must first identify the main contradiction of the current problem:
the dominant blocking tension that determines the next useful decomposition.
The group mode follows from that analysis:

- `stage`: use when the work contains qualitatively different phases that must
  converge in order, such as understand -> change -> verify.
- `parallel`: use when the work is one phase split across independent items,
  such as inspecting several modules or producing several same-level design
  options.

Do not encode arbitrary dependency graphs inside one planning step. Plan items
describe child node intent and optional scope hints; they do not choose
`execute`, `split`, or nested groups. Every child re-enters `Specify`, and the
engine applies the same scope policy recursively. A failed parent can be planned
differently on a later attempt, but that is still `Plan`, not a separate repair
operation.

### Execute

`Execute` solves an atomic node in an isolated workspace instance.

Input:

- leaf `ProblemNode`;
- immutable world snapshot;
- capability profile;
- budget.

Output:

- `WorkArtifact`;
- side-effect ledger;
- observation summary.

`Execute` cannot decide success and cannot update the main world.

### Combine

`Combine` is the conquer step.

Input:

- parent `ProblemNode`;
- accepted child artifacts;
- child group completion state.

Output:

- candidate parent artifact.

Examples:

- combine research findings into a report;
- combine scoped patch proposals into a patch set;
- combine test results into a verification summary;
- combine competing design options into a recommendation.

`Combine` does not verify the candidate. It only constructs it.

### Verify

`Verify` judges whether an artifact satisfies a node spec.

Input:

- artifact;
- node constraints;
- acceptance rules;
- side-effect ledger;
- optional evidence.

Output:

```ts
type VerificationVerdict =
  | "accept"
  | {
      reject: {
        failureClass: FailureClass;
        reason: string;
      };
    }
  | {
      uncertain: {
        missingInfo: string;
        reason: string;
      };
    };
```

Rust records verification attempts directly as operation attempts instead of
wrapping the verdict in a second result type:

```rust
struct AttemptRecord {
    node_id: NodeId,
    operation: NodeOperation,
    verdict: Option<VerificationVerdict>,
}
```

Earlier design sketches used a separate verification wrapper with retry hints;
that shape is intentionally not part of the current core state.

Verification should prefer deterministic checks:

- schema validity;
- diff scope;
- side-effect ledger;
- file hash and workspace scope;
- focused test evidence;
- budget compliance.

Semantic model judgment and human judgment are allowed, but they are lower in
the trust hierarchy and should be recorded as such.

### Commit

`Commit` is the only node operation that mutates durable world state.

Input:

- accepted artifact;
- merge policy;
- current world projection;
- scope lease state.

Output:

- memo table entry;
- world patch;
- task result update;
- workspace memory update;
- or a rejected commit with conflict evidence.

Only artifacts accepted by `Verify` can be committed. Commit may write to the
memo table without writing to the external workspace, or it may apply a scoped
patch if the policy allows it.

## Dynamic Programming Tables

The kernel maintains three core tables.

```rust
struct EngineTables {
    memo_table: HashMap<ProblemKey, AcceptedArtifactId>,
    attempt_table: HashMap<ProblemKey, Vec<AttemptRecord>>,
    frontier: ReadyQueue<NodeId>,
}
```

### Memo Table

`memo_table` prevents duplicate work.

If two nodes have the same `ProblemKey`, the engine can reuse the accepted
artifact instead of executing another workspace instance.

The key must include:

- normalized intent hash;
- spec hash;
- context snapshot hash;
- capability profile hash;
- relevant input artifact hashes.

### Attempt Table

`attempt_table` prevents infinite retry.

Every node operation run records:

- operation;
- input hashes;
- output artifact or error;
- verification verdict;
- failure class;
- token, time, and tool budgets used.

Repeated failure classes force the engine to choose a different structural
action: acquire more evidence, plan a different local group, prune, or fail.

### Frontier

`frontier` contains nodes ready for work. A node becomes ready when its parent
group allows it:

- `stage` groups expose only the next unfinished item.
- `parallel` groups expose all unfinished items in the group.
- root nodes are ready when the task is admitted.

The frontier scheduler can run independent workspace instances concurrently,
but commit remains controlled by scope leases and parent group convergence.

## Workspace Abstraction

`ProblemNode` and workspace are separate concepts.

```text
ProblemNode       = semantic unit, answers what problem should be solved
NodeOperation     = operation applied to a ProblemNode
Workspace         = isolated environment where an operation may run
WorkspaceInstance = one concrete forked workspace for one operation run
WorkspaceChange   = provider-captured filesystem/git change facts
```

`Fork` is not a node and not a `NodeOperation`. It is a `WorkspaceProvider`
runtime action that creates a `WorkspaceInstance` for an operation run.

Different tasks require different workspace providers:

- pure design or synthesis: `Memory`;
- read-only source analysis: `FileSystem`;
- coding with mergeable patches: `GitFileSystem`;
- generated documents, images, or PDFs: `TempDirectory`;
- browser automation: `Browser`;
- migrations or query experiments: `Database`;
- hosted or dangerous execution: `RemoteSandbox`.

The common abstraction is:

```rust
enum WorkspaceProvider {
    Memory,
    FileSystem,
    GitFileSystem,
    TempDirectory,
    Browser,
    Database,
    RemoteSandbox,
}

trait Workspace {
    fn name(&self) -> WorkspaceProvider;

    fn snapshot(&self, scope: WorkspaceScope) -> Result<WorkspaceSnapshot>;

    fn fork(
        &self,
        snapshot: &WorkspaceSnapshot,
        policy: &WorkspacePolicy,
    ) -> Result<WorkspaceInstance>;

    fn execution_context(
        &self,
        instance: &WorkspaceInstance,
    ) -> Result<ExecutionContext>;

    fn collect_change(
        &self,
        instance: &WorkspaceInstance,
    ) -> Result<WorkspaceChange>;

    fn combine(
        &self,
        base: &WorkspaceSnapshot,
        changes: &[WorkspaceChange],
        policy: &CombinePolicy,
    ) -> Result<WorkspaceIntegration>;

    fn commit(
        &self,
        integration: &WorkspaceIntegration,
        policy: &CommitPolicy,
    ) -> Result<CommitResult>;

    fn dispose(&self, instance: WorkspaceInstance) -> Result<()>;
}
```

Not every provider must support every method. The implementation can split the
trait into capability traits such as `ForkableWorkspace`, `DiffableWorkspace`,
`CombinableWorkspace`, and `CommittableWorkspace`.

The node declares a requirement; the engine selects a provider:

```rust
struct WorkspaceRequirement {
    provider: WorkspaceProvider,
    read_scope: Vec<PathPattern>,
    write_scope: Vec<PathPattern>,
}
```

For a read-only task, the selected workspace may be file-system backed, but the
capability profile must omit write tools and verification must reject any
non-empty write delta. Prompt instructions are not a workspace policy.

### Git File System Workspace

Git is a workspace provider, not a special node type.

`WorkspaceProvider::GitFileSystem` implements isolation and combination through
worktrees and branches:

```text
snapshot  = record repo root, HEAD sha, and dirty state inside scope
fork      = git worktree add for a node operation run
execute   = run Bun with cwd set to the worktree
collect   = git diff, changed files, patch artifact, and side-effect ledger
combine   = create integration worktree and merge accepted branch deltas
commit    = apply patch, merge branch, or create pull request
dispose   = remove worktree and temporary branch according to retention policy
```

Git-specific records extend the generic workspace records:

```rust
struct GitWorkspaceSnapshot {
    repo_root: PathBuf,
    head_sha: String,
    dirty_index_ref: Option<ArtifactRef>,
    untracked_files: Vec<PathBuf>,
}

struct GitWorkspaceInstance {
    worktree_path: PathBuf,
    branch_name: String,
    base_sha: String,
}

struct GitWorkspaceChange {
    base_sha: String,
    head_sha: String,
    patch_ref: ArtifactRef,
    changed_files: Vec<PathBuf>,
}
```

`Combine` for Git creates an integration workspace:

```text
git worktree add <integration-path> -b <integration-branch> <base-sha>
git merge --no-ff <accepted-child-branch>
git merge --no-ff <accepted-child-branch-2>
```

If integration conflicts, the provider returns a conflict delta. The kernel can
then plan a conflict-resolution node and solve it through the same recursive
mechanism.

`Commit` for Git is controlled by policy:

```rust
enum GitCommitPolicy {
    ApplyPatchToWorkingTree,
    MergeIntoTargetBranch,
    CreatePullRequest,
}
```

The local-first policy should prefer `ApplyPatchToWorkingTree` so the engine can
apply verified changes without taking over the user's branch structure. Dirty
working trees are allowed only when the dirty paths do not overlap the commit
scope; otherwise the node becomes pending on user input or is rejected by
policy.

## Core Data Structures

```rust
struct ProblemNode {
    id: NodeId,
    key: ProblemKey,
    parent: Option<NodeId>,
    intent: String,
    spec: Spec,
    constraints: Vec<Constraint>,
    acceptance: Vec<AcceptanceRule>,
    workspace: WorkspaceRequirement,
    capabilities: CapabilityProfile,
    budget: Budget,
    plan: NodePlan,
    children: Vec<NodeId>,
    status: NodeStatus,
}

enum NodePlan {
    Execute,
    Split,
    Group(PlanGroup),
}

struct PlanGroup {
    mode: PlanGroupMode,
    items: Vec<NodeTemplate>,
}

enum PlanGroupMode {
    Stage,
    Parallel,
}

enum NodeStatus {
    New,
    Specified,
    WaitingForInfo,
    Planned,
    Running,
    Combining,
    Verifying,
    Accepted,
    Rejected,
    Pruned,
    Committed,
}

struct NodeOperationRun {
    id: OperationRunId,
    node_id: NodeId,
    snapshot_id: SnapshotId,
    workspace_instance_id: Option<WorkspaceInstanceId>,
    operation: NodeOperation,
    capabilities: CapabilityProfile,
    budget: Budget,
    process_run_id: Option<ProcessRunId>,
}

struct Artifact {
    id: ArtifactId,
    node_id: NodeId,
    content_kind: ArtifactContentKind,
    payload_ref: ArtifactRef,
}

struct WorkspaceSnapshot {
    id: SnapshotId,
    provider: WorkspaceProvider,
    root_ref: WorkspaceRootRef,
    content_hash: Hash,
    scope: WorkspaceScope,
}

struct WorkspaceInstance {
    id: WorkspaceInstanceId,
    snapshot_id: SnapshotId,
    provider: WorkspaceProvider,
    location: WorkspaceLocation,
    policy: WorkspacePolicy,
}

struct WorkspaceChange {
    id: WorkspaceChangeId,
    instance_id: WorkspaceInstanceId,
    changed_paths: Vec<PathRef>,
    payload_ref: ArtifactRef,
    side_effects: Vec<SideEffect>,
}

struct WorkspaceIntegration {
    id: IntegrationId,
    base_snapshot: SnapshotId,
    changes: Vec<WorkspaceChangeId>,
    payload_ref: ArtifactRef,
    conflicts: Vec<Conflict>,
}

enum ArtifactContentKind {
    Text,
    Json,
    FileRef,
}

struct AttemptRecord {
    node_id: NodeId,
    operation: NodeOperation,
    verdict: Option<VerificationVerdict>,
}
```

## Engine Loop

The kernel loop is recursive in semantics, but iterative in implementation so
it can be persisted and resumed.

```text
while task is not terminal:
  node = frontier.pop()

  if memo_table contains node.key:
    Commit(memo[node.key])
    continue

  if node is not specified:
    spec = run_operation(Specify, node)
    update node from spec
    frontier.push(node)
    continue

  if policy says node should plan a child group:
    group = run_operation(Plan, node)
    register child nodes under the local group
    continue

  if node has unresolved children:
    enqueue children allowed by the group mode
    continue

  if node has accepted children and no candidate artifact:
    candidate = run_operation(Combine, node)
    attach candidate to node
    frontier.push(node)
    continue

  if node has candidate artifact and no verdict:
    verdict = run_operation(Verify, node.candidate)
    record verdict
    frontier.push(node)
    continue

  if verdict is accept:
    Commit(node.candidate)
    continue

  if verdict is uncertain:
    handle_uncertain(node)
    continue

  if verdict is reject:
    handle_reject(node)
    continue
```

`handle_reject` is not a repair operation. It is a bounded decision table:

```text
missing information     -> Specify next evidence work or WaitingForInfo
same failure repeated   -> Plan differently or prune
spec ambiguity          -> Specify again with failure evidence
executor mismatch       -> Execute with a different capability profile
unsafe side effect      -> prune workspace instance and record violation
budget exhausted        -> prune or fail task
human decision required -> WaitingForInfo
```

Every path consumes retry, time, and token budget. When budget is exhausted the
node must become `Pruned`, `Rejected`, or `WaitingForInfo`. It cannot loop.

## Plan And Conquer Semantics

`Plan` and `Combine` are symmetric:

```text
Plan(parent) -> one child group
Resolve(child_1)
Resolve(child_2)
...
Combine(parent, accepted children) -> Parent candidate
Verify(parent candidate)
Commit(parent result)
```

Each child is solved with the same `Resolve` mechanism as the parent. A child
can itself plan a `stage` or `parallel` group, which is what makes the model
recursive rather than a fixed pipeline.

The engine can support multiple decomposition attempts:

```text
attempt 1: split by subsystem
attempt 2: split by risk class
attempt 3: split into information gathering + implementation + verification
```

The attempt ledger decides when a local group strategy has failed repeatedly
and should be replaced or pruned.

## Workspace, Fork, And Commit

`Plan` is semantic. It creates child problems.

`Fork` is mechanical. It asks a `WorkspaceProvider` to create an isolated
`WorkspaceInstance` for a ready node operation. It is not a `ProblemNode` and
not a `NodeOperation`, because it does not answer what work should be done. It
only answers where and with what isolation the operation should run.

`Commit` is controlled mutation. It merges only verified artifacts.

```text
Plan    = decide what local child group exists
Fork    = create a WorkspaceInstance for a node operation run
Execute = run inside that WorkspaceInstance
Collect = let the workspace provider capture WorkspaceChange; keep agent artifacts separate
Commit  = merge accepted results into durable world state
```

Workspace instances may perform tool calls only through their capability
profile. A read-only workspace instance must not receive write tools. Prompt
instructions are not a security boundary.

`WorkspaceChange` is not an agent-submitted artifact content type. The agent
submits artifacts; the workspace provider captures changed paths, commits,
merge facts, and side-effect facts. Normal agent runs should not see these
facts. Conflict resolution is the exception: when an integration surface has
conflicts, the engine may expose the conflict paths needed to resolve them.

All provider-captured side effects must be recorded in a side-effect ledger.
Verification must reject workspace changes whose side effects violate the node
policy.

## Policy Packs

The standard node operations are fixed. Task types are policy packs.

Examples:

- `fast_path`
- `design`
- `research`
- `code_change`
- `debug`
- `release`
- `non_coding_planning`

Policy packs can define:

- leaf detection rules;
- default planning strategy;
- allowed acquire sources;
- capability profiles;
- artifact schemas;
- verifier pipeline;
- commit target;
- UI projection style.

They cannot add new kernel node operations.

## Scenario Simulations

### Simple Text Task

Request: "Polish this paragraph."

```text
Specify -> leaf text rewrite spec
Execute -> rewritten paragraph artifact
Verify  -> preserve meaning, no new facts
Commit  -> task result
```

No group planning, no concurrent workspace instance, no complex review.

### Pure Design Task

Request: "Design an agent workflow state machine."

```text
Specify -> design node with acceptance rules
Plan    -> parallel group: state machine, data model, failure handling, UI projection
Resolve each child
Combine -> full design document
Verify  -> coverage, consistency, no contradictory states
Commit  -> design artifact
```

If failure handling is incomplete:

```text
Verify rejects child
Specify child with failure evidence
Plan child as parallel group: retry policy + budget policy + prune policy
Resolve children
Combine and verify again
```

### Non-Coding Planning Task

Request: "Plan a trip."

```text
Specify -> extract dates, budget, preferences
WaitingForInfo -> ask for missing origin city if the user must decide it
Execute evidence work -> transport and lodging evidence
Plan -> parallel group: route, lodging, transport, constraints
Resolve children
Combine -> itinerary candidate
Verify -> date coverage, budget, travel feasibility
Commit -> final itinerary artifact
```

The user question is only one possible information source, not a special
workflow.

### Coding Task

Request: "Fix the work detail page."

```text
Specify -> UI/code-change node with scoped acceptance
Execute evidence work -> existing components and projection shape
Plan -> stage group: understand current projection, update UI model, verify interaction
Resolve each stage; stages may plan parallel items internally
Execute child workspace instances -> patch artifacts
Verify children -> diff scope, no unrelated edits, focused checks
Combine -> patch set
Verify parent -> acceptance and conflict check
Commit -> apply patch under scope lease
```

Implementation workers do not write directly to the main world. They propose
patch artifacts. Commit applies accepted patches.

For a Git-backed coding task, each executable child runs in its own
`GitFileSystem` workspace instance:

```text
Workspace snapshot -> HEAD sha + scoped dirty state
Fork child         -> git worktree for child branch
Execute child      -> Bun runner cwd = child worktree
Collect delta      -> git diff + changed files + patch artifact
Verify child       -> scope, diff, tests, side-effect ledger
Combine children   -> integration worktree merge
Verify integration -> conflict-free, scope-valid, focused checks
Commit             -> apply patch or merge according to policy
```

### Same Project, Multiple Concurrent Tasks

Task A: optimize work detail UI.

Task B: fix client-agent timeout.

Both tasks can execute workspace instances concurrently. Commit is serialized by
scope lease:

```text
Task A workspace delta writes package/client/task-detail*
Task B workspace delta writes package/workspace/client-agent/turn.ts
Commit both if scopes do not overlap
```

If both want `packages/client/src/api.ts`:

```text
Execute in isolated workspace instances
Verify each artifact
Commit first accepted artifact
Rebase/re-verify second artifact before commit
```

Parallelism is exploration. Commit is controlled convergence.

## Relationship To Current Coordination Engine

The current `coordination-engine.md` model can be implemented as a policy pack
over this kernel:

- task request becomes a root `ProblemNode`;
- accepted `PlanDef` stages are coarse child nodes;
- `StageRoundDef` is a plan group candidate for one active stage;
- `StageWorkUnitDef` is a child node;
- worker run result is a `WorkArtifact`;
- stage review is a `Verify` run over accumulated stage artifacts;
- final review is a `Verify` run over the root task candidate;
- accepted stage/final output is committed to the task projection.

The product UI may continue to show stages, rounds, and work units. The kernel
does not need those terms as primitive concepts.

## Non-Goals

- Do not add a `Repair` operation. Repair is `Verify` failure evidence flowing
  back into `Specify`, `Plan`, or `Execute`.
- Do not add task-type operations such as `Research`, `CodeChange`, or `Debug`.
  These are policy packs.
- Do not let Bun runners mutate durable state directly.
- Do not treat natural-language intent as a hard verifier. Intent helps
  semantic review; deterministic constraints remain the hard gate.
- Do not model `Fork` as a problem node. Fork is a workspace operation.
- Do not assume in-memory fork protects external side effects. External effects
  require workspace policy, capability controls, side-effect ledgers, and commit
  policy.

## Migration Path

1. Introduce artifact records for worker output without changing the current
   stage-round protocol.
2. Add explicit capability profiles per work unit, including read-only profiles
   that remove write tools mechanically.
3. Introduce `WorkspaceRequirement` and workspace-provider selection for work
   units, starting with `Memory`, `FileSystem`, and `GitFileSystem` providers.
4. Add side-effect ledgers and reject read-only artifacts that changed files or
   executed disallowed tools.
5. Treat stage work units as `ProblemNode` leaves internally while preserving
   current UI terminology.
6. Add memo and attempt tables to prevent repeated equivalent work and repeated
   failure loops.
7. Move stage review and final review toward generic `Verify` artifacts.
8. Replace direct worker writes with patch/report artifacts plus controlled
   commit.
9. Add `GitFileSystem` worktree execution for code-change nodes after artifact
   and side-effect verification exist.

This migration keeps the current product workflow usable while moving the
kernel toward recursive, safe convergence.
