import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  HookJSONOutput,
  McpServerConfig as SdkMcpServerConfig,
  Options as ClaudeAgentOptions,
  PreToolUseHookInput,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  BackendAdapter,
  BackendResult,
  BackendRun,
  ResolvedRequest,
} from "../core/adapter";
import type { CapabilityList } from "../core/capabilities";
import { createEventChannel } from "../core/channel";
import { type LoopEvent } from "../core/events";
import type {
  McpServerConfig,
  McpServers,
  PreflightResult,
  ToolDefinition,
  ToolSet,
} from "../core/types";

/**
 * Construction-time options for {@link ClaudeAdapter}. These configure the
 * adapter itself (model, working directory, permission posture). Everything
 * about a *single run* (system, prompt, tools, mcp, hooks) arrives via the
 * `ResolvedRequest` passed to {@link ClaudeAdapter.start}.
 */
export interface ClaudeAdapterOptions {
  /** "opus" | "sonnet" | "haiku" alias, or a raw model id. */
  model?: string;
  /** Default system-prompt append, used only when `req.system` is empty. */
  instructions?: string;
  /** Working directory for the agent. */
  cwd?: string;
  /** Tool allow-list passed straight to the SDK. */
  allowedTools?: string[];
  /** Permission posture. "bypassPermissions" also skips dangerous-op prompts. */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  /** Extra environment variables for the agent subprocess. */
  env?: Record<string, string>;
  /** Directories the agent may read/write beyond `cwd`. */
  allowedPaths?: string[];
  /** Raw `--flag value` pairs forwarded to the underlying CLI. */
  extraArgs?: string[];
  /** Reserved: idle timeout (ms). Currently unused by the SDK transport. */
  idleTimeout?: number;
  /** Provider-injected child env (set by `claudeCodeLoop({ provider })`). */
  providerEnv?: Record<string, string>;
  /** Provider-injected default model id. */
  providerModel?: string;
  /** True when a provider supplied credentials — preflight then trusts it. */
  hasInjectedProvider?: boolean;
}

/**
 * Per-run escape hatch, read from `req.runtimeOptions`. Lets a caller override
 * adapter defaults for a single run without reconstructing the adapter.
 */
export interface ClaudeRuntimeOptions {
  model?: string;
  /** Override the soft turn cap (otherwise derived from `req.maxSteps`). */
  maxTurns?: number;
  /** Resume a prior session id. */
  resume?: string;
  /** Continue the most recent session. */
  continue?: boolean;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  /** Extra `allowedTools` merged with the adapter's. */
  allowedTools?: string[];
  /** Extra environment variables merged with the adapter's. */
  env?: Record<string, string>;
}

const STREAM_SESSION_ID = "agent-loop-claude";

/**
 * BackendAdapter over the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 *
 * Wires:
 *  - tools   -> an in-process SDK MCP server (createSdkMcpServer + tool()).
 *  - mcp     -> req.mcp converted to the SDK's mcpServers config.
 *  - hooks   -> a PreToolUse hook that consults req.hooks.toolUse and maps the
 *               decision onto the SDK's permissionDecision shape.
 *  - thinking/usage -> mapped from streamed SDK messages.
 *  - steer.deferred -> streaming-input mode (an async iterable of user messages)
 *               lets us push an extra user message that lands at the next turn.
 *  - interrupt -> cancel() aborts the controller and interrupts the query.
 */
export class ClaudeAdapter implements BackendAdapter {
  readonly id = "claude-code";
  readonly capabilities: CapabilityList = [
    "tools",
    "mcp",
    "hooks",
    "thinking",
    "usage",
    "steer.deferred",
    "sessionResume",
    "interrupt",
  ];

  constructor(private readonly opts: ClaudeAdapterOptions = {}) {}

