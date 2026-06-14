import type { AgentLoop, RunResult } from "agent-loop";
import { createClientAgentTools } from "../tools";
import type { CommandContext } from "../commands";
import {
  buildClientAgentContext,
  formatClientAgentContext,
  type ClientAgentContextPacket,
  type ClientAgentFocus,
} from "./context";
import { FileClientWorkLog, type ClientWorkLog } from "./work-log";

export interface RunClientAgentTurnInput {
  ctx: CommandContext;
  loop: AgentLoop;
  message: string;
  focus?: ClientAgentFocus;
  workLog?: ClientWorkLog;
  workLogLimit?: number;
  maxSteps?: number;
  system?: string;
}

export interface RunClientAgentTurnResult {
  context: ClientAgentContextPacket;
  run: RunResult;
}

export const CLIENT_AGENT_SYSTEM_PROMPT = `You are Sikong's Client Agent.

You are not a traditional persistent chat-session agent. The visible transcript
is presentation state only and is not provided as memory. Use the supplied
client work log, focused workspace/task summary, and typed Sikong tools as your
context. Do not assume raw task event logs are in context unless you explicitly
inspect them with a tool. Keep task coordination inside Sikong tools.`;

export async function runClientAgentTurn(
  input: RunClientAgentTurnInput,
): Promise<RunClientAgentTurnResult> {
  if (!input.message.trim()) throw new Error("client agent message must be non-empty");
  const workLog = input.workLog ?? new FileClientWorkLog(input.ctx.dataDir);
  const context = await buildClientAgentContext({
    ctx: input.ctx,
    focus: input.focus,
    workLog,
    workLogLimit: input.workLogLimit,
  });
  const run = input.loop.run({
    system: input.system ?? CLIENT_AGENT_SYSTEM_PROMPT,
    prompt: formatClientAgentPrompt(input.message, context),
    tools: createClientAgentTools({ ctx: input.ctx }),
    ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
    metadata: { surface: "sikong.client_agent" },
  });
  return { context, run: await run.result };
}

export function formatClientAgentPrompt(
  message: string,
  context: ClientAgentContextPacket,
): string {
  return `Current user message:
${message}

Context packet:
${formatClientAgentContext(context)}

Transcript policy:
The UI transcript is intentionally omitted. Treat the context packet above as
the durable memory and current focus for this turn.`;
}
