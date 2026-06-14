import type {
  PlanDecisionProjection,
  StageReviewProjection,
  TaskEvent,
  TaskProjection,
  WorkerRunProjection,
  WorkerRunStatus,
} from "./types";

export function reduceTaskEvents(events: readonly TaskEvent[]): TaskProjection | null {
  let projection: TaskProjection | null = null;
  for (const event of events) {
    projection = applyTaskEvent(projection, event);
  }
  return projection;
}

export function applyTaskEvent(
  projection: TaskProjection | null,
  event: TaskEvent,
): TaskProjection {
  const next = projection ? cloneProjection(projection) : emptyProjection(event);

  if (next.taskId !== event.taskId || next.workspaceId !== event.workspaceId) {
    throw new Error("task event does not belong to this projection");
  }

  next.updatedAt = event.createdAt;
  next.eventCount += 1;

  switch (event.type) {
    case "task.created":
      next.request = event.request;
      next.runtime = event.runtime;
      next.createdAt = event.createdAt;
      next.status = "created";
      break;
    case "plan.requested":
      next.status = "planning";
      next.planDecision = planDecision("requested", event.createdAt);
      break;
    case "plan.submitted":
      next.status = "plan_submitted";
      next.plan = event.plan;
      next.planDecision = planDecision("submitted", event.createdAt, {
        planId: event.plan.id,
        version: event.plan.version,
      });
      break;
    case "plan.accepted":
      next.status = "running";
      next.planDecision = planDecision("accepted", event.createdAt, {
        planId: event.planId,
        version: event.version,
        report: event.report,
      });
      break;
    case "plan.rejected":
      next.status = "planning";
      next.planDecision = planDecision("rejected", event.createdAt, {
        planId: event.planId,
        version: event.version,
        report: event.report,
        requestedChanges: event.requestedChanges,
      });
      break;
    case "stage.started":
      next.status = "running";
      next.currentStageId = event.stageId;
      break;
    case "worker_run.started":
      next.status = "running";
      next.workerRuns[event.runId] = {
        runId: event.runId,
        stageId: event.stageId,
        workerId: event.workerId,
        status: "running",
        objective: event.objective,
        startedAt: event.createdAt,
      };
      break;
    case "worker_run.completed":
      next.workerRuns[event.runId] = finishWorkerRun(
        next.workerRuns[event.runId],
        event,
        "completed",
      );
      break;
    case "worker_run.failed":
      next.workerRuns[event.runId] = finishWorkerRun(next.workerRuns[event.runId], event, "failed");
      break;
    case "worker_run.budget_exceeded":
      next.workerRuns[event.runId] = finishWorkerRun(
        next.workerRuns[event.runId],
        event,
        "budget_exceeded",
      );
      break;
    case "stage.review.started":
      next.status = "reviewing";
      next.stageReviews[event.reviewId] = {
        reviewId: event.reviewId,
        stageId: event.stageId,
        status: "started",
        startedAt: event.createdAt,
      };
      break;
    case "stage.review.accepted":
      next.status = "running";
      next.stageReviews[event.reviewId] = finishStageReview(
        next.stageReviews[event.reviewId],
        event,
        "accepted",
      );
      next.acceptedStageIds = appendUnique(next.acceptedStageIds, event.stageId);
      break;
    case "stage.review.rejected":
      next.status = "running";
      next.stageReviews[event.reviewId] = finishStageReview(
        next.stageReviews[event.reviewId],
        event,
        "rejected",
      );
      break;
    case "stage.advanced":
      next.status = "running";
      next.currentStageId = event.toStageId;
      break;
    case "final.review.started":
      next.status = "reviewing";
      next.finalReview = {
        reviewId: event.reviewId,
        status: "started",
        startedAt: event.createdAt,
      };
      break;
    case "final.review.recommended":
      next.status = "reviewing";
      next.finalReview = {
        ...(next.finalReview ?? { reviewId: event.reviewId, status: "started" as const }),
        reviewId: event.reviewId,
        status: "recommended",
        recommendation: event.recommendation,
        report: event.report,
        finishedAt: event.createdAt,
      };
      break;
    case "task.accepted":
      next.status = "accepted";
      next.terminal = {
        outcome: "accepted",
        report: event.report,
        at: event.createdAt,
      };
      break;
    case "task.rejected":
      next.status = "rejected";
      next.terminal = {
        outcome: "rejected",
        report: event.report,
        at: event.createdAt,
      };
      break;
    case "task.completed":
      next.status = "completed";
      next.terminal = {
        outcome: event.outcome,
        report: event.report,
        at: event.createdAt,
      };
      break;
  }

  return next;
}

function emptyProjection(event: TaskEvent): TaskProjection {
  return {
    taskId: event.taskId,
    workspaceId: event.workspaceId,
    status: "created",
    acceptedStageIds: [],
    workerRuns: {},
    stageReviews: {},
    eventCount: 0,
  };
}

function cloneProjection(projection: TaskProjection): TaskProjection {
  return {
    ...projection,
    acceptedStageIds: [...projection.acceptedStageIds],
    workerRuns: { ...projection.workerRuns },
    stageReviews: { ...projection.stageReviews },
  };
}

function planDecision(
  status: PlanDecisionProjection["status"],
  updatedAt: string,
  rest: Omit<PlanDecisionProjection, "status" | "updatedAt"> = {},
): PlanDecisionProjection {
  return {
    status,
    updatedAt,
    ...rest,
  };
}

function finishWorkerRun(
  existing: WorkerRunProjection | undefined,
  event: Extract<
    TaskEvent,
    { type: "worker_run.completed" | "worker_run.failed" | "worker_run.budget_exceeded" }
  >,
  status: WorkerRunStatus,
): WorkerRunProjection {
  return {
    ...(existing ?? {
      runId: event.runId,
      stageId: event.stageId,
    }),
    runId: event.runId,
    stageId: event.stageId,
    status,
    result: event.result,
    finishedAt: event.createdAt,
  };
}

function finishStageReview(
  existing: StageReviewProjection | undefined,
  event: Extract<TaskEvent, { type: "stage.review.accepted" | "stage.review.rejected" }>,
  status: StageReviewProjection["status"],
): StageReviewProjection {
  return {
    ...(existing ?? {
      reviewId: event.reviewId,
      stageId: event.stageId,
    }),
    reviewId: event.reviewId,
    stageId: event.stageId,
    status,
    report: event.report,
    requestedChanges: event.type === "stage.review.rejected" ? event.requestedChanges : undefined,
    finishedAt: event.createdAt,
  };
}

function appendUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}
