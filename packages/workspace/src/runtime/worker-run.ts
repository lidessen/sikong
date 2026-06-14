import type {
  AgentLoop,
  McpServers,
  Skill,
  TaskInput,
  TaskResult as AgentTaskResult,
  ToolSet,
} from "agent-loop";
import {
  completeWorkerRun,
  exceedWorkerRunBudget,
  failWorkerRun,
  startWorkerRun,
  type CommandContext,
  type CommandResult,
  type StartWorkerRunInput,
} from "../commands";
import { fail, ok } from "../commands";
import type { PlanStageDef, TaskProjection } from "../coordination";

export interface WorkerRunSpec {
  workspaceId?: string;
  taskId: string;
  prompt: string;
  tools?: ToolSet;
  skills?: Skill[];
  mcp?: McpServers;
  runtimeOptions?: unknown;
  metadata?: Record<string, unknown>;
}

export interface RunWorkerTaskInput extends StartWorkerRunInput {
  taskInput: Omit<TaskInput, "goal">;
  runTask: (input: TaskInput) => Promise<AgentTaskResult>;
  goal?: string;
}

export interface RunWorkerLoopInput extends WorkerRunSpec {
  loop: AgentLoop;
  maxSteps?: number;
  system?: string;
  signal?: AbortSignal;
}

export interface RunWorkerTaskResult {
  runId: string;
  taskResult: AgentTaskResult;
  projection: TaskProjection;
}

export async function runWorkerTask(
  ctx: CommandContext,
  input: RunWorkerTaskInput,
): Promise<CommandResult<RunWorkerTaskResult>> {
  const started = await startWorkerRun(ctx, input);
  if (!started.ok) return started;

  const { runId, projection } = started.data;
  const stage = currentRunStage(projection, runId);
  if (!stage) {
    return fail("invalid_state", "Worker run did not resolve to a plan stage.", {
      taskId: input.taskId,
      runId,
    });
  }

  let taskResult: AgentTaskResult;
  try {
    taskResult = await input.runTask({
      ...input.taskInput,
      goal: input.goal ?? buildStageWorkerPrompt(projection, stage),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await failWorkerRun(ctx, {
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      runId,
      summary: `Worker runtime failed before returning a task result: ${message}`,
      report: `Worker runtime failed before returning a task result: ${message}`,
    });
    if (!failed.ok) return failed;
    return ok({
      runId,
      taskResult: {
        status: "failed",
        rounds: 0,
        report: message,
        timeline: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        error: err instanceof Error ? err : new Error(message),
      },
      projection: failed.data.projection,
    });
  }

  const terminal = terminalInput(input, runId, taskResult);
  const recorded =
    taskResult.status === "completed"
      ? await completeWorkerRun(ctx, terminal)
      : taskResult.status === "failed"
        ? await failWorkerRun(ctx, terminal)
        : await exceedWorkerRunBudget(ctx, terminal);
  if (!recorded.ok) return recorded;

  return ok({
    runId,
    taskResult,
    projection: recorded.data.projection,
  });
}

export async function runWorkerLoop(input: RunWorkerLoopInput) {
  const run = input.loop.run({
    prompt: input.prompt,
    ...(input.system ? { system: input.system } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.mcp ? { mcp: input.mcp } : {}),
    ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
    ...(input.runtimeOptions !== undefined ? { runtimeOptions: input.runtimeOptions } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return await run.result;
}

export function buildStageWorkerPrompt(projection: TaskProjection, stage: PlanStageDef): string {
  return [
    `Task: ${projection.request ?? projection.taskId}`,
    `Stage: ${stage.title}`,
    "",
    "Objective:",
    stage.objective,
    "",
    "Acceptance:",
    ...stage.acceptance.map((item) => `- ${item}`),
  ].join("\n");
}

export const buildWorkerGoal = buildStageWorkerPrompt;
export const runTaskWorker = runWorkerTask;

function currentRunStage(projection: TaskProjection, runId: string): PlanStageDef | undefined {
  const run = projection.workerRuns[runId];
  return projection.plan?.stages.find((stage) => stage.id === run?.stageId);
}

function terminalInput(
  input: RunWorkerTaskInput,
  runId: string,
  result: AgentTaskResult,
): {
  workspaceId?: string;
  taskId: string;
  runId: string;
  summary: string;
  report: string;
  note?: string;
} {
  return {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    runId,
    summary: result.report,
    report: taskResultReport(result),
  };
}

function taskResultReport(result: AgentTaskResult): string {
  const parts = [`Report:\n${result.report}`];
  if (result.gateReport) parts.push(`Gate:\n${result.gateReport}`);
  if (result.timeline.length > 0) {
    parts.push(
      [
        "Timeline:",
        ...result.timeline.map((entry) => `- Round ${entry.round}: ${entry.report}`),
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}
