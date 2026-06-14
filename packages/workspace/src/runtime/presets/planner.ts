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
    "Create a concrete ordered PlanDef for this Sikong task.",
    "",
    "Task request:",
    input.projection.request ?? input.projection.taskId,
    "",
    ...(input.requirementSpec ? ["Lead requirement spec:", input.requirementSpec, ""] : []),
    ...section("Workspace preferences", input.workspacePreferences),
    ...section("Prior lead feedback", input.priorFeedback),
    "Requirements:",
    "- Inspect the available project context before planning when needed.",
    "- Use available file, command, and network tools when they are relevant.",
    "- Submit the final plan only through the provided plan submission tool.",
    "- Do not treat narrative text or process output as a submitted plan.",
  ].join("\n");
}

function section(title: string, values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return [title + ":", ...values.map((value) => `- ${value}`), ""];
}
