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
  otherwise divide it into child nodes and resolve each child
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
- dependency and frontier scheduling;
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

### Agent Run Protocol

A single Rust-to-agent run is not a task, node, or workspace by itself. It is
one generic model/tool loop invocation prepared by a Rust harness. The current
wire request is:

```ts
type AgentRunRequest = {
  protocolVersion: 1;
  kind: "engine_operation" | "assistant_turn";
  objective: string;
  prompt: AgentPromptSection[];
  input: JsonValue;
  tools: AgentToolSpec[];
  terminalToolSet: string[];
  toolChoice: { type: "required" } | { type: "tool"; name: string };
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

Rust harnesses are typed context holders. The shared generic wrapper owns the
context for one agent-loop invocation. The context itself implements the run
contract:

```rust
struct Harness<C> {
    context: C,
}

trait AgentRunContext {
    type Tool;

    fn kind(&self) -> AgentRunKind;
    fn objective(&self) -> String;
    fn prompt(&self) -> Vec<AgentPromptSection>;
    fn input(&self) -> JsonValue;
    fn tools(&self) -> Vec<Self::Tool>;
    fn terminal_tools(&self) -> Vec<Self::Tool>;
}
```

The current harness families are:

- `OperationHarness = Harness<AgentOperationContext>`: owns
  `AgentOperationContext`, meaning the selected `NodeOperation`, problem node,
  candidate artifact, child artifacts, and workspace integration evidence. It
  produces `kind: "engine_operation"`.
- `AssistantHarness = Harness<AssistantContext>`: owns
  assistant/task context for one operator message, including current message,
  active task, and task list. It produces `kind: "assistant_turn"`.

`Harness<C>` performs the common `AgentRunRequest` assembly: `protocolVersion`,
prompt, structured input, tool specs, terminal tool set, and tool choice. The
context supplies the differences for that run family.

Tool definitions live outside harnesses:

- `EngineTool`: tools available to engine operation runs, such as
  `read_operation_context` and operation submit tools.
- `AssistantTool`: tools available to assistant turns, such as
  `read_assistant_context` and assistant decision submission.

The tool catalog defines names, descriptions, and input schemas. It does not
decide which terminal tools an operation should use. That choice stays with the
current harness and operation implementation.

Field meanings:

- `protocolVersion`: fail-fast compatibility version for the Rust/Bun contract.
- `kind`: names the harness family. `engine_operation` is used for
  `NodeOperation`; `assistant_turn` is reserved for the future assistant loop.
- `objective`: concise label for this one loop run, suitable for logs and
  summaries.
- `prompt`: ordered model-facing harness sections. Each section has a stable
  title and content so the Bun loop can render the prompt predictably and tests
  can inspect role, operation/decision scope, context usage, boundaries, and
  completion requirements without parsing one long string.
- `input`: structured harness-owned context packet. For engine operations this
  is `EngineAgentContextPacket`, containing operation, node metadata,
  workspace requirement, candidate artifact, child artifacts, and integration
  conflict evidence. For assistant turns this is `AssistantTurnContextPacket`.
- `tools`: dynamic tools made available to the loop. Tool definitions do not
  carry terminal semantics. Rust keeps tool definitions in a tool catalog; the
  harness selects concrete tools for the current context.
- `terminalToolSet`: explicit stop set. A tool call ends the loop only if its
  name appears here. This is a set, not a single terminal. A future operation
  can expose separate success/failure terminal tools without changing the run
  protocol.
- `toolChoice`: optional forcing/requirement for the loop's terminal choice.
  Harnesses use `required` when any terminal tool from `terminalToolSet` is
  acceptable.

The transport JSONL message wraps the request with a connection-local id:

```ts
type RuntimeClientMessage =
  | { type: "run"; id: string; request: AgentRunRequest }
  | { type: "shutdown"; id: string };
