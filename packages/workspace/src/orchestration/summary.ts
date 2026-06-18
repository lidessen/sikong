import type { TaskProjection } from "../coordination";
import {
  activeRound,
  describeRound,
  latestRoundForStage,
  latestStageReview,
} from "../coordination";

export type OrchestrationActionSummary =
  | { type: "start_lead_requirement_spec" }
  | { type: "start_planning_worker" }
  | { type: "start_lead_plan_decision"; planId?: string; version?: number }
  | { type: "start_lead_round_planning"; stageId: string }
  | { type: "start_stage_worker"; stageId: string; roundId: string; workUnitId: string }
  | {
      type: "start_stage_workers";
      stageId: string;
      roundId: string;
      workUnitIds: string[];
      count: number;
    }
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

  const round = activeRound(projection);
  const latestRound = latestRoundForStage(projection, stageId);
  if (!round) {
    if (latestRound?.status === "completed") {
      if (roundNeedsLeadDecision(projection, latestRound)) {
        return { type: "start_lead_round_planning", stageId };
      }
      return { type: "start_stage_review", stageId };
    }
    return { type: "start_lead_round_planning", stageId };
  }

  const roundState = describeRound(projection, round);
  if (roundState.unstartedWorkUnits.length === 1) {
    return {
      type: "start_stage_worker",
      stageId,
      roundId: round.id,
      workUnitId: roundState.unstartedWorkUnits[0]!.id,
    };
  }
  if (roundState.unstartedWorkUnits.length > 1) {
    return {
      type: "start_stage_workers",
      stageId,
      roundId: round.id,
      workUnitIds: roundState.unstartedWorkUnits.map((workUnit) => workUnit.id),
      count: roundState.unstartedWorkUnits.length,
    };
  }

  if (!roundState.readyToComplete) {
    return {
      type: "await_worker_results",
      stageId,
      runningRuns: roundState.runningRuns,
      targetRuns: roundState.workUnits,
    };
  }

  return { type: "complete_stage_round", roundId: round.id };
}

function roundNeedsLeadDecision(
  projection: TaskProjection,
  round: NonNullable<TaskProjection["stageRounds"][string]>,
): boolean {
  const roundState = describeRound(projection, round);
  return roundState.failedRuns > 0 || roundState.budgetExceededRuns > 0;
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
