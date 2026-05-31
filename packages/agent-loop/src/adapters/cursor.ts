import {
  Agent,
  Cursor,
  type AgentOptions,
  type McpServerConfig as CursorMcpServerConfig,
  type Run,
  type SDKAgent,
  type SDKMessage,
  type SendOptions,
  type SettingSource,
} from "@cursor/sdk";
import type {
  BackendAdapter,
  BackendResult,
  BackendRun,
  ResolvedRequest,
} from "../core/adapter";
import type { CapabilityList } from "../core/capabilities";
import { createEventChannel } from "../core/channel";
import { resolveContextWindow } from "../core/context-window";
import { resolveApiKey } from "../core/credentials";
import { estimateTokens, type LoopEvent, type TokenUsage } from "../core/events";
import type { McpServers, PreflightResult } from "../core/types";

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
  /** Model id, e.g. "composer-2". Defaults to "composer-2". */
  model?: string;
  /** Override the model's context-window size (tokens) for usage.usedRatio. */
  contextWindow?: number;
  /** Resume / target a specific Cursor agent id. */
  agentId?: string;
  /** Cursor local setting sources. Defaults to ["project"]. */
  settingSources?: SettingSource[];
  /** Working directory (single path or multiple allowed paths). */
  cwd?: string | string[];
  /** Toggle the Cursor local sandbox. */
  sandboxEnabled?: boolean;
  /** Extra instructions prepended to every prompt. */
  instructions?: string;
  /** When true, `preflight()` performs an online `Cursor.me` check. */
  preflightOnline?: boolean;
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
 * through from `req.mcp`. Cursor does not accept custom in-process tools and
 * has no pre-tool interception hook, so neither "tools" nor "hooks" is
 * declared. There is no live mid-turn follow-up, so steer is omitted.
 */
export class CursorAdapter implements BackendAdapter {
  readonly id = "cursor";
  readonly capabilities: CapabilityList = [
    "mcp",
    "thinking",
    "usage",
    "interrupt",
  ];

  private agentPromise: Promise<SDKAgent> | null = null;
  private agent: SDKAgent | null = null;

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
    const model = o.model ?? this.opts.model;
    const contextWindow = resolveContextWindow(model, this.opts.contextWindow);

    let activeRun: Run | null = null;
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

        const agent = await this.getAgent(req.mcp, o.agentId);
        if (abort.signal.aborted) throw new Error("Cursor run cancelled");

        const mcpServers = buildCursorMcpServers(req.mcp);
        const sendOptions: SendOptions = {
          ...(model ? { model: { id: model } } : {}),
          ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
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
        if (!cancelled) ch.push({ type: "error", error });
        ch.fail(error);
        rejectResult(error);
      } finally {
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
        void activeRun?.cancel();
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
    this.agent?.close();
    this.agent = null;
    this.agentPromise = null;
  }

  private getAgent(mcp: McpServers, agentId?: string): Promise<SDKAgent> {
    // A per-run agentId override forces a fresh agent so it is honored.
    if (agentId && this.agent && this.agent.agentId !== agentId) {
      this.agent.close();
      this.agent = null;
      this.agentPromise = null;
    }
    if (!this.agentPromise) {
      this.agentPromise = Agent.create(
        this.buildAgentOptions(mcp, agentId),
      ).then((agent) => {
        this.agent = agent;
        return agent;
      });
    }
    return this.agentPromise;
  }

  private buildAgentOptions(mcp: McpServers, agentId?: string): AgentOptions {
    const apiKey = this.resolveApiKey();
    const cwd = this.opts.cwd;
    const mcpServers = buildCursorMcpServers(mcp);

    return {
      ...(apiKey ? { apiKey } : {}),
      model: { id: this.opts.model ?? "composer-2" },
      local: {
        ...(cwd ? { cwd } : {}),
        settingSources: this.opts.settingSources ?? ["project"],
        ...(this.opts.sandboxEnabled !== undefined
          ? { sandboxOptions: { enabled: this.opts.sandboxEnabled } }
          : {}),
      },
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      ...(agentId ?? this.opts.agentId
        ? { agentId: (agentId ?? this.opts.agentId) as string }
        : {}),
    };
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

function mapAssistantMessage(
  message: Extract<SDKMessage, { type: "assistant" }>,
): LoopEvent[] {
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

function mapToolCallMessage(
  message: Extract<SDKMessage, { type: "tool_call" }>,
): LoopEvent[] {
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

function buildPrompt(
  system: string,
  prompt: string,
  instructions: string,
): string {
  return [instructions, system, prompt]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");
}

/** Convert the normalized `McpServers` into Cursor's native config shape. */
function buildCursorMcpServers(
  servers: McpServers,
): Record<string, CursorMcpServerConfig> {
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
