# Coordination Engine

## Purpose

The Sikong coordination engine is the durable multi-worker layer above
`agent-loop`.

It owns:

- creating durable tasks under a registered workspace;
- planning a task into ordered stages;
- asking the Task Lead to plan each stage round;
- scheduling worker runs for the current round's work units;
- recording worker run results and review decisions;
- deciding when a stage advances;
- deciding when the whole task is accepted or rejected.

It does not replace `agent-loop.runTask`. A worker still performs one bounded
worker run through `runTask`. Sikong coordinates many such runs over durable
task state.

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
- stage-initial dependency graphs between all future worker jobs;
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

- submit a requirement spec for a newly created task;
- accept or reject a submitted plan;
- plan the next round of work for the current stage;
- override a stage review when needed;
- make the final task acceptance decision.

The lead should not author the stage roadmap directly by default. It turns the
user request into a requirement spec, decides whether the planner's stage-level
roadmap is acceptable, and plans tactical stage rounds as execution evidence
arrives.

### Planner

The planner receives an engine-triggered planning run based on the lead's
requirement spec and submits a `PlanDef`.

The planner can revise a rejected plan, but it does not drive execution after a
plan is accepted.

### Stage Worker

A stage worker executes one work unit in the current stage round.

The worker receives the stage objective, stage acceptance criteria, the round
intent, its work unit objective, relevant task context, and previous durable
record. It completes one bounded run through `agent-loop.runTask` and returns a
`TaskResult`.

The worker does not transition stages, update Sikong progress through custom
tools, or decide whether the stage is done.

### Stage Reviewer

The stage reviewer evaluates whether all available worker output satisfies the
current stage's acceptance criteria.

By default, the stage reviewer can accept or reject the stage. A rejection keeps
the task on the same stage and gives the lead concrete gaps for the next stage
round.

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

This loop is intentionally stateless after each tick. Progress lives in the
task event log and projection, not in a process-local Bun singleton. The Go
daemon owns a liveness scheduler that scans durable task projections and asks
TypeScript to execute one orchestration tick at a time. The daemon does not
choose planner, worker, review, or lead actions itself; TypeScript computes the
next action from durable state for every tick.

## Core State Machine

The core state machine must stay small and projection-derived. Process state,
UI state, and agent narrative text are not workflow states.

Task phase is a derived scheduling view:

```ts
type TaskPhase =
  | "specifying"
  | "planning"
  | "plan_review"
  | "executing"
  | "final_review"
  | "completed"
  | "rejected";
```

The durable projection still records protocol status such as `created`,
`planning`, `plan_submitted`, `running`, and `reviewing`, but orchestration
should reason from the derived phase plus these stable pointers:

```ts
currentStageId?: string;
activeRoundId?: string;
finalReview?: FinalReviewProjection;
terminal?: { outcome: "accepted" | "rejected" };
```

The only normal execution loop inside a stage is:

```text
executing + no active round + no pending review
  -> lead plans the next stage round
  -> engine starts one worker run per unstarted work unit
  -> engine waits until every work unit has a terminal worker run
  -> engine completes the round
  -> engine starts stage review
  -> accepted review advances stage
  -> rejected review keeps the same stage and returns to lead round planning
```

Worker run status is intentionally tiny:

```ts
type WorkerRunStatus = "running" | "completed" | "failed" | "budget_exceeded";
```

`completed`, `failed`, and `budget_exceeded` are all terminal for round
completion. Failed or budget-exceeded work does not imply stage failure. It is
evidence for stage review and the next lead decision.

Round completion is the central invariant:

```ts
const roundReady = round.workUnits.every((unit) =>
  Object.values(projection.workerRuns).some(
    (run) => run.roundId === round.id && run.workUnitId === unit.id && run.status !== "running",
  ),
);
```

If a worker subprocess times out, is cancelled, or crashes after a worker run
was recorded, Sikong records a `worker_run.failed` result and lets the stage
round proceed to review once all work units are terminal. Runtime process facts
remain inspection and cancellation evidence; they do not replace worker
terminal results.

