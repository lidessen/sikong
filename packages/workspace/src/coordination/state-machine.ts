import type {
  PlanStageDef,
  StageReviewProjection,
  StageRoundProjection,
  StageWorkUnitDef,
  TaskProjection,
  WorkerRunProjection,
  WorkerRunStatus,
} from "./types";

export type TaskPhase =
  | "specifying"
  | "planning"
  | "plan_review"
  | "executing"
  | "final_review"
  | "completed"
  | "rejected";

export interface RoundState {
  round: StageRoundProjection;
  workUnits: number;
  startedRuns: number;
  runningRuns: number;
  terminalRuns: number;
  completedRuns: number;
  failedRuns: number;
  budgetExceededRuns: number;
  unstartedWorkUnits: StageWorkUnitDef[];
  readyToComplete: boolean;
}

export function deriveTaskPhase(projection: TaskProjection): TaskPhase {
  if (projection.terminal?.outcome === "accepted" || projection.status === "completed") {
    return "completed";
  }
  if (projection.terminal?.outcome === "rejected" || projection.status === "rejected") {
    return "rejected";
  }
  if (projection.status === "created") return "specifying";
  if (projection.status === "planning") return "planning";
  if (projection.status === "plan_submitted") return "plan_review";
  if (projection.finalReview) return "final_review";
  if (projection.status === "reviewing" && projection.finalReview) return "final_review";
  return "executing";
}

export function currentStage(projection: TaskProjection): PlanStageDef | undefined {
  return projection.plan?.stages.find((stage) => stage.id === projection.currentStageId);
}

export function activeRound(projection: TaskProjection): StageRoundProjection | undefined {
  return projection.activeRoundId ? projection.stageRounds[projection.activeRoundId] : undefined;
}

export function describeRound(projection: TaskProjection, round: StageRoundProjection): RoundState {
  const runs = runsForRound(projection, round.id);
  const terminalRuns = runs.filter(isWorkerRunTerminal);
  const unstartedWorkUnits = round.workUnits.filter(
    (workUnit) => !runs.some((run) => run.workUnitId === workUnit.id),
  );
  return {
    round,
    workUnits: round.workUnits.length,
    startedRuns: runs.length,
    runningRuns: runs.filter((run) => run.status === "running").length,
    terminalRuns: terminalRuns.length,
    completedRuns: runs.filter((run) => run.status === "completed").length,
    failedRuns: runs.filter((run) => run.status === "failed").length,
    budgetExceededRuns: runs.filter((run) => run.status === "budget_exceeded").length,
    unstartedWorkUnits,
    readyToComplete:
      runs.length === round.workUnits.length && terminalRuns.length === round.workUnits.length,
  };
}

export function isWorkerRunTerminal(run: WorkerRunProjection): boolean {
  return isTerminalWorkerRunStatus(run.status);
}

export function isTerminalWorkerRunStatus(status: WorkerRunStatus): boolean {
  return status !== "running";
}

export function runsForRound(projection: TaskProjection, roundId: string): WorkerRunProjection[] {
  return Object.values(projection.workerRuns).filter((run) => run.roundId === roundId);
}

export function latestRoundForStage(
  projection: TaskProjection,
  stageId: string,
): StageRoundProjection | undefined {
  return Object.values(projection.stageRounds)
    .filter((round) => round.stageId === stageId)
    .sort((a, b) =>
      String(b.completedAt ?? b.startedAt).localeCompare(String(a.completedAt ?? a.startedAt)),
    )[0];
}

export function latestStageReview(
  projection: TaskProjection,
  stageId: string,
): StageReviewProjection | undefined {
  return Object.values(projection.stageReviews)
    .filter((review) => review.stageId === stageId)
    .sort((a, b) =>
      String(b.finishedAt ?? b.startedAt).localeCompare(String(a.finishedAt ?? a.startedAt)),
    )[0];
}
