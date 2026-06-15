# Coordination Engine

## Purpose

The Sikong coordination engine is the durable multi-worker layer above
`agent-loop`.

It owns:

- creating durable tasks under a registered workspace;
- planning a task into ordered stages;
- assigning one or more workers to the current stage;
- recording worker run results and review decisions;
- deciding when a stage advances;
- deciding when the whole task is accepted or rejected.

It does not replace `agent-loop.runTask`. A stage worker still performs one
bounded worker run through `runTask`. Sikong coordinates many such runs over
durable task state.

Workspace directories are Sikong state namespaces, not agent execution
directories. Runtime must provide a workspace-derived agent cwd for each run.
The default task-level allocation is `workspaces/<workspaceId>/tasks/<taskId>/`.
For git work, that cwd should instead be a workspace-owned worktree, not the
resolved source repository. The git task-level allocation is
`workspaces/<workspaceId>/worktrees/<taskId>/` when a task is created with a git
`repoPath`.
Runtime assembly resolves default adapter cwd and permissions from that task
runtime cwd. AI SDK uses explicit local inspection/execution tool profiles;
Claude Code, Codex, and Cursor should use their adapter-native sandbox and
permission surfaces.

## Non-Goals

The first design deliberately excludes:

- arbitrary workflow DSLs;
- dependency graphs between stages;
- arbitrary transitions between stages;
- stage guard expressions or field-based transition rules;
- Sikong-specific worker progress tools;
- worker-issued transition requests;
- stage-specific runtime tool allowlists;
- automatic workspace preference injection or recording.

These concepts made the old workflow model too broad. The new model keeps the
coordination protocol fixed and pushes task-specific judgment into planner
output and review.

## Roles

External agents and the UI-embedded `Client Agent` are callers of Sikong. They
are outside this role model.

### Lead

The lead is the decision owner and overall driver.

The lead can:

- request a plan;
- accept or reject a submitted plan;
- override a stage review when needed;
- make the final task acceptance decision.

The lead should not author the plan directly by default. It starts the planning
work and decides whether the planner's result is acceptable.

### Planner

The planner receives the lead's planning request and submits a `PlanDef`.

The planner can revise a rejected plan, but it does not drive execution after a
plan is accepted.

### Stage Worker

A stage worker executes assigned work for the current stage.

The worker receives the stage objective, acceptance criteria, relevant task
context, and previous durable record. It completes one bounded run through
`agent-loop.runTask` and returns a `TaskResult`.

The worker does not transition stages, update Sikong progress through custom
tools, or decide whether the stage is done.

### Stage Reviewer

The stage reviewer evaluates whether all available worker output satisfies the
current stage's acceptance criteria.

By default, the stage reviewer can accept or reject the stage. A rejection keeps
the task on the same stage and lets the engine schedule more worker runs.

### Final Reviewer

The final reviewer evaluates the whole task after the last stage is accepted.

The final reviewer recommends acceptance or rejection. The lead makes the final
decision.

## Review Policy

The default review policy is fixed:

```ts
type ReviewPolicy = {
  plan: "lead_decides";
  stage: "reviewer_decides";
  final: "reviewer_recommends_lead_decides";
};
```

Plan review is intentionally simple: the lead is the only reviewer of a
submitted `PlanDef`. There is no dedicated plan reviewer in this protocol.
After `plan.submitted`, the only valid plan transitions are lead-issued
`plan.accepted` or lead-issued `plan.rejected`.

Stage review is delegated to a reviewer worker by default because stage
acceptance can require file inspection, command evidence, external context, or
domain judgment. It is not just a structured field check.

Final review is separated from stage review because a sequence of accepted
stages can still fail the user's overall request. The final reviewer provides an
independent recommendation, while the lead remains the final authority.

## Engine Loop

The TypeScript orchestration driver is the repeatable execution loop:

```text
load durable projection
  -> plan next action from projection
  -> execute that action
  -> reload durable projection
  -> continue until wait / terminal / blocked / maxActions
```

This loop is intentionally stateless after it returns. Progress lives in the
task event log and projection, not in a long-lived in-memory scheduler. The Go
daemon may supervise subprocesses, but it does not decide which orchestration
action comes next.

## Plan Lifecycle

Planning is lead-initiated and planner-produced:

```text
no_plan
  -> plan_requested
  -> plan_submitted
  -> plan_accepted
```