The state machine invariants are:

- a task has at most one `currentStageId`;
- a task has at most one `activeRoundId`;
- a round has one or more work units;
- each work unit has at most one worker run;
- a round can complete only after every work unit has a terminal worker run;
- rejected stage review keeps `currentStageId` unchanged and permits the lead
  to plan another round;
- daemon restart, UI refresh, and process restart must be recoverable by
  reloading events, rebuilding projection, and deriving the next action again;
- the daemon and scheduler wake work but never choose business transitions.

## Plan Lifecycle

Planning is engine-triggered and planner-produced after the lead submits a
requirement spec:

```text
no_plan
  -> requirement_spec_submitted
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
};
```

Field rationale:

| Field                     | Required | Owner   | Why it exists                                                  |
| ------------------------- | -------- | ------- | -------------------------------------------------------------- |
| `PlanDef.id`              | yes      | engine  | Stable reference for events, review decisions, and inspection. |
| `PlanDef.version`         | yes      | engine  | Distinguishes rejected and revised plans under the same task.  |
| `PlanDef.summary`         | no       | planner | Human-readable orientation for lead/reviewer/inspect views.    |
| `PlanDef.stages`          | yes      | planner | Ordered coarse work phases. Must be non-empty.                 |
| `PlanStageDef.id`         | yes      | engine  | Stable reference for stage events and round planning.          |
| `PlanStageDef.title`      | yes      | planner | Short display label for traces and inspection.                 |
| `PlanStageDef.objective`  | yes      | planner | The stage-level target.                                        |
| `PlanStageDef.acceptance` | yes      | planner | The review rubric for advancing out of the stage.              |

The planner-facing tool input does not include engine-owned fields:

```ts
submit_plan({
  summary?: string;
  stages: Array<{
    title: string;
    objective: string;
    acceptance: string[];
  }>;
});
```

The engine assigns `id`, `version`, and stage ids when recording the plan. The
planner does not define stage rounds or work units. Those are planned by the
lead when each stage is active.

## Stage Round Definition

`StageRoundDef` is a tactical execution plan for the current stage only. It is
not part of `PlanDef` and is not predicted upfront by the planner.

```ts
type StageRoundDef = {
  id: string;
  stageId: string;
  title?: string;
  intent: string;
  workUnits: StageWorkUnitDef[];
};

type StageWorkUnitDef = {
  id: string;
  title: string;
  objective: string;
  acceptance?: string[];
};
```

Field rationale:

| Field                         | Required | Owner  | Why it exists                                             |
| ----------------------------- | -------- | ------ | --------------------------------------------------------- |
| `StageRoundDef.id`            | yes      | engine | Stable reference for worker runs and inspection.          |
| `StageRoundDef.stageId`       | yes      | engine | Binds the round to the current stage.                     |
| `StageRoundDef.title`         | no       | lead   | Short display label for the round.                        |
| `StageRoundDef.intent`        | yes      | lead   | Why this round is the next useful work against the stage. |
| `StageRoundDef.workUnits`     | yes      | lead   | Work units that can run concurrently in this round.       |
| `StageWorkUnitDef.id`         | yes      | engine | Stable reference for one worker run target.               |
| `StageWorkUnitDef.title`      | yes      | lead   | Short display label for a worker's task.                  |
| `StageWorkUnitDef.objective`  | yes      | lead   | The concrete target for one worker run.                   |
| `StageWorkUnitDef.acceptance` | no       | lead   | Optional work-unit-specific completion rubric.            |

The lead-facing tool input does not include engine-owned fields:

```ts
plan_stage_round({
  stageId: string;
  title?: string;
  intent: string;
  workUnits: Array<{
    title: string;
    objective: string;
    acceptance?: string[];
  }>;
});
```

Use `Work Unit` only for stage-round child work. Use `Work Item` only for the
user-facing durable coordination object in a workspace.

