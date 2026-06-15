import type { AcceptanceCheck, StageDef, Task, WorkflowDef } from "../workflow/types";
import type { TeamMember } from "./team-status";

export interface TimeoutComponent {
  name: string;
  ms: number;
}

export interface WakeTimeoutEstimate {
  timeoutMs: number;
  rawMs: number;
  minMs: number;
  maxMs: number;
  effort: string;
  components: TimeoutComponent[];
}

export interface WakeTimeoutInput {
  task: Task;
  workflow: WorkflowDef;
  stage?: StageDef;
  workerToolNames: readonly string[];
  commandToolNames: readonly string[];
  team: readonly TeamMember[];
  projectMemory?: string;
  effort?: string;
  /** Model id, when known — used for model-specific speed multipliers. */
  model?: string;
}

const MIN_WAKE_TIMEOUT_MS = 120_000;
const MAX_WAKE_TIMEOUT_MS = 1_200_000;
const AGENT_TURN_BASE_MS = 45_000;
const PROMPT_UNIT_CHARS = 4_000;
const PROMPT_UNIT_MS = 8_000;
const OUTPUT_FIELD_MS = 12_000;
const TOOL_SURFACE_MS = 3_000;
const CHILD_ACTIVE_MS = 25_000;
const CHILD_TERMINAL_MS = 35_000;

const EFFORT_MULTIPLIERS: Record<string, number> = {
  low: 0.8,
  medium: 1,
  high: 1.35,
  max: 1.7,
};
const DEFAULT_EFFORT_MULTIPLIER = 1;

/**
 * Model-to-speed multipliers, relative to "claude-sonnet-4-6" (baseline 1.0).
 * Slower models get a higher multiplier so the timeout reflects real-world
 * response times. Unknown models default to 1.0.
 */
const MODEL_SPEED_MULTIPLIERS: Record<string, number> = {
  "claude-sonnet-4-6": 1.0,
  "claude-sonnet-4-": 1.0,
  "claude-opus-4-": 1.45,
  "deepseek-": 1.8,
  "gpt-4": 1.2,
  "gpt-5": 1.1,
};
const DEFAULT_MODEL_SPEED = 1.0;

export function estimateWakeTimeout(input: WakeTimeoutInput): WakeTimeoutEstimate {
  const components: TimeoutComponent[] = [{ name: "agentTurn", ms: AGENT_TURN_BASE_MS }];
  const promptChars = measuredPromptChars(input);
  components.push({ name: "promptUnits", ms: Math.ceil(promptChars / PROMPT_UNIT_CHARS) * PROMPT_UNIT_MS });

  const outputFields = input.stage?.outputFields?.length ?? 0;
  if (outputFields > 0) components.push({ name: "outputFields", ms: outputFields * OUTPUT_FIELD_MS });

  const toolCount = new Set([...input.workerToolNames, ...input.commandToolNames]).size;
  if (toolCount > 0) components.push({ name: "toolSurface", ms: toolCount * TOOL_SURFACE_MS });

  const acceptance = [...(input.stage?.acceptance ?? []), ...(input.task.acceptance ?? [])];
  const acceptanceMs = acceptance.reduce((sum, check) => sum + acceptanceCheckMs(check), 0);
  if (acceptanceMs > 0) components.push({ name: "acceptance", ms: acceptanceMs });

  const childMs = input.team.reduce((sum, child) => sum + (child.status === "done" || child.status === "cancelled" ? CHILD_TERMINAL_MS : CHILD_ACTIVE_MS), 0);
  if (childMs > 0) components.push({ name: "team", ms: childMs });

  const effort = input.effort ?? input.task.effort ?? input.stage?.effort ?? "medium";
  const multiplier = EFFORT_MULTIPLIERS[effort] ?? DEFAULT_EFFORT_MULTIPLIER;
  const speedMultiplier = lookupSpeedMultiplier(input.model);
  const baseMs = components.reduce((sum, component) => sum + component.ms, 0);
  const rawMs = Math.ceil(baseMs * multiplier * speedMultiplier);
  const timeoutMs = clamp(rawMs, MIN_WAKE_TIMEOUT_MS, MAX_WAKE_TIMEOUT_MS);
  return { timeoutMs, rawMs, minMs: MIN_WAKE_TIMEOUT_MS, maxMs: MAX_WAKE_TIMEOUT_MS, effort, components };
}

function measuredPromptChars(input: WakeTimeoutInput): number {
  const fieldChars = Object.entries(input.task.fields).reduce(
    (sum, [key, value]) => sum + key.length + stableCharLength(value),
    0,
  );
  const teamChars = input.team.reduce(
    (sum, member) =>
      sum +
      member.id.length +
      member.workflowId.length +
      member.status.length +
      (member.request?.length ?? 0) +
      (member.summary?.length ?? 0),
    0,
  );
  return (
    input.workflow.description.length +
    (input.stage?.instructions?.length ?? 0) +
    (input.projectMemory?.length ?? 0) +
    fieldChars +
    teamChars
  );
}

function stableCharLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function acceptanceCheckMs(check: AcceptanceCheck): number {
  switch (check.kind) {
    case "projectGate":
      return 240_000;
    case "command":
      return commandMs(check.cmd);
    case "fileExists":
    case "grep":
      return 10_000;
  }
}

function commandMs(command: string): number {
  const c = command.toLowerCase();
  let ms = 30_000;
  if (/\b(typecheck|tsc)\b/.test(c)) ms += 90_000;
  if (/\b(test|vitest|jest|pytest|go test|swift test)\b/.test(c)) ms += 120_000;
  if (/\b(build|compile|xcodebuild|swift build|go build)\b/.test(c)) ms += 120_000;
  if (/\b(lint|biome|eslint)\b/.test(c)) ms += 60_000;
  if (/\b(pack|npm pack|publish --dry-run|dry-run)\b/.test(c)) ms += 90_000;
  if (/\b(smoke|self-smoke)\b/.test(c)) ms += 120_000;
  return ms;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Look up the speed multiplier for a model id by substring match.
 * Returns the baseline (1.0) for unknown models.
 */
function lookupSpeedMultiplier(modelId: string | undefined): number {
  if (!modelId) return DEFAULT_MODEL_SPEED;
  for (const [key, mult] of Object.entries(MODEL_SPEED_MULTIPLIERS)) {
    if (modelId.startsWith(key) || modelId.includes(key)) return mult;
  }
  return DEFAULT_MODEL_SPEED;
}