```

The response is:

```ts
type AgentWorkerResult = {
  report: string;
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

The worker does not need to know whether the run is `Specify`, `Acquire`,
`Divide`, `Execute`, `Combine`, `Verify`, or `Commit`; that protocol
distinction is made by the engine harness before and after the generic worker
run. The harness injects operation-specific terminal tools, forces or requires
`tool_choice`, and rejects runs that end without the required terminal tool.
Rust still owns state transition, workspace isolation, side-effect gates, memo
writes, and durable event recording. An agent can propose a child DAG,
candidate artifact, verification verdict, or commit report through terminal tool
arguments; it cannot directly mutate the main world.

The Rust prototype defines only the `AgentWorker` client boundary. Rust-side
tests may use a test-only worker under `tests/`, but the real Bun mock belongs
in `@sikong/agent-host`, where it can exercise the same dynamic tool
registration and loop stop path as the production runner. `BunAgentHostClient`
is only a Unix socket client for that host process; it is not the runtime pool
implementation. `AgentOperationContext` prepares operation-specific context and
submit-tool implementations through `OperationHarness`; `EngineAgentHarness` is
only the current adapter for the engine's legacy `AgentHarness` trait.
`NodeScript` is only the current
fixture used by the operation harness before real submit-tool payload schemas
exist. It should not become the durable kernel model.

## Standard Node Operations

The kernel has a small fixed set of standard operations it can apply to a
`ProblemNode`. These are not agent modes, product modes, or business task
types. They are node lifecycle operations.

Product concepts such as research, coding, debugging, release, review, repair,
and planning are policy packs or compositions, not node operations.

```rust
enum NodeOperation {
    Specify,
    Acquire,
    Divide,
    Execute,
    Combine,
    Verify,
    Commit,
}
```

Use the following naming layers:

```text
NodeOperation = Specify / Acquire / Divide / Execute / Combine / Verify / Commit
NodePolicy    = fast_path / design / research / code_change / debug / release
WorkspaceProvider = memory / file_system / git_file_system / temp_directory / browser / database
RuntimeRole   = specifier / acquirer / divider / executor / combiner / verifier
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
  budget, and a stable memo key.

`Specify` is used at the beginning and after failures. It is not a retry
operation;
it re-normalizes the problem with new evidence.

### Acquire

`Acquire` fills an explicit information need.

Input:

- `InformationNeed`;
- allowed sources;
- trust policy;
- budget.

Output:

- `EvidenceArtifact`.

Allowed sources include user input, file system reads, workspace memory, search,
RAG, databases, APIs, and low-trust model inference. Asking the user is only
`Acquire(User)`, where the node becomes pending until the user replies.

`Acquire` cannot complete the task, change the DAG, or commit to the world. It
only produces evidence.

### Divide

`Divide` is the divide step.

Input:

- parent `ProblemNode`;
- available evidence;
- attempt history;
- budget and concurrency policy.

Output:

- one or more child DAG candidates.

Each child node receives its own spec, capability profile, budget, acceptance
rules, and dependency edges. A failed parent can be divided differently on a
later attempt, but that is still `Divide`, not a separate repair operation.

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
- dependency graph completion state.

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
type VerificationResult = {
  verdict: "accept" | "reject" | "uncertain";
  reasons: string[];
  missingInfo?: InformationNeed[];
  failureClass?: FailureClass;
  retryHint?: string;
};
```

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
action: acquire more evidence, divide differently, prune, or fail.

### Frontier

`frontier` contains nodes ready for work. A node becomes ready when:

- its dependencies are committed, or
- it has no dependencies, or
- a policy marks it as speculative and safe to run in parallel.

The frontier scheduler can run workspace instances concurrently, but commit
remains controlled by scope leases and dependency order.

## Workspace Abstraction

`ProblemNode` and workspace are separate concepts.

```text
ProblemNode       = semantic unit, answers what problem should be solved
NodeOperation     = operation applied to a ProblemNode
Workspace         = isolated environment where an operation may run
WorkspaceInstance = one concrete forked workspace for one operation run
WorkspaceDelta    = observed output/change from a workspace instance
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

    fn collect_delta(
        &self,
        instance: &WorkspaceInstance,
    ) -> Result<WorkspaceDelta>;

    fn combine(
        &self,
        base: &WorkspaceSnapshot,
        deltas: &[WorkspaceDelta],
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

struct GitWorkspaceDelta {
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
then divide a conflict-resolution node and solve it through the same recursive
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
scope; otherwise the node becomes pending on `Acquire(User)` or is rejected by
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
    dependencies: Vec<NodeId>,
    status: NodeStatus,
}

enum NodeStatus {
    New,
    Specified,
    WaitingForInfo,
    Divided,
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
    kind: ArtifactKind,
    payload_ref: ArtifactRef,
    evidence: Vec<EvidenceRef>,
    side_effects: Vec<SideEffect>,
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

struct WorkspaceDelta {
    id: DeltaId,
    instance_id: WorkspaceInstanceId,
    kind: DeltaKind,
    changed_paths: Vec<PathRef>,
    payload_ref: ArtifactRef,
    side_effects: Vec<SideEffect>,
}

struct WorkspaceIntegration {
    id: IntegrationId,
    base_snapshot: SnapshotId,
    deltas: Vec<DeltaId>,
    payload_ref: ArtifactRef,
    conflicts: Vec<Conflict>,
}

enum ArtifactKind {
    Spec,
    Evidence,
    ChildDag,
    Work,
    Combined,
    Verification,
    CommitPatch,
}

struct AttemptRecord {
    node_id: NodeId,
    problem_key: ProblemKey,
    attempt: u32,
    operation_trace: Vec<NodeOperationEvent>,
    artifact: Option<ArtifactId>,
    verification: Option<VerificationResult>,
    budget_used: BudgetUsage,
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

  if node has missing information:
    evidence = run_operation(Acquire, node.information_need)
    attach evidence to node
    frontier.push(node)
    continue

  if policy says node should divide:
    child_dag = run_operation(Divide, node)
    register child nodes and edges
    continue

  if node has unresolved children:
    enqueue ready children
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
missing information     -> Acquire
same failure repeated   -> Divide differently or prune
spec ambiguity          -> Specify again with failure evidence
executor mismatch       -> Execute with a different capability profile
unsafe side effect      -> prune workspace instance and record violation
budget exhausted        -> prune or fail task
human decision required -> Acquire(User)
```

Every path consumes retry, time, and token budget. When budget is exhausted the
node must become `Pruned`, `Rejected`, or `WaitingForInfo`. It cannot loop.

## Divide And Conquer Semantics

`Divide` and `Combine` are symmetric:

```text
Divide(parent) -> Child DAG
Resolve(child_1)
Resolve(child_2)
...
Combine(parent, accepted children) -> Parent candidate
Verify(parent candidate)
Commit(parent result)
```

Each child is solved with the same `Resolve` mechanism as the parent. This is
what makes the model recursive rather than a fixed pipeline.

The engine can support multiple decomposition attempts:

```text
attempt 1: split by subsystem
attempt 2: split by risk class
attempt 3: split into information gathering + implementation + verification
```

The attempt ledger decides when a decomposition strategy has failed repeatedly
and should be replaced or pruned.

## Workspace, Fork, And Commit

`Divide` is semantic. It creates child problems.

`Fork` is mechanical. It asks a `WorkspaceProvider` to create an isolated
`WorkspaceInstance` for a ready node operation. It is not a `ProblemNode` and
not a `NodeOperation`, because it does not answer what work should be done. It
only answers where and with what isolation the operation should run.

`Commit` is controlled mutation. It merges only verified artifacts.

```text
Divide  = decide what subproblems exist
Fork    = create a WorkspaceInstance for a node operation run
Execute = run inside that WorkspaceInstance
Collect = convert workspace changes into WorkspaceDelta and Artifact
Commit  = merge accepted results into durable world state
```

Workspace instances may perform tool calls only through their capability
profile. A read-only workspace instance must not receive write tools. Prompt
instructions are not a security boundary.

All side effects must be recorded in a side-effect ledger. Verification must
reject artifacts whose side effects violate the node policy.

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
- default divide strategy;
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

No divide, no concurrent workspace instance, no complex review.

### Pure Design Task

Request: "Design an agent workflow state machine."

```text
Specify -> design node with acceptance rules
Divide  -> state machine, data model, failure handling, UI projection
Resolve each child
Combine -> full design document
Verify  -> coverage, consistency, no contradictory states
Commit  -> design artifact
```

If failure handling is incomplete:

```text
Verify rejects child
Specify child with failure evidence
Divide child into retry policy + budget policy + prune policy
Resolve children
Combine and verify again
```

### Non-Coding Planning Task

Request: "Plan a trip."

```text
Specify -> extract dates, budget, preferences
Acquire(User) -> ask for missing origin city
Acquire(Search/Tool) -> transport and lodging evidence
Divide -> route, lodging, transport, constraints
Resolve children
Combine -> itinerary candidate
Verify -> date coverage, budget, travel feasibility
Commit -> final itinerary artifact
```

The user question is only one acquire source, not a special workflow.

### Coding Task

Request: "Fix the work detail page."

```text
Specify -> UI/code-change node with scoped acceptance
Acquire(FileSystem) -> existing components and projection shape
Divide -> data projection, stage/round layout, drawer detail, focused verification
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
- `StageRoundDef` is a divide candidate for one active stage;
- `StageWorkUnitDef` is a child node;
- worker run result is a `WorkArtifact`;
- stage review is a `Verify` run over accumulated stage artifacts;
- final review is a `Verify` run over the root task candidate;
- accepted stage/final output is committed to the task projection.

The product UI may continue to show stages, rounds, and work units. The kernel
does not need those terms as primitive concepts.

## Non-Goals

- Do not add a `Repair` operation. Repair is `Verify` failure evidence flowing
  back into `Specify`, `Acquire`, `Divide`, or `Execute`.
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