  start(req: ResolvedRequest): BackendRun {
    const o = (req.runtimeOptions ?? {}) as ClaudeRuntimeOptions;
    const ch = createEventChannel<LoopEvent>();
    const abortController = new AbortController();

    // Tie the caller's signal to our controller.
    if (req.signal) {
      if (req.signal.aborted) abortController.abort();
      else
        req.signal.addEventListener("abort", () => abortController.abort(), {
          once: true,
        });
    }

    // ---- steer plumbing: a streaming-input async-iterable of user messages.
    // The first message is the real prompt; subsequent ones are steer pushes.
    let pushSteer: ((msg: string) => void) | null = null;
    let endInput: (() => void) | null = null;
    const steerQueue: string[] = [];
    let wakeInput: (() => void) | null = null;
    let inputClosed = false;

    const promptInput = (async function* (): AsyncIterable<SDKUserMessage> {
      yield makeUserMessage(req.prompt);
      while (true) {
        while (steerQueue.length > 0) {
          const msg = steerQueue.shift() as string;
          yield makeUserMessage(msg);
        }
        if (inputClosed) return;
        await new Promise<void>((resolve) => {
          wakeInput = resolve;
        });
      }
    })();

    pushSteer = (msg: string) => {
      steerQueue.push(msg);
      const w = wakeInput;
      wakeInput = null;
      w?.();
    };
    endInput = () => {
      inputClosed = true;
      const w = wakeInput;
      wakeInput = null;
      w?.();
    };

    // ---- tools -> in-process SDK MCP server.
    const sdkServers: Record<string, SdkMcpServerConfig> = {};
    const inProcessTool = buildInProcessToolServer(req.tools, req.signal);
    if (inProcessTool) {
      sdkServers[inProcessTool.name] = inProcessTool.config;
    }

    // ---- mcp -> SDK mcpServers config.
    const externalServers = convertMcpServers(req.mcp);
    const mcpServers: Record<string, SdkMcpServerConfig> = {
      ...externalServers,
      ...sdkServers,
    };

    // ---- hooks -> PreToolUse interception via the bridge.
    const preToolUse = makePreToolUseHook(req);

    let activeQuery: Query | null = null;
    let started = Date.now();

    const result = (async (): Promise<BackendResult> => {
      started = Date.now();
      let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const toolNames = new Map<string, string>();
      const streamState = { streamedText: "", streamedThinking: "" };
      let stepIndex = -1;
      let stepOpen = false;

      const openStep = () => {
        stepIndex += 1;
        stepOpen = true;
        ch.push({ type: "step", phase: "start", index: stepIndex });
      };
      const closeStep = () => {
        if (stepOpen) {
          ch.push({ type: "step", phase: "end", index: stepIndex });
          stepOpen = false;
        }
      };

      try {
        const q = query({
          prompt: promptInput,
          options: buildOptions({
            req,
            opts: this.opts,
            o,
            mcpServers:
              Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
            preToolUse,
            abortController,
          }),
        });
        activeQuery = q;

        for await (const message of q) {
          // A new assistant turn opens a step; the matching result closes it.
          if (message.type === "assistant" && !stepOpen) openStep();

          const mapped = mapClaudeMessage(message, toolNames, streamState);

          if (mapped.usage) {
            usage = mapped.usage;
            ch.push({
              type: "usage",
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
              source: "runtime",
            });
          }
          for (const ev of mapped.events) ch.push(ev);

          if (message.type === "result") closeStep();
        }

        closeStep();
        endInput?.();
        ch.end();
        return { usage, durationMs: Date.now() - started };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // An abort is an expected cancellation, not a stream failure.
        if (abortController.signal.aborted) {
          closeStep();
          endInput?.();
          ch.end();
          return { usage, durationMs: Date.now() - started };
        }
        ch.push({ type: "error", error });
        endInput?.();
        ch.fail(error);
        throw error;
      } finally {
        activeQuery = null;
      }
    })();

    result.catch(() => {});

    return {
      [Symbol.asyncIterator]: () => ch.iterable[Symbol.asyncIterator](),
      result,
      steer: async (message: string) => {
        pushSteer?.(message);
        return "deferred";
      },
      cancel: () => {
        abortController.abort();
        endInput?.();
        const q = activeQuery;
        if (q) {
          void q.interrupt?.().catch(() => {});
          q.close?.();
        }
      },
    };
  }

