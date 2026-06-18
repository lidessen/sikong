import {
  summarizeProjectionNextAction,
  type OrchestrationActionSummary,
} from "../orchestration/summary";
import { activeRound as getActiveRound, describeRound } from "../coordination";
import type {
  PlanDecisionProjection,
  TaskEvent,
  TaskProjection,
  TaskRunResult,
} from "../coordination";

export interface TaskSummary {
  taskId: string;
  workspaceId: string;
  status: TaskProjection["status"];
  request?: string;
  currentStageId?: string;
  planStatus?: PlanDecisionProjection["status"];
  workerRuns: number;
  runtimeProcesses: number;
  queuedRuntimeProcesses: number;
  runningRuntimeProcesses: number;
  acceptedStages: number;
  terminal?: TaskProjection["terminal"];
  updatedAt?: string;
}

export interface TaskCompactView {
  taskId: string;
  workspaceId: string;
  status: TaskProjection["status"];
  request?: string;
  currentStage?: {
    id: string;
    title: string;
  };
  activeRound?: {
    id: string;
    title?: string;
    intent: string;
    workUnits: number;
    startedWorkUnits: number;
    runningWorkUnits: number;
    completedWorkUnits: number;
  };
  plan?: {
    status?: PlanDecisionProjection["status"];
    id?: string;
    version?: number;
    stageCount: number;
  };
  nextAction: TaskCompactNextAction;
  waitingForLead: boolean;
  latestWorkerResult?: {
    runId: string;
    stageId: string;
    status: TaskProjection["workerRuns"][string]["status"];
    summary?: string;
    finishedAt?: string;
  };
  runtimeProcesses: {
    total: number;
    queued: number;
    running: number;
  };
  latestRuntimeProcess?: {
    processRunId: string;
    actionType: string;
    status: NonNullable<TaskProjection["runtimeProcessRuns"]>[string]["status"];
    processStatus?: NonNullable<TaskProjection["runtimeProcessRuns"]>[string]["processStatus"];
    startedAt: string;
    finishedAt?: string;
  };
  latestReview?: {
    reviewId: string;
    stageId?: string;
    status: string;
    recommendation?: "accept" | "reject";
    report?: string;
    finishedAt?: string;
  };
  terminal?: TaskProjection["terminal"];
  updatedAt?: string;
}

export type TaskCompactNextAction = OrchestrationActionSummary;

export interface TaskTraceEntry {
  eventId: string;
  type: TaskEvent["type"];
  createdAt: string;
  summary: string;
}

export interface TaskDetailView {
  compact: TaskCompactView;
  projection: TaskProjection;
  trace: TaskTraceEntry[];
  events: TaskEvent[];
  observations: Array<{
    runId: string;
    stageId: string;
    roundId: string;
    workUnitId: string;
    observations: NonNullable<TaskRunResult["observations"]>;
  }>;
}

export interface RunnableTaskView {
  workspaceId: string;
  taskId: string;
  status: TaskCompactView["status"];
  nextAction: TaskCompactView["nextAction"];
  currentStage?: TaskCompactView["currentStage"];
  activeRound?: TaskCompactView["activeRound"];
  runtimeProcesses: TaskCompactView["runtimeProcesses"];
  updatedAt?: string;
}

