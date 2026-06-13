import { addUsage, emptyUsage, type LoopEvent, type TokenUsage } from "../core/events";
import type { Hooks } from "../core/hooks";
import type { EffortLevel, McpServers, RunHandle, Skill, ToolSet } from "../core/types";
import type { AgentLoop } from "../loop";
import {
  createExitTools,
  createGateTools,
  type ExitOutcome,
  type ExitToolMode,
  type GateOutcome,
} from "./exit-tools";

export type TaskRoundMode = "work" | "finish" | "gate";

export interface TaskTimelineEntry {
  /** Work round that produced this continuation or gate rejection note. */
  round: number;
  /** Text state carried into later loops. */
  report: string;
}

export interface TaskRoundEnd {
  mode: TaskRoundMode;
  outcome: ExitOutcome | GateOutcome | null;
  report: string;
}

/** Observability hooks for the outer task loop (distinct from per-run `Hooks`). */
export interface TaskHooks {
  /** Before a task or gate loop starts; `prompt` is the full briefing the agent sees. */
  onRoundStart?(round: number, prompt: string, mode: TaskRoundMode): void | Promise<void>;
  /** Every normalized event from every task or gate loop. */
  onEvent?(ev: LoopEvent, round: number, mode: TaskRoundMode): void;
  /** After a task or gate loop ends. `outcome` is null when no terminal tool was called. */
  onRoundEnd?(round: number, end: TaskRoundEnd): void | Promise<void>;
}

export interface TaskInput {
  /** The overall task. Carried into every loop verbatim. */
  goal: string;
  /**
   * Factory called once per work/finish round to get a fresh loop. The task
   * layer keeps transient continuation state between these loops, but no state
   * survives after `runTask` returns.
   */
  loop: () => AgentLoop;
  /**
   * Optional gate reviewer loop. Defaults to `loop`. Gate runs do not consume
   * work budget, but they do use their own `gateMaxSteps` safety cap.
   */
  gateLoop?: () => AgentLoop;
  /** Optional system prompt prepended to worker rounds. */
  system?: string;
  /** Skills available to worker rounds. */
  skills?: Skill[];
  /** MCP servers available to worker rounds. */
  mcp?: McpServers;
  /** Worker reasoning-effort level, passed through to `loop.run`. */
  effort?: EffortLevel;
  /** Worker runtime-native options, passed through to `loop.run`. */
  runtimeOptions?: unknown;
  /** Worker run hooks, distinct from task observability hooks. */
  runHooks?: Hooks;
  /** Worker metadata, passed through to `loop.run`. */
  metadata?: Record<string, unknown>;
  /** Caller-supplied tools available to worker rounds. */
  tools?: ToolSet;
  /** Caller-supplied tools available to gate rounds. Defaults to `tools`. */
  gateTools?: ToolSet;
  /** Maximum number of work rounds before a finish-only round. Default 10. */
  maxRounds?: number;
  /** Soft per-work-round step cap, passed to each worker run as `maxSteps`. */
  maxStepsPerRun?: number;
  /** Soft step cap for the finish-only round. Default 1. */
  finishMaxSteps?: number;
  /** Soft step cap for each gate review. Default 50. */
  gateMaxSteps?: number;
  signal?: AbortSignal;
  hooks?: TaskHooks;
}

export type TaskStatus = "completed" | "failed" | "budget_exceeded";

export interface TaskResult {
  status: TaskStatus;
  /** Work/finish rounds executed. Gate runs are not counted as task rounds. */
  rounds: number;
  /** Required terminal report produced by the task tool, or a protocol failure report. */
  report: string;
  /** Gate accept/reject report for final complete/fail claims when a gate ran. */
  gateReport?: string;
  /** Structured final result, only when `agent_loop_task_complete` supplied one. */
  result?: unknown;
  /** Transient continuation state accumulated during this call. */
  timeline: TaskTimelineEntry[];
  /** Token usage accumulated across worker, finish, and gate runs in this call. */
  usage: TokenUsage;
  error?: Error;
}

type ClaimOutcome = Extract<ExitOutcome, { status: "completed" | "failed" }>;

interface RoundResult {
  outcome: ExitOutcome | null;
  report: string;
  usage: TokenUsage;
  error?: Error;
}

interface GateResult {
  outcome: GateOutcome | null;
  report: string;
  usage: TokenUsage;
  error?: Error;
}

const MAX_NOTE_CHARS = 4_000;
const DEFAULT_GATE_MAX_STEPS = 50;

interface TaskRunInternalOptions {
  /** Whether runTask owns and should dispose loops returned by loop/gateLoop factories. */
  disposeRoundLoops?: boolean;
}