  async preflight(): Promise<PreflightResult> {
    // A provider injected credentials as data (via child env) — trust it.
    if (this.opts.hasInjectedProvider) return { ok: true };
    // Auth paths the Agent SDK can actually use when spawned headlessly:
    //  - an env credential (the common case; e.g. CLAUDE_CODE_OAUTH_TOKEN set
    //    in your shell rc, ANTHROPIC_API_KEY, AWS creds, or Google ADC), or
    //  - a credentials *file* (~/.claude/.credentials.json) on systems that use
    //    one (Linux). On macOS the interactive CLI keeps the token in the
    //    Keychain, which the spawned SDK does NOT read — so a keychain entry is
    //    deliberately NOT treated as usable here (it would be a false positive:
    //    preflight "ok" but the run 401s). Export CLAUDE_CODE_OAUTH_TOKEN for
    //    headless use.
    const envAuth =
      Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) ||
      Boolean(process.env.ANTHROPIC_API_KEY) ||
      Boolean(process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID) ||
      Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS) ||
      Boolean(process.env.GOOGLE_CLOUD_PROJECT);
    if (envAuth) return { ok: true };

    if (existsSync(join(homedir(), ".claude", ".credentials.json"))) {
      return { ok: true };
    }

    return {
      ok: false,
      reason:
        "No Claude credentials available to a headless run. Set CLAUDE_CODE_OAUTH_TOKEN " +
        "(or ANTHROPIC_API_KEY / AWS creds / Google ADC). On macOS a Keychain-only " +
        "Claude Code login is not usable by the spawned SDK — export the token.",
      missingEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    };
  }
}

// ---------------------------------------------------------------------------
// Option building
// ---------------------------------------------------------------------------

function buildOptions(args: {
  req: ResolvedRequest;
  opts: ClaudeAdapterOptions;
  o: ClaudeRuntimeOptions;
  mcpServers?: Record<string, SdkMcpServerConfig>;
  preToolUse: ClaudeAgentOptions["hooks"];
  abortController: AbortController;
}): ClaudeAgentOptions {
  const { req, opts, o, mcpServers, preToolUse, abortController } = args;

  const permissionMode = o.permissionMode ?? opts.permissionMode;
  const append = req.system || opts.instructions;
  const allowedTools =
    opts.allowedTools || o.allowedTools
      ? [...(opts.allowedTools ?? []), ...(o.allowedTools ?? [])]
      : undefined;
  // The SDK's Options.env REPLACES the child env entirely (it is NOT merged
  // with process.env). So whenever we inject anything we must also carry the
  // parent env (PATH/HOME/...) or the spawn fails — spread process.env first,
  // injected values win. process.env is only READ, never mutated, so concurrent
  // runs with different provider keys stay isolated.
  const injected: Record<string, string> = {};
  if (opts.providerEnv) Object.assign(injected, opts.providerEnv);
  if (opts.env) Object.assign(injected, opts.env);
  if (o.env) Object.assign(injected, o.env);
  let env: Record<string, string> | undefined;
  if (Object.keys(injected).length > 0) {
    env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    Object.assign(env, injected);
  }

  return {
    abortController,
    cwd: opts.cwd,
    model: resolveClaudeModel(o.model ?? opts.model ?? opts.providerModel),
    env,
    additionalDirectories: opts.allowedPaths,
    allowedTools,
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
    includePartialMessages: true,
    includeHookEvents: false,
    maxTurns: o.maxTurns ?? req.maxSteps,
    resume: o.resume,
    continue: o.continue,
    mcpServers,
    hooks: preToolUse,
    settingSources: ["project"],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append,
    },
    tools: { type: "preset", preset: "claude_code" },
    extraArgs: opts.extraArgs ? parseClaudeExtraArgs(opts.extraArgs) : undefined,
  };
}

function resolveClaudeModel(model?: string): string | undefined {
  if (!model) return undefined;
  switch (model) {
    case "opus":
      return "claude-opus-4-6";
    case "sonnet":
      return "claude-sonnet-4-6";
    case "haiku":
      return "claude-haiku-4-5";
    default:
      return model;
  }
}

/** Parse `["--flag", "value", "--bool"]` into the SDK's extraArgs record. */
export function parseClaudeExtraArgs(
  args: string[],
): Record<string, string | null> {
  const parsed: Record<string, string | null> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) continue;

    const inlineEq = arg.indexOf("=");
    if (inlineEq > 2) {
      parsed[arg.slice(2, inlineEq)] = arg.slice(inlineEq + 1);
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[arg.slice(2)] = next;
      index++;
      continue;
    }

    parsed[arg.slice(2)] = null;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// MCP conversion
// ---------------------------------------------------------------------------

function convertMcpServers(
  mcp: McpServers,
): Record<string, SdkMcpServerConfig> {
  const out: Record<string, SdkMcpServerConfig> = {};
  for (const [name, server] of Object.entries(mcp)) {
    const converted = convertMcpServer(server);
    if (converted) out[name] = converted;
  }
  return out;
}

