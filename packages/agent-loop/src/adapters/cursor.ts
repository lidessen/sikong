import { homedir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  Cursor,
  JsonlLocalAgentStore,
  type AgentOptions,
  type LocalAgentStore,
  type SDKCustomTool,
  type SDKJsonValue,
  type McpServerConfig as CursorMcpServerConfig,
  type Run,
  type SDKAgent,
  type SDKMessage,
  type SendOptions,
} from "@cursor/sdk";
import type { BackendAdapter, BackendResult, BackendRun, ResolvedRequest } from "../core/adapter";
import type { CapabilityList } from "../core/capabilities";
import { createEventChannel } from "../core/channel";
import { resolveContextWindow } from "../core/context-window";
import { resolveApiKey } from "../core/credentials";
import { estimateTokens, type LoopEvent, type TokenUsage } from "../core/events";
import type { McpServers, PreflightResult, ToolSet } from "../core/types";

/**
 * Adapter-construction options for the Cursor Agent SDK backend.
 *
 * Everything that varies *per run* (system / prompt / mcp / signal / hooks)
 * arrives through `ResolvedRequest` in `start()`. These options configure the
 * long-lived adapter / agent: model, working directory, sandbox, etc.
 */
export interface CursorAdapterOptions {
  /** Cursor API key. Falls back to `process.env.CURSOR_API_KEY`. */
  apiKey?: string;
  /** Model id. When omitted, Sikong asks Cursor to use its `default` model. */
  model?: string;
  /** Override the model's context-window size (tokens) for usage.usedRatio. */
  contextWindow?: number;
  /** Resume / target a specific Cursor agent id. */
  agentId?: string;
  /** Cursor local agent store. Defaults to a JSONL store under SIKONG_DATA_DIR. */
  store?: LocalAgentStore;
  /** Directory for the default JSONL Cursor local agent store. */
  storeDir?: string;
  /** Working directory (single path or multiple allowed paths). */
  cwd?: string | string[];
  /** Toggle the Cursor local sandbox. */
  sandboxEnabled?: boolean;
  /** Extra instructions prepended to every prompt. */
  instructions?: string;
  /** When true, `preflight()` performs an online `Cursor.me` check. */
  preflightOnline?: boolean;
}

export interface CursorModelOption {
  id: string;
  label: string;
  aliases?: string[];
}

/**
 * Per-run escape hatch for Cursor-native options (`req.runtimeOptions`). Lets a
 * caller override the model or inject extra instructions for a single run
 * without reconstructing the adapter.
 */
export interface CursorRuntimeOptions {
  /** Override the model id for this run only. */
  model?: string;
  /** Override the agent id for this run only (forces a fresh agent). */
  agentId?: string;
  /** Extra instructions prepended ahead of the constructor `instructions`. */
  instructions?: string;
}

/**
 * Cursor Agent SDK backend.
 *
 * Cursor reports no native token usage, so `usage` is emitted with
 * `source:"estimate"` via {@link estimateTokens}. MCP servers are passed
 * through from `req.mcp`. Custom tools from `req.tools` are passed through
 * Cursor's native `local.customTools` support. There is no pre-tool
 * interception hook, so "hooks" is not declared.
 */
export class CursorAdapter implements BackendAdapter {
  readonly id = "cursor";
  readonly capabilities: CapabilityList = ["tools", "mcp", "thinking", "usage", "interrupt"];

  private agentPromise: Promise<SDKAgent> | null = null;
  private agent: SDKAgent | null = null;
  private localStore: LocalAgentStore | null = null;

  constructor(private readonly opts: CursorAdapterOptions = {}) {}

