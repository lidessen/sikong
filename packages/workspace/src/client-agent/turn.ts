import {
  emptyUsage,
  type AgentLoop,
  type LoopEvent,
  type RunHandle,
  type RunResult,
} from "agent-loop";
import { createClientAgentTools } from "../tools";
import type { CommandContext } from "../commands";
import {
  buildClientAgentContext,
  formatClientAgentContext,
  type ClientAgentContextPacket,
  type ClientAgentCurrentMessage,
  type ClientAgentFocus,
  type ClientTranscriptSource,
} from "./context";
import {
  formatClientTurnOutcomeText,
  type ClientTurnOutcome,
  type ClientTurnOutcomeSink,
} from "./outcome";

const DEFAULT_CLIENT_AGENT_PASS_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CLIENT_AGENT_SETTLEMENT_TIMEOUT_MS = 2 * 60 * 1000;

export interface RunClientAgentTurnInput {
  ctx: CommandContext;
  loop: AgentLoop;
  message: string;
  currentMessage?: ClientAgentCurrentMessage;
  focus?: ClientAgentFocus;
  transcript?: ClientTranscriptSource;
  recentTranscriptLimit?: number;
  maxSteps?: number;
  settlementMaxSteps?: number;
  passTimeoutMs?: number;
  settlementPassTimeoutMs?: number;
  system?: string;
  signal?: AbortSignal;
  onActivity?: (activity: ClientAgentActivity) => void | Promise<void>;
}

export interface RunClientAgentTurnResult {
  context: ClientAgentContextPacket;
  run: RunResult;
  settlementRun?: RunResult;
  outcome: ClientTurnOutcome;
  outcomeText: string;
  settlement: {
    used: boolean;
    fallbackUsed: boolean;
  };
}

export type ClientAgentActivityKind = "status" | "thinking" | "text" | "tool" | "usage" | "error";

export type ClientAgentActivityStatus = "running" | "done" | "error";

export interface ClientAgentActivity {
  id: string;
  at: string;
  phase: "work" | "settlement";
  kind: ClientAgentActivityKind;
  status: ClientAgentActivityStatus;
  title: string;
  detail?: string;
  callId?: string;
}

export const CLIENT_AGENT_SYSTEM_PROMPT = `You are Sikong's Client Agent.

Your job is to represent the human operator in the Sikong client. You maintain
orientation across workspaces, help the operator see what is happening, and use
typed Sikong tools to create, inspect, and steer durable Work Items.

Development work belongs inside Sikong Work Items, where the Task Lead,
Planner, Workers, and Reviewers coordinate execution. When the user asks for
code changes or project work, your natural move is to find or create the right
workspace and Work Item, then report the current boundary or ask for the next
operator decision.

Each turn is a fresh pass over an explicit bootstrap context. The bootstrap
context orients you, while authoritative project facts live in workspace and
task stores. The transcript is a UI record for conversation continuity.

When the current message refers to previous work, workspace state, task state,
or earlier conversation, inspect the relevant source store with tools before
acting. Treat tool results as the source of truth for prior history and
workspace facts. If focus is ambiguous, resolve it by workspace/task names,
recent transcript, or ask a concise clarification.

Finish each visible turn with one of three client outcomes:
- report: what changed or what you found;
- question: a concise clarification for the operator;
- request: an operator decision such as accepting a plan or final result.

Do not rely on plain assistant text as the final reply. Once you have enough
information for the visible turn, call finishClientTurn exactly once and stop.`;

