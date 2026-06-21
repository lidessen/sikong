import {
  aiSdkLoop,
  claudeCodeLoop,
  defineTool,
  deepseek,
  kimi,
  type AgentLoop,
  type EffortLevel,
  type ModelProvider,
  type RunHandle,
  type ToolSet,
} from "agent-loop";
import type { AgentRunRequest, AgentRunResponse, AgentToolCall, JsonValue } from "./protocol";

export interface AgentLoopWorkerOptions {
  provider?: "deepseek" | "kimi";
  runtime?: "ai-sdk" | "claude-code";
  model?: string;
  maxSteps?: number;
  effort?: EffortLevel;
}

const ORCHESTRATION_ESCAPE_TOOLS = ["Agent", "Task", "EnterPlanMode", "ExitPlanMode"];

const GENERAL_BUILTIN_DENY_TOOLS = [
  ...ORCHESTRATION_ESCAPE_TOOLS,
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
];

export function createAgentLoopWorker(options: AgentLoopWorkerOptions = {}) {
  const loop = createLoop(options);
  const runtime = resolveRuntime(options);

  return async function runAgentLoopWorker(request: AgentRunRequest): Promise<AgentRunResponse> {
    const runStartedAt = performance.now();
    const terminalToolNames = new Set(request.terminalToolSet);
    const toolCalls: AgentToolCall[] = [];
    let terminalCall: AgentToolCall | undefined;
    let run: RunHandle | undefined;
    let resultSettled = false;
    const effort = request.effort ?? options.effort;
    const tools = createAgentLoopTools(request, terminalToolNames, toolCalls, (call) => {
      terminalCall = call;
      logAgentLoopEvent(request, "terminal_captured", runStartedAt, {
        terminalTool: call.name,
      });
      const fallbackCancelMs = 15_000;
      setTimeout(() => {
        if (resultSettled) return;
        logAgentLoopEvent(request, "terminal_fallback_cancel", runStartedAt, {
          terminalTool: call.name,
          fallbackCancelMs,
        });
        run?.cancel(`terminal tool ${call.name} fallback cancel`);
      }, fallbackCancelMs);
    });

    logAgentLoopEvent(request, "loop.start", runStartedAt, {
      provider: options.provider ?? "kimi",
      runtime,
      runtimeProfile: request.runtimeProfile,
      model: options.model,
      maxSteps: options.maxSteps ?? 12,
      effort,
    });
    run = loop.run({
      system: renderSystemPrompt(request),
      prompt: renderUserPrompt(request),
      tools,
      terminalToolSet: request.terminalToolSet,
      maxSteps: options.maxSteps ?? 12,
      effort,
      runtimeOptions: runtimeOptionsForWorker(request, runtime),
    });
    logAgentLoopEvent(request, "loop.created", runStartedAt, {});
    const eventsDone = logLoopEvents(request, run, runStartedAt);
    logAgentLoopEvent(request, "result.await", runStartedAt, {});
    const result = await run.result;
    resultSettled = true;
    await eventsDone;
    logAgentLoopEvent(request, "result", runStartedAt, {
      status: result.status,
      durationMs: result.durationMs,
      error: result.error?.message,
      usage: result.usage,
      terminalTool: terminalCall?.name,
      toolCallCount: toolCalls.length,
    });

    return {
      report: [
        `agent-loop worker completed ${request.objective}`,
        `status=${result.status}`,
        `tool_calls=${toolCalls.map((call) => call.name).join(" -> ") || "none"}`,
        terminalCall ? `terminal=${terminalCall.name}` : "terminal=none",
        result.error ? `error=${result.error.message}` : "",
      ]
        .filter(Boolean)
        .join("; "),
      toolCalls,
      ...(terminalCall ? { terminalCall } : {}),
      usage: result.usage,
    };
  };
}

async function logLoopEvents(
  request: AgentRunRequest,
  run: AsyncIterable<unknown>,
  runStartedAt: number,
): Promise<void> {
  try {
    for await (const event of run) {
      logLoopEvent(request, event, runStartedAt);
    }
  } catch (error) {
    logAgentLoopEvent(request, "event_stream_error", runStartedAt, {
      error: errorMessage(error),
    });
  }
}

function logLoopEvent(request: AgentRunRequest, event: unknown, runStartedAt: number): void {
  const record = toRecord(event);
  const type = stringOr(record.type, "unknown");
  switch (type) {
    case "step":
      logAgentLoopEvent(request, "step", runStartedAt, {
        phase: record.phase,
        index: record.index,
      });
      break;
    case "tool_call_start":
      logAgentLoopEvent(request, "tool_call_start", runStartedAt, {
        name: record.name,
        callId: record.callId,
        args: truncateJson(record.args),
      });
      break;
    case "tool_call_end":
      logAgentLoopEvent(request, "tool_call_end", runStartedAt, {
        name: record.name,
        callId: record.callId,
        durationMs: record.durationMs,
        error: record.error,
        result: truncateJson(record.result),
      });
      break;
    case "usage":
      logAgentLoopEvent(request, "usage", runStartedAt, {
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        totalTokens: record.totalTokens,
        cacheReadTokens: record.cacheReadTokens,
        cacheCreationTokens: record.cacheCreationTokens,
        usedRatio: record.usedRatio,
        source: record.source,
      });
      break;
    case "thinking":
    case "text":
      if (shouldLogVerboseText()) {
        logAgentLoopEvent(request, type, runStartedAt, {
          chars: stringOr(record.text, "").length,
          text: truncateText(stringOr(record.text, ""), 400),
        });
      }
      break;
    case "hook":
      logAgentLoopEvent(request, "hook", runStartedAt, {
        phase: record.phase,
        name: record.name,
        hookEvent: record.hookEvent,
        outcome: record.outcome,
        stdout: truncateText(stringOr(record.stdout, ""), 300),
        stderr: truncateText(stringOr(record.stderr, ""), 300),
      });
      break;
    case "error":
      logAgentLoopEvent(request, "error", runStartedAt, {
        error: errorMessage(record.error),
      });
      break;
    default:
      logAgentLoopEvent(request, type, runStartedAt, {
        event: truncateJson(record),
      });
      break;
  }
}