function convertMcpServer(
  server: McpServerConfig,
): SdkMcpServerConfig | undefined {
  if (server.type === "sse") {
    if (!server.url) return undefined;
    return {
      type: "sse",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }
  if (server.type === "http" || (server.url && !server.command)) {
    if (!server.url) return undefined;
    return {
      type: "http",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }
  if (server.command) {
    return {
      type: "stdio",
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// In-process tools -> SDK MCP server
// ---------------------------------------------------------------------------

function buildInProcessToolServer(
  tools: ToolSet,
  signal?: AbortSignal,
): { name: string; config: SdkMcpServerConfig } | undefined {
  const names = Object.keys(tools);
  if (names.length === 0) return undefined;

  const sdkTools = names.map((name) =>
    buildSdkTool(name, tools[name] as ToolDefinition, signal),
  );

  const serverName = "agent_loop_tools";
  const instance = createSdkMcpServer({
    name: serverName,
    version: "1.0.0",
    tools: sdkTools,
  });
  return { name: serverName, config: instance };
}

function buildSdkTool(
  name: string,
  def: ToolDefinition,
  signal?: AbortSignal,
) {
  const shape = toZodRawShape(def.inputSchema);
  return tool(
    name,
    def.description ?? name,
    shape,
    async (args: Record<string, unknown>) => {
      if (!def.execute) {
        return {
          content: [
            { type: "text", text: `Tool "${name}" has no executor.` },
          ],
          isError: true,
        };
      }
      try {
        const out = await def.execute(args ?? {}, { signal });
        return { content: [{ type: "text", text: stringifyResult(out) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: msg }],
          isError: true,
        };
      }
    },
  );
}

/**
 * Coerce a tool's `inputSchema` (unknown by contract) into a Zod raw shape that
 * the SDK's `tool()` helper accepts. We support a Zod object schema directly,
 * pass through a raw shape, and otherwise fall back to an open object.
 */
function toZodRawShape(schema: unknown): z.ZodRawShape {
  if (!schema || typeof schema !== "object") return {};
  // A Zod object schema: lift its `.shape`.
  const maybeZod = schema as { shape?: unknown; _def?: unknown };
  if (
    maybeZod._def &&
    maybeZod.shape &&
    typeof maybeZod.shape === "object"
  ) {
    return maybeZod.shape as z.ZodRawShape;
  }
  // Already a raw shape (record of Zod types).
  const values = Object.values(schema as Record<string, unknown>);
  if (
    values.length > 0 &&
    values.every((v) => v instanceof z.ZodType)
  ) {
    return schema as z.ZodRawShape;
  }
  // JSON Schema or anything else: accept arbitrary input.
  return {};
}

function stringifyResult(out: unknown): string {
  if (typeof out === "string") return out;
  try {
    return JSON.stringify(out);
  } catch {
    return String(out);
  }
}

// ---------------------------------------------------------------------------
// PreToolUse hook -> req.hooks.toolUse bridge
// ---------------------------------------------------------------------------

function makePreToolUseHook(
  req: ResolvedRequest,
): ClaudeAgentOptions["hooks"] {
  const callback = async (
    input: PreToolUseHookInput | Record<string, unknown>,
    toolUseID: string | undefined,
  ): Promise<HookJSONOutput> => {
    const name = String(
      (input as { tool_name?: unknown }).tool_name ?? "unknown",
    );
    const args = ((input as { tool_input?: unknown }).tool_input ?? {}) as
      | Record<string, unknown>
      | undefined;

    const decision = await req.hooks.toolUse({
      name,
      callId: toolUseID,
      args,
    });

    if (decision.action === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason ?? "Denied by hook.",
        },
      };
    }
    if (decision.action === "replaceArgs") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: decision.args,
        },
      };
    }
    if (decision.action === "stop") {
      return {
        continue: false,
        stopReason: decision.reason ?? "Stopped by hook.",
      };
    }
    // "continue" / "steer" -> let the call proceed normally.
    return {};
  };

  return {
    PreToolUse: [{ hooks: [callback] }],
  };
}

// ---------------------------------------------------------------------------
// Streaming-input user messages
// ---------------------------------------------------------------------------

function makeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    session_id: STREAM_SESSION_ID,
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  };
}

