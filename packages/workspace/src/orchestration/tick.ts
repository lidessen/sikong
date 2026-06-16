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
      type: "start_stage_workers";
      inputs: Array<Omit<RunWorkerTaskInput, "runTask">>;
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

  const unstartedWorkUnits = activeRound.workUnits.filter(
    (workUnit) =>
      !Object.values(projection.workerRuns).some(
        (run) => run.roundId === activeRound.id && run.workUnitId === workUnit.id,
      ),
  );
  if (unstartedWorkUnits.length === 1) {
    return startStageWorker(input, activeRound, unstartedWorkUnits[0]!.id);
  }
  if (unstartedWorkUnits.length > 1) {
    return startStageWorkers(
      input,
      activeRound,
      unstartedWorkUnits.map((workUnit) => workUnit.id),
    );
  }

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

function startStageWorkers(
  input: OrchestrationInput,
  round: StageRoundProjection,
  workUnitIds: string[],
): OrchestrationAction {
  return {
    type: "start_stage_workers",
    inputs: workUnitIds.map((workUnitId) =>
      createStageExecutionPreset({
        projection: input.projection,
        roundId: round.id,
        workUnitId,
        baseTaskInput: input.workerTaskInput,
        executionTools: input.tools.executionTools,
        skills: input.executionSkills,
      }),
    ),
  };
}

function createLeadPreset(
  input: OrchestrationInput,
  phase: "requirement_spec" | "plan_decision" | "round_planning" | "final_decision",
): WorkerRunSpec {
  return {
    workspaceId: input.projection.workspaceId,
    taskId: input.projection.taskId,
    prompt: buildLeadPrompt(input, phase),
    tools: input.tools.leadProtocolTools,
    skills: input.planningSkills,
  };
}

function buildLeadPrompt(
  input: OrchestrationInput,
  phase: "requirement_spec" | "plan_decision" | "round_planning" | "final_decision",
): string {
  const { projection } = input;
  return [
    "You are Sikong's internal Task Lead.",
    "",
    "Your responsibility is to own task decisions and keep the durable workflow moving. You translate the user's request into a requirement spec, decide whether the Planner's stage roadmap is acceptable, plan the next tactical round for the current stage, and make the final accept/reject decision after review evidence is available.",
    "",
    "Execution belongs to Stage Workers. Plan authoring belongs to the Planner. Verification belongs to Reviewers. Your output for this phase is the relevant lead protocol decision.",
    "",
    `Current lead phase: ${phase}`,
    `Task: ${projection.request ?? projection.taskId}`,
    "",
    ...leadPhaseGuidance(phase),
    ...leadProjectionContext(projection),
    "Submit the current phase decision through the provided lead protocol tool.",
  ].join("\n");
}

function leadPhaseGuidance(
  phase: "requirement_spec" | "plan_decision" | "round_planning" | "final_decision",
): string[] {
  switch (phase) {
    case "requirement_spec":
      return [
        "Phase responsibility:",
        "- Capture the user's request as a clear requirement spec for planning.",
        "- Preserve important constraints, success criteria, and workspace intent.",
        "",
      ];
    case "plan_decision":
      return [
        "Phase responsibility:",
        "- Review the submitted stage roadmap against the requirement spec.",
        "- Accept a plan that gives the workers a coherent path to satisfy the request.",
        "- Reject with concrete requested changes when the roadmap is missing critical work.",
        "",
      ];
    case "round_planning":
      return [
        "Phase responsibility:",
        "- Plan only the next useful round for the active stage.",
        "- Split the round into one or more work units that can be executed independently.",
        "- For each work unit, define explicit instructions, deliverables, and out-of-scope boundaries so the worker knows exactly what to do and what not to do.",
        "- Do not ask a worker to complete another work unit, another stage, or the whole task unless the active stage is itself that small.",
        "- Use prior worker and reviewer evidence to aim the next round.",
        "",
      ];
    case "final_decision":
      return [
        "Phase responsibility:",
        "- Decide whether the completed work satisfies the original request.",
        "- Use final review recommendation and recorded worker evidence.",
        "- Accept or reject the task with a concise final report.",
        "",
      ];
  }
}

function leadProjectionContext(projection: TaskProjection): string[] {
  return [
    ...(projection.requirementSpec
      ? ["Requirement spec:", projection.requirementSpec.summary, ""]
      : []),
    ...(projection.plan
      ? [
          "Plan:",
          projection.plan.summary ?? projection.plan.id,
          ...projection.plan.stages.map(
            (stage) => `- ${stage.id}: ${stage.title} - ${stage.objective}`,
          ),
          "",
        ]
      : []),
    ...(projection.currentStageId ? [`Current stage id: ${projection.currentStageId}`, ""] : []),
    ...(projection.finalReview?.status
      ? [
          "Final review:",
          `${projection.finalReview.status}${
            projection.finalReview.recommendation
              ? ` (${projection.finalReview.recommendation})`
              : ""
          }`,
          ...(projection.finalReview.report ? [projection.finalReview.report] : []),
          "",
        ]
      : []),
  ];
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