function logAgentLoopEvent(
  request: AgentRunRequest,
  event: string,
  runStartedAt: number,
  fields: Record<string, unknown>,
): void {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      source: "agent-loop",
      event,
      elapsedMs: Math.round(performance.now() - runStartedAt),
      objective: request.objective,
      terminalToolSet: request.terminalToolSet,
      ...fields,
    }),
  );
}

function createLoop(options: AgentLoopWorkerOptions): AgentLoop {
  const provider = options.provider ?? "kimi";
  const runtime = resolveRuntime(options);
  switch (provider) {
    case "deepseek":
      if (runtime === "claude-code") {
        return claudeCodeLoop({
          provider: createProvider(options),
        });
      }
      return aiSdkLoop({ provider: createProvider(options) });
    case "kimi":
      if (runtime === "claude-code") {
        return claudeCodeLoop({
          provider: createProvider(options),
        });
      }
      throw new Error(
        "Kimi Code does not support the ai-sdk runtime without client allowlist onboarding.",
      );
  }
}

function resolveRuntime(options: AgentLoopWorkerOptions): "ai-sdk" | "claude-code" {
  const provider = options.provider ?? "kimi";
  return options.runtime ?? (provider === "kimi" ? "claude-code" : "ai-sdk");
}

function createProvider(options: AgentLoopWorkerOptions): ModelProvider {
  switch (options.provider ?? "kimi") {
    case "deepseek":
      return deepseek({ model: options.model ?? "deepseek-v4-flash" });
    case "kimi":
      return kimi({});
  }
}

function runtimeOptionsForWorker(
  request: AgentRunRequest,
  runtime: "ai-sdk" | "claude-code",
): Record<string, unknown> | undefined {
  if (runtime !== "claude-code") {
    return undefined;
  }

  if (request.runtimeProfile === "code") {
    return {
      systemPromptPreset: "claude_code",
      builtinTools: { type: "preset", preset: "claude_code" },
      disallowedTools: ORCHESTRATION_ESCAPE_TOOLS,
    };
  }

  return {
    systemPromptPreset: "custom",
    builtinTools: [],
    disallowedTools: GENERAL_BUILTIN_DENY_TOOLS,
  };
}

function createAgentLoopTools(
  request: AgentRunRequest,
  terminalToolNames: Set<string>,
  toolCalls: AgentToolCall[],
  setTerminalCall: (call: AgentToolCall) => void,
): ToolSet {
  const tools: ToolSet = {};

  for (const spec of request.tools) {
    tools[spec.name] = defineTool({
      description: spec.description,
      inputSchema: spec.inputSchema,
      execute: (args, context) => {
        const call = {
          name: spec.name,
          arguments: toJsonObject(args),
        };
        toolCalls.push(call);

        const isTerminal = terminalToolNames.has(spec.name);
        if (isTerminal) {
          setTerminalCall(call);
          context.requestStop?.(`terminal tool ${spec.name} called`);
        }

        return toolResult(spec.name, isTerminal, call.arguments, request.input);
      },
    });
  }

  return tools;
}

function toolResult(
  tool: string,
  isTerminal: boolean,
  received: JsonValue,
  runInput: JsonValue,
): Record<string, unknown> {
  if (isTerminal) {
    return {
      ok: true,
      terminal: true,
      tool,
      received,
    };
  }

  return {
    ok: true,
    tool,
    received,
    input: runInput,
  };
}

function renderSystemPrompt(request: AgentRunRequest): string {
  return request.prompt.map((section) => `## ${section.title}\n${section.content}`).join("\n\n");
}

function renderUserPrompt(request: AgentRunRequest): string {
  return [
    `Objective: ${request.objective}`,
    `You must finish this run by calling one of these terminal tools: ${request.terminalToolSet.join(", ")}.`,
    "Do not answer in plain text instead of calling the terminal tool.",
  ].join("\n");
}

function toJsonObject(input: Record<string, unknown>): JsonValue {
  return JSON.parse(JSON.stringify(input)) as JsonValue;
}

function toRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function stringOr(input: unknown, fallback: string): string {
  return typeof input === "string" ? input : fallback;
}

function truncateText(input: string, maxChars: number): string {
  return input.length > maxChars ? `${input.slice(0, maxChars)}…` : input;
}

function truncateJson(input: unknown): string {
  const encoded = JSON.stringify(input ?? null);
  return truncateText(encoded, 800);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldLogVerboseText(): boolean {
  return Bun.env.SIKONG_AGENT_LOOP_VERBOSE_TEXT === "1";
}
