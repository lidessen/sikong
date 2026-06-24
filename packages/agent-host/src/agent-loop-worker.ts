import {
  aiSdkLoop,
  anthropic,
  claudeCodeLoop,
  codexLoop,
  cursorLoop,
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
  provider?: "deepseek" | "kimi" | "claude" | "codex" | "cursor";
  runtime?: "ai-sdk" | "claude-code" | "codex" | "cursor";
  model?: string;
  maxSteps?: number;
  effort?: EffortLevel;
}

const ORCHESTRATION_ESCAPE_TOOLS = ["Agent", "Task", "EnterPlanMode", "ExitPlanMode"];
const READONLY_MUTATION_BUILTIN_TOOLS = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"];

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
];

export function createAgentLoopWorker(options: AgentLoopWorkerOptions = {}) {
  const loop = createLoop(options);
  const runtime = resolveRuntime(options);

  return async function runAgentLoopWorker(request: AgentRunRequest): Promise<AgentRunResponse> {
    const runStartedAt = performance.now();
    const terminalToolNames = new Set(request.terminalToolSet);
    const toolCalls: AgentToolCall[] = [];
    const events: JsonValue[] = [];
    let terminalCall: AgentToolCall | undefined;
    let run: RunHandle | undefined;
    let resultSettled = false;
    const effort = request.effort ?? options.effort;
    const specTools = createAgentLoopTools(request, terminalToolNames, toolCalls, (call) => {
      terminalCall = call;
      logAgentLoopEvent(request, "terminal_captured", runStartedAt, {
        terminalTool: call.name,
      }, events);
      const fallbackCancelMs = 15_000;
      setTimeout(() => {
        if (resultSettled) return;
        logAgentLoopEvent(request, "terminal_fallback_cancel", runStartedAt, {
          terminalTool: call.name,
          fallbackCancelMs,
        }, events);
        run?.cancel(`terminal tool ${call.name} fallback cancel`);
      }, fallbackCancelMs);
    });
    const execTools: ToolSet = {};
    if (request.runtimeProfile === "code") {
      execTools.Bash = defineTool({
        description: "Run a shell command. Returns stdout.",
        inputSchema: { type: "object", properties: {
          command: { type: "string", description: "Shell command to run" },
          timeout: { type: "number", description: "Timeout in ms (default 120000)" },
        }, required: ["command"] } as Record<string, unknown>,
        execute: async (args: Record<string, unknown>) => {
          const cmd = stringOr(args.command, "");
          const t = Number(args.timeout ?? 120_000);
          try {
            const proc = Bun.spawn(["/bin/bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
            const out = await Promise.race([
              new Response(proc.stdout).text(),
              new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), t)),
            ]);
            await proc.exited;
            return { ok: true, exitCode: proc.exitCode, stdout: out.slice(0, 50000) };
          } catch (e) { return { ok: false, error: errorMessage(e) }; }
        },
      });
    }
    const tools = { ...specTools, ...execTools };

    logAgentLoopEvent(request, "loop.start", runStartedAt, {
      provider: options.provider ?? "deepseek",
      runtime,
      runtimeProfile: request.runtimeProfile,
      model: options.model,
      maxSteps: options.maxSteps ?? 12,
      effort,
    }, events);
    run = loop.run({
      system: renderSystemPrompt(request),
      prompt: renderUserPrompt(request),
      tools,
      terminalToolSet: request.terminalToolSet,
      maxSteps: options.maxSteps ?? 12,
      effort,
      runtimeOptions: runtimeOptionsForWorker(request, runtime),
    });
    logAgentLoopEvent(request, "loop.created", runStartedAt, {}, events);
    const eventsDone = logLoopEvents(request, run, runStartedAt, events);
    logAgentLoopEvent(request, "result.await", runStartedAt, {}, events);
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
    }, events);

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
      events,
    };
  };
}

async function logLoopEvents(
  request: AgentRunRequest,
  run: AsyncIterable<unknown>,
  runStartedAt: number,
  events: JsonValue[],
): Promise<void> {
  try {
    for await (const event of run) {
      logLoopEvent(request, event, runStartedAt, events);
    }
  } catch (error) {
    logAgentLoopEvent(request, "event_stream_error", runStartedAt, {
      error: errorMessage(error),
    }, events);
  }
}

function logLoopEvent(
  request: AgentRunRequest,
  event: unknown,
  runStartedAt: number,
  events: JsonValue[],
): void {
  const record = toRecord(event);
  const type = stringOr(record.type, "unknown");
  switch (type) {
    case "step":
      logAgentLoopEvent(request, "step", runStartedAt, {
        phase: record.phase,
        index: record.index,
      }, events);
      break;
    case "tool_call_start":
      logAgentLoopEvent(request, "tool_call_start", runStartedAt, {
        name: record.name,
        callId: record.callId,
        args: truncateJson(record.args),
      }, events);
      break;
    case "tool_call_end":
      logAgentLoopEvent(request, "tool_call_end", runStartedAt, {
        name: record.name,
        callId: record.callId,
        durationMs: record.durationMs,
        error: record.error,
        result: truncateJson(record.result),
      }, events);
      break;
    case "usage":
      logAgentLoopEvent(request, "usage", runStartedAt, {
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        activeTokens: record.activeTokens,
        totalTokens: record.totalTokens,
        cacheReadTokens: record.cacheReadTokens,
        cacheCreationTokens: record.cacheCreationTokens,
        usedRatio: record.usedRatio,
        source: record.source,
      }, events);
      break;
    case "thinking":
    case "text":
      if (shouldLogVerboseText()) {
        logAgentLoopEvent(request, type, runStartedAt, {
          chars: stringOr(record.text, "").length,
          text: truncateText(stringOr(record.text, ""), 400),
        }, events);
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
      }, events);
      break;
    case "error":
      logAgentLoopEvent(request, "error", runStartedAt, {
        error: errorMessage(record.error),
      }, events);
      break;
    default:
      logAgentLoopEvent(request, type, runStartedAt, {
        event: truncateJson(record),
      }, events);
      break;
  }
}

