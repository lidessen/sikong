import type { Skill, TaskInput, ToolSet } from "agent-loop";
import type { StageReviewProjection, TaskProjection, WorkerRunProjection } from "../coordination";
import {
  createFinalVerificationPreset,
  createPlanningPreset,
  createStageExecutionPreset,
  createStageVerificationPreset,
  type WorkerRunSpec,
} from "../runtime";
import type { RunWorkerTaskInput } from "../runtime";

export interface OrchestrationPresetTools {
  planningProtocolTools: ToolSet;
  stageReviewProtocolTools: ToolSet;
  finalReviewProtocolTools: ToolSet;
  inspectionTools?: ToolSet;
  executionTools?: ToolSet;
}

export interface OrchestrationInput {
  projection: TaskProjection;
  tools: OrchestrationPresetTools;
  workerTaskInput: Omit<TaskInput, "goal" | "tools" | "skills">;
  workspacePreferences?: readonly string[];
  requirementSpec?: string;
  planningSkills?: Skill[];
  executionSkills?: Skill[];
  verificationSkills?: Skill[];
}

export type OrchestrationAction =
  | {
      type: "start_planning_worker";
      spec: WorkerRunSpec;
    }
  | {
      type: "await_plan_decision";
      taskId: string;
      planId?: string;
      version?: number;
    }
  | {
      type: "start_stage_worker";
      input: Omit<RunWorkerTaskInput, "runTask">;
    }
  | {
      type: "await_worker_results";
      taskId: string;
      stageId: string;
      runningRuns: number;
      targetRuns: number;
    }
  | {
      type: "start_stage_review";
      taskId: string;
      workspaceId: string;
      stageId: string;
    }
  | {
      type: "start_stage_verification_worker";
      spec: WorkerRunSpec;
      reviewId: string;
    }
  | {
      type: "start_final_verification_worker";
      spec: WorkerRunSpec;
      reviewId: string;
    }
  | {
      type: "await_final_decision";
      taskId: string;
      recommendation?: "accept" | "reject";
    }
  | {
      type: "terminal";
      taskId: string;
      outcome: "accepted" | "rejected";
    }
  | {
      type: "blocked";
      taskId: string;
      reason: string;
    };

export function planNextOrchestrationAction(input: OrchestrationInput): OrchestrationAction {
  const { projection } = input;

  if (projection.terminal) {
    return {
      type: "terminal",
      taskId: projection.taskId,
      outcome: projection.terminal.outcome,
    };
  }

  if (projection.status === "planning") {
    return {
      type: "start_planning_worker",
      spec: createPlanningPreset({
        projection,
        requirementSpec: input.requirementSpec,
        workspacePreferences: input.workspacePreferences,
        inspectionTools: input.tools.inspectionTools,
        protocolTools: input.tools.planningProtocolTools,
        skills: input.planningSkills,
      }),
    };
  }

  if (projection.status === "plan_submitted") {
    return {
      type: "await_plan_decision",
      taskId: projection.taskId,
      planId: projection.plan?.id,
      version: projection.plan?.version,
    };
  }

  if (projection.status === "running") {
    return planRunningAction(input);
  }

  if (projection.status === "reviewing") {
    return planReviewingAction(input);
  }

  return {
    type: "blocked",
    taskId: projection.taskId,
    reason: `No orchestration action for task status ${projection.status}.`,
  };
}

function planRunningAction(input: OrchestrationInput): OrchestrationAction {
  const { projection } = input;
  const stageId = projection.currentStageId;
  if (!stageId) {
    return {
      type: "blocked",
      taskId: projection.taskId,
      reason: "Running task has no current stage.",
    };
  }

  const latestReview = latestStageReview(projection, stageId);
  if (latestReview?.status === "rejected") {
    return startStageWorker(input);
  }

  const stage = projection.plan?.stages.find((candidate) => candidate.id === stageId);
  const targetRuns = stageWorkerCount(stage);
  const allRuns = runsForStage(projection, stageId);
  if (allRuns.length < targetRuns) {
    return startStageWorker(input);
  }

  const terminalRuns = terminalRunsForStage(projection, stageId);
  if (terminalRuns.length < targetRuns) {
    return {
      type: "await_worker_results",
      taskId: projection.taskId,
      stageId,
      runningRuns: allRuns.length - terminalRuns.length,
      targetRuns,
    };
  }

  return {
    type: "start_stage_review",
    taskId: projection.taskId,
    workspaceId: projection.workspaceId,
    stageId,
  };
}

function planReviewingAction(input: OrchestrationInput): OrchestrationAction {
  const { projection } = input;
  const activeStageReview = Object.values(projection.stageReviews).find(
    (review) => review.status === "started",
  );
  if (activeStageReview) {
    return {
      type: "start_stage_verification_worker",
      reviewId: activeStageReview.reviewId,
      spec: createStageVerificationPreset({
        projection,
        reviewId: activeStageReview.reviewId,
        stageId: activeStageReview.stageId,
        inspectionTools: input.tools.inspectionTools,
        protocolTools: input.tools.stageReviewProtocolTools,
        skills: input.verificationSkills,
      }),
    };
  }

  if (projection.finalReview?.status === "started") {
    return {
      type: "start_final_verification_worker",
      reviewId: projection.finalReview.reviewId,
      spec: createFinalVerificationPreset({
        projection,
        reviewId: projection.finalReview.reviewId,
        inspectionTools: input.tools.inspectionTools,
        protocolTools: input.tools.finalReviewProtocolTools,
        skills: input.verificationSkills,
      }),
    };
  }

  if (projection.finalReview?.status === "recommended") {
    return {
      type: "await_final_decision",
      taskId: projection.taskId,
      recommendation: projection.finalReview.recommendation,
    };
  }

  return {
    type: "blocked",
    taskId: projection.taskId,
    reason: "Reviewing task has no active stage or final review.",
  };
}

function startStageWorker(input: OrchestrationInput): OrchestrationAction {
  return {
    type: "start_stage_worker",
    input: createStageExecutionPreset({
      projection: input.projection,
      baseTaskInput: input.workerTaskInput,
      executionTools: input.tools.executionTools,
      skills: input.executionSkills,
    }),
  };
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
