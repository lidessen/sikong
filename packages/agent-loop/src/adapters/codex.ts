import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { execa } from "execa";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AdapterHookBridge,
  BackendAdapter,
  BackendResult,
  BackendRun,
  ResolvedRequest,
} from "../core/adapter";
import type { CapabilityList } from "../core/capabilities";
import { createEventChannel } from "../core/channel";
import { resolveContextWindow } from "../core/context-window";
import { estimateTokens, type LoopEvent } from "../core/events";
import type { EffortLevel, McpServers, PreflightResult, ToolSet } from "../core/types";

/**
 * Construction-time options for the Codex adapter. Everything here configures
 * how the `codex app-server` subprocess is launched and how the conversation /
 * thread is configured — it is NOT per-run input (that arrives via
 * `ResolvedRequest`).
 */
export interface CodexAdapterOptions {
  model?: string;
  /** Override the model's context-window size (tokens) for usage.usedRatio. */
  contextWindow?: number;
  cwd?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /**
   * When true, auto-approve exec/patch/permission requests and set
   * `approvalPolicy="never"`. When false, requests are declined unless an
   * `approvalsReviewer` is provided.
   */
  fullAuto?: boolean;
  /**
   * Forwarded as the `approvalsReviewer` param to the codex thread. Codex itself
   * consumes this; the adapter passes it through untouched.
   */
  approvalsReviewer?: unknown;
  serviceTier?: string;
  effort?: "minimal" | "low" | "medium" | "high";
  summary?: "auto" | "concise" | "detailed" | "none";
  /** Extra environment variables for the subprocess (merged over process.env). */
  env?: Record<string, string>;
  /** Reject pending requests after this many ms of stream silence (0 = disabled). */
  idleTimeout?: number;
  /** Base instructions forwarded to the codex thread (separate from req.system). */
  instructions?: string;
  /** Provider-injected `-c` overrides defining + selecting a custom provider. */
  providerOverrides?: string[];
  /** Provider-injected child env (holds the api key under its env_key). */
  providerEnv?: Record<string, string>;
  /** Provider-injected default model id. */
  providerModel?: string;
  /** True when a provider supplied credentials — preflight then trusts it. */
  hasInjectedProvider?: boolean;
}

/**
 * Per-run escape hatch carried on `req.runtimeOptions`.
 */
export interface CodexRuntimeOptions {
  /** Resume an existing thread by id. */
  threadId?: string;
  /** Path to a previously persisted thread id (read-only here). */
  threadIdFile?: string;
  /** Structured-output schema to request from Codex. */
  outputSchema?: unknown;
  /** Raw sandbox policy object passed straight through to `turn/start`. */
  sandboxPolicy?: unknown;
}

/* -------------------------------------------------------------------------- */
/* MCP -> codex `-c` config overrides (reimplements buildCodexMcpOverrides)    */
/* -------------------------------------------------------------------------- */

/** Quote a TOML key if it contains characters outside bare-key range. */
function quoteTomlKey(key: string): string {
  if (isBareTomlKey(key)) return key;
  return `"${escapeToml(key)}"`;
}

function isBareTomlKey(key: string): boolean {
  if (!key) return false;
  for (let index = 0; index < key.length; index += 1) {
    if (!isBareTomlKeyChar(key.charCodeAt(index))) return false;
  }
  return true;
}

function isBareTomlKeyChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 45 ||
    code === 95 ||
    (code >= 97 && code <= 122)
  );
}

