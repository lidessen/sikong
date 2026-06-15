import type { Skill, ToolSet } from "agent-loop";
import type { TaskProjection } from "../../coordination";
import type { WorkerRunSpec } from "../worker-run";
import { mergeToolSets } from "./tools";

export interface PlanningPresetInput {
  projection: TaskProjection;
  requirementSpec?: string;
  workspacePreferences?: readonly string[];
  priorFeedback?: readonly string[];
  inspectionTools?: ToolSet;
  protocolTools: ToolSet;
  skills?: Skill[];
  metadata?: Record<string, unknown>;
}

export function createPlanningPreset(input: PlanningPresetInput): WorkerRunSpec {
  return {
    workspaceId: input.projection.workspaceId,
    taskId: input.projection.taskId,
    prompt: buildPlanningPrompt(input),
    tools: mergeToolSets(input.inspectionTools, input.protocolTools),
    skills: input.skills,
    metadata: input.metadata,
  };
}

function buildPlanningPrompt(input: PlanningPresetInput): string {
  return [
    "You are Sikong's Planner for this task.",
    "",
    "Your responsibility is to turn the Task Lead's requirement spec into a coarse ordered stage roadmap. The roadmap should define what has to become true, while detailed worker rounds are planned later by the Task Lead.",
    "",
    "Task request:",
    input.projection.request ?? input.projection.taskId,
    "",
    ...(input.requirementSpec ? ["Lead requirement spec:", input.requirementSpec, ""] : []),
    ...section("Workspace preferences", input.workspacePreferences),
    ...section("Prior lead feedback", input.priorFeedback),
    "Planning responsibilities:",
    "- Inspect the available project context before planning when needed.",
    "- Produce ordered stages with clear objectives and acceptance criteria.",
    "- Leave tactical rounds and per-worker work units for the Task Lead after the plan is accepted.",
    "- Submit the final PlanDef through the provided plan submission tool.",
  ].join("\n");
}

function section(title: string, values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return [title + ":", ...values.map((value) => `- ${value}`), ""];
}