## Lead Tools

The lead's protocol tools are narrow:

```ts
submit_requirement_spec({
  summary: string;
  constraints?: string[];
  acceptance?: string[];
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

plan_stage_round({
  stageId: string;
  title?: string;
  intent: string;
  workUnits: Array<{
    title: string;
    objective: string;
    acceptance?: string[];
  }>;
});
```

`submit_requirement_spec` is the only path from a newly created task into
planning. The engine writes the planning trigger after the requirement spec is
recorded. The planner must end its planning run by calling `submit_plan`; a
plan inferred from stdout or narrative text is not accepted as a submitted
plan.

`accept_plan` is the only path into stage execution. `reject_plan` records why
the current plan is not acceptable and gives the next planner run concrete
revision context.

`plan_stage_round` is the only path from an active stage into worker execution.
The lead may plan another round only after the previous round has reached a
reviewed boundary.

## Stage Execution

Accepted plans execute stages in order.

Within one stage, execution proceeds as a loop of stage rounds. This is the key
difference from `agent-loop.runTask`: Sikong can coordinate multiple worker
runs across one durable stage and review the accumulated result.

The round policy is intentionally small:

1. when a stage starts, the engine waits for the lead to plan the next
   `StageRoundDef`;
2. the engine starts one worker run for each work unit in the round;
3. work units in the same round run concurrently;
4. rounds for the same stage are serial;
5. after all work-unit runs in a round are terminal, the engine starts stage
   review over the stage evidence accumulated so far;
6. accepted stage review advances to the next stage;
7. rejected stage review keeps the task on the same stage and returns to lead
   round planning with reviewer feedback.

The normal round-loop stop condition is accepted stage review. Budget,
cancellation, blocked, and final lead rejection are system or lead-level escape
conditions, not normal stage completion.

In the daemon-backed product path, round concurrency means one daemon-supervised
subprocess per work unit. TypeScript may use promise coordination to launch and
wait for the subprocesses, but each worker remains an independent runtime
process with its own process facts, timeout, and cancellation surface.

Each worker run:

1. receives the current task context, stage definition, round intent, and one
   work unit definition;
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

Stage review starts after the current stage round's work-unit runs are all
terminal.

The reviewer evaluates:

- the stage objective;
- the acceptance criteria;
- all relevant worker run results;
- command evidence, file changes, or external context when needed.

Accepted stage review advances the task to the next stage. Rejected stage
review keeps the task on the same stage and records review feedback for the next
stage round.

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
requirement_spec.submitted
plan.requested
plan.submitted
plan.accepted
plan.rejected
stage.started
stage_round.planned
stage_round.completed
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
- a current stage has at most one active stage round;
- a stage round has one or more work units;
- the engine starts one worker run per work unit;
- workers can only add run results to the current stage;
- worker results must be submitted through the terminal `runTask` result tool;
- reviewers decide stage advancement;
- the lead submits requirement specs, decides plan acceptance, plans stage
  rounds, and decides final task acceptance.

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
- stage rounds are planned dynamically by the lead during execution;
- reviewers judge whether the criteria are satisfied;
- workers only execute work units through `runTask`.

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
- stage round history;
- worker run history;
- stage and final reviews;
- lead decisions;
- lead-controlled workspace preference policy;
- inspection and wake scheduling.

Sikong may use many `runTask` calls to complete one durable task.

## Deferred Questions

The first implementation should not solve these yet:

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
Lead, planner, worker, and reviewer runtime-backed actions until a worker-result
wait, terminal, blocked, or action-budget boundary. Runtime-backed actions can
be executed through daemon-supervised generic Bun child processes, while task
semantics remain in the TypeScript engine and command handlers.

`PlanStageDef.workerCount` has been removed from protocol types, planner tool
input, CLI plan JSON, orchestration scheduling, tests, and inspect output. Do
not keep a compatibility fallback or a second worker-count execution path. Stage
parallelism is expressed only by work units inside one lead-planned stage round.
