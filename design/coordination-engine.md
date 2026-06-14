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
directories. Runtime must provide an agent cwd for each run. For git work, that
cwd should be a workspace-owned worktree, not the resolved source repository.

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

Plan review is intentionally simple: the lead decides whether to accept the
planner's `PlanDef`. A dedicated plan reviewer can be added later as an advisory
worker, but it is not part of the default path.

Stage review is delegated to a reviewer worker by default because stage
acceptance can require file inspection, command evidence, external context, or
domain judgment. It is not just a structured field check.

Final review is separated from stage review because a sequence of accepted
stages can still fail the user's overall request. The final reviewer provides an
independent recommendation, while the lead remains the final authority.

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
};
```

Field rationale:

| Field                     | Required | Owner   | Why it exists                                                  |
| ------------------------- | -------- | ------- | -------------------------------------------------------------- |
| `PlanDef.id`              | yes      | engine  | Stable reference for events, review decisions, and inspection. |
| `PlanDef.version`         | yes      | engine  | Distinguishes rejected and revised plans under the same task.  |
| `PlanDef.summary`         | no       | planner | Human-readable orientation for lead/reviewer/inspect views.    |
| `PlanDef.stages`          | yes      | planner | Ordered coarse work phases. Must be non-empty.                 |
| `PlanStageDef.id`         | yes      | engine  | Stable reference for stage events and worker assignments.      |
| `PlanStageDef.title`      | yes      | planner | Short display label for traces and inspection.                 |
| `PlanStageDef.objective`  | yes      | planner | The stage's execution target for assigned workers.             |
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

The engine assigns `id`, `version`, and stage ids when recording the plan.

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

`request_plan` starts or restarts planning. `accept_plan` is the only path into
stage execution. `reject_plan` records why the current plan is not acceptable
and gives the next planner run concrete revision context.

## Stage Execution

Accepted plans execute stages in order.

Within one stage, the engine may run one or more worker runs concurrently. This
is the key difference from `agent-loop.runTask`: Sikong can coordinate multiple
workers against the same stage and persist their outputs.

Each worker run:

1. receives the current task context and stage definition;
2. runs through `agent-loop.runTask`;
3. ends as `completed`, `failed`, or `budget_exceeded`;
4. records its `TaskResult` into the durable task event log.

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
4. Add minimal planner, worker, reviewer, and lead command handlers.
5. Connect worker execution to `agent-loop.runTask`.
6. Add inspect views over the event log and projection.
