import type { Skill, ToolSet } from "agent-loop";
import type { PlanStageDef, TaskProjection, WorkerRunProjection } from "../../coordination";
import type { WorkerRunSpec } from "../worker-run";
import { mergeToolSets } from "./tools";

export interface StageVerificationPresetInput {
  projection: TaskProjection;
  reviewId: string;
  stageId?: string;
  inspectionTools?: ToolSet;
  protocolTools: ToolSet;
  skills?: Skill[];
  metadata?: Record<string, unknown>;
}

export interface FinalVerificationPresetInput {
  projection: TaskProjection;
  reviewId: string;
  inspectionTools?: ToolSet;
  protocolTools: ToolSet;
  skills?: Skill[];
  metadata?: Record<string, unknown>;
}

export function createStageVerificationPreset(input: StageVerificationPresetInput): WorkerRunSpec {
  const stage = resolveStage(input.projection, input.stageId);
  const runs = terminalRunsForStage(input.projection, stage.id);
  return {
    workspaceId: input.projection.workspaceId,
    taskId: input.projection.taskId,
    prompt: [
      "You are Sikong's Stage Reviewer for this task.",
      "",
      "Your responsibility is to inspect worker evidence and decide whether the current stage satisfies its acceptance criteria. A rejection should give the Task Lead concrete gaps for the next round.",
      "",
      `Review id: ${input.reviewId}`,
      `Task: ${input.projection.request ?? input.projection.taskId}`,
      `Stage: ${stage.title}`,
      "",
      "Objective:",
      stage.objective,
      "",
      "Acceptance:",
      ...stage.acceptance.map((item) => `- ${item}`),
      "",
      "Worker results:",
      ...formatWorkerRuns(runs),
      "",
      "Use inspection tools as needed, then submit the stage review decision through the provided review tool.",
    ].join("\n"),
    tools: mergeToolSets(input.inspectionTools, input.protocolTools),
    skills: input.skills,
    metadata: input.metadata,
  };
}

export function createFinalVerificationPreset(input: FinalVerificationPresetInput): WorkerRunSpec {
  return {
    workspaceId: input.projection.workspaceId,
    taskId: input.projection.taskId,
    prompt: [
      "You are Sikong's Final Reviewer for this task.",
      "",
      "Your responsibility is to inspect the complete task evidence and recommend whether the result satisfies the user's original request. The Task Lead makes the final accept/reject decision.",
      "",
      `Review id: ${input.reviewId}`,
      `Task: ${input.projection.request ?? input.projection.taskId}`,
      "",
      "Accepted stages:",
      ...input.projection.acceptedStageIds.map((stageId) => `- ${stageId}`),
      "",
      "Worker results:",
      ...formatWorkerRuns(Object.values(input.projection.workerRuns)),
      "",
      "Use inspection tools as needed, then submit the final recommendation through the provided review tool.",
    ].join("\n"),
    tools: mergeToolSets(input.inspectionTools, input.protocolTools),
    skills: input.skills,
    metadata: input.metadata,
  };
}

function resolveStage(projection: TaskProjection, stageId?: string): PlanStageDef {
  const id = stageId ?? projection.currentStageId;
  const stage = projection.plan?.stages.find((candidate) => candidate.id === id);
  if (!stage) throw new Error("current stage is required for verification preset");
  return stage;
}

function terminalRunsForStage(projection: TaskProjection, stageId: string): WorkerRunProjection[] {
  return Object.values(projection.workerRuns).filter(
    (run) => run.stageId === stageId && run.status !== "running",
  );
}

function formatWorkerRuns(runs: readonly WorkerRunProjection[]): string[] {
  if (runs.length === 0) return ["- No terminal worker results recorded yet."];
  return runs.map((run) => {
    const summary = run.result?.summary ?? "No summary.";
    return `- ${run.runId} (${run.status}): ${summary}`;
  });
}
