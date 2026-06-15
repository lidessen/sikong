import type {
  StageReviewProjection,
  StageRoundProjection,
  TaskProjection,
  WorkerRunProjection,
} from "../coordination";

export type OrchestrationActionSummary =
  | { type: "start_lead_requirement_spec" }
  | { type: "start_planning_worker" }
  | { type: "start_lead_plan_decision"; planId?: string; version?: number }
  | { type: "start_lead_round_planning"; stageId: string }
  | { type: "start_stage_worker"; stageId: string; roundId: string; workUnitId: string }
  | {
      type: "await_worker_results";
      stageId: string;
      runningRuns: number;
      targetRuns: number;
    }
  | { type: "complete_stage_round"; roundId: string }
  | { type: "start_stage_review"; stageId: string }
  | { type: "start_stage_verification_worker"; reviewId: string; stageId: string }
  | { type: "start_final_verification_worker"; reviewId: string }
  | { type: "start_lead_final_decision"; recommendation?: "accept" | "reject" }
  | { type: "terminal"; outcome: "accepted" | "rejected" }
  | { type: "blocked"; reason: string };

export function summarizeProjectionNextAction(
  projection: TaskProjection,
): OrchestrationActionSummary {
  if (projection.terminal) {
    return { type: "terminal", outcome: projection.terminal.outcome };
  }

  if (projection.status === "created") return { type: "start_lead_requirement_spec" };

  if (projection.status === "planning") return { type: "start_planning_worker" };

  if (projection.status === "plan_submitted") {
    return {
      type: "start_lead_plan_decision",
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
  if (latestReview?.status === "rejected") return { type: "start_lead_round_planning", stageId };

  const activeRound = projection.activeRoundId
    ? projection.stageRounds[projection.activeRoundId]
    : undefined;
  const latestRound = latestRoundForStage(projection, stageId);
  if (!activeRound) {
    if (latestRound?.status === "completed") return { type: "start_stage_review", stageId };
    return { type: "start_lead_round_planning", stageId };
  }

  const unstartedWorkUnit = activeRound.workUnits.find(
    (workUnit) =>
      !Object.values(projection.workerRuns).some(
        (run) => run.roundId === activeRound.id && run.workUnitId === workUnit.id,
      ),
  );
  if (unstartedWorkUnit) {
    return {
      type: "start_stage_worker",
      stageId,
      roundId: activeRound.id,
      workUnitId: unstartedWorkUnit.id,
    };
  }

  const allRuns = runsForRound(projection, activeRound.id);
  const terminalRuns = terminalRunsForRound(projection, activeRound.id);
  if (terminalRuns.length < activeRound.workUnits.length) {
    return {
      type: "await_worker_results",
      stageId,
      runningRuns: allRuns.length - terminalRuns.length,
      targetRuns: activeRound.workUnits.length,
    };
  }

  return { type: "complete_stage_round", roundId: activeRound.id };
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
      type: "start_lead_final_decision",
      ...(projection.finalReview.recommendation
        ? { recommendation: projection.finalReview.recommendation }
        : {}),
    };
  }

  return { type: "blocked", reason: "Reviewing task has no active stage or final review." };
}

function terminalRunsForRound(projection: TaskProjection, roundId: string): WorkerRunProjection[] {
  return runsForRound(projection, roundId).filter((run) => run.status !== "running");
}

function runsForRound(projection: TaskProjection, roundId: string): WorkerRunProjection[] {
  return Object.values(projection.workerRuns).filter((run) => run.roundId === roundId);
}

function latestRoundForStage(
  projection: TaskProjection,
  stageId: string,
): StageRoundProjection | undefined {
  return Object.values(projection.stageRounds)
    .filter((round) => round.stageId === stageId)
    .sort((a, b) =>
      String(b.completedAt ?? b.startedAt).localeCompare(String(a.completedAt ?? a.startedAt)),
    )[0];
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