/**
 * Thin multi-round extension over `AgentLoop.run`.
 *
 * Work rounds must end by calling one namespaced task exit tool:
 *
 * - `agent_loop_task_continue({ report })`
 * - `agent_loop_task_complete({ report, result? })`
 * - `agent_loop_task_fail({ report })`
 *
 * `continue` appends the report to the transient timeline and starts the next
 * fresh worker loop. `complete` and `fail` are worker claims and must be accepted
 * by a gate loop before they become the final task result. Gate loops do not
 * consume work budget and are prompted to evaluate only, not solve.
 */
export async function runTask(input: TaskInput): Promise<TaskResult> {
  const maxWorkRounds = input.maxRounds ?? 10;
  let usage = emptyUsage();
  const timeline: TaskTimelineEntry[] = [];
  let rounds = 0;

  for (let workRound = 1; workRound <= maxWorkRounds; workRound++) {
    if (input.signal?.aborted) {
      return failed(
        rounds,
        usage,
        timeline,
        "Task was cancelled before it reached a terminal tool.",
      );
    }

    const round = await runTaskRound({
      input,
      round: workRound,
      mode: "work",
      timeline,
      maxSteps: input.maxStepsPerRun,
      disposeLoop: shouldDisposeRoundLoops(input),
    }).catch(roundFailure);
    rounds = workRound;
    usage = addUsage(usage, round.usage);

    if (round.error) return failed(rounds, usage, timeline, round.report, round.error);
    if (!round.outcome) {
      return failed(
        rounds,
        usage,
        timeline,
        "Task protocol violation: work round ended without calling agent_loop_task_continue, agent_loop_task_complete, or agent_loop_task_fail.",
      );
    }

    if (round.outcome.status === "continue") {
      timeline.push({ round: workRound, report: round.outcome.report });
      continue;
    }
    if (!isClaimOutcome(round.outcome)) {
      return failed(
        rounds,
        usage,
        timeline,
        `Task protocol violation: work round called ${round.outcome.status}, which is unavailable in work mode.`,
      );
    }

    const gate = await reviewClaim({
      input,
      round: workRound,
      timeline,
      claim: round.outcome,
    }).catch(gateFailure);
    usage = addUsage(usage, gate.usage);
    if (gate.error) return failed(rounds, usage, timeline, gate.report, gate.error);
    if (gate.outcome?.decision === "accept") {
      return resultFromOutcome(round.outcome, rounds, usage, timeline, gate.outcome.report);
    }

    timeline.push({
      round: workRound,
      report: rejectedClaimReport(round.outcome, gate.report),
    });
  }

  if (input.signal?.aborted) {
    return failed(rounds, usage, timeline, "Task was cancelled before it reached a terminal tool.");
  }

  const finishRound = rounds + 1;
  const finish = await runTaskRound({
    input,
    round: finishRound,
    mode: "finish",
    timeline,
    maxSteps: input.finishMaxSteps ?? 1,
    disposeLoop: shouldDisposeRoundLoops(input),
  }).catch(roundFailure);
  rounds = finishRound;
  usage = addUsage(usage, finish.usage);

  if (finish.error) return failed(rounds, usage, timeline, finish.report, finish.error);
  if (!finish.outcome) {
    return failed(
      rounds,
      usage,
      timeline,
      "Task protocol violation: finish-only round ended without calling agent_loop_task_complete, agent_loop_task_fail, or agent_loop_task_budget_exceeded.",
    );
  }

  if (finish.outcome.status === "budget_exceeded") {
    return resultFromOutcome(finish.outcome, rounds, usage, timeline);
  }

  if (finish.outcome.status === "continue") {
    return failed(
      rounds,
      usage,
      timeline,
      "Task protocol violation: finish-only round called agent_loop_task_continue, which is unavailable in finish mode.",
    );
  }

  const gate = await reviewClaim({
    input,
    round: finishRound,
    timeline,
    claim: finish.outcome,
  }).catch(gateFailure);
  usage = addUsage(usage, gate.usage);
  if (gate.error) return failed(rounds, usage, timeline, gate.report, gate.error);
  if (gate.outcome?.decision === "accept") {
    return resultFromOutcome(finish.outcome, rounds, usage, timeline, gate.outcome.report);
  }

  return resultFromOutcome(
    {
      status: "budget_exceeded",
      report:
        "Work budget was exhausted and the gate rejected the final worker claim.\n\n" +
        rejectedClaimReport(finish.outcome, gate.report),
    },
    rounds,
    usage,
    timeline,
    gate.outcome?.report,
  );
}

function roundFailure(err: unknown): RoundResult {
  const error = err instanceof Error ? err : new Error(String(err));
  return {
    outcome: null,
    report: `Task round failed before reaching a terminal tool: ${error.message}`,
    usage: emptyUsage(),
    error,
  };
}

function gateFailure(err: unknown): GateResult {
  const error = err instanceof Error ? err : new Error(String(err));
  return {
    outcome: null,
    report: `Gate failed before reviewing the worker claim: ${error.message}`,
    usage: emptyUsage(),
    error,
  };
}

