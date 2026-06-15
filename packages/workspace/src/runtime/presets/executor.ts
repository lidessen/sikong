import type { Skill, TaskInput, ToolSet } from "agent-loop";
import type {
  PlanStageDef,
  StageRoundProjection,
  StageWorkUnitDef,
  TaskProjection,
} from "../../coordination";
import type { RunWorkerTaskInput } from "../worker-run";
import { buildStageWorkerPrompt } from "../worker-run";
import { mergeToolSets } from "./tools";

export interface StageExecutionPresetInput {
  projection: TaskProjection;
  stageId?: string;
  roundId: string;
  workUnitId: string;
  baseTaskInput: Omit<TaskInput, "goal" | "tools" | "skills">;
  executionTools?: ToolSet;
  skills?: Skill[];
  metadata?: Record<string, unknown>;
}

export function createStageExecutionPreset(
  input: StageExecutionPresetInput,
): Omit<RunWorkerTaskInput, "runTask"> {
  const target = resolveWorkUnit(input.projection, input.roundId, input.workUnitId);
  return {
    workspaceId: input.projection.workspaceId,
    taskId: input.projection.taskId,
    roundId: target.round.id,
    workUnitId: target.workUnit.id,
    goal: buildStageWorkerPrompt(input.projection, target.stage, target.round, target.workUnit),
    taskInput: {
      ...input.baseTaskInput,
      tools: mergeToolSets(input.executionTools),
      skills: input.skills,
      metadata: input.metadata,
    },
  };
}

function resolveWorkUnit(
  projection: TaskProjection,
  roundId: string,
  workUnitId: string,
): { stage: PlanStageDef; round: StageRoundProjection; workUnit: StageWorkUnitDef } {
  const round = projection.stageRounds[roundId];
  const stage = projection.plan?.stages.find((candidate) => candidate.id === round?.stageId);
  const workUnit = round?.workUnits.find((candidate) => candidate.id === workUnitId);
  if (!stage || !round || !workUnit) {
    throw new Error("active stage round work unit is required for stage execution preset");
  }
  return { stage, round, workUnit };
}
