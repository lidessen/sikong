import { addUsage, emptyUsage, type LoopEvent, type TokenUsage } from "../core/events";
import type { RunHandle } from "../core/types";
import type { AgentLoop } from "../loop";
import { createExitTools, type ExitOutcome } from "./exit-tools";
import { memoryStore, renderHandoffs, type Handoff, type HandoffStore } from "./handoff";

/** Observability hooks for the outer task loop (distinct from per-run `Hooks`). */
export interface TaskHooks {
  /** Before a round's run starts; `prompt` is the full briefing the agent sees. */
  onRoundStart?(round: number, prompt: string): void | Promise<void>;
  /** Every normalized event from every round (round-tagged). */
  onEvent?(ev: LoopEvent, round: number): void;
  /** After a round ends; `handoff` is null when the round completed the task. */
  onRoundEnd?(round: number, handoff: Handoff | null): void | Promise<void>;
}

export interface TaskInput {
  /** The overall task. Carried into every round verbatim. */
  goal: string;
  /**
   * Factory called once per round to get a FRESH loop (fresh context). Return a
   * new loop each call; may switch runtime/provider between rounds. The runtime
   * must support the `tools` capability (the exit tools are injected as tools).
   */
  loop: () => AgentLoop;
  /** Optional system prompt prepended each round (atop the built-in guidance). */
  system?: string;
  /** Hard cap on rounds. Default 10. */
  maxRounds?: number;
  /**
   * usedRatio at/above which the supervisor injects a steer telling the agent to
   * wrap up via task_handoff. Default 0.8. Needs a runtime that reports
   * `usedRatio` (see context-window signal); otherwise it simply never fires.
   */
  handoffThreshold?: number;
  /** Soft per-round step cap, passed to each run as `maxSteps`. */
  maxStepsPerRun?: number;
  /** Where handoffs persist (enables resume). Default in-memory. */
  store?: HandoffStore;
  /** Give up after this many consecutive FORCED handoffs (no progress). Default 2. */
  stuckRounds?: number;
  signal?: AbortSignal;
  hooks?: TaskHooks;
}

export type TaskStatus =
  | "completed"
  | "exhausted"
  | "stuck"
  | "cancelled"
  | "error";

export interface TaskResult {
  status: TaskStatus;
  /** Rounds actually executed this call. */
  rounds: number;
  /** Final summary, when completed. */
  summary?: string;
  /** Structured final result, when the model provided one. */
  result?: unknown;
  /** All handoffs (including any pre-loaded from the store on resume). */
  handoffs: Handoff[];
  /** Token usage accumulated across this call's rounds. */
  usage: TokenUsage;
  error?: Error;
}

const STEER_WRAP_UP =
  "You are running low on context. Wrap up NOW: call task_handoff with your " +
  "progress and concrete next steps (or task_complete if the whole task is done).";

/**
 * Outer task supervisor — a "ralph loop". Runs the agent repeatedly until the
 * task is complete, the round budget is exhausted, or it's stuck. Each round is
 * a fresh run (fresh context); rounds are bridged by structured handoffs. The
 * model signals completion/continuation via the injected `task_complete` /
 * `task_handoff` tools; if it does neither, the supervisor forces a handoff from
 * the run's text so the task still advances.
 *
 * Runtime ⊥ task: the supervisor only consumes the `AgentLoop` interface, so a
 * task can switch runtime/provider between rounds (e.g. claude then codex).
 */