function isClaimOutcome(outcome: ExitOutcome): outcome is ClaimOutcome {
  return outcome.status === "completed" || outcome.status === "failed";
}

function shouldDisposeRoundLoops(input: TaskInput): boolean {
  return (input as TaskInput & TaskRunInternalOptions).disposeRoundLoops ?? true;
}

async function runTaskRound(args: {
  input: TaskInput;
  round: number;
  mode: ExitToolMode;
  timeline: TaskTimelineEntry[];
  maxSteps: number | undefined;
  disposeLoop: boolean;
}): Promise<RoundResult> {
  const { input, round, mode, timeline, maxSteps, disposeLoop } = args;
  const loop = input.loop();
  if (!loop.supports("tools")) {
    if (disposeLoop) await loop.dispose().catch(() => {});
    throw new Error(
      `Task runtime "${loop.id}" lacks the "tools" capability; task exit tools can't be injected.`,
    );
  }

  const prompt = buildTaskPrompt(input.goal, timeline, mode);
  await input.hooks?.onRoundStart?.(round, prompt, mode);

  let run: RunHandle | undefined;
  let terminalReached = false;
  const exit = createExitTools({
    mode,
    readContext: { goal: input.goal, mode, round, timeline },
    onTerminal: () => {
      terminalReached = true;
      run?.cancel("agent-loop task exit tool called");
    },
  });

  try {
    const baseTools = input.tools
      ? guardToolsAfterTerminal(input.tools, () => terminalReached)
      : undefined;
    const tools = baseTools ? { ...baseTools, ...exit.tools } : exit.tools;
    run = loop.run({
      ...(input.system ? { system: input.system } : {}),
      prompt,
      ...(input.skills ? { skills: input.skills } : {}),
      tools,
      ...(input.mcp ? { mcp: input.mcp } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.runtimeOptions !== undefined ? { runtimeOptions: input.runtimeOptions } : {}),
      ...(input.runHooks ? { hooks: input.runHooks } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });

    for await (const ev of run) input.hooks?.onEvent?.(ev, round, mode);
    const result = await run.result;
    const outcome = exit.outcome();
    const report = outcome?.report ?? reportFromRunResult(result);
    await input.hooks?.onRoundEnd?.(round, { mode, outcome, report });
    return { outcome, report, usage: result.usage };
  } finally {
    if (disposeLoop) await loop.dispose().catch(() => {});
  }
}

async function reviewClaim(args: {
  input: TaskInput;
  round: number;
  timeline: TaskTimelineEntry[];
  claim: ClaimOutcome;
  disposeLoop?: boolean;
}): Promise<GateResult> {
  const { input, round, timeline, claim } = args;
  const loop = (input.gateLoop ?? input.loop)();
  if (!loop.supports("tools")) {
    if (args.disposeLoop ?? shouldDisposeRoundLoops(input)) await loop.dispose().catch(() => {});
    const error = new Error(
      `Gate runtime "${loop.id}" lacks the "tools" capability; gate exit tools can't be injected.`,
    );
    return {
      outcome: null,
      report: `Gate failed before reviewing the worker claim: ${error.message}`,
      usage: emptyUsage(),
      error,
    };
  }

  const prompt = buildGatePrompt(input.goal, timeline, claim);
  await input.hooks?.onRoundStart?.(round, prompt, "gate");

  let run: RunHandle | undefined;
  let terminalReached = false;
  const gate = createGateTools({
    readContext: { goal: input.goal, mode: "gate", round, timeline },
    onTerminal: () => {
      terminalReached = true;
      run?.cancel("agent-loop gate exit tool called");
    },
  });

  try {
    const baseTools = input.gateTools ?? input.tools;
    const guardedBaseTools = baseTools
      ? guardToolsAfterTerminal(baseTools, () => terminalReached)
      : undefined;
    const tools = guardedBaseTools ? { ...guardedBaseTools, ...gate.tools } : gate.tools;
    run = loop.run({
      prompt,
      tools,
      ...(input.mcp !== undefined ? { mcp: input.mcp } : {}),
      maxSteps: input.gateMaxSteps ?? DEFAULT_GATE_MAX_STEPS,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.runHooks !== undefined ? { hooks: input.runHooks } : {}),
    });

    for await (const ev of run) input.hooks?.onEvent?.(ev, round, "gate");
    const result = await run.result;
    const outcome = gate.outcome();
    const report = outcome?.report ?? reportFromRunResult(result);
    await input.hooks?.onRoundEnd?.(round, { mode: "gate", outcome, report });
    if (!outcome) {
      const error = new Error(
        "Gate protocol violation: gate loop ended without calling agent_loop_gate_accept or agent_loop_gate_reject.",
      );
      return { outcome: null, report: error.message, usage: result.usage, error };
    }
    return { outcome, report, usage: result.usage };
  } finally {
    if (args.disposeLoop ?? shouldDisposeRoundLoops(input)) await loop.dispose().catch(() => {});
  }
}

