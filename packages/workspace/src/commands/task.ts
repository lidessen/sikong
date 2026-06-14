import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FileTaskEventStore,
  FileTaskProjectionStore,
  type PlanDecisionProjection,
  type PlanDef,
  type PlanStageDef,
  type TaskEvent,
  type TaskProjection,
  type TaskRunResult,
  type RuntimeProcessStatus,
} from "../coordination";
import {
  summarizeProjectionNextAction,
  type OrchestrationActionSummary,
} from "../orchestration/summary";
import { taskProjectionsDir } from "../data-dir";
import { FileWorkspaceStore, WorkspaceWorktreeError, allocateTaskWorktree } from "../workspace";
import { nextId } from "./ids";
import type { CommandContext, CommandResult } from "./types";
import { commandNow, fail, ok } from "./types";

export interface CreateTaskInput {
  workspaceId?: string;
  request: string;
  cwd?: string;
  repoPath?: string;
}

export interface TaskIdInput {
  workspaceId?: string;
  taskId: string;
}

export interface ListTasksInput {
  workspaceId?: string;
}

export interface SubmitPlanInput extends TaskIdInput {
  summary?: string;
  stages: Array<{
    title: string;
    objective: string;
    acceptance: string[];
    workerCount?: number;
  }>;
}

export interface PlanDecisionInput extends TaskIdInput {
  planId: string;
  version: number;
  report: string;
}

export interface RejectPlanInput extends PlanDecisionInput {
  requestedChanges?: string;
}

export interface StartWorkerRunInput extends TaskIdInput {
  stageId?: string;
  workerId?: string;
  objective?: string;
}

export interface FinishWorkerRunInput extends TaskIdInput {
  runId: string;
  summary: string;
  report?: string;
  note?: string;
}

export interface StageReviewInput extends TaskIdInput {
  stageId?: string;
}

export interface FinishStageReviewInput extends TaskIdInput {
  reviewId: string;
  report: string;
  requestedChanges?: string;
}

export interface RecommendFinalReviewInput extends TaskIdInput {
  reviewId: string;
  recommendation: "accept" | "reject";
  report: string;
}

export interface FinishTaskInput extends TaskIdInput {
  report: string;
}

export interface InspectTaskTraceInput extends TaskIdInput {
  follow?: boolean;
}