export async function runTask(input: TaskInput): Promise<TaskResult> {
  const maxRounds = input.maxRounds ?? 10;
  const threshold = input.handoffThreshold ?? 0.8;
  const stuckLimit = input.stuckRounds ?? 2;
  const store = input.store ?? memoryStore();

  let handoffs = await store.load();
  let usage = emptyUsage();
  let consecutiveForced = 0;
  let round = handoffs.length; // resume: continue numbering after stored handoffs

  while (round < maxRounds) {
    if (input.signal?.aborted) {
      return { status: "cancelled", rounds: round, handoffs, usage };
    }
    round += 1;

    const loop = input.loop();
    if (!loop.supports("tools")) {
      await loop.dispose().catch(() => {});
      return {
        status: "error",
        rounds: round - 1,
        handoffs,
        usage,
        error: new Error(
          `Task runtime "${loop.id}" lacks the "tools" capability; the task_complete/` +
            `task_handoff exit tools can't be injected. Use a tools-capable runtime ` +
            `(claude-code / ai-sdk).`,
        ),
      };
    }

    const prompt = buildPrompt(input.goal, handoffs);
    await input.hooks?.onRoundStart?.(round, prompt);

    const exit = createExitTools();
    let steered = false;
    let run!: RunHandle;
    let runError: Error | undefined;

    try {
      run = loop.run({
        ...(input.system ? { system: input.system } : {}),
        prompt,
        tools: exit.tools,
        ...(input.maxStepsPerRun ? { maxSteps: input.maxStepsPerRun } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        hooks: {
          onUsage: async (u) => {
            if (
              !steered &&
              u.usedRatio !== undefined &&
              u.usedRatio >= threshold
            ) {
              steered = true;
              await run.steer(STEER_WRAP_UP).catch(() => {});
            }
          },
        },
      });

      for await (const ev of run) input.hooks?.onEvent?.(ev, round);
      const result = await run.result;
      usage = addUsage(usage, result.usage);
      if (result.status === "error") runError = result.error;
    } finally {
      await loop.dispose().catch(() => {});
    }

    const outcome = exit.outcome();

    if (outcome?.kind === "complete") {
      await input.hooks?.onRoundEnd?.(round, null);
      return {
        status: "completed",
        rounds: round,
        summary: outcome.summary,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        handoffs,
        usage,
      };
    }

    const handoff = toHandoff(round, outcome, runError);
    handoffs = [...handoffs, handoff];
    await store.save(handoffs);
    await input.hooks?.onRoundEnd?.(round, handoff);

    if (handoff.voluntary) consecutiveForced = 0;
    else consecutiveForced += 1;
    if (consecutiveForced >= stuckLimit) {
      return { status: "stuck", rounds: round, handoffs, usage };
    }
  }

  return { status: "exhausted", rounds: round, handoffs, usage };
}

function toHandoff(
  round: number,
  outcome: ExitOutcome | null,
  runError: Error | undefined,
): Handoff {
  if (outcome?.kind === "handoff") {
    return {
      round,
      progress: outcome.progress,
      nextSteps: outcome.nextSteps,
      ...(outcome.openQuestions ? { openQuestions: outcome.openQuestions } : {}),
      ...(outcome.artifacts ? { artifacts: outcome.artifacts } : {}),
      voluntary: true,
    };
  }
  // Forced: the run ended without calling an exit tool.
  return {
    round,
    progress: runError
      ? `Round ended with an error: ${runError.message}`
      : "Round ended without calling an exit tool (forced handoff).",
    nextSteps: "Review what was done and continue toward the goal.",
    voluntary: false,
  };
}

function buildPrompt(goal: string, handoffs: Handoff[]): string {
  if (handoffs.length === 0) {
    return [
      `# Task`,
      goal,
      `# How to finish`,
      `When the WHOLE task is complete, call \`task_complete\`. If you run low on ` +
        `context before finishing, call \`task_handoff\` with your progress and next steps.`,
    ].join("\n\n");
  }
  return [
    `# Task`,
    goal,
    `# Progress so far (from previous agents)`,
    renderHandoffs(handoffs),
    `# Your job`,
    `Continue from where the last agent left off. When the WHOLE task is complete, ` +
      `call \`task_complete\`. If you run low on context first, call \`task_handoff\`.`,
  ].join("\n\n");
}
