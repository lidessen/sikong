import type { StageReviewProjection, TaskProjection, WorkerRunProjection } from "../coordination";

export type OrchestrationActionSummary =
  | { type: "start_planning_worker" }
  | { type: "await_plan_decision"; planId?: string; version?: number }
  | { type: "start_stage_worker"; stageId: string }
  | {
      type: "await_worker_results";
      stageId: string;
      runningRuns: number;
      targetRuns: number;
    }
  | { type: "start_stage_review"; stageId: string }
  | { type: "start_stage_verification_worker"; reviewId: string; stageId: string }
  | { type: "start_final_verification_worker"; reviewId: string }
  | { type: "await_final_decision"; recommendation?: "accept" | "reject" }
  | { type: "terminal"; outcome: "accepted" | "rejected" }
  | { type: "blocked"; reason: string };

export function summarizeProjectionNextAction(
  projection: TaskProjection,
): OrchestrationActionSummary {
  if (projection.terminal) {
    return { type: "terminal", outcome: projection.terminal.outcome };
  }

  if (projection.status === "planning") return { type: "start_planning_worker" };

  if (projection.status === "plan_submitted") {
    return {
      type: "await_plan_decision",
      ...(projection.plan?.id ? { planId: projection.plan.id } : {}),
      ...(projection.plan?.version !== undefined ? { version: projection.plan.version } : {}),
    };
  }

  if (projection.status === "running") return summarizeRunningAction(projection);
  if (projection.status === "reviewing") return summarizeReviewingAction(projection);

  return { type: "blocked", reason: `No next action for task status ${projection.status}.` };
}

function summarizeRunningAction(projection: TaskProjection): OrchestrationActionSummary {
  const stageId = projection.currentStageId;
  if (!stageId) return { type: "blocked", reason: "Running task has no current stage." };

  const latestReview = latestStageReview(projection, stageId);
  if (latestReview?.status === "rejected") return { type: "start_stage_worker", stageId };

  const stage = projection.plan?.stages.find((candidate) => candidate.id === stageId);
  const targetRuns = stageWorkerCount(stage);
  const allRuns = runsForStage(projection, stageId);
  if (allRuns.length < targetRuns) return { type: "start_stage_worker", stageId };

  const terminalRuns = terminalRunsForStage(projection, stageId);
  if (terminalRuns.length < targetRuns) {
    return {
      type: "await_worker_results",
      stageId,
      runningRuns: allRuns.length - terminalRuns.length,
      targetRuns,
    };
  }

  return { type: "start_stage_review", stageId };
}

function summarizeReviewingAction(projection: TaskProjection): OrchestrationActionSummary {
  const activeStageReview = Object.values(projection.stageReviews).find(
    (review) => review.status === "started",
  );
  if (activeStageReview) {
    return {
      type: "start_stage_verification_worker",
      reviewId: activeStageReview.reviewId,
      stageId: activeStageReview.stageId,
    };
  }

  if (projection.finalReview?.status === "started") {
    return {
      type: "start_final_verification_worker",
      reviewId: projection.finalReview.reviewId,
    };
  }

  if (projection.finalReview?.status === "recommended") {
    return {
      type: "await_final_decision",
      ...(projection.finalReview.recommendation
        ? { recommendation: projection.finalReview.recommendation }
        : {}),
    };
  }

  return { type: "blocked", reason: "Reviewing task has no active stage or final review." };
}

function terminalRunsForStage(projection: TaskProjection, stageId: string): WorkerRunProjection[] {
  return runsForStage(projection, stageId).filter((run) => run.status !== "running");
}

function runsForStage(projection: TaskProjection, stageId: string): WorkerRunProjection[] {
  return Object.values(projection.workerRuns).filter((run) => run.stageId === stageId);
}

function stageWorkerCount(stage: { workerCount?: number } | undefined): number {
  return stage?.workerCount && stage.workerCount > 1 ? stage.workerCount : 1;
}

function latestStageReview(
  projection: TaskProjection,
  stageId: string,
): StageReviewProjection | undefined {
  return Object.values(projection.stageReviews)
    .filter((review) => review.stageId === stageId)
    .sort((a, b) =>
      String(b.finishedAt ?? b.startedAt).localeCompare(String(a.finishedAt ?? a.startedAt)),
    )[0];
}