export interface WaitTaskInput extends TaskIdInput {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface RecordRuntimeProcessStartedInput extends TaskIdInput {
  processRunId: string;
  actionType: string;
}

export interface RecordRuntimeProcessFinishedInput extends TaskIdInput {
  processRunId: string;
  processStatus: RuntimeProcessStatus;
  exitCode?: number;
}

export async function createTask(
  ctx: CommandContext,
  input: CreateTaskInput,
): Promise<
  CommandResult<{
    taskId: string;
    projection: TaskProjection;
  }>
> {
  if (!input.request.trim()) return fail("invalid_input", "Task request must be non-empty.");
  const workspaceId = input.workspaceId ?? ctx.workspaceId;
  if (!workspaceId) return fail("invalid_input", "Workspace id is required.");

  const workspace = await new FileWorkspaceStore(ctx.dataDir).get(workspaceId);
  if (!workspace) return fail("workspace_not_found", "Workspace not found.", { workspaceId });

  const taskId = nextId("task", ctx.id);
  const runtime = await resolveRuntimeInput(ctx, { ...input, workspaceId, taskId });
  if (!runtime.ok) return runtime;

  const now = commandNow(ctx);
  const eventId = () => nextId("event", ctx.id);
  const events: TaskEvent[] = [
    {
      id: eventId(),
      type: "task.created",
      taskId,
      workspaceId,
      createdAt: now,
      request: input.request,
      ...(runtime.data ? { runtime: runtime.data } : {}),
    },
    {
      id: eventId(),
      type: "plan.requested",
      taskId,
      workspaceId,
      createdAt: now,
      brief: input.request,
    },
  ];

  const eventStore = new FileTaskEventStore(ctx.dataDir);
  const projection = await eventStore.appendManyAndRebuildProjection(events);
  if (!projection) return fail("internal_error", "Task projection was not created.");
  return ok({ taskId, projection });
}

export async function getTask(
  ctx: CommandContext,
  input: TaskIdInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  const loaded = await loadTaskProjection(ctx, input);
  if (!loaded.ok) return loaded;
  return ok({ projection: loaded.data.projection });
}

export async function listTasks(
  ctx: CommandContext,
  input: ListTasksInput = {},
): Promise<CommandResult<{ tasks: TaskCompactView[] }>> {
  const workspaceId = input.workspaceId ?? ctx.workspaceId;
  if (!workspaceId) return fail("invalid_input", "Workspace id is required.");
  const workspace = await new FileWorkspaceStore(ctx.dataDir).get(workspaceId);
  if (!workspace) return fail("workspace_not_found", "Workspace not found.", { workspaceId });

  const dir = taskProjectionsDir(ctx.dataDir, workspaceId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return ok({ tasks: [] });
    throw err;
  }

  const tasks: TaskCompactView[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const projection = JSON.parse(await readFile(join(dir, entry), "utf8")) as TaskProjection;
    tasks.push(compactTaskView(projection));
  }
  tasks.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return ok({ tasks });
}

export async function submitPlan(
  ctx: CommandContext,
  input: SubmitPlanInput,
): Promise<CommandResult<{ plan: PlanDef; projection: TaskProjection }>> {
  const loaded = await loadTaskProjection(ctx, input);
  if (!loaded.ok) return loaded;
  const projection = loaded.data.projection;
  if (projection.status !== "planning") {
    return fail("invalid_state", "Plan can only be submitted while task is planning.", {
      taskId: input.taskId,
      status: projection.status,
    });
  }

  const stages = validatePlanStages(input.stages);
  if (!stages.ok) return stages;

  const now = commandNow(ctx);
  const planId = projection.plan?.id ?? nextId("plan", ctx.id);
  const plan: PlanDef = {
    id: planId,
    version: (projection.plan?.version ?? 0) + 1,
    ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
    stages: stages.data.stages.map((stage) => ({
      ...stage,
      id: nextId("stage", ctx.id),
    })),
  };

  const updated = await appendAndProject(ctx, {
    id: nextId("event", ctx.id),
    type: "plan.submitted",
    taskId: input.taskId,
    workspaceId: projection.workspaceId,
    createdAt: now,
    plan,
  });
  if (!updated.ok) return updated;
  return ok({ plan, projection: updated.data.projection });
}

export async function acceptPlan(
  ctx: CommandContext,
  input: PlanDecisionInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  const loaded = await loadSubmittedPlan(ctx, input);
  if (!loaded.ok) return loaded;
  const { projection, plan } = loaded.data;
  const firstStage = plan.stages[0];
  if (!firstStage) return fail("invalid_state", "Submitted plan has no stages.");
  const now = commandNow(ctx);
  return await appendAndProject(ctx, [
    {
      id: nextId("event", ctx.id),
      type: "plan.accepted",
      taskId: input.taskId,
      workspaceId: projection.workspaceId,
      createdAt: now,
      planId: input.planId,
      version: input.version,
      report: input.report,
    },
    {
      id: nextId("event", ctx.id),
      type: "stage.started",
      taskId: input.taskId,
      workspaceId: projection.workspaceId,
      createdAt: now,
      stageId: firstStage.id,
    },
  ]);
}

export async function rejectPlan(
  ctx: CommandContext,
  input: RejectPlanInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  const loaded = await loadSubmittedPlan(ctx, input);
  if (!loaded.ok) return loaded;
  const projection = loaded.data.projection;
  return await appendAndProject(ctx, {
    id: nextId("event", ctx.id),
    type: "plan.rejected",
    taskId: input.taskId,
    workspaceId: projection.workspaceId,
    createdAt: commandNow(ctx),
    planId: input.planId,
    version: input.version,
    report: input.report,
    ...(input.requestedChanges?.trim() ? { requestedChanges: input.requestedChanges.trim() } : {}),
  });
}

export async function startWorkerRun(
  ctx: CommandContext,
  input: StartWorkerRunInput,
): Promise<CommandResult<{ runId: string; projection: TaskProjection }>> {
  const loaded = await loadCurrentStage(ctx, input);
  if (!loaded.ok) return loaded;
  const { projection, stage } = loaded.data;
  const runId = nextId("run", ctx.id);
  const updated = await appendAndProject(ctx, {
    id: nextId("event", ctx.id),
    type: "worker_run.started",
    taskId: input.taskId,
    workspaceId: projection.workspaceId,
    createdAt: commandNow(ctx),
    runId,
    stageId: stage.id,
    ...(input.workerId ? { workerId: input.workerId } : {}),
    objective: input.objective?.trim() || stage.objective,
  });
  if (!updated.ok) return updated;
  return ok({ runId, projection: updated.data.projection });
}

export async function completeWorkerRun(
  ctx: CommandContext,
  input: FinishWorkerRunInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  return await finishWorkerRun(ctx, input, "worker_run.completed");
}

export async function failWorkerRun(
  ctx: CommandContext,
  input: FinishWorkerRunInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  return await finishWorkerRun(ctx, input, "worker_run.failed");
}

export async function exceedWorkerRunBudget(
  ctx: CommandContext,
  input: FinishWorkerRunInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  return await finishWorkerRun(ctx, input, "worker_run.budget_exceeded");
}

export async function startStageReview(
  ctx: CommandContext,
  input: StageReviewInput,
): Promise<CommandResult<{ reviewId: string; projection: TaskProjection }>> {
  const loaded = await loadCurrentStage(ctx, input);
  if (!loaded.ok) return loaded;
  const { projection, stage } = loaded.data;
  const reviewId = nextId("review", ctx.id);
  const updated = await appendAndProject(ctx, {
    id: nextId("event", ctx.id),
    type: "stage.review.started",
    taskId: input.taskId,
    workspaceId: projection.workspaceId,
    createdAt: commandNow(ctx),
    reviewId,
    stageId: stage.id,
  });
  if (!updated.ok) return updated;
  return ok({ reviewId, projection: updated.data.projection });
}

export async function acceptStageReview(
  ctx: CommandContext,
  input: FinishStageReviewInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  const loaded = await loadStartedStageReview(ctx, input);
  if (!loaded.ok) return loaded;
  const { projection, review, stageIndex } = loaded.data;
  const nextStage = projection.plan?.stages[stageIndex + 1];
  const now = commandNow(ctx);
  const events: TaskEvent[] = [
    {
      id: nextId("event", ctx.id),
      type: "stage.review.accepted",
      taskId: input.taskId,
      workspaceId: projection.workspaceId,
      createdAt: now,
      reviewId: input.reviewId,
      stageId: review.stageId,
      report: input.report,
    },
    {
      id: nextId("event", ctx.id),
      type: "stage.advanced",
      taskId: input.taskId,
      workspaceId: projection.workspaceId,
      createdAt: now,
      fromStageId: review.stageId,
      ...(nextStage ? { toStageId: nextStage.id } : {}),
    },
  ];

  if (nextStage) {
    events.push({
      id: nextId("event", ctx.id),
      type: "stage.started",
      taskId: input.taskId,
      workspaceId: projection.workspaceId,
      createdAt: now,
      stageId: nextStage.id,
    });
  } else {
    events.push({
      id: nextId("event", ctx.id),
      type: "final.review.started",
      taskId: input.taskId,
      workspaceId: projection.workspaceId,
      createdAt: now,
      reviewId: nextId("final_review", ctx.id),
    });
  }

  return await appendAndProject(ctx, events);
}

export async function rejectStageReview(
  ctx: CommandContext,
  input: FinishStageReviewInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  const loaded = await loadStartedStageReview(ctx, input);
  if (!loaded.ok) return loaded;
  const { projection, review } = loaded.data;
  return await appendAndProject(ctx, {
    id: nextId("event", ctx.id),
    type: "stage.review.rejected",
    taskId: input.taskId,
    workspaceId: projection.workspaceId,
    createdAt: commandNow(ctx),
    reviewId: input.reviewId,
    stageId: review.stageId,
    report: input.report,
    ...(input.requestedChanges?.trim() ? { requestedChanges: input.requestedChanges.trim() } : {}),
  });
}

export async function recommendFinalReview(
  ctx: CommandContext,
  input: RecommendFinalReviewInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  const loaded = await loadTaskProjection(ctx, input);
  if (!loaded.ok) return loaded;
  const projection = loaded.data.projection;
  if (
    projection.finalReview?.reviewId !== input.reviewId ||
    projection.finalReview.status !== "started"
  ) {
    return fail("invalid_state", "Final review is not started for this review id.", {
      taskId: input.taskId,
      reviewId: input.reviewId,
    });
  }
  return await appendAndProject(ctx, {
    id: nextId("event", ctx.id),
    type: "final.review.recommended",
    taskId: input.taskId,
    workspaceId: projection.workspaceId,
    createdAt: commandNow(ctx),
    reviewId: input.reviewId,
    recommendation: input.recommendation,
    report: input.report,
  });
}

export async function acceptTask(
  ctx: CommandContext,
  input: FinishTaskInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  return await finishTask(ctx, input, "accepted");
}

export async function rejectTask(
  ctx: CommandContext,
  input: FinishTaskInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  return await finishTask(ctx, input, "rejected");
}

export async function inspectTaskSummary(
  ctx: CommandContext,
  input: TaskIdInput,
): Promise<
  CommandResult<{
    summary: TaskSummary;
  }>
> {
  const loaded = await loadTaskProjection(ctx, input);
  if (!loaded.ok) return loaded;
  const projection = loaded.data.projection;
  return ok({
    summary: {
      taskId: projection.taskId,
      workspaceId: projection.workspaceId,
      status: projection.status,
      request: projection.request,
      currentStageId: projection.currentStageId,
      planStatus: projection.planDecision?.status,
      workerRuns: Object.keys(projection.workerRuns).length,
      runtimeProcesses: Object.keys(projection.runtimeProcessRuns ?? {}).length,
      runningRuntimeProcesses: Object.values(projection.runtimeProcessRuns ?? {}).filter(
        (processRun) => processRun.status === "running",
      ).length,
      acceptedStages: projection.acceptedStageIds.length,
      terminal: projection.terminal,
      updatedAt: projection.updatedAt,
    },
  });
}

export async function inspectTaskCompact(
  ctx: CommandContext,
  input: TaskIdInput,
): Promise<
  CommandResult<{
    compact: TaskCompactView;
  }>
> {
  const loaded = await loadTaskProjection(ctx, input);
  if (!loaded.ok) return loaded;
  return ok({ compact: compactTaskView(loaded.data.projection) });
}

export async function waitTask(
  ctx: CommandContext,
  input: WaitTaskInput,
): Promise<
  CommandResult<{
    compact: TaskCompactView;
  }>
> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    return fail("invalid_input", "timeoutMs must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    return fail("invalid_input", "intervalMs must be a positive integer.");
  }