  start(req: ResolvedRequest): BackendRun {
    const o = (req.runtimeOptions ?? {}) as CursorRuntimeOptions;
    const ch = createEventChannel<LoopEvent>();
    const abort = new AbortController();
    const startedAt = Date.now();

    // Mirror the caller's signal onto our internal controller.
    if (req.signal) {
      if (req.signal.aborted) abort.abort();
      else req.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }

    const instructions = [o.instructions, this.opts.instructions]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n\n");
    const prompt = buildPrompt(req.system, req.prompt, instructions);
    const model = resolveCursorModelId(o.model ?? this.opts.model);
    const contextWindow = resolveContextWindow(model, this.opts.contextWindow);

    let activeRun: Run | null = null;
    let ownedAgent: SDKAgent | null = null;
    let stopRequested = false;
    let cancelled = false;

    let resolveResult!: (r: BackendResult) => void;
    let rejectResult!: (err: Error) => void;
    const result = new Promise<BackendResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    let outputText = "";
    const run = async () => {
      try {
        if (abort.signal.aborted) throw new Error("Cursor run cancelled");

        ch.push({ type: "step", phase: "start", index: 0 });

        const acquired = await this.acquireAgent(req.mcp, o.agentId);
        const agent = acquired.agent;
        ownedAgent = acquired.closeAfterRun ? agent : null;
        if (abort.signal.aborted) throw new Error("Cursor run cancelled");

        const mcpServers = buildCursorMcpServers(req.mcp);
        const requestStop = () => {
          stopRequested = true;
        };

        const sendOptions: SendOptions = {
          ...(model ? { model: { id: model } } : {}),
          ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
          ...(Object.keys(req.tools).length > 0
            ? {
                local: {
                  customTools: buildCursorCustomTools(req.tools, abort.signal, requestStop),
                },
              }
            : {}),
          onStep: () => {
            if (stopRequested) void cancelCursorRun(activeRun);
          },
        };

        const cursorRun = await agent.send(prompt, sendOptions);
        activeRun = cursorRun;

        if (abort.signal.aborted) {
          await cursorRun.cancel();
          throw new Error("Cursor run cancelled");
        }

        for await (const message of cursorRun.stream() as AsyncGenerator<SDKMessage>) {
          if (abort.signal.aborted) {
            await cursorRun.cancel();
            throw new Error("Cursor run cancelled");
          }
          for (const event of mapCursorMessage(message)) {
            if (event.type === "text" || event.type === "thinking") {
              outputText += event.text;
            }
            ch.push(event);
          }
        }

        const usage = estimateUsage(prompt, outputText);
        ch.push({ type: "usage", ...usage, source: "estimate" });

        ch.push({ type: "step", phase: "end", index: 0 });
        ch.end();
        resolveResult({ usage, durationMs: Date.now() - startedAt });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (cancelled || isCursorExpectedCancellationError(error)) {
          const usage = estimateUsage(prompt, outputText);
          ch.push({ type: "usage", ...usage, source: "estimate" });
          ch.end();
          resolveResult({ usage, durationMs: Date.now() - startedAt });
          return;
        }
        if (!cancelled) ch.push({ type: "error", error });
        ch.fail(error);
        rejectResult(error);
      } finally {
        if (ownedAgent) await closeCursorAgent(ownedAgent);
        activeRun = null;
      }
    };

    void run();

    return {
      [Symbol.asyncIterator]: () => ch.iterable[Symbol.asyncIterator](),
      result,
      contextWindow,
      cancel: (_reason?: string) => {
        cancelled = true;
        abort.abort();
        void cancelCursorRun(activeRun);
      },
    };
  }

