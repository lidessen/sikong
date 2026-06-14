import { getTask, type CommandContext, type CommandResult, fail, ok } from "../commands";
import type { TaskProjection } from "../coordination";
import {
  executeOrchestrationAction,
  type OrchestrationExecutionResult,
  type OrchestrationExecutionRuntime,
} from "./execute";
import {
  planNextOrchestrationAction,
  type OrchestrationAction,
  type OrchestrationInput,
} from "./tick";

export type OrchestrationStopReason = "waiting" | "terminal" | "blocked" | "max_actions";

export interface OrchestrationDriverStep {
  action: OrchestrationAction;
  result: OrchestrationExecutionResult;
}

export interface OrchestrationDriverResult {
  taskId: string;
  stopReason: OrchestrationStopReason;
  steps: OrchestrationDriverStep[];
  projection: TaskProjection;
}

export interface RunOrchestrationUntilWaitInput {
  ctx: CommandContext;
  taskId: string;
  workspaceId?: string;
  buildInput: (projection: TaskProjection) => OrchestrationInput;
  runtime?: OrchestrationExecutionRuntime;
  maxActions?: number;
  executeAction?: (
    ctx: CommandContext,
    action: OrchestrationAction,
    runtime: OrchestrationExecutionRuntime,
  ) => Promise<CommandResult<OrchestrationExecutionResult>>;
}

export async function runOrchestrationUntilWait(
  input: RunOrchestrationUntilWaitInput,
): Promise<CommandResult<OrchestrationDriverResult>> {
  const maxActions = input.maxActions ?? 20;
  const runtime = input.runtime ?? {};
  const executeAction = input.executeAction ?? executeOrchestrationAction;
  const steps: OrchestrationDriverStep[] = [];

  for (let index = 0; index < maxActions; index += 1) {
    const projection = await loadProjection(input);
    if (!projection.ok) return projection;

    const action = planNextOrchestrationAction(input.buildInput(projection.data.projection));
    const executed = await executeAction(input.ctx, action, runtime);
    if (!executed.ok) return executed;

    steps.push({ action, result: executed.data });

    const stopReason = stopReasonFor(executed.data);
    if (stopReason) {
      const latest = await loadProjection(input);
      if (!latest.ok) return latest;
      return ok({
        taskId: input.taskId,
        stopReason,
        steps,
        projection: latest.data.projection,
      });
    }
  }

  const latest = await loadProjection(input);
  if (!latest.ok) return latest;
  return ok({
    taskId: input.taskId,
    stopReason: "max_actions",
    steps,
    projection: latest.data.projection,
  });
}

async function loadProjection(input: {
  ctx: CommandContext;
  workspaceId?: string;
  taskId: string;
}): Promise<CommandResult<{ projection: TaskProjection }>> {
  const loaded = await getTask(input.ctx, {
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    taskId: input.taskId,
  });
  if (!loaded.ok) return fail(loaded.error.code, loaded.error.message, loaded.error.details);
  return loaded;
}

function stopReasonFor(result: OrchestrationExecutionResult): OrchestrationStopReason | undefined {
  switch (result.resultType) {
    case "waiting":
      return "waiting";
    case "terminal":
      return "terminal";
    case "blocked":
      return "blocked";
    default:
      return undefined;
  }
}
