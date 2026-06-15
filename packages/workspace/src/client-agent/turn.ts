import type { AgentLoop, RunHandle, RunResult } from "agent-loop";
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
  system?: string;
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

export const CLIENT_AGENT_SYSTEM_PROMPT = `You are Sikong's Client Agent.

You are not a traditional persistent chat-session agent. The bootstrap context
orients you, but it is not a memory dump. The transcript is a UI record, not
authoritative project state. Workspace and task stores are authoritative.

When the current message refers to previous work, workspace state, task state,
or earlier conversation, inspect the relevant source store with tools before
acting. Do not assume all relevant history is already in the prompt. Do not
invent workspace facts from memory. If focus is ambiguous, resolve it by
workspace/task names, recent transcript, or ask a concise clarification.

Keep task coordination inside Sikong tools.`;

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
    ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
  });
  if (work.outcome) {
    return {
      context,
      run: work.run,
      outcome: work.outcome,
      outcomeText: formatClientTurnOutcomeText(work.outcome),
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
    metadata: { surface: "sikong.client_agent", phase: "settlement" },
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

Turn boundary:
When the visible work for this turn reaches a user-facing boundary, call
finishClientTurn with a report, question, or request.`;
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

Submit one finishClientTurn outcome now. Do not mutate workspace or task state in this settlement pass.`;
}

async function runClientAgentPass(input: {
  ctx: CommandContext;
  loop: AgentLoop;
  system: string;
  prompt: string;
  transcript?: ClientTranscriptSource;
  mode: "work" | "settlement";
  maxSteps?: number;
  metadata: Record<string, unknown>;
}): Promise<{ run: RunResult; outcome?: ClientTurnOutcome }> {
  const sink: ClientTurnOutcomeSink = {};
  let run: RunHandle | undefined;
  run = input.loop.run({
    system: input.system,
    prompt: input.prompt,
    tools: createClientAgentTools({
      ctx: input.ctx,
      transcript: input.transcript,
      mode: input.mode,
      outcome: sink,
      onFinish: () => run?.cancel("client-agent turn outcome submitted"),
    }),
    ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
    metadata: input.metadata,
  });
  return { run: await run.result, ...(sink.outcome ? { outcome: sink.outcome } : {}) };
}

function fallbackOutcome(work: RunResult, settlement: RunResult): ClientTurnOutcome {
  const summary =
    settlement.text.trim() ||
    work.text.trim() ||
    "The client agent turn ended without a structured outcome.";
  return {
    kind: "report",
    title: "Turn ended without structured outcome",
    summary,
    facts: [
      { label: "work pass", value: work.status },
      { label: "settlement pass", value: settlement.status },
    ],
  };
}