export async function runClientAgentTurn(
  input: RunClientAgentTurnInput,
): Promise<RunClientAgentTurnResult> {
  if (!input.message.trim()) throw new Error("client agent message must be non-empty");
  const currentMessage = input.currentMessage ?? {
    id: "current-message",
    text: input.message,
    createdAt: new Date().toISOString(),
  };
  const context = await buildClientAgentContext({
    ctx: input.ctx,
    currentMessage,
    focus: input.focus,
    transcript: input.transcript,
    recentTranscriptLimit: input.recentTranscriptLimit,
  });
  const work = await runClientAgentPass({
    ctx: input.ctx,
    loop: input.loop,
    system: input.system ?? CLIENT_AGENT_SYSTEM_PROMPT,
    prompt: formatClientAgentPrompt(input.message, context),
    transcript: input.transcript,
    mode: "work",
    metadata: { surface: "sikong.client_agent", phase: "work" },
    timeoutMs: input.passTimeoutMs ?? DEFAULT_CLIENT_AGENT_PASS_TIMEOUT_MS,
    onActivity: input.onActivity,
    signal: input.signal,
    ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
  });
  if (work.run.status === "cancelled") {
    return {
      context,
      run: work.run,
      outcome: {
        kind: "report",
        title: "Turn cancelled",
        summary: "The client agent pass was cancelled before it finished.",
      },
      outcomeText: "",
      settlement: { used: false, fallbackUsed: false },
    };
  }
  if (work.outcome) {
    return {
      context,
      run: work.run,
      outcome: work.outcome,
      outcomeText: formatClientTurnOutcomeText(work.outcome),
      settlement: { used: false, fallbackUsed: false },
    };
  }
  if (isClientAgentPassTimeout(work.run)) {
    const outcome = fallbackOutcome(work.run, skippedSettlementRun("skipped after work timeout"));
    return {
      context,
      run: work.run,
      outcome,
      outcomeText: formatClientTurnOutcomeText(outcome),
      settlement: { used: false, fallbackUsed: true },
    };
  }

  if (!shouldRunSettlementPass(work)) {
    const outcome = work.outcome ?? outcomeFromWorkRun(work.run);
    return {
      context,
      run: work.run,
      outcome,
      outcomeText: formatClientTurnOutcomeText(outcome),
      settlement: { used: false, fallbackUsed: false },
    };
  }

  const settlement = await runClientAgentPass({
    ctx: input.ctx,
    loop: input.loop,
    system: input.system ?? CLIENT_AGENT_SYSTEM_PROMPT,
    prompt: formatClientAgentSettlementPrompt(input.message, context, work.run),
    transcript: input.transcript,
    mode: "settlement",
    maxSteps: input.settlementMaxSteps ?? 2,
    timeoutMs: input.settlementPassTimeoutMs ?? DEFAULT_CLIENT_AGENT_SETTLEMENT_TIMEOUT_MS,
    metadata: { surface: "sikong.client_agent", phase: "settlement" },
    onActivity: input.onActivity,
    signal: input.signal,
  });
  const outcome = settlement.outcome ?? fallbackOutcome(work.run, settlement.run);
  return {
    context,
    run: work.run,
    settlementRun: settlement.run,
    outcome,
    outcomeText: formatClientTurnOutcomeText(outcome),
    settlement: { used: true, fallbackUsed: !settlement.outcome },
  };
}

export function formatClientAgentPrompt(
  message: string,
  context: ClientAgentContextPacket,
): string {
  return `Current user message:
${message}

Bootstrap context:
${formatClientAgentContext(context)}

Source policy:
Use the bootstrap packet to orient this turn. Query transcript, workspace, and
task tools when prior conversation or project state matters.

Role boundary:
You are the client-side operator agent. Use Sikong tools to manage workspaces,
preferences, transcript context, and Work Items. Implementation, verification,
and final task evidence are produced by the task orchestration agents.

Turn boundary:
When the visible work for this turn reaches a user-facing boundary, call
finishClientTurn with a report, question, or request. Do not continue producing
assistant text after calling finishClientTurn.`;
}

export function formatClientAgentSettlementPrompt(
  message: string,
  context: ClientAgentContextPacket,
  run: RunResult,
): string {
  return `The previous client-agent pass ended without finishClientTurn.

Current user message:
${message}

Bootstrap context:
${formatClientAgentContext(context)}

Previous pass status:
${run.status}

Previous pass text:
${run.text || "(no assistant text)"}

Submit one finishClientTurn outcome now. This settlement pass is report-only and should leave workspace and task state unchanged.`;
}