If the lead rejects the submitted plan, the task returns to planning:

```text
plan_submitted
  -> plan_rejected
  -> plan_requested
  -> plan_submitted
```

Only an accepted plan can start stage execution.

## Plan Definition

`PlanDef` is a coarse execution plan. It has ordered stages, not fine-grained
steps.

```ts
type PlanDef = {
  id: string;
  version: number;
  summary?: string;
  stages: PlanStageDef[];
};

type PlanStageDef = {
  id: string;
  title: string;
  objective: string;
  acceptance: string[];
  workerCount?: number;
};
```

Field rationale:

| Field                      | Required | Owner   | Why it exists                                                                  |
| -------------------------- | -------- | ------- | ------------------------------------------------------------------------------ |
| `PlanDef.id`               | yes      | engine  | Stable reference for events, review decisions, and inspection.                 |
| `PlanDef.version`          | yes      | engine  | Distinguishes rejected and revised plans under the same task.                  |
| `PlanDef.summary`          | no       | planner | Human-readable orientation for lead/reviewer/inspect views.                    |
| `PlanDef.stages`           | yes      | planner | Ordered coarse work phases. Must be non-empty.                                 |
| `PlanStageDef.id`          | yes      | engine  | Stable reference for stage events and worker assignments.                      |
| `PlanStageDef.title`       | yes      | planner | Short display label for traces and inspection.                                 |
| `PlanStageDef.objective`   | yes      | planner | The stage's execution target for assigned workers.                             |
| `PlanStageDef.acceptance`  | yes      | planner | The review rubric for advancing out of the stage.                              |
| `PlanStageDef.workerCount` | no       | planner | Number of worker runs the engine should start for this stage. Defaults to `1`. |

The planner-facing tool input does not include engine-owned fields:

```ts
submit_plan({
  summary?: string;
  stages: Array<{
    title: string;
    objective: string;
    acceptance: string[];
    workerCount?: number;
  }>;
});
```

The engine assigns `id`, `version`, and stage ids when recording the plan.
`workerCount` is optional and must be a positive integer. Omitted or `1` means
serial execution for that stage.

## Lead Tools

The lead's plan tools are narrow:

```ts
request_plan({
  brief?: string;
  constraints?: string;
  expectedStages?: string;
});

accept_plan({
  planId: string;
  version: number;
  report: string;
});

reject_plan({
  planId: string;
  version: number;
  report: string;
  requestedChanges?: string;
});
```

`request_plan` starts or restarts planning. The planner must end its planning
run by calling `submit_plan`; a plan inferred from stdout or narrative text is
not accepted as a submitted plan.

`accept_plan` is the only path into stage execution. `reject_plan` records why
the current plan is not acceptable and gives the next planner run concrete
revision context.

## Stage Execution

Accepted plans execute stages in order.

Within one stage, the engine may run one or more worker runs concurrently. This
is the key difference from `agent-loop.runTask`: Sikong can coordinate multiple
workers against the same stage and persist their outputs.

The initial policy is intentionally small: the current stage declares
`workerCount`, the engine starts worker runs until that count has been reached,
waits for those runs to end, and then starts stage review over the accumulated
terminal results. Workers still do not transition stages themselves.

Each worker run:

1. receives the current task context and stage definition;
2. runs through `agent-loop.runTask`;
3. ends as `completed`, `failed`, or `budget_exceeded`;
4. records its `TaskResult` into the durable task event log.

The worker result is a protocol result, not a process-output convention. It
must come from the terminal tool call of `agent-loop.runTask`, or from an
adapter-provided equivalent with the same terminal schema. Sikong must not infer
`completed`, `failed`, or `budget_exceeded` from stdout, stderr, exit code, or a
free-form final message.

If the subprocess exits without a valid terminal task tool call, the run is a
protocol failure. The process runner may report stdout, stderr, exit code,
duration, and timeout as process facts, but those facts do not themselves
constitute a worker `TaskResult`.

A failed or budget-exceeded worker run does not automatically fail the stage.
The stage reviewer evaluates the accumulated evidence.

## Stage Review

Stage review starts after the engine decides there is enough worker output to
evaluate the current stage.

The reviewer evaluates:

- the stage objective;
- the acceptance criteria;
- all relevant worker run results;
- command evidence, file changes, or external context when needed.

Accepted stage review advances the task to the next stage. Rejected stage
review keeps the task on the same stage and records review feedback for the next
worker assignment.

