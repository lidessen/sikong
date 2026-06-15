import type {
  AgentLoop,
  LoopEvent,
  McpServers,
  Skill,
  TaskInput,
  TaskResult as AgentTaskResult,
  TaskRoundMode,
  ToolDefinition,
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
import type {
  PlanStageDef,
  StageRoundProjection,
  StageWorkUnitDef,
  TaskProjection,
  WorkerRunObservation,
} from "../coordination";

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
  const target = currentRunTarget(projection, runId);
  if (!target) {
    return fail("invalid_state", "Worker run did not resolve to a stage round work unit.", {
      taskId: input.taskId,
      runId,
    });
  }

  let taskResult: AgentTaskResult;
  const observations = new WorkerObservationCollector();
  const existingHooks = input.taskInput.hooks;
  try {
    taskResult = await input.runTask({
      ...input.taskInput,
      goal:
        input.goal ??
        buildStageWorkerPrompt(projection, target.stage, target.round, target.workUnit),
      hooks: {
        ...existingHooks,
        async onRoundStart(round, prompt, mode) {
          observations.roundStart(round, mode, prompt);
          await existingHooks?.onRoundStart?.(round, prompt, mode);
        },
        onEvent(ev, round, mode) {
          observations.event(ev, round, mode);
          existingHooks?.onEvent?.(ev, round, mode);
        },
        async onRoundEnd(round, end) {
          observations.roundEnd(round, end.mode, end.report);
          await existingHooks?.onRoundEnd?.(round, end);
        },
      },
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
  if (observations.items.length > 0) terminal.observations = observations.items;
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
  let run: ReturnType<AgentLoop["run"]> | undefined;
  run = input.loop.run({
    prompt: input.prompt,
    ...(input.system ? { system: input.system } : {}),
    ...(input.tools
      ? {
          tools: terminalProtocolTools(input.tools, () =>
            run?.cancel("sikong protocol tool called"),
          ),
        }
      : {}),
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.mcp ? { mcp: input.mcp } : {}),
    ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
    ...(input.runtimeOptions !== undefined ? { runtimeOptions: input.runtimeOptions } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return await run.result;
}

const terminalProtocolToolNames = new Set([
  "submit_requirement_spec",
  "submit_plan",
  "accept_plan",
  "reject_plan",
  "plan_stage_round",
  "accept_task",
  "reject_task",
  "accept_stage_review",
  "reject_stage_review",
  "recommend_final_review",
]);

function terminalProtocolTools(tools: ToolSet, onTerminal: () => void): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = terminalProtocolToolNames.has(name)
      ? terminalProtocolTool(tool, onTerminal)
      : tool;
  }
  return wrapped;
}

function terminalProtocolTool(tool: ToolDefinition, onTerminal: () => void): ToolDefinition {
  if (!tool.execute) return tool;
  return {
    ...tool,
    execute: async (args, ctx) => {
      const result = await tool.execute?.(args, ctx);
      if (isSuccessfulCommandResult(result)) onTerminal();
      return result;
    },
  };
}

function isSuccessfulCommandResult(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as { ok?: unknown }).ok === true);
}

export function buildStageWorkerPrompt(
  projection: TaskProjection,
  stage: PlanStageDef,
  round: StageRoundProjection,
  workUnit: StageWorkUnitDef,
): string {
  return [
    "You are Sikong's Stage Worker for one assigned work unit.",
    "",
    "Your responsibility is to complete this work unit inside the current stage round and return concrete evidence of what changed, what was verified, and what remains. The Task Lead plans rounds, and Reviewers decide whether the stage or task is acceptable.",
    "",
    `Task: ${projection.request ?? projection.taskId}`,
    `Stage: ${stage.title}`,
    "",
    "Objective:",
    stage.objective,
    "",
    "Acceptance:",
    ...stage.acceptance.map((item) => `- ${item}`),
    "",
    `Stage round: ${round.title ?? round.id}`,
    "",
    "Round intent:",
    round.intent,
    "",
    `Work unit: ${workUnit.title}`,
    "",
    "Work unit objective:",
    workUnit.objective,
    ...(workUnit.acceptance?.length
      ? ["", "Work unit acceptance:", ...workUnit.acceptance.map((item) => `- ${item}`)]
      : []),
  ].join("\n");
}

export const buildWorkerGoal = buildStageWorkerPrompt;
export const runTaskWorker = runWorkerTask;

function currentRunTarget(
  projection: TaskProjection,
  runId: string,
): { stage: PlanStageDef; round: StageRoundProjection; workUnit: StageWorkUnitDef } | undefined {
  const run = projection.workerRuns[runId];
  const stage = projection.plan?.stages.find((candidate) => candidate.id === run?.stageId);
  const round = run ? projection.stageRounds[run.roundId] : undefined;
  const workUnit = round?.workUnits.find((candidate) => candidate.id === run?.workUnitId);
  return stage && round && workUnit ? { stage, round, workUnit } : undefined;
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
  observations?: WorkerRunObservation[];
} {
  return {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    runId,
    summary: result.report,
    report: taskResultReport(result),
  };
}

class WorkerObservationCollector {
  readonly items: WorkerRunObservation[] = [];
  private sequence = 0;

  roundStart(round: number, mode: TaskRoundMode, prompt: string): void {
    this.push({
      kind: "round_start",
      round,
      mode,
      summary: `Round ${round} ${mode} started. ${summarizeText(prompt)}`,
    });
  }

  roundEnd(round: number, mode: TaskRoundMode, report: string): void {
    this.push({
      kind: "round_end",
      round,
      mode,
      summary: `Round ${round} ${mode} ended. ${summarizeText(report)}`,
    });
  }

  event(ev: LoopEvent, round: number, mode: TaskRoundMode): void {
    switch (ev.type) {
      case "thinking":
        this.push({
          kind: "thinking",
          round,
          mode,
          summary: summarizeText(ev.text),
        });
        break;
      case "text":
        this.push({
          kind: "text",
          round,
          mode,
          summary: summarizeText(ev.text),
        });
        break;
      case "tool_call_start":
        this.push({
          kind: "tool_call",
          round,
          mode,
          summary: `${ev.name} started.`,
          toolName: ev.name,
          callId: ev.callId,
          status: "started",
          argsSummary: summarizeUnknown(ev.args),
        });
        break;
      case "tool_call_end":
        this.push({
          kind: "tool_call",
          round,
          mode,
          summary: `${ev.name} ${ev.error ? "failed" : "completed"}.`,
          toolName: ev.name,
          callId: ev.callId,
          status: ev.error ? "failed" : "completed",
          resultSummary: ev.error ? summarizeText(ev.error) : summarizeUnknown(ev.result),
          durationMs: ev.durationMs,
        });
        break;
      case "usage":
        this.push({
          kind: "usage",
          round,
          mode,
          summary: `${ev.totalTokens} tokens used.`,
          usage: {
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            totalTokens: ev.totalTokens,
          },
        });
        break;
      case "step":
        this.push({
          kind: "step",
          round,
          mode,
          summary: `Step ${ev.index} ${ev.phase}.`,
        });
        break;
      case "error":
        this.push({
          kind: "error",
          round,
          mode,
          summary: summarizeText(ev.error.message),
        });
        break;
      case "hook":
        this.push({
          kind: "hook",
          round,
          mode,
          summary: summarizeText(`${ev.name} ${ev.phase} ${ev.outcome ?? ""}`.trim()),
          resultSummary: summarizeText(ev.output ?? ev.stdout ?? ev.stderr ?? ""),
        });
        break;
      case "steer":
        this.push({
          kind: "text",
          round,
          mode,
          summary: `Steer ${ev.mode}: ${summarizeText(ev.message)}`,
        });
        break;
      case "unknown":
        this.push({
          kind: "unknown",
          round,
          mode,
          summary: summarizeUnknown(ev.data) ?? "Unknown runtime event.",
        });
        break;
    }
  }

  private push(input: Omit<WorkerRunObservation, "id" | "at">): void {
    this.items.push({
      id: `obs_${++this.sequence}`,
      at: new Date().toISOString(),
      ...compactObservation(input),
    });
  }
}

const OBSERVATION_TEXT_LIMIT = 420;
const OBSERVATION_JSON_LIMIT = 520;
const SENSITIVE_FIELD = /api[_-]?key|authorization|bearer|cookie|password|secret|token/i;

function compactObservation(
  input: Omit<WorkerRunObservation, "id" | "at">,
): Omit<WorkerRunObservation, "id" | "at"> {
  return removeUndefined({
    ...input,
    summary: summarizeText(input.summary),
    argsSummary: input.argsSummary
      ? summarizeText(input.argsSummary, OBSERVATION_JSON_LIMIT)
      : undefined,
    resultSummary: input.resultSummary
      ? summarizeText(input.resultSummary, OBSERVATION_JSON_LIMIT)
      : undefined,
  }) as Omit<WorkerRunObservation, "id" | "at">;
}

function summarizeText(text: string, limit = OBSERVATION_TEXT_LIMIT): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function summarizeUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return summarizeText(value, OBSERVATION_JSON_LIMIT);
  try {
    return summarizeText(JSON.stringify(redactUnknown(value)), OBSERVATION_JSON_LIMIT);
  } catch {
    return summarizeText(String(value), OBSERVATION_JSON_LIMIT);
  }
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_FIELD.test(key) ? "[redacted]" : redactUnknown(item),
    ]),
  );
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
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
