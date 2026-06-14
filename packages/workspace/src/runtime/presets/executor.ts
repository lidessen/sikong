import type { Skill, TaskInput, ToolSet } from "agent-loop";
import type { PlanStageDef, TaskProjection } from "../../coordination";
import type { RunWorkerTaskInput } from "../worker-run";
import { buildStageWorkerPrompt } from "../worker-run";
import { mergeToolSets } from "./tools";

export interface StageExecutionPresetInput {
  projection: TaskProjection;
  stageId?: string;
  baseTaskInput: Omit<TaskInput, "goal" | "tools" | "skills">;
  executionTools?: ToolSet;
  skills?: Skill[];
  metadata?: Record<string, unknown>;
}

export function createStageExecutionPreset(
  input: StageExecutionPresetInput,
): Omit<RunWorkerTaskInput, "runTask"> {
  const stage = resolveStage(input.projection, input.stageId);
  return {
    workspaceId: input.projection.workspaceId,
    taskId: input.projection.taskId,
    stageId: stage.id,
    objective: stage.objective,
    goal: buildStageWorkerPrompt(input.projection, stage),
    taskInput: {
      ...input.baseTaskInput,
      tools: mergeToolSets(input.executionTools),
      skills: input.skills,
      metadata: input.metadata,
    },
  };
}

function resolveStage(projection: TaskProjection, stageId?: string): PlanStageDef {
  const id = stageId ?? projection.currentStageId;
  const stage = projection.plan?.stages.find((candidate) => candidate.id === id);
  if (!stage) throw new Error("current stage is required for stage execution preset");
  return stage;
}