// ---------------------------------------------------------------------------
// SDK message -> LoopEvent mapping (ported from agent-worker's mapClaudeMessage)
// ---------------------------------------------------------------------------

export function mapClaudeMessage(
  message: SDKMessage,
  toolNames: Map<string, string>,
  streamState: { streamedText: string; streamedThinking: string },
): {
  events: LoopEvent[];
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
} {
  const events: LoopEvent[] = [];

  if (message.type === "assistant") {
    const content = (message.message.content ?? []) as unknown as Array<
      Record<string, unknown>
    >;
    for (const block of content) {
      if (
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        block.thinking.length > streamState.streamedThinking.length
      ) {
        const newThinking = block.thinking.slice(
          streamState.streamedThinking.length,
        );
        if (newThinking) {
          events.push({ type: "thinking", text: newThinking });
          streamState.streamedThinking = block.thinking;
        }
      } else if (
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > streamState.streamedText.length
      ) {
        const newText = block.text.slice(streamState.streamedText.length);
        if (newText) {
          events.push({ type: "text", text: newText });
          streamState.streamedText = block.text;
        }
      } else if (block.type === "tool_use") {
        const callId = String(block.id ?? "");
        const name = String(block.name ?? "unknown");
        if (!toolNames.has(callId)) {
          toolNames.set(callId, name);
          events.push({
            type: "tool_call_start",
            name,
            callId,
            args: (block.input as Record<string, unknown> | undefined) ?? {},
          });
        }
      }
    }
  } else if (message.type === "user") {
    const m = message as {
      parent_tool_use_id?: string | null;
      tool_use_result?: unknown;
    };
    if (m.parent_tool_use_id && m.tool_use_result !== undefined) {
      events.push({
        type: "tool_call_end",
        name: toolNames.get(m.parent_tool_use_id) ?? "unknown",
        callId: m.parent_tool_use_id,
        result: m.tool_use_result,
      });
    }
  } else if (message.type === "stream_event") {
    const event = (message as { event?: unknown }).event as
      | Record<string, unknown>
      | undefined;
    const eventType = String(event?.type ?? "");
    if (eventType === "content_block_delta") {
      const delta = (event?.delta as Record<string, unknown> | undefined) ?? {};
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        streamState.streamedText += delta.text;
        events.push({ type: "text", text: delta.text });
      } else if (
        delta.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      ) {
        streamState.streamedThinking += delta.thinking;
        events.push({ type: "thinking", text: delta.thinking });
      }
    }
  } else if ((message as { type?: string }).type === "tool_progress") {
    const m = message as { tool_name?: string; tool_use_id?: string };
    events.push({
      type: "tool_call_start",
      name: m.tool_name ?? "unknown",
      callId: m.tool_use_id,
    });
  } else if (message.type === "system") {
    const subtype = (message as { subtype?: string }).subtype;
    if (subtype === "hook_started") {
      const h = message as { hook_name?: string; hook_event?: string };
      events.push({
        type: "hook",
        phase: "started",
        name: h.hook_name ?? "",
        hookEvent: h.hook_event ?? "",
      });
    } else if (subtype === "hook_progress") {
      const h = message as {
        hook_name?: string;
        hook_event?: string;
        output?: string;
        stdout?: string;
        stderr?: string;
      };
      events.push({
        type: "hook",
        phase: "progress",
        name: h.hook_name ?? "",
        hookEvent: h.hook_event ?? "",
        output: h.output,
        stdout: h.stdout,
        stderr: h.stderr,
      });
    } else if (subtype === "hook_response") {
      const h = message as {
        hook_name?: string;
        hook_event?: string;
        output?: string;
        stdout?: string;
        stderr?: string;
        outcome?: "success" | "error" | "cancelled";
      };
      events.push({
        type: "hook",
        phase: "response",
        name: h.hook_name ?? "",
        hookEvent: h.hook_event ?? "",
        output: h.output,
        stdout: h.stdout,
        stderr: h.stderr,
        outcome: h.outcome,
      });
    } else if (subtype === "local_command_output") {
      const m = message as { content?: string };
      events.push({ type: "text", text: m.content ?? "" });
    }
  } else if (message.type === "result") {
    return { events, usage: mapResultUsage(message) };
  }

  return { events };
}

function mapResultUsage(message: SDKMessage & { type: "result" }): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const usage = (message as { usage?: Record<string, unknown> }).usage ?? {};
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}
