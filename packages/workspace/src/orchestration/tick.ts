import type { Skill, TaskInput, ToolSet } from "agent-loop";
import type {
  StageReviewProjection,
  StageRoundProjection,
  TaskProjection,
  WorkerRunProjection,
} from "../coordination";
import {
  createFinalVerificationPreset,
  createPlanningPreset,
  createStageExecutionPreset,
  createStageVerificationPreset,
  type WorkerRunSpec,
} from "../runtime";
import type { RunWorkerTaskInput } from "../runtime";

export interface OrchestrationPresetTools {
  leadProtocolTools?: ToolSet;
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
      type: "start_lead_requirement_spec";
      spec: WorkerRunSpec;
    }
  | {
      type: "start_planning_worker";
      spec: WorkerRunSpec;
    }
  | {
      type: "start_lead_plan_decision";
      spec: WorkerRunSpec;
    }
  | {
      type: "start_lead_round_planning";
      spec: WorkerRunSpec;
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
      type: "complete_stage_round";
      taskId: string;
      workspaceId: string;
      roundId: string;
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
      type: "start_lead_final_decision";
      spec: WorkerRunSpec;
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
    return startLeadPlanDecision(input);
  }

  if (projection.status === "created") {
    if (!projection.requirementSpec) return startLeadRequirementSpec(input);
    return {
      type: "blocked",
      taskId: projection.taskId,
      reason: "Created task has a requirement spec but no planning trigger.",
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
    return startLeadRoundPlanning(input);
  }

  const activeRound = projection.activeRoundId
    ? projection.stageRounds[projection.activeRoundId]
    : undefined;
  const latestRound = latestRoundForStage(projection, stageId);

  if (!activeRound) {
    if (latestRound?.status === "completed") {
      return {
        type: "start_stage_review",
        taskId: projection.taskId,
        workspaceId: projection.workspaceId,
        stageId,
      };
    }
    return startLeadRoundPlanning(input);
  }

  const unstartedWorkUnit = activeRound.workUnits.find(
    (workUnit) =>
      !Object.values(projection.workerRuns).some(
        (run) => run.roundId === activeRound.id && run.workUnitId === workUnit.id,
      ),
  );
  if (unstartedWorkUnit) return startStageWorker(input, activeRound, unstartedWorkUnit.id);

  const allRuns = runsForRound(projection, activeRound.id);
  const terminalRuns = terminalRunsForRound(projection, activeRound.id);
  if (terminalRuns.length < activeRound.workUnits.length) {
    return {
      type: "await_worker_results",
      taskId: projection.taskId,
      stageId,
      runningRuns: allRuns.length - terminalRuns.length,
      targetRuns: activeRound.workUnits.length,
    };
  }

  return {
    type: "complete_stage_round",
    taskId: projection.taskId,
    workspaceId: projection.workspaceId,
    roundId: activeRound.id,
  };
}

function startLeadRequirementSpec(input: OrchestrationInput): OrchestrationAction {
  return {
    type: "start_lead_requirement_spec",
    spec: createLeadPreset(input, "requirement_spec"),
  };
}

function startLeadPlanDecision(input: OrchestrationInput): OrchestrationAction {
  return {
    type: "start_lead_plan_decision",
    spec: createLeadPreset(input, "plan_decision"),
  };
}

function startLeadRoundPlanning(input: OrchestrationInput): OrchestrationAction {
  return {
    type: "start_lead_round_planning",
    spec: createLeadPreset(input, "round_planning"),
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
      type: "start_lead_final_decision",
      spec: createLeadPreset(input, "final_decision"),
    };
  }

  return {
    type: "blocked",
    taskId: projection.taskId,
    reason: "Reviewing task has no active stage or final review.",
  };
}

function startStageWorker(
  input: OrchestrationInput,
  round: StageRoundProjection,
  workUnitId: string,
): OrchestrationAction {
  return {
    type: "start_stage_worker",
    input: createStageExecutionPreset({
      projection: input.projection,
      roundId: round.id,
      workUnitId,
      baseTaskInput: input.workerTaskInput,
      executionTools: input.tools.executionTools,
      skills: input.executionSkills,
    }),
  };
}

function createLeadPreset(
  input: OrchestrationInput,
  phase: "requirement_spec" | "plan_decision" | "round_planning" | "final_decision",
): WorkerRunSpec {
  return {
    workspaceId: input.projection.workspaceId,
    taskId: input.projection.taskId,
    prompt: [
      `You are Sikong's internal Task Lead for phase: ${phase}.`,
      "",
      `Task: ${input.projection.request ?? input.projection.taskId}`,
      "",
      ...(input.projection.requirementSpec
        ? ["Requirement spec:", input.projection.requirementSpec.summary, ""]
        : []),
      ...(input.projection.plan
        ? [
            "Submitted/accepted plan:",
            input.projection.plan.summary ?? input.projection.plan.id,
            "",
          ]
        : []),
      "Use only the provided protocol tool for the current phase.",
    ].join("\n"),
    tools:
      phase === "requirement_spec" || phase === "plan_decision" || phase === "round_planning"
        ? input.tools.leadProtocolTools
        : undefined,
    skills: input.planningSkills,
  };
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