Stage review is similar in spirit to `agent-loop.runTask` gate review, but it is
at a different layer:

- `runTask` gate review checks one worker's terminal claim;
- Sikong stage review checks whether the whole stage is actually satisfied.

## Final Review

After the last stage is accepted, Sikong starts final review.

The final reviewer should evaluate the full user request, accepted stage
outputs, unresolved risks, and verification evidence. It recommends acceptance
or rejection.

The lead then records the final task decision. A rejected final review can send
the task back to additional work on the most relevant stage, or close the task
as rejected if the lead decides the request cannot be completed.

## Event Model

The coordination engine should be event-sourced. Events are the durable source
of truth; projections are derived inspection and scheduling views.

Core events:

```text
task.created
plan.requested
plan.submitted
plan.accepted
plan.rejected
stage.started
worker_run.started
worker_run.completed
worker_run.failed
worker_run.budget_exceeded
stage.review.started
stage.review.accepted
stage.review.rejected
stage.advanced
final.review.started
final.review.recommended
task.accepted
task.rejected
task.completed
```

The exact event payloads can evolve, but the state machine should stay small:

- no accepted plan means planning is the only available path;
- an accepted plan has exactly one current stage until stage review accepts it;
- workers can only add run results to the current stage;
- worker results must be submitted through the terminal `runTask` result tool;
- reviewers decide stage advancement;
- the lead decides plan acceptance and final task acceptance.

Workspace preferences are not part of the reducer input and are not
automatically injected into planner, worker, or reviewer runs. The lead may read
workspace preferences at task start and maintain preference entries at task end.

## Relationship To Old WorkflowDef

The old `WorkflowDef` direction tried to encode work methods as a configurable
workflow language. That created pressure for dependencies, arbitrary
transitions, guard fields, evidence facts, and workflow-specific tool surfaces.

The replacement is simpler:

- methodology is used by the planner to create a concrete `PlanDef`;
- `PlanDef` stages are ordered;
- stage acceptance criteria are textual review rubrics;
- reviewers judge whether the criteria are satisfied;
- workers only execute assigned work through `runTask`.

This keeps process structure durable without turning Sikong into a general
workflow language.

## Relationship To agent-loop

`agent-loop.runTask` is a single-worker primitive. It owns:

- one worker's task prompt;
- its continuation loop;
- its terminal `completed` / `failed` / `budget_exceeded` result;
- optional gate review for that worker's final claim.

The terminal task tool call is the source of truth for the worker result stored
by Sikong. The generic subprocess runner is only transport and supervision; it
does not define the domain result protocol.
Runtime process start/finish events are process facts used for inspection and
cancellation. They do not change worker terminal state and do not replace the
terminal task tool result.

Sikong owns the durable multi-worker task:

- accepted plan;
- current stage;
- worker run history;
- stage and final reviews;
- lead decisions;
- lead-controlled workspace preference policy;
- inspection and wake scheduling.

Sikong may use many `runTask` calls to complete one durable task.

## Deferred Questions

The first implementation should not solve these yet:

- how stage worker assignments are generated inside a stage;
- whether accepted plans can be amended during execution;
- exact Go-to-TypeScript daemon/API boundary;
- advanced worktree allocation, branch naming, and cleanup policy;
- final artifact packaging or merge behavior;
- long-history summarization for inspect and worker context.

## First Implementation Slice

Build the first slice in this order:

1. Define event types, `PlanDef`, and task projections in `packages/workspace`.
2. Add reducer tests for plan request, plan submit, plan accept/reject, stage
   start, worker result record, stage review, and final review.
3. Add a file-backed event store and projection loader.
4. Add minimal plan, worker result, review, and lead decision command handlers.
5. Connect worker execution to `agent-loop.runTask`.
6. Add inspect views over the event log and projection.

Items 1 through 5 are implemented as the initial coordination core. The current
runtime core can call an injected `agent-loop.runTask` function and record its
terminal result through the validated worker result command handlers. Planning,
execution, and verification are preset wrappers over the same worker-run core,
not code-level agent roles. The orchestration tick chooses the next preset
action from projection state. The orchestration driver can repeatedly execute
non-lead actions until a wait, terminal, blocked, or action-budget boundary.
Runtime-backed actions can be executed through daemon-supervised generic Bun
child processes, while task semantics remain in the TypeScript engine and
command handlers.
