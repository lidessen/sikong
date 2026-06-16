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
- request: an operator decision such as accepting a plan or final result.`;

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

Role boundary:
You are the client-side operator agent. Use Sikong tools to manage workspaces,
preferences, transcript context, and Work Items. Implementation, verification,
and final task evidence are produced by the task orchestration agents.

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
    formatRunErrors(work, settlement) ||
    "The client agent turn ended without a structured outcome.";
  return {
    kind: "report",
    title: "Turn ended without structured outcome",
    summary,
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