export function compactTaskView(projection: TaskProjection): TaskCompactView {
  const currentStage = projection.plan?.stages.find(
    (stage) => stage.id === projection.currentStageId,
  );
  const nextAction = summarizeProjectionNextAction(projection);
  const latestWorker = latestWorkerRun(projection);
  const runtimeProcesses = Object.values(projection.runtimeProcessRuns ?? {});
  const latestRuntimeProcess = latestRuntimeProcessRun(projection);
  const latestReview = latestReviewProjection(projection);
  const activeRound = getActiveRound(projection);
  const activeRoundState = activeRound ? describeRound(projection, activeRound) : undefined;
  return {
    taskId: projection.taskId,
    workspaceId: projection.workspaceId,
    status: projection.status,
    ...(projection.request ? { request: projection.request } : {}),
    ...(currentStage ? { currentStage: { id: currentStage.id, title: currentStage.title } } : {}),
    ...(activeRound
      ? {
          activeRound: {
            id: activeRound.id,
            ...(activeRound.title ? { title: activeRound.title } : {}),
            intent: activeRound.intent,
            workUnits: activeRoundState?.workUnits ?? 0,
            startedWorkUnits: activeRoundState?.startedRuns ?? 0,
            runningWorkUnits: activeRoundState?.runningRuns ?? 0,
            completedWorkUnits: activeRoundState?.completedRuns ?? 0,
          },
        }
      : {}),
    ...(projection.plan || projection.planDecision
      ? {
          plan: {
            ...(projection.planDecision?.status ? { status: projection.planDecision.status } : {}),
            ...(projection.plan?.id ? { id: projection.plan.id } : {}),
            ...(projection.plan?.version !== undefined ? { version: projection.plan.version } : {}),
            stageCount: projection.plan?.stages.length ?? 0,
          },
        }
      : {}),
    nextAction,
    waitingForLead:
      nextAction.type === "start_lead_requirement_spec" ||
      nextAction.type === "start_lead_plan_decision" ||
      nextAction.type === "start_lead_round_planning" ||
      nextAction.type === "start_lead_final_decision",
    runtimeProcesses: {
      total: runtimeProcesses.length,
      queued: runtimeProcesses.filter((processRun) => processRun.status === "queued").length,
      running: runtimeProcesses.filter((processRun) => processRun.status === "running").length,
    },
    ...(latestWorker
      ? {
          latestWorkerResult: {
            runId: latestWorker.runId,
            stageId: latestWorker.stageId,
            status: latestWorker.status,
            ...(latestWorker.result?.summary ? { summary: latestWorker.result.summary } : {}),
            ...(latestWorker.finishedAt ? { finishedAt: latestWorker.finishedAt } : {}),
          },
        }
      : {}),
    ...(latestRuntimeProcess
      ? {
          latestRuntimeProcess: {
            processRunId: latestRuntimeProcess.processRunId,
            actionType: latestRuntimeProcess.actionType,
            status: latestRuntimeProcess.status,
            ...(latestRuntimeProcess.processStatus
              ? { processStatus: latestRuntimeProcess.processStatus }
              : {}),
            startedAt: latestRuntimeProcess.startedAt,
            ...(latestRuntimeProcess.finishedAt
              ? { finishedAt: latestRuntimeProcess.finishedAt }
              : {}),
          },
        }
      : {}),
    ...(latestReview ? { latestReview } : {}),
    ...(projection.terminal ? { terminal: projection.terminal } : {}),
    ...(projection.updatedAt ? { updatedAt: projection.updatedAt } : {}),
  };
}

export function isTaskWaitBoundary(compact: TaskCompactView): boolean {
  if (compact.terminal) return true;
  if (compact.waitingForLead) return true;
  return (
    compact.nextAction.type === "await_worker_results" || compact.nextAction.type === "blocked"
  );
}

export function isRunnableTaskCompact(compact: TaskCompactView): boolean {
  if (compact.terminal) return false;
  if (compact.runtimeProcesses.running > 0) return false;
  return !(
    compact.nextAction.type === "await_worker_results" ||
    compact.nextAction.type === "blocked" ||
    compact.nextAction.type === "terminal"
  );
}

function latestWorkerRun(
  projection: TaskProjection,
): TaskProjection["workerRuns"][string] | undefined {
  return Object.values(projection.workerRuns).sort((a, b) =>
    String(b.finishedAt ?? b.startedAt).localeCompare(String(a.finishedAt ?? a.startedAt)),
  )[0];
}

function latestRuntimeProcessRun(
  projection: TaskProjection,
): NonNullable<TaskProjection["runtimeProcessRuns"]>[string] | undefined {
  return Object.values(projection.runtimeProcessRuns ?? {}).sort((a, b) =>
    String(b.finishedAt ?? b.startedAt).localeCompare(String(a.finishedAt ?? a.startedAt)),
  )[0];
}

function latestReviewProjection(projection: TaskProjection): TaskCompactView["latestReview"] {
  const latestStage = Object.values(projection.stageReviews).sort((a, b) =>
    String(b.finishedAt ?? b.startedAt).localeCompare(String(a.finishedAt ?? a.startedAt)),
  )[0];

  const latestFinal = projection.finalReview;
  if (!latestStage && !latestFinal) return undefined;
  if (!latestStage) {
    if (!latestFinal) return undefined;
    return {
      reviewId: latestFinal.reviewId,
      status: latestFinal.status,
      ...(latestFinal.recommendation ? { recommendation: latestFinal.recommendation } : {}),
      ...(latestFinal.report ? { report: latestFinal.report } : {}),
      ...(latestFinal.finishedAt ? { finishedAt: latestFinal.finishedAt } : {}),
    };
  }
  if (
    latestFinal &&
    String(latestFinal.finishedAt ?? latestFinal.startedAt).localeCompare(
      String(latestStage.finishedAt ?? latestStage.startedAt),
    ) >= 0
  ) {
    return {
      reviewId: latestFinal.reviewId,
      status: latestFinal.status,
      ...(latestFinal.recommendation ? { recommendation: latestFinal.recommendation } : {}),
      ...(latestFinal.report ? { report: latestFinal.report } : {}),
      ...(latestFinal.finishedAt ? { finishedAt: latestFinal.finishedAt } : {}),
    };
  }

  return {
    reviewId: latestStage.reviewId,
    stageId: latestStage.stageId,
    status: latestStage.status,
    ...(latestStage.report ? { report: latestStage.report } : {}),
    ...(latestStage.finishedAt ? { finishedAt: latestStage.finishedAt } : {}),
  };
}