  async preflight(): Promise<PreflightResult> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      return {
        ok: false,
        reason: "Cursor SDK requires CURSOR_API_KEY.",
        missingEnv: ["CURSOR_API_KEY"],
      };
    }

    const explicitModel = this.opts.model?.trim();
    const modelToValidate = explicitModel ? resolveCursorModelId(explicitModel) : undefined;
    if (modelToValidate) {
      try {
        const models = await Cursor.models.list({ apiKey });
        if (!cursorModelListIncludes(models, modelToValidate)) {
          return {
            ok: false,
            reason: `Cursor model "${explicitModel}" is not available. Clear the model field to use Cursor default, or choose one from Cursor.models.list().`,
          };
        }
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (this.opts.preflightOnline) {
      try {
        await Cursor.me({ apiKey });
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { ok: true };
  }

  async dispose(): Promise<void> {
    await closeCursorAgent(this.agent);
    this.agent = null;
    this.agentPromise = null;
  }

  private async acquireAgent(
    mcp: McpServers,
    agentId?: string,
  ): Promise<{ agent: SDKAgent; closeAfterRun: boolean }> {
    const persistentAgentId = agentId ?? this.opts.agentId;
    if (!persistentAgentId) {
      return {
        agent: await Agent.create(this.buildAgentOptions(mcp)),
        closeAfterRun: true,
      };
    }

    if (this.agent && this.agent.agentId !== persistentAgentId) {
      void closeCursorAgent(this.agent);
      this.agent = null;
      this.agentPromise = null;
    }
    if (!this.agentPromise) {
      this.agentPromise = Agent.create(this.buildAgentOptions(mcp, persistentAgentId)).then(
        (agent) => {
          this.agent = agent;
          return agent;
        },
      );
    }
    return { agent: await this.agentPromise, closeAfterRun: false };
  }

  private buildAgentOptions(mcp: McpServers, agentId?: string): AgentOptions {
    const apiKey = this.resolveApiKey();
    const cwd = this.opts.cwd;
    const mcpServers = buildCursorMcpServers(mcp);

    return {
      ...(apiKey ? { apiKey } : {}),
      model: { id: resolveCursorModelId(this.opts.model) },
      local: {
        ...(cwd ? { cwd } : {}),
        store: this.resolveLocalStore(),
        settingSources: [],
        ...(this.opts.sandboxEnabled !== undefined
          ? { sandboxOptions: { enabled: this.opts.sandboxEnabled } }
          : {}),
      },
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      ...((agentId ?? this.opts.agentId)
        ? { agentId: (agentId ?? this.opts.agentId) as string }
        : {}),
    };
  }

  private resolveLocalStore(): LocalAgentStore {
    if (this.opts.store) return this.opts.store;
    this.localStore ??= new JsonlLocalAgentStore(
      this.opts.storeDir ?? defaultCursorLocalStoreDir(),
    );
    return this.localStore;
  }

  // Explicit key wins; else auto-discover CURSOR_API_KEY, gated by the same
  // global `autoDiscover` switch as providers. required:false — a missing key
  // surfaces via preflight, not a throw here.
  private resolveApiKey(): string | undefined {
    return resolveApiKey({
      providerId: "cursor",
      explicit: this.opts.apiKey,
      envVars: ["CURSOR_API_KEY"],
      required: false,
    });
  }
}

function defaultCursorLocalStoreDir(): string {
  const dataDir = process.env.SIKONG_DATA_DIR?.trim() || join(homedir(), ".sikong");
  return join(dataDir, "state", "cursor-agent-store");
}

/**
 * Translate one Cursor SDK message into normalized LoopEvents. Mirrors the
 * reference `mapCursorMessage` exactly.
 */
export function mapCursorMessage(message: SDKMessage): LoopEvent[] {
  switch (message.type) {
    case "assistant":
      return mapAssistantMessage(message);
    case "thinking":
      return message.text ? [{ type: "thinking", text: message.text }] : [];
    case "tool_call":
      return mapToolCallMessage(message);
    case "status":
      if (message.status === "ERROR") {
        return [
          {
            type: "error",
            error: new Error(message.message ?? "Cursor run failed"),
          },
        ];
      }
      return [];
    case "task":
      return message.text ? [{ type: "text", text: message.text }] : [];
    default:
      return [];
  }
}

function mapAssistantMessage(message: Extract<SDKMessage, { type: "assistant" }>): LoopEvent[] {
  const events: LoopEvent[] = [];
  for (const block of message.message.content ?? []) {
    if (block.type === "text" && block.text) {
      events.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      events.push({
        type: "tool_call_start",
        name: block.name,
        callId: block.id,
        args: isRecord(block.input) ? block.input : { input: block.input },
      });
    }
  }
  return events;
}

function mapToolCallMessage(message: Extract<SDKMessage, { type: "tool_call" }>): LoopEvent[] {
  if (message.status === "running") {
    return [
      {
        type: "tool_call_start",
        name: message.name,
        callId: message.call_id,
        ...(isRecord(message.args) ? { args: message.args } : {}),
      },
    ];
  }

  return [
    {
      type: "tool_call_end",
      name: message.name,
      callId: message.call_id,
      result: message.result,
      ...(message.status === "error"
        ? { error: String(message.result ?? "Cursor tool call failed") }
        : {}),
    },
  ];
}

function buildPrompt(system: string, prompt: string, instructions: string): string {
  return [instructions, system, prompt]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");
}

/** Convert the normalized `McpServers` into Cursor's native config shape. */
function buildCursorMcpServers(servers: McpServers): Record<string, CursorMcpServerConfig> {
  const converted: Record<string, CursorMcpServerConfig> = {};

  for (const [name, raw] of Object.entries(servers ?? {})) {
    if (!raw) continue;

    if (typeof raw.command === "string") {
      converted[name] = {
        type: "stdio",
        command: raw.command,
        ...(Array.isArray(raw.args) ? { args: raw.args } : {}),
        ...(isStringRecord(raw.env) ? { env: raw.env } : {}),
      };
      continue;
    }

    if (typeof raw.url === "string") {
      const headers = {
        ...(isStringRecord(raw.headers) ? raw.headers : {}),
        ...bearerHeaderFromEnv(raw.bearerTokenEnvVar),
      };
      converted[name] = {
        type: raw.type === "sse" ? "sse" : "http",
        url: raw.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    }
  }

  return converted;
}

function bearerHeaderFromEnv(value: unknown): Record<string, string> {
  if (typeof value !== "string") return {};
  const token = process.env[value];
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function estimateUsage(input: string, output: string): TokenUsage {
  const inputTokens = estimateTokens(input);
  const outputTokens = estimateTokens(output);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string");
}

export function buildCursorCustomTools(
  tools: ToolSet,
  signal?: AbortSignal,
  requestStop?: (reason?: string) => void,
): Record<string, SDKCustomTool> {
  const converted: Record<string, SDKCustomTool> = {};
  for (const [name, def] of Object.entries(tools)) {
    converted[name] = {
      description: def.description ?? "",
      inputSchema: toCursorInputSchema(def.inputSchema),
      execute: async (args, ctx) => {
        const result = await def.execute?.(args, {
          signal,
          callId: ctx.toolCallId,
          requestStop,
        });
        return toCursorToolResult(result);
      },
    };
  }
  return converted;
}

function toCursorInputSchema(value: unknown): Record<string, SDKJsonValue> {
  if (!isRecord(value)) return {};
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    return isRecord(cloned) && isSdkJsonValue(cloned)
      ? (cloned as Record<string, SDKJsonValue>)
      : {};
  } catch {
    return {};
  }
}

function toCursorToolResult(value: unknown): SDKJsonValue {
  if (value === undefined) return null;
  if (isSdkJsonValue(value)) return value;
  return JSON.parse(JSON.stringify(value)) as SDKJsonValue;
}

function isSdkJsonValue(value: unknown): value is SDKJsonValue {
  if (value === null) return true;
  if (["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isSdkJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isSdkJsonValue);
}

/* -------------------------------------------------------------------------- */
/* Legacy MCP request helper retained for adapter-level protocol tests.        */
/* Runtime tool delivery uses Cursor native local.customTools above.           */
/* -------------------------------------------------------------------------- */

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export async function handleMcpRequest(
  msg: JsonRpcMessage,
  tools: ToolSet,
): Promise<JsonRpcMessage | undefined> {
  const base = { jsonrpc: "2.0" as const, id: msg.id };

  if (msg.method === "initialize") {
    return {
      ...base,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "agent-loop-tools",
          version: "0.1.0",
        },
      },
    };
  }

  if (msg.method === "notifications/initialized") return undefined;

  if (msg.method === "ping") {
    return { ...base, result: {} };
  }

  if (msg.method === "tools/list") {
    const toolList = Object.entries(tools).map(([name, def]) => ({
      name,
      description: def.description ?? "",
      inputSchema: def.inputSchema ?? {},
    }));
    return { ...base, result: { tools: toolList } };
  }

  if (msg.method === "tools/call") {
    const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = params.name;
    if (!name || !tools[name]) {
      return {
        ...base,
        error: { code: -32602, message: `Unknown tool: "${name ?? "undefined"}"` },
      };
    }
    const toolDef = tools[name]!;
    try {
      const result = await toolDef.execute?.(params.arguments ?? {}, {
        callId: typeof msg.id === "string" ? msg.id : msg.id?.toString(),
      });
      const content = typeof result === "string" ? result : JSON.stringify(result ?? null);
      return { ...base, result: { content: [{ type: "text", text: content }] } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        result: { content: [{ type: "text", text: `Error: ${msg}` }], isError: true },
      };
    }
  }

  return { ...base, error: { code: -32601, message: `Method not found: ${msg.method}` } };
}

async function closeCursorAgent(agent: SDKAgent | null): Promise<void> {
  try {
    await Promise.resolve(agent?.close());
  } catch {
    // Cursor SDK close can surface transport shutdown errors after a successful run.
  }
}

async function cancelCursorRun(run: Run | null): Promise<void> {
  try {
    await run?.cancel();
  } catch {
    // Cancellation is best-effort; the main run loop observes the abort signal.
  }
}

function isCursorExpectedCancellationError(value: unknown): boolean {
  return value instanceof Error && value.message === "Cursor run cancelled";
}

export function resolveCursorModelId(model: string | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "auto") return "default";
  return trimmed;
}

export async function discoverCursorModels(
  options: { apiKey?: string } = {},
): Promise<CursorModelOption[]> {
  const apiKey = resolveApiKey({
    providerId: "cursor",
    explicit: options.apiKey,
    envVars: ["CURSOR_API_KEY"],
    required: false,
  });
  if (!apiKey) return [];
  const models = await Cursor.models.list({ apiKey });
  return models.map((model) => ({
    id: model.id,
    label: model.displayName || model.id,
    ...(model.aliases?.length ? { aliases: model.aliases } : {}),
  }));
}

function cursorModelListIncludes(
  models: Array<{ id: string; aliases?: string[] }>,
  modelId: string,
): boolean {
  return models.some((model) => model.id === modelId || model.aliases?.includes(modelId));
}