function logAgentLoopEvent(
  request: AgentRunRequest,
  event: string,
  runStartedAt: number,
  fields: Record<string, unknown>,
  events?: JsonValue[],
): void {
  const record = {
    ts: new Date().toISOString(),
    source: "agent-loop",
    event,
    elapsedMs: Math.round(performance.now() - runStartedAt),
    objective: request.objective,
    terminalToolSet: request.terminalToolSet,
    ...fields,
  };
  events?.push(toJsonValue(record));
  console.error(JSON.stringify(record));
}

function createLoop(options: AgentLoopWorkerOptions): AgentLoop {
  const provider = options.provider ?? "deepseek";
  const runtime = resolveRuntime(options);
  switch (provider) {
    case "deepseek":
      if (runtime === "claude-code") {
        return claudeCodeLoop({ provider: createProvider(options) });
      }
      return aiSdkLoop({ provider: createProvider(options) });
    case "kimi":
      if (runtime === "claude-code") {
        return claudeCodeLoop({ provider: createProvider(options) });
      }
      throw new Error(
        "Kimi Code does not support the ai-sdk runtime without client allowlist onboarding.",
      );
    case "claude":
      return claudeCodeLoop({ provider: createProvider(options) });
    case "codex":
      return codexLoop({});
    case "cursor":
      return cursorLoop({});
  }
}

function resolveRuntime(options: AgentLoopWorkerOptions): "ai-sdk" | "claude-code" | "codex" | "cursor" {
  return options.runtime ?? "ai-sdk";
}

function createProvider(options: AgentLoopWorkerOptions): ModelProvider {
  switch (options.provider ?? "deepseek") {
    case "deepseek":
      return deepseek({ model: options.model ?? "deepseek-v4-flash" });
    case "kimi":
      return kimi({});
    case "claude":
      return anthropic({ model: options.model ?? "claude-sonnet-4-20250514" });
    case "codex":
      // codexLoop handles its own provider
      return anthropic({});
    case "cursor":
      return anthropic({});
  }
}

export function runtimeOptionsForWorker(
  request: AgentRunRequest,
  runtime: "ai-sdk" | "claude-code" | "codex" | "cursor",
): Record<string, unknown> | undefined {
  if (runtime === "ai-sdk") {
    // Do not force toolChoice — some ai-sdk providers (DeepSeek) reject it.
    // The engine's Ralph loop handles missing terminal tools via retry.
    return undefined;
  }

  if (runtime !== "claude-code") {
    return undefined;
  }

  const workspaceOptions = runtimeWorkspaceOptionsForWorker(request);
  const readonlyDisallowedTools = isReadOnlyRequest(request) ? READONLY_MUTATION_BUILTIN_TOOLS : [];

  if (request.runtimeProfile === "code") {
    return {
      ...workspaceOptions,
      permissionMode: "bypassPermissions",
      dangerouslyDisableSandbox: true,
      systemPromptPreset: "claude_code",
      builtinTools: { type: "preset", preset: "claude_code" },
      disallowedTools: uniqueStrings([...ORCHESTRATION_ESCAPE_TOOLS, ...readonlyDisallowedTools]),
      env: {
        CLAUDE_SESSION_ENV_DIR: "/tmp/siko-sessions",
      },
    };
  }

  return {
    ...workspaceOptions,
    permissionMode: "bypassPermissions",
    systemPromptPreset: "custom",
    builtinTools: { type: "preset", preset: "claude_code" },
    disallowedTools: uniqueStrings([...GENERAL_BUILTIN_DENY_TOOLS, ...readonlyDisallowedTools]),
  };
}

function runtimeWorkspaceOptionsForWorker(request: AgentRunRequest): Record<string, unknown> {
  const input = toRecord(request.input);
  const surface = toRecord(input.workspace_surface);
  const gitWorktreePath = stringOr(surface.git_worktree_path, "").trim();
  const fileSystemRootPath = stringOr(surface.file_system_root_path, "").trim();
  const workspacePath = gitWorktreePath || fileSystemRootPath;
  if (workspacePath.length === 0) {
    return {};
  }

  return {
    cwd: workspacePath,
    allowedPaths: [workspacePath],
  };
}

function isReadOnlyRequest(request: AgentRunRequest): boolean {
  const input = toRecord(request.input);
  const node = toRecord(input.node);
  return node.allow_write !== true;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
  return toJsonValue(input);
}

function toJsonValue(input: unknown): JsonValue {
  return JSON.parse(JSON.stringify(input ?? null)) as JsonValue;
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