/** Escape a string for use inside a TOML basic (double-quoted) string. */
function escapeToml(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Translate normalized MCP server configs into `-c mcp_servers.<name>....` CLI
 * flags, matching agent-worker's buildCodexMcpOverrides. SSE transport is not
 * supported by Codex MCP and is rejected.
 */
function buildCodexMcpOverrides(servers: McpServers): string[] {
  const flags: string[] = [];

  for (const [name, server] of Object.entries(servers)) {
    const key = quoteTomlKey(name);

    if (server.type === "sse") {
      throw new Error(
        `Codex MCP does not support SSE transport for server "${name}"`,
      );
    }

    if (server.url || server.type === "http") {
      flags.push("-c", `mcp_servers.${key}.type="http"`);
      if (server.url) {
        flags.push("-c", `mcp_servers.${key}.url="${escapeToml(server.url)}"`);
      }
      if (server.bearerTokenEnvVar) {
        flags.push(
          "-c",
          `mcp_servers.${key}.bearer_token_env_var="${escapeToml(
            server.bearerTokenEnvVar,
          )}"`,
        );
      }
    } else if (server.command) {
      flags.push("-c", `mcp_servers.${key}.type="stdio"`);
      flags.push(
        "-c",
        `mcp_servers.${key}.command="${escapeToml(server.command)}"`,
      );
      if (server.args?.length) {
        const tomlArray =
          "[" + server.args.map((a) => `"${escapeToml(a)}"`).join(", ") + "]";
        flags.push("-c", `mcp_servers.${key}.args=${tomlArray}`);
      }
      if (server.env && Object.keys(server.env).length > 0) {
        const entries = Object.entries(server.env).map(
          ([envKey, envValue]) =>
            `${quoteTomlKey(envKey)}="${escapeToml(envValue)}"`,
        );
        flags.push("-c", `mcp_servers.${key}.env={${entries.join(", ")}}`);
      }
    }
  }

  return flags;
}

/* -------------------------------------------------------------------------- */
/* Minimal JSON-RPC over stdio client (ported inline from jsonrpc-stdio.ts)    */
/* -------------------------------------------------------------------------- */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcStdioClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stderr?: (data: string) => void;
  handleRequest?: (request: JsonRpcRequest) => unknown | Promise<unknown>;
}

class JsonRpcStdioClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private stdoutBuf = "";
  private closed = false;
  private onNotification: ((message: JsonRpcNotification) => void) | null = null;

  constructor(private readonly options: JsonRpcStdioClientOptions) {}

  start(onNotification: (message: JsonRpcNotification) => void): void {
    if (this.proc) return;
    this.onNotification = onNotification;

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env };
    delete env.CLAUDECODE;

    this.proc = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk: string) => {
      this.stdoutBuf += chunk;
      let newline = this.stdoutBuf.indexOf("\n");
      while (newline >= 0) {
        const line = this.stdoutBuf.slice(0, newline).trim();
        this.stdoutBuf = this.stdoutBuf.slice(newline + 1);
        if (line) this.handleMessage(line);
        newline = this.stdoutBuf.indexOf("\n");
      }
    });

    this.proc.stderr.on("data", (chunk: string) => {
      this.options.stderr?.(chunk);
    });

    this.proc.on("error", (err) => {
      this.rejectAll(err instanceof Error ? err : new Error(String(err)));
    });

    this.proc.on("exit", (code, signal) => {
      const reason =
        code === 0
          ? new Error("codex app-server exited")
          : new Error(
              `codex app-server exited with code ${code ?? "null"} signal ${
                signal ?? "null"
              }`,
            );
      this.rejectAll(reason);
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.proc || this.closed) {
      return Promise.reject(new Error("codex app-server is not running"));
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
    return result;
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc || this.closed) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.proc = null;
    }
    this.rejectAll(new Error("codex app-server client closed"));
  }

  private handleMessage(line: string): void {
    let parsed: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as
        | JsonRpcResponse
        | JsonRpcNotification
        | JsonRpcRequest;
    } catch {
      return;
    }

    // Server -> client request: has both id and method.
    if ("id" in parsed && "method" in parsed) {
      void this.handleServerRequest(parsed as JsonRpcRequest);
      return;
    }

    // Response to one of our requests: has id, no method.
    if ("id" in parsed) {
      const response = parsed as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(
          new Error(
            response.error.message ?? `JSON-RPC error ${response.error.code ?? ""}`,
          ),
        );
      } else {
        pending.resolve(response.result);
      }
      return;
    }

    // Notification: method, no id.
    if ("method" in parsed) {
      this.onNotification?.(parsed as JsonRpcNotification);
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    try {
      if (!this.options.handleRequest) {
        this.writeResponse({
          id: request.id,
          error: {
            code: -32601,
            message: `Unhandled server request: ${request.method}`,
          },
        });
        return;
      }
      const result = await this.options.handleRequest(request);
      this.writeResponse({ id: request.id, result });
    } catch (err) {
      this.writeResponse({
        id: request.id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private writeResponse(response: JsonRpcResponse): void {
    if (!this.proc || this.closed) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...response }) + "\n");
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }
}

/* Codex app-server callback responses */

/* -------------------------------------------------------------------------- */
/* Native item -> LoopEvent mapping                                            */
/* -------------------------------------------------------------------------- */