async function runClientAgentPass(input: {
  ctx: CommandContext;
  loop: AgentLoop;
  system: string;
  prompt: string;
  transcript?: ClientTranscriptSource;
  mode: "work" | "settlement";
  maxSteps?: number;
  timeoutMs?: number;
  metadata: Record<string, unknown>;
  onActivity?: (activity: ClientAgentActivity) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<{ run: RunResult; outcome?: ClientTurnOutcome }> {
  const sink: ClientTurnOutcomeSink = {};
  const run = input.loop.run({
    system: input.system,
    prompt: input.prompt,
    tools: createClientAgentTools({
      ctx: input.ctx,
      transcript: input.transcript,
      mode: input.mode,
      outcome: sink,
    }),
    ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
    metadata: input.metadata,
  });
  const activityStream = streamClientAgentActivities(run, input.mode, input.onActivity);
  const result = await waitClientAgentRun(run, input.timeoutMs, input.signal);
  if (isClientAgentPassTimeout(result)) void activityStream.catch(() => {});
  else await activityStream;
  return { run: result, ...(sink.outcome ? { outcome: sink.outcome } : {}) };
}

async function streamClientAgentActivities(
  run: RunHandle,
  phase: ClientAgentActivity["phase"],
  onActivity: ((activity: ClientAgentActivity) => void | Promise<void>) | undefined,
): Promise<void> {
  if (!onActivity) return;
  let sequence = 0;
  const nextId = (ev: LoopEvent): string => {
    const callId =
      "callId" in ev && typeof ev.callId === "string" && ev.callId.trim()
        ? ev.callId.trim()
        : undefined;
    return callId ? `${phase}-${callId}` : `${phase}-${++sequence}-${ev.type}`;
  };
  try {
    for await (const ev of run) {
      const activity = activityFromLoopEvent(ev, phase, nextId(ev));
      if (activity) await onActivity(activity);
    }
  } catch (err) {
    await onActivity({
      id: `${phase}-activity-error`,
      at: new Date().toISOString(),
      phase,
      kind: "error",
      status: "error",
      title: "Activity stream failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

function activityFromLoopEvent(
  ev: LoopEvent,
  phase: ClientAgentActivity["phase"],
  id: string,
): ClientAgentActivity | undefined {
  const at = new Date().toISOString();
  switch (ev.type) {
    case "thinking":
      return {
        id,
        at,
        phase,
        kind: "thinking",
        status: "running",
        title: "Thinking",
        detail: summarizeText(ev.text),
      };
    case "text":
      return {
        id,
        at,
        phase,
        kind: "text",
        status: "running",
        title: "Drafting response",
        detail: summarizeText(ev.text),
      };
    case "tool_call_start":
      return {
        id,
        at,
        phase,
        kind: "tool",
        status: "running",
        title: `Calling ${ev.name}`,
        detail: summarizeUnknown(ev.args),
        callId: ev.callId,
      };
    case "tool_call_end":
      return {
        id,
        at,
        phase,
        kind: "tool",
        status: ev.error ? "error" : "done",
        title: `${ev.name} ${ev.error ? "failed" : "returned"}`,
        detail: ev.error ? summarizeText(ev.error) : summarizeUnknown(ev.result),
        callId: ev.callId,
      };
    case "usage":
      return {
        id,
        at,
        phase,
        kind: "usage",
        status: "done",
        title: "Token usage",
        detail: `${ev.totalTokens} tokens · ${ev.inputTokens} in · ${ev.outputTokens} out`,
      };
    case "step":
      return {
        id,
        at,
        phase,
        kind: "status",
        status: ev.phase === "end" ? "done" : "running",
        title: `Step ${ev.index} ${ev.phase}`,
      };
    case "hook":
      return {
        id,
        at,
        phase,
        kind: ev.outcome === "error" ? "error" : "status",
        status: ev.outcome === "error" ? "error" : ev.phase === "response" ? "done" : "running",
        title: `${ev.name} ${ev.phase}`,
        detail: summarizeText(ev.output ?? ev.stdout ?? ev.stderr ?? ""),
      };
    case "steer":
      return {
        id,
        at,
        phase,
        kind: "status",
        status: ev.mode === "live" ? "running" : "done",
        title: `Steer ${ev.mode}`,
        detail: summarizeText(ev.message),
      };
    case "error":
      return {
        id,
        at,
        phase,
        kind: "error",
        status: "error",
        title: "Runtime error",
        detail: summarizeText(ev.error.message),
      };
    case "unknown":
      return {
        id,
        at,
        phase,
        kind: "status",
        status: "running",
        title: "Runtime event",
        detail: summarizeUnknown(ev.data),
      };
  }
}

const ACTIVITY_TEXT_LIMIT = 280;
const ACTIVITY_JSON_LIMIT = 360;
const SENSITIVE_FIELD = /api[_-]?key|authorization|bearer|cookie|password|secret|token/i;

function summarizeText(text: string | undefined, limit = ACTIVITY_TEXT_LIMIT): string | undefined {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function summarizeUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return summarizeText(value, ACTIVITY_JSON_LIMIT);
  try {
    return summarizeText(JSON.stringify(redactUnknown(value)), ACTIVITY_JSON_LIMIT);
  } catch {
    return summarizeText(String(value), ACTIVITY_JSON_LIMIT);
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

async function waitClientAgentRun(
  run: RunHandle,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<RunResult> {
  if (signal?.aborted) return cancelledRunResult();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let abortListener: (() => void) | undefined;

  const timeoutResult =
    timeoutMs === undefined
      ? undefined
      : new Promise<RunResult>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            const error = new Error(`client agent pass timed out after ${timeoutMs}ms`);
            run.cancel(error.message);
            void run.cleanup({ reason: error.message, graceMs: 2_000 });
            resolve({
              events: [],
              usage: emptyUsage(),
              durationMs: timeoutMs,
              status: "error",
              error,
              text: "",
            });
          }, timeoutMs);
        });

  const abortResult = signal
    ? new Promise<RunResult>((resolve) => {
        abortListener = () => {
          const reason = signal.reason === "timeout" ? "turn timed out" : "turn cancelled";
          run.cancel(reason);
          void run.cleanup({ reason, graceMs: 2_000 });
          resolve(cancelledRunResult());
        };
        signal.addEventListener("abort", abortListener, { once: true });
      })
    : undefined;

  const racers = [
    run.result,
    ...(timeoutResult ? [timeoutResult] : []),
    ...(abortResult ? [abortResult] : []),
  ];
  const result = await Promise.race(racers);
  if (timeout) clearTimeout(timeout);
  if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  if (timedOut) void run.result.catch(() => {});
  return result;
}

function cancelledRunResult(): RunResult {
  return {
    events: [],
    usage: emptyUsage(),
    durationMs: 0,
    status: "cancelled",
    text: "",
  };
}

function shouldRunSettlementPass(work: { run: RunResult; outcome?: ClientTurnOutcome }): boolean {
  if (work.outcome) return false;
  if (work.run.status === "cancelled") return false;
  if (work.run.text.trim()) return false;
  return true;
}

function outcomeFromWorkRun(run: RunResult): ClientTurnOutcome {
  const text = run.text.trim();
  if (text) {
    return {
      kind: "report",
      title: "Sikong response",
      summary: text,
    };
  }
  return fallbackOutcome(run, skippedSettlementRun("skipped settlement"));
}

function fallbackOutcome(work: RunResult, settlement: RunResult): ClientTurnOutcome {
  const visibleText = settlement.text.trim() || work.text.trim();
  if (visibleText) {
    return {
      kind: "report",
      title: "Sikong response",
      summary: visibleText,
    };
  }

  const errorSummary = formatRunErrors(work, settlement);
  if (!errorSummary) {
    return {
      kind: "report",
      title: "No response",
      summary: "Client agent did not produce a usable response. Please retry.",
    };
  }

  return {
    kind: "report",
    title: "Client agent turn failed",
    summary: errorSummary,
    facts: [
      { label: "work pass", value: work.status },
      ...(work.error ? [{ label: "work error", value: work.error.message }] : []),
      { label: "settlement pass", value: settlement.status },
      ...(settlement.error ? [{ label: "settlement error", value: settlement.error.message }] : []),
    ],
  };
}

function formatRunErrors(work: RunResult, settlement: RunResult): string {
  const lines = [
    work.error ? `Work pass error: ${work.error.message}` : "",
    settlement.error ? `Settlement pass error: ${settlement.error.message}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function isClientAgentPassTimeout(run: RunResult): boolean {
  return Boolean(run.error?.message.startsWith("client agent pass timed out after "));
}

function skippedSettlementRun(_reason: string): RunResult {
  return {
    events: [],
    usage: emptyUsage(),
    durationMs: 0,
    status: "cancelled",
    text: "",
  };
}