  const deadline = Date.now() + timeoutMs;
  let latest: TaskCompactView | undefined;
  while (true) {
    const inspected = await inspectTaskCompact(ctx, input);
    if (!inspected.ok) return inspected;
    latest = inspected.data.compact;
    if (isTaskWaitBoundary(latest)) return ok({ compact: latest });
    if (Date.now() >= deadline) {
      return fail("timeout", "Task did not reach a wait boundary before timeout.", {
        taskId: input.taskId,
        workspaceId: input.workspaceId ?? ctx.workspaceId,
        nextAction: latest.nextAction,
      });
    }
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
}

export async function recordRuntimeProcessStarted(
  ctx: CommandContext,
  input: RecordRuntimeProcessStartedInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  const loaded = await loadTaskProjection(ctx, input);
  if (!loaded.ok) return loaded;
  const projection = loaded.data.projection;
  if (!input.processRunId.trim()) {
    return fail("invalid_input", "Runtime process run id must be non-empty.");
  }
  if (!input.actionType.trim()) {
    return fail("invalid_input", "Runtime process action type must be non-empty.");
  }
  return await appendAndProject(ctx, {
    id: nextId("event", ctx.id),
    type: "runtime_process.started",
    taskId: input.taskId,
    workspaceId: projection.workspaceId,
    createdAt: commandNow(ctx),
    processRunId: input.processRunId,
    actionType: input.actionType,
  });
}

export async function recordRuntimeProcessFinished(
  ctx: CommandContext,
  input: RecordRuntimeProcessFinishedInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  const loaded = await loadTaskProjection(ctx, input);
  if (!loaded.ok) return loaded;
  const projection = loaded.data.projection;
  const processRun = projection.runtimeProcessRuns?.[input.processRunId];
  if (!processRun || processRun.status !== "running") {
    return fail("invalid_state", "Runtime process run is not running.", {
      taskId: input.taskId,
      processRunId: input.processRunId,
    });
  }
  return await appendAndProject(ctx, {
    id: nextId("event", ctx.id),
    type: "runtime_process.finished",
    taskId: input.taskId,
    workspaceId: projection.workspaceId,
    createdAt: commandNow(ctx),
    processRunId: input.processRunId,
    processStatus: input.processStatus,
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
  });
}

export async function inspectTaskEvents(
  ctx: CommandContext,
  input: TaskIdInput,
): Promise<CommandResult<{ events: TaskEvent[] }>> {
  const workspaceId = await resolveTaskWorkspaceId(ctx, input);
  if (!workspaceId.ok) return workspaceId;
  const events = await new FileTaskEventStore(ctx.dataDir).read(
    workspaceId.data.workspaceId,
    input.taskId,
  );
  if (events.length === 0) {
    return fail("task_not_found", "Task not found.", {
      workspaceId: workspaceId.data.workspaceId,
      taskId: input.taskId,
    });
  }
  return ok({ events });
}

export async function inspectTaskProjection(
  ctx: CommandContext,
  input: TaskIdInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  return getTask(ctx, input);
}

export async function inspectTaskTrace(
  ctx: CommandContext,
  input: InspectTaskTraceInput,
): Promise<CommandResult<{ trace: TaskTraceEntry[] }>> {
  const events = await inspectTaskEvents(ctx, input);
  if (!events.ok) return events;
  return ok({
    trace: events.data.events.map((event) => ({
      eventId: event.id,
      type: event.type,
      createdAt: event.createdAt,
      summary: summarizeEvent(event),
    })),
  });
}

export interface TaskSummary {
  taskId: string;
  workspaceId: string;
  status: TaskProjection["status"];
  request?: string;
  currentStageId?: string;
  planStatus?: PlanDecisionProjection["status"];
  workerRuns: number;
  runtimeProcesses: number;
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

function compactTaskView(projection: TaskProjection): TaskCompactView {
  const currentStage = projection.plan?.stages.find(
    (stage) => stage.id === projection.currentStageId,
  );
  const nextAction = summarizeProjectionNextAction(projection);
  const latestWorker = latestWorkerRun(projection);
  const runtimeProcesses = Object.values(projection.runtimeProcessRuns ?? {});
  const latestRuntimeProcess = latestRuntimeProcessRun(projection);
  const latestReview = latestReviewProjection(projection);
  return {
    taskId: projection.taskId,
    workspaceId: projection.workspaceId,
    status: projection.status,
    ...(projection.request ? { request: projection.request } : {}),
    ...(currentStage ? { currentStage: { id: currentStage.id, title: currentStage.title } } : {}),
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
      nextAction.type === "await_plan_decision" || nextAction.type === "await_final_decision",
    runtimeProcesses: {
      total: runtimeProcesses.length,
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

function isTaskWaitBoundary(compact: TaskCompactView): boolean {
  if (compact.terminal) return true;
  if (compact.waitingForLead) return true;
  return (
    compact.nextAction.type === "await_worker_results" || compact.nextAction.type === "blocked"
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function latestReviewProjection(
  projection: TaskProjection,
): TaskCompactView["latestReview"] | undefined {
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

async function resolveRuntimeInput(
  ctx: CommandContext,
  input: CreateTaskInput & { workspaceId: string; taskId: string },
): Promise<CommandResult<{ cwd?: string; repoPath?: string } | undefined>> {
  if (input.cwd && input.repoPath) {
    return fail("invalid_input", "Use either runtime cwd or repo path, not both.");
  }

  if (input.cwd) {
    try {
      await access(input.cwd);
    } catch {
      return fail("runtime_cwd_not_found", "Runtime cwd does not exist.", { cwd: input.cwd });
    }
  }

  if (input.repoPath) {
    try {
      await access(input.repoPath);
    } catch {
      return fail("runtime_repo_not_found", "Runtime repo path does not exist.", {
        repoPath: input.repoPath,
      });
    }
    try {
      return ok(
        await allocateTaskWorktree({
          dataDir: ctx.dataDir,
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          repoPath: input.repoPath,
        }),
      );
    } catch (err) {
      if (err instanceof WorkspaceWorktreeError) {
        return fail(
          err.code === "repo_not_git" ? "runtime_repo_not_git" : "runtime_worktree_failed",
          err.message,
          { repoPath: input.repoPath, stderr: err.stderr },
        );
      }
      throw err;
    }
  }

  if (!input.cwd) return ok(undefined);
  return ok({ cwd: input.cwd });
}

async function loadTaskProjection(
  ctx: CommandContext,
  input: TaskIdInput,
): Promise<CommandResult<{ projection: TaskProjection }>> {
  const workspaceId = await resolveTaskWorkspaceId(ctx, input);
  if (!workspaceId.ok) return workspaceId;

  const projectionStore = new FileTaskProjectionStore(ctx.dataDir);
  let projection = await projectionStore.read(workspaceId.data.workspaceId, input.taskId);
  if (!projection) {
    const events = await new FileTaskEventStore(ctx.dataDir).read(
      workspaceId.data.workspaceId,
      input.taskId,
    );
    projection = await projectionStore.rebuild(workspaceId.data.workspaceId, input.taskId, events);
  }
  if (!projection) {
    return fail("task_not_found", "Task not found.", {
      workspaceId: workspaceId.data.workspaceId,
      taskId: input.taskId,
    });
  }
  return ok({ projection });
}

async function resolveTaskWorkspaceId(
  ctx: CommandContext,
  input: TaskIdInput,
): Promise<CommandResult<{ workspaceId: string }>> {
  const workspaceId = input.workspaceId ?? ctx.workspaceId;
  if (!workspaceId) return fail("invalid_input", "Workspace id is required.");
  const workspace = await new FileWorkspaceStore(ctx.dataDir).get(workspaceId);
  if (!workspace) return fail("workspace_not_found", "Workspace not found.", { workspaceId });
  return ok({ workspaceId });
}

function validatePlanStages(
  stages: SubmitPlanInput["stages"],
): CommandResult<{ stages: Omit<PlanStageDef, "id">[] }> {
  if (!Array.isArray(stages) || stages.length === 0) {
    return fail("invalid_input", "Plan must include at least one stage.");
  }

  const normalized: Omit<PlanStageDef, "id">[] = [];
  for (const [index, stage] of stages.entries()) {
    const title = stage.title.trim();
    const objective = stage.objective.trim();
    const acceptance = stage.acceptance.map((item) => item.trim()).filter(Boolean);
    if (!title || !objective || acceptance.length === 0) {
      return fail("invalid_input", "Plan stages require title, objective, and acceptance.", {
        index,
      });
    }
    const workerCount = normalizeWorkerCount(stage.workerCount);
    if (!workerCount.ok) {
      return fail("invalid_input", "Plan stage workerCount must be a positive integer.", {
        index,
      });
    }
    normalized.push({
      title,
      objective,
      acceptance,
      ...(workerCount.data > 1 ? { workerCount: workerCount.data } : {}),
    });
  }
  return ok({ stages: normalized });
}

function normalizeWorkerCount(value: number | undefined): CommandResult<number> {
  if (value === undefined) return ok(1);
  if (!Number.isSafeInteger(value) || value < 1) return fail("invalid_input", "invalid");
  return ok(value);
}

async function loadSubmittedPlan(
  ctx: CommandContext,
  input: PlanDecisionInput,
): Promise<CommandResult<{ projection: TaskProjection; plan: PlanDef }>> {
  const loaded = await loadTaskProjection(ctx, input);
  if (!loaded.ok) return loaded;
  const projection = loaded.data.projection;
  if (projection.status !== "plan_submitted" || !projection.plan) {
    return fail("invalid_state", "Task does not have a submitted plan awaiting lead decision.", {
      taskId: input.taskId,
      status: projection.status,
    });
  }
  if (projection.plan.id !== input.planId || projection.plan.version !== input.version) {
    return fail("invalid_state", "Plan decision does not match the submitted plan.", {
      taskId: input.taskId,
      submittedPlanId: projection.plan.id,
      submittedVersion: projection.plan.version,
    });
  }
  return ok({ projection, plan: projection.plan });
}

async function loadCurrentStage(
  ctx: CommandContext,
  input: TaskIdInput & { stageId?: string },
): Promise<CommandResult<{ projection: TaskProjection; stage: PlanStageDef }>> {
  const loaded = await loadTaskProjection(ctx, input);
  if (!loaded.ok) return loaded;
  const projection = loaded.data.projection;
  const stageId = input.stageId ?? projection.currentStageId;
  const stage = projection.plan?.stages.find((candidate) => candidate.id === stageId);
  if (projection.status !== "running" || !stage || projection.currentStageId !== stage.id) {
    return fail("invalid_state", "Task is not running the requested current stage.", {
      taskId: input.taskId,
      status: projection.status,
      currentStageId: projection.currentStageId,
      requestedStageId: input.stageId,
    });
  }
  return ok({ projection, stage });
}

async function loadStartedStageReview(
  ctx: CommandContext,
  input: FinishStageReviewInput,
): Promise<
  CommandResult<{
    projection: TaskProjection;
    review: NonNullable<TaskProjection["stageReviews"][string]>;
    stageIndex: number;
  }>
> {
  const loaded = await loadTaskProjection(ctx, input);
  if (!loaded.ok) return loaded;
  const projection = loaded.data.projection;
  const review = projection.stageReviews[input.reviewId];
  const stageIndex =
    projection.plan?.stages.findIndex((stage) => stage.id === review?.stageId) ?? -1;
  if (!review || review.status !== "started" || stageIndex < 0) {
    return fail("invalid_state", "Stage review is not started for this review id.", {
      taskId: input.taskId,
      reviewId: input.reviewId,
    });
  }
  return ok({ projection, review, stageIndex });
}

async function finishWorkerRun(
  ctx: CommandContext,
  input: FinishWorkerRunInput,
  type: "worker_run.completed" | "worker_run.failed" | "worker_run.budget_exceeded",
): Promise<CommandResult<{ projection: TaskProjection }>> {
  const loaded = await loadTaskProjection(ctx, input);
  if (!loaded.ok) return loaded;
  const projection = loaded.data.projection;
  const run = projection.workerRuns[input.runId];
  if (!run || run.status !== "running") {
    return fail("invalid_state", "Worker run is not running.", {
      taskId: input.taskId,
      runId: input.runId,
    });
  }

  const result = normalizeTaskRunResult(input);
  if (!result.ok) return result;
  if (type !== "worker_run.completed" && !result.data.result.report && !result.data.result.note) {
    return fail("invalid_input", "Failed or budget-exceeded worker runs require report or note.", {
      runId: input.runId,
    });
  }

  return await appendAndProject(ctx, {
    id: nextId("event", ctx.id),
    type,
    taskId: input.taskId,
    workspaceId: projection.workspaceId,
    createdAt: commandNow(ctx),
    runId: input.runId,
    stageId: run.stageId,
    result: result.data.result,
  });
}

function normalizeTaskRunResult(
  input: FinishWorkerRunInput,
): CommandResult<{ result: TaskRunResult }> {
  const summary = input.summary.trim();
  if (!summary) return fail("invalid_input", "Worker result summary must be non-empty.");
  return ok({
    result: {
      summary,
      ...(input.report?.trim() ? { report: input.report.trim() } : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    },
  });
}

async function finishTask(
  ctx: CommandContext,
  input: FinishTaskInput,
  outcome: "accepted" | "rejected",
): Promise<CommandResult<{ projection: TaskProjection }>> {
  const loaded = await loadTaskProjection(ctx, input);
  if (!loaded.ok) return loaded;
  const projection = loaded.data.projection;
  const now = commandNow(ctx);
  return await appendAndProject(ctx, [
    {
      id: nextId("event", ctx.id),
      type: outcome === "accepted" ? "task.accepted" : "task.rejected",
      taskId: input.taskId,
      workspaceId: projection.workspaceId,
      createdAt: now,
      report: input.report,
    },
    {
      id: nextId("event", ctx.id),
      type: "task.completed",
      taskId: input.taskId,
      workspaceId: projection.workspaceId,
      createdAt: now,
      outcome,
      report: input.report,
    },
  ]);
}

async function appendAndProject(
  ctx: CommandContext,
  eventOrEvents: TaskEvent | readonly TaskEvent[],
): Promise<CommandResult<{ projection: TaskProjection }>> {
  const events = Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents];
  const projection = await new FileTaskEventStore(ctx.dataDir).appendManyAndRebuildProjection(
    events,
  );
  if (!projection) return fail("internal_error", "Task projection was not updated.");
  return ok({ projection });
}

function summarizeEvent(event: TaskEvent): string {
  switch (event.type) {
    case "task.created":
      return event.request;
    case "plan.requested":
      return event.brief ?? "Plan requested.";
    case "plan.submitted":
      return event.plan.summary ?? `Plan ${event.plan.id} submitted.`;
    case "plan.accepted":
    case "plan.rejected":
      return event.report;
    case "runtime_process.started":
      return `Runtime process ${event.processRunId} started for ${event.actionType}.`;
    case "runtime_process.finished":
      return `Runtime process ${event.processRunId} finished as ${event.processStatus}.`;
    case "stage.started":
      return `Stage ${event.stageId} started.`;
    case "worker_run.started":
      return event.objective ?? `Worker run ${event.runId} started.`;
    case "worker_run.completed":
    case "worker_run.failed":
    case "worker_run.budget_exceeded":
      return event.result.summary;
    case "stage.review.started":
      return `Stage review ${event.reviewId} started.`;
    case "stage.review.accepted":
    case "stage.review.rejected":
      return event.report;
    case "stage.advanced":
      return event.toStageId
        ? `Advanced from ${event.fromStageId} to ${event.toStageId}.`
        : `Advanced from ${event.fromStageId}.`;
    case "final.review.started":
      return `Final review ${event.reviewId} started.`;
    case "final.review.recommended":
      return event.report;
    case "task.accepted":
    case "task.rejected":
      return event.report;
    case "task.completed":
      return event.report ?? `Task completed as ${event.outcome}.`;
  }
}