function resultFromOutcome(
  outcome: Exclude<ExitOutcome, { status: "continue" }>,
  rounds: number,
  usage: TokenUsage,
  timeline: TaskTimelineEntry[],
  gateReport?: string,
): TaskResult {
  return {
    status: outcome.status,
    rounds,
    report: outcome.report,
    ...(gateReport !== undefined ? { gateReport } : {}),
    ...(outcome.status === "completed" && outcome.result !== undefined
      ? { result: outcome.result }
      : {}),
    timeline,
    usage,
  };
}

function failed(
  rounds: number,
  usage: TokenUsage,
  timeline: TaskTimelineEntry[],
  message: string,
  cause?: Error,
): TaskResult {
  const error = cause ?? new Error(message);
  return {
    status: "failed",
    rounds,
    report: message,
    timeline,
    usage,
    error,
  };
}

function reportFromRunResult(result: Awaited<RunHandle["result"]>): string {
  if (result.status === "error" && result.error) {
    return `Run ended with a runtime error: ${result.error.message}`;
  }
  const text = result.text.trim();
  if (!text)
    return "Run ended without a required agent-loop exit tool and produced no assistant text.";
  return truncate(text, MAX_NOTE_CHARS);
}

function buildTaskPrompt(goal: string, timeline: TaskTimelineEntry[], mode: ExitToolMode): string {
  const parts = [
    "# Task",
    goal,
    "# Required agent-loop task protocol",
    mode === "finish" ? finishProtocol() : workProtocol(),
  ];

  if (timeline.length > 0) {
    parts.push("# Task timeline", renderTimeline(timeline));
  }

  if (mode === "finish") {
    parts.push(
      "# Finish-only mode",
      "The work budget is exhausted. Do not attempt more work. Call exactly one task exit tool now.",
    );
  }

  return parts.join("\n\n");
}

function buildGatePrompt(goal: string, timeline: TaskTimelineEntry[], claim: ClaimOutcome): string {
  return [
    "# Gate review",
    "You are reviewing a worker's terminal task claim. Evaluate only whether the claim is supported.",
    "You may use available tools to inspect evidence, but do not solve the task, implement fixes, or continue the worker's unfinished work.",
    "You must call exactly one gate exit tool: `agent_loop_gate_accept` or `agent_loop_gate_reject`.",
    "# Task",
    goal,
    "# Task timeline",
    timeline.length > 0 ? renderTimeline(timeline) : "(empty)",
    "# Worker claim",
    `Status: ${claim.status}`,
    `Report: ${claim.report}`,
    claim.status === "completed" && claim.result !== undefined
      ? `Structured result: ${safeJson(claim.result)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function workProtocol(): string {
  return [
    "End this work round by calling exactly one namespaced task exit tool.",
    "- If more work is needed and the task should continue in a fresh loop, call `agent_loop_task_continue` with a concrete `report`.",
    "- If the whole task is complete, call `agent_loop_task_complete` with a concrete `report`.",
    "- If the task cannot be completed successfully, call `agent_loop_task_fail` with a concrete `report`.",
    "Do not use un-namespaced task tool names.",
  ].join("\n");
}

function finishProtocol(): string {
  return [
    "You are in finish-only mode. You may not continue working.",
    "- Call `agent_loop_task_complete` if the task is complete.",
    "- Call `agent_loop_task_fail` if the task failed for a reason other than budget.",
    "- Call `agent_loop_task_budget_exceeded` if the task is unfinished because the work budget is exhausted.",
    "Every task exit tool requires `report`. Do not use un-namespaced task tool names.",
  ].join("\n");
}

function rejectedClaimReport(claim: ClaimOutcome, gateReport: string): string {
  return [
    `Worker claimed ${claim.status}:`,
    claim.report,
    "",
    "Gate rejected the claim:",
    gateReport,
  ].join("\n");
}

function guardToolsAfterTerminal(tools: ToolSet, isTerminalReached: () => boolean): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, def]) => [
      name,
      {
        ...def,
        ...(def.execute
          ? {
              execute: (args, ctx) => {
                if (isTerminalReached()) {
                  return {
                    error: `Tool "${name}" skipped because an agent-loop terminal tool was already called.`,
                  };
                }
                return def.execute?.(args, ctx);
              },
            }
          : {}),
      },
    ]),
  );
}

function renderTimeline(timeline: TaskTimelineEntry[]): string {
  return timeline.map((entry) => `## Round ${entry.round}\n${entry.report}`).join("\n\n");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 24)}\n...[truncated]`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