function mapCodexItemStart(item: Record<string, unknown>): LoopEvent | null {
  switch (item.type) {
    case "mcpToolCall":
    case "dynamicToolCall":
      return {
        type: "tool_call_start",
        name: String(item.tool ?? "unknown"),
        callId: String(item.id ?? ""),
        args: (item.arguments as Record<string, unknown> | undefined) ?? {},
      };
    case "commandExecution":
      return {
        type: "tool_call_start",
        name: "shell",
        callId: String(item.id ?? ""),
        args: { command: item.command, cwd: item.cwd },
      };
    case "fileChange":
      return {
        type: "tool_call_start",
        name: "apply_patch",
        callId: String(item.id ?? ""),
      };
    default:
      return null;
  }
}

function mapCodexItemEnd(item: Record<string, unknown>): LoopEvent | null {
  switch (item.type) {
    case "mcpToolCall":
      return {
        type: "tool_call_end",
        name: String(item.tool ?? "unknown"),
        callId: String(item.id ?? ""),
        result: item.error ? null : (item.result ?? null),
        durationMs:
          typeof item.durationMs === "number" ? item.durationMs : undefined,
        error: item.error ? JSON.stringify(item.error) : undefined,
      };
    case "dynamicToolCall":
      return {
        type: "tool_call_end",
        name: String(item.tool ?? "unknown"),
        callId: String(item.id ?? ""),
        result: item.contentItems ?? null,
        durationMs:
          typeof item.durationMs === "number" ? item.durationMs : undefined,
        error: item.success === false ? "dynamic tool call failed" : undefined,
      };
    case "commandExecution":
      return {
        type: "tool_call_end",
        name: "shell",
        callId: String(item.id ?? ""),
        result: item.aggregatedOutput ?? "",
        durationMs:
          typeof item.durationMs === "number" ? item.durationMs : undefined,
        error:
          item.status === "failed"
            ? `command failed (${item.exitCode ?? "unknown"})`
            : undefined,
      };
    case "fileChange":
      return {
        type: "tool_call_end",
        name: "apply_patch",
        callId: String(item.id ?? ""),
        result: item.changes ?? [],
        error:
          item.status && item.status !== "applied"
            ? String(item.status)
            : undefined,
      };
    default:
      return null;
  }
}

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Map generic EffortLevel to Codex's native effort values. Codex has no "max"
 * level — "high" is the ceiling; "low" maps to "minimal" (codex's rote tier).
 */
function codexEffort(level: EffortLevel | undefined): CodexAdapterOptions["effort"] | undefined {
  if (!level) return undefined;
  switch (level) {
    case "low":
      return "minimal";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "high";
  }
}

/**
 * Drives the Codex `app-server` CLI over JSON-RPC/stdio and normalizes its
 * notifications into the shared LoopEvent stream.
 *
 * Capabilities:
 *  - "mcp": req.mcp is translated into `-c mcp_servers.*` config overrides.
 *  - "steer.live": a steer message is injected into the running turn via
 *    `turn/steer`, applied mid-turn.
 *  - "thinking": reasoning deltas surface as `thinking` events.
 *  - "usage": `thread/tokenUsage/updated` surfaces as runtime `usage` events.
 *  - "interrupt": cancel() sends `turn/interrupt` and closes the client.
 *
 * Capabilities:
 *  - "tools": `req.tools` are registered on turn/start and their calls are
 *    handled via `item/tool/call` — the adapter executes the tool's `execute`
 *    function and returns the result. MCP tools still route through the
 *    `-c mcp_servers.*` path below.
 *  - "hooks": pre-tool interception via `req.hooks.toolUse()`, for the
 *    `onToolUse` deny/replace-args lifecycle.
 *  - "mcp": req.mcp is translated into `-c mcp_servers.*` config overrides.
 *  - "steer.live": a steer message is injected into the running turn via
 *    `turn/steer`, applied mid-turn.
 *  - "thinking": reasoning deltas surface as `thinking` events.
 *  - "usage": `thread/tokenUsage/updated` surfaces as runtime `usage` events.
 *  - "interrupt": cancel() sends `turn/interrupt` and closes the client.
 *
 * Codex's own approval RPCs are answered by `handleCodexRequest` based on
 * `fullAuto`.
 */
export class CodexAdapter implements BackendAdapter {
  readonly id = "codex";
  readonly capabilities: CapabilityList = [
    "tools",
    "mcp",
    "hooks",
    "steer.live",
    "thinking",
    "usage",
    "interrupt",
  ];

  private clients = new Set<JsonRpcStdioClient>();

  private currentTurn: {
    client: JsonRpcStdioClient;
    threadId: string;
    turnId: string;
  } | null = null;

  constructor(private readonly opts: CodexAdapterOptions = {}) {}

  start(req: ResolvedRequest): BackendRun {
    const o = (req.runtimeOptions ?? {}) as CodexRuntimeOptions;
    const contextWindow = resolveContextWindow(
      this.opts.model ?? this.opts.providerModel,
      this.opts.contextWindow,
    );
    const ch = createEventChannel<LoopEvent>();
    const startedAt = Date.now();

    let resolveResult!: (r: BackendResult) => void;
    let rejectResult!: (e: Error) => void;
    const result = new Promise<BackendResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    let usage: TurnUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let sawUsage = false;
    let textCharCount = 0;

    let client: JsonRpcStdioClient | null = null;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let settled = false;

    // Resolved/rejected when the turn finishes (turn/completed or error).
    let resolveDone!: () => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) ch.push({ type: "error", error: err });

      ch.push({ type: "step", phase: "end", index: 0 });

      if (!sawUsage) {
        const turnText = req.system
          ? `${req.system}\n\n${req.prompt}`
          : req.prompt;
        const inputTokens = estimateTokens(turnText);
        const outputTokens = estimateTokens("x".repeat(textCharCount));
        usage = {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
        ch.push({
          type: "usage",
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          source: "estimate",
        });
      }

      ch.end();
      const durationMs = Date.now() - startedAt;
      if (err) rejectResult(err);
      else resolveResult({ usage, durationMs });

      this.currentTurn = null;
      if (client) {
        client.close();
        this.clients.delete(client);
      }
    };

    const handleNotification = (message: JsonRpcNotification): void => {
      const method = message.method;
      const params = (message.params ?? {}) as Record<string, unknown>;
      // Only process notifications belonging to the active turn.
      if (turnId !== undefined && params.turnId !== undefined && params.turnId !== turnId) {
        return;
      }

      switch (method) {
        case "item/agentMessage/delta": {
          const delta = params.delta as string | undefined;
          if (delta) {
            textCharCount += delta.length;
            ch.push({ type: "text", text: delta });
          }
          return;
        }
        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta": {
          const delta = params.delta as string | undefined;
          if (delta) {
            textCharCount += delta.length;
            ch.push({ type: "thinking", text: delta });
          }
          return;
        }
        case "item/started": {
          const item = params.item as Record<string, unknown> | undefined;
          if (item) {
            const ev = mapCodexItemStart(item);
            if (ev) ch.push(ev);
          }
          return;
        }
        case "item/completed": {
          const item = params.item as Record<string, unknown> | undefined;
          if (item) {
            const ev = mapCodexItemEnd(item);
            if (ev) ch.push(ev);
          }
          return;
        }
        case "thread/tokenUsage/updated": {
          const tokenUsage = params.tokenUsage as
            | {
                cumulative?: {
                  inputTokens?: number;
                  outputTokens?: number;
                  totalTokens?: number;
                };
                last?: {
                  inputTokens?: number;
                  outputTokens?: number;
                  totalTokens?: number;
                };
              }
            | undefined;
          const snapshot = tokenUsage?.cumulative ?? tokenUsage?.last;
          if (!snapshot) return;
          const inputTokens = snapshot.inputTokens ?? 0;
          const outputTokens = snapshot.outputTokens ?? 0;
          const totalTokens = snapshot.totalTokens ?? inputTokens + outputTokens;
          usage = { inputTokens, outputTokens, totalTokens };
          sawUsage = true;
          ch.push({
            type: "usage",
            inputTokens,
            outputTokens,
            totalTokens,
            source: "runtime",
          });
          return;
        }
        case "error": {
          const msg = (params.message as string) ?? "codex app-server error";
          rejectDone(new Error(msg));
          return;
        }
        case "turn/completed": {
          const turn = params.turn as
            | { id?: string; status?: string; error?: { message?: string } | null }
            | undefined;
          if (turnId !== undefined && turn?.id !== undefined && turn.id !== turnId) {
            return;
          }
          switch (turn?.status) {
            case "completed":
              resolveDone();
              break;
            case "interrupted":
              rejectDone(new Error(turn.error?.message ?? "turn interrupted"));
              break;
            case "failed":
            default:
              rejectDone(new Error(turn?.error?.message ?? "turn failed"));
              break;
          }
          return;
        }
        default:
          return;
      }
    };

    const tools = req.tools;
    const hooksBridge = req.hooks;

    const run = async () => {
      ch.push({ type: "step", phase: "start", index: 0 });

      const mcpFlags = buildCodexMcpOverrides(req.mcp);
      const args = ["app-server", "--listen", "stdio://", ...mcpFlags];
      // Provider-injected `-c model_provider/model/model_providers.*` overrides.
      if (this.opts.providerOverrides) args.push(...this.opts.providerOverrides);

      // Provider api key (under its env_key) merged over opts.env.
      // JsonRpcStdioClient spreads process.env first, so these win; process.env
      // is never mutated -> concurrent runs with different keys stay isolated.
      const childEnv =
        this.opts.env || this.opts.providerEnv
          ? { ...this.opts.env, ...this.opts.providerEnv }
          : undefined;

      client = new JsonRpcStdioClient({
        command: "codex",
        args,
        cwd: this.opts.cwd,
        env: childEnv,
        handleRequest: (request) =>
          this.handleCodexRequest(request, tools, hooksBridge),
      });
      this.clients.add(client);
      client.start(handleNotification);

      await client.request("initialize", {
        clientInfo: { name: "agent-loop", title: "agent-loop", version: "1.0.0" },
        capabilities: null,
      });

      // Start or resume the thread. System prompt is folded in as developer
      // instructions on the thread.
      const resumeThreadId = o.threadId;
      const threadMethod = resumeThreadId ? "thread/resume" : "thread/start";
      const threadResp = (await client.request(threadMethod, {
        cwd: this.opts.cwd,
        model: this.opts.model ?? this.opts.providerModel ?? undefined,
        threadId: resumeThreadId ?? undefined,
        approvalPolicy: this.opts.fullAuto ? "never" : "on-request",
        sandbox:
          this.opts.sandbox ?? (this.opts.fullAuto ? "workspace-write" : undefined),
        approvalsReviewer: this.opts.approvalsReviewer ?? undefined,
        developerInstructions: req.system?.trim() ? req.system.trim() : undefined,
        baseInstructions: this.opts.instructions ?? undefined,
      })) as { thread?: { id?: string } };
      threadId = threadResp.thread?.id;
      if (!threadId) throw new Error("codex app-server returned no thread id");

      // Honor an abort that fired before we got this far.
      if (req.signal?.aborted) {
        await this.interrupt(client, threadId, turnId);
        resolveDone();
      }

      const onAbort = () => {
        void this.interrupt(client, threadId, turnId);
        resolveDone();
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });

      // Start the turn — pass tool definitions so Codex knows about custom tools.
      const toolDefs = Object.keys(tools).length > 0
        ? Object.entries(tools).map(([name, def]) => ({
            name,
            description: def.description ?? "",
            inputSchema: def.inputSchema ?? null,
          }))
        : undefined;
      const turnResp = (await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: req.prompt, text_elements: [] }],
        cwd: this.opts.cwd,
        model: this.opts.model ?? this.opts.providerModel ?? undefined,
        serviceTier: this.opts.serviceTier ?? undefined,
        effort: codexEffort(req.effort) ?? this.opts.effort ?? undefined,
        summary: this.opts.summary ?? undefined,
        approvalsReviewer: this.opts.approvalsReviewer ?? undefined,
        sandboxPolicy: o.sandboxPolicy ?? undefined,
        outputSchema: o.outputSchema ?? undefined,
        ...(toolDefs ? { tools: toolDefs } : {}),
      })) as { turn?: { id?: string } };
      turnId = turnResp.turn?.id;
      if (!turnId) throw new Error("codex app-server returned no turn id");

      this.currentTurn = { client, threadId, turnId };

      // If abort already fired before turn/start resolved, interrupt now.
      if (req.signal?.aborted) {
        await this.interrupt(client, threadId, turnId);
      }

      try {
        await done;
      } finally {
        req.signal?.removeEventListener("abort", onAbort);
      }
      finish();
    };

    run().catch((err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });

    return {
      [Symbol.asyncIterator]: () => ch.iterable[Symbol.asyncIterator](),
      result,
      contextWindow,
      steer: async (message: string) => {
        const turn = this.currentTurn;
        if (!turn) return "deferred";
        await turn.client.request("turn/steer", {
          threadId: turn.threadId,
          expectedTurnId: turn.turnId,
          input: [{ type: "text", text: message, text_elements: [] }],
        });
        ch.push({ type: "steer", message, mode: "live" });
        return "live";
      },
      cancel: () => {
        void this.interrupt(client, threadId, turnId);
        resolveDone();
      },
    };
  }

  /**
   * Handle a JSON-RPC request from the codex app-server, including approval
   * callbacks, permission requests, and dynamic tool calls.
   */
  private async handleCodexRequest(
    request: JsonRpcRequest,
    tools: ToolSet,
    hooksBridge: AdapterHookBridge,
  ): Promise<unknown> {
    const allow = this.opts.fullAuto === true;
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        return { decision: allow ? "accept" : "decline" };
      case "item/fileChange/requestApproval":
        return { decision: allow ? "accept" : "decline" };
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: allow ? "approved" : "denied" };
      case "item/permissions/requestApproval": {
        const params = request.params as {
          permissions?: { network?: unknown | null; fileSystem?: unknown | null };
        };
        if (!allow) return { permissions: {}, scope: "turn", strictAutoReview: true };
        const permissions: Record<string, unknown> = {};
        if (params.permissions?.network) permissions.network = params.permissions.network;
        if (params.permissions?.fileSystem)
          permissions.fileSystem = params.permissions.fileSystem;
        return { permissions, scope: "turn", strictAutoReview: false };
      }
      case "mcpServer/elicitation/request": {
        const params = request.params as {
          _meta?: { codex_approval_kind?: unknown } | null;
        };
        if (allow && params._meta?.codex_approval_kind === "mcp_tool_call") {
          return { action: "accept", content: {}, _meta: null };
        }
        return { action: "decline", content: null, _meta: null };
      }
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "item/tool/call": {
        const params = (request.params ?? {}) as {
          tool?: string;
          arguments?: Record<string, unknown>;
          id?: string;
        };
        const toolName = params.tool;
        if (!toolName || !tools[toolName]) {
          return {
            contentItems: [{
              type: "inputText",
              text: `Tool "${toolName ?? "unknown"}" is not registered.`,
            }],
            success: false,
          };
        }
        const toolDef = tools[toolName]!;

        // Pre-tool interception hook (onToolUse)
        if (hooksBridge) {
          const decision = await hooksBridge.toolUse({
            name: toolName,
            callId: params.id ?? toolName,
            args: params.arguments ?? {},
          });
          if (decision.action === "deny") {
            return {
              contentItems: [{ type: "inputText", text: decision.reason ?? "Tool call denied by policy." }],
              success: false,
            };
          }
          if (decision.action === "replaceArgs" && decision.args) {
            params.arguments = decision.args;
          }
        }

        try {
          const result = await toolDef.execute?.(params.arguments ?? {}, {
            signal: undefined,
            callId: params.id,
          });
          const resultText = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          return {
            contentItems: [{ type: "inputText", text: resultText }],
            success: true,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            contentItems: [{ type: "inputText", text: `Tool "${toolName}" failed: ${msg}` }],
            success: false,
          };
        }
      }
      default:
        throw new Error(`Unhandled Codex server request: ${request.method}`);
    }
  }

  private async interrupt(
    client: JsonRpcStdioClient | null,
    threadId: string | undefined,
    turnId: string | undefined,
  ): Promise<void> {
    if (!client || !threadId || !turnId) return;
    try {
      await client.request("turn/interrupt", { threadId, turnId });
    } catch {
      // best effort
    }
  }

  async preflight(): Promise<PreflightResult> {
    try {
      const res = await execa("codex", ["--version"], {
        reject: false,
        timeout: 10_000,
      });
      if (res.exitCode !== 0) {
        return {
          ok: false,
          reason: `\`codex --version\` exited with ${res.exitCode}`,
        };
      }
    } catch {
      return {
        ok: false,
        reason: "`codex` CLI not found on PATH. Install the Codex CLI.",
      };
    }

    // A provider injected credentials as data (`-c` + child env) — trust it
    // (the CLI itself was already verified above).
    if (this.opts.hasInjectedProvider) return { ok: true };

    // Codex needs no API key — it authenticates via `codex login`, stored in
    // ~/.codex/auth.json (or $CODEX_HOME/auth.json). An env key also works.
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    const loggedIn = existsSync(join(codexHome, "auth.json"));
    const envKey = Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
    if (!loggedIn && !envKey) {
      return {
        ok: false,
        reason: "Codex is not authenticated — run `codex login` (no API key required).",
      };
    }
    return { ok: true };
  }

  async dispose(): Promise<void> {
    const clients = Array.from(this.clients);
    this.clients.clear();
    this.currentTurn = null;
    for (const c of clients) {
      try {
        c.close();
      } catch {
        // ignore
      }
    }
  }
}
