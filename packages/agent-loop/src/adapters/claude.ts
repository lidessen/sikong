import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  HookJSONOutput,
  McpServerConfig as SdkMcpServerConfig,
  Options as ClaudeAgentOptions,
  PostToolBatchHookInput,
  PreToolUseHookInput,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as zod from "zod";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { BackendAdapter, BackendResult, BackendRun, ResolvedRequest } from "../core/adapter";
import type { CapabilityList } from "../core/capabilities";
import { createEventChannel } from "../core/channel";
import { resolveContextWindow } from "../core/context-window";
import { type LoopEvent } from "../core/events";
import type {
  McpServerConfig,
  McpServers,
  PreflightResult,
  ToolDefinition,
  ToolSet,
} from "../core/types";

export type ClaudePermissionMode = NonNullable<ClaudeAgentOptions["permissionMode"]>;
type ClaudeBuiltinTools = ClaudeAgentOptions["tools"];
type ClaudeSystemPromptPreset = "custom" | "claude_code";

const z = ((zod as unknown as { z?: typeof zod }).z ?? zod) as typeof zod;
export const CLAUDE_SETTING_SOURCES: [] = [];

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
  /** Tool names auto-allowed without a permission prompt. This is not an availability allow-list. */
  allowedTools?: string[];
  /** Built-in Claude Code tools made visible to the model. */
  builtinTools?: ClaudeBuiltinTools;
  /** Built-in or MCP tools removed from the model context entirely. */
  disallowedTools?: string[];
  /** Permission posture. "bypassPermissions" also skips dangerous-op prompts. */
  permissionMode?: ClaudePermissionMode;
  /** Extra environment variables for the agent subprocess. */
  env?: Record<string, string>;
  /** Directories the agent may read/write beyond `cwd`. */
  allowedPaths?: string[];
  /** Raw `--flag value` pairs forwarded to the underlying CLI. */
  extraArgs?: string[];
  /**
   * Path to the Claude Code CLI the SDK spawns. Unset ⇒ auto-resolved (env
   * `CLAUDE_CODE_EXECUTABLE`, then a `claude` on PATH / common install dirs),
   * falling back to the SDK's bundled binary. Set explicitly to pin one. This is
   * what lets a `bun --compile` single-file build (which can't embed the SDK's
   * native binary) drive claude-code via the user's installed `claude`.
   */
  pathToClaudeCodeExecutable?: string;
  /** Reserved: idle timeout (ms). Currently unused by the SDK transport. */
  idleTimeout?: number;
  /** Override the model's context-window size (tokens) for usage.usedRatio. */
  contextWindow?: number;
  /** Provider-injected child env (set by `claudeCodeLoop({ provider })`). */
  providerEnv?: Record<string, string>;
  /** Provider-injected default model id. */
  providerModel?: string;
  /** Default system prompt shape. Library default remains Claude Code. */
  systemPromptPreset?: ClaudeSystemPromptPreset;
  /** True when a provider supplied credentials — preflight then trusts it. */
  hasInjectedProvider?: boolean;
}

/**
 * Per-run escape hatch, read from `req.runtimeOptions`. Lets a caller override
 * adapter defaults for a single run without reconstructing the adapter.
 */
export interface ClaudeRuntimeOptions {
  model?: string;
  /** Per-run working directory override. */
  cwd?: string;
  /** Override the soft turn cap (otherwise derived from `req.maxSteps`). */
  maxTurns?: number;
  /** Resume a prior session id. */
  resume?: string;
  /** Continue the most recent session. */
  continue?: boolean;
  permissionMode?: ClaudePermissionMode;
  /** Extra tool names auto-allowed without a permission prompt. */
  allowedTools?: string[];
  /** Per-run override for built-in Claude Code tools made visible to the model. */
  builtinTools?: ClaudeBuiltinTools;
  /** Extra built-in or MCP tools removed from the model context entirely. */
  disallowedTools?: string[];
  /** Per-run system prompt shape. Use custom for general Sikong control runs. */
  systemPromptPreset?: ClaudeSystemPromptPreset;
  /** Extra environment variables merged with the adapter's. */
  env?: Record<string, string>;
  /** Per-run directories the agent may access beyond cwd. */
  allowedPaths?: string[];
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
    const contextWindow = resolveContextWindow(
      resolveClaudeModel(o.model ?? this.opts.model ?? this.opts.providerModel),
      this.opts.contextWindow,
    );
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
    const emittedToolResults = new Set<string>();
    let stopRequested = false;
    const requestStop = () => {
      stopRequested = true;
    };

    const inProcessTool = buildInProcessToolServer(req.tools, req.signal, requestStop, (event) => {
      const callId = event.callId ?? event.name;
      if (callId) emittedToolResults.add(callId);
      ch.push({ type: "tool_call_end", ...event, callId });
    });
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
    const claudeHooks = makeClaudeHooks(req, () => stopRequested);

    let activeQuery: Query | null = null;
    let started = Date.now();

    const result = (async (): Promise<BackendResult> => {
      started = Date.now();
      let usage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      const toolNames = new Map<string, string>();
      const streamState = { streamedText: "", streamedThinking: "" };
      let stepIndex = -1;
      let stepOpen = false;
      let closedInputAfterAssistant = false;

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
            mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
            hooks: claudeHooks,
            abortController,
          }),
        });
        activeQuery = q;

        for await (const message of q) {
          // A new assistant turn opens a step; the matching result closes it.
          if (message.type === "assistant") {
            if (!stepOpen) openStep();
            if (!closedInputAfterAssistant) {
              closedInputAfterAssistant = true;
              endInput?.();
            }
          }

          const mapped = mapClaudeMessage(message, toolNames, streamState, emittedToolResults);

          if (mapped.usage) {
            usage = mapped.usage;
            ch.push({
              type: "usage",
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheCreationTokens: usage.cacheCreationTokens,
              source: "runtime",
            });
          }
          for (const ev of mapped.events) ch.push(ev);

          if (message.type === "result") closeStep();
        }

        closeStep();
        endInput?.();
        ch.end();
        return { usage: fillEstimatedOutput(usage, streamState), durationMs: Date.now() - started };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // An abort is an expected cancellation, not a stream failure.
        if (abortController.signal.aborted) {
          closeStep();
          endInput?.();
          ch.end();
          return {
            usage: fillEstimatedOutput(usage, streamState),
            durationMs: Date.now() - started,
          };
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
      contextWindow,
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
  hooks: ClaudeAgentOptions["hooks"];
  abortController: AbortController;
}): ClaudeAgentOptions {
  const { req, opts, o, mcpServers, hooks, abortController } = args;

  const permissionMode = o.permissionMode ?? opts.permissionMode;
  const append = req.system || opts.instructions;
  const autoAllowedToolNames = inProcessToolAllowedNames(req.tools);
  const allowedTools =
    opts.allowedTools || o.allowedTools || autoAllowedToolNames.length > 0
      ? [
          ...new Set([
            ...autoAllowedToolNames,
            ...(opts.allowedTools ?? []),
            ...(o.allowedTools ?? []),
          ]),
        ]
      : undefined;
  const disallowedTools =
    opts.disallowedTools || o.disallowedTools
      ? [...new Set([...(opts.disallowedTools ?? []), ...(o.disallowedTools ?? [])])]
      : undefined;
  const builtinTools = o.builtinTools ??
    opts.builtinTools ?? { type: "preset", preset: "claude_code" };
  const systemPrompt = buildClaudeSystemPrompt(
    o.systemPromptPreset ?? opts.systemPromptPreset ?? "claude_code",
    append,
  );
  // The SDK's Options.env REPLACES the child env entirely (it is NOT merged
  // with process.env). So whenever we inject anything we must also carry the
  // parent env (PATH/HOME/...) or the spawn fails — spread process.env first,
  // injected values win. process.env is only READ, never mutated, so concurrent
  // runs with different provider keys stay isolated.
  const injected: Record<string, string> = {};
  if (opts.providerEnv) Object.assign(injected, opts.providerEnv);
  if (opts.env) Object.assign(injected, opts.env);
  if (o.env) Object.assign(injected, o.env);
  // Per-run effort overrides the provider's default for this specific run.
  if (req.effort) {
    injected.CLAUDE_CODE_EFFORT_LEVEL = req.effort;
  }
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
    cwd: o.cwd ?? opts.cwd,
    model: resolveClaudeModel(o.model ?? opts.model ?? opts.providerModel),
    env,
    additionalDirectories: o.allowedPaths ?? opts.allowedPaths,
    allowedTools,
    disallowedTools,
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
    includePartialMessages: true,
    includeHookEvents: false,
    maxTurns: o.maxTurns ?? req.maxSteps,
    resume: o.resume,
    continue: o.continue,
    mcpServers,
    hooks,
    // Sikong runs are fully context-projected. Do not load user/project/local
    // Claude settings, CLAUDE.md, plugins, or memory into agent-loop runs.
    settingSources: CLAUDE_SETTING_SOURCES,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    tools: builtinTools,
    extraArgs: opts.extraArgs ? parseClaudeExtraArgs(opts.extraArgs) : undefined,
    pathToClaudeCodeExecutable: resolveClaudeExecutable(opts.pathToClaudeCodeExecutable),
  };
}

function buildClaudeSystemPrompt(
  preset: ClaudeSystemPromptPreset,
  append: string | undefined,
): ClaudeAgentOptions["systemPrompt"] | undefined {
  if (preset === "claude_code") {
    return {
      type: "preset",
      preset: "claude_code",
      append,
    };
  }
  return append;
}

/**
 * Resolve the Claude Code CLI the SDK should spawn. Returns undefined when none
 * is found, so the SDK falls back to its bundled binary (the dev/source path).
 * A `bun --compile` standalone has NO bundled binary, so this is what makes the
 * compiled `sikong` drive claude-code: it finds the user's installed `claude`.
 * Resolution order: explicit arg → env → PATH (real file, not a shell function)
 * → common install locations.
 */
function resolveClaudeExecutable(explicit?: string): string | undefined {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const env = process.env.CLAUDE_CODE_EXECUTABLE ?? process.env.CLAUDE_CODE_PATH;
  if (env) candidates.push(env);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push(join(dir, exe));
  }
  const home = homedir();
  candidates.push(
    join(home, ".local", "bin", exe),
    join(home, ".claude", "local", exe),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  );
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // unreadable candidate — skip
    }
  }
  return undefined;
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
export function parseClaudeExtraArgs(args: string[]): Record<string, string | null> {
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

function convertMcpServers(mcp: McpServers): Record<string, SdkMcpServerConfig> {
  const out: Record<string, SdkMcpServerConfig> = {};
  for (const [name, server] of Object.entries(mcp)) {
    const converted = convertMcpServer(server);
    if (converted) out[name] = converted;
  }
  return out;
}

function convertMcpServer(server: McpServerConfig): SdkMcpServerConfig | undefined {
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
  requestStop?: (reason?: string) => void,
  onToolEnd?: (event: { name: string; callId?: string; result?: unknown; error?: string }) => void,
): { name: string; config: SdkMcpServerConfig } | undefined {
  const names = Object.keys(tools);
  if (names.length === 0) return undefined;

  const sdkTools = names.map((name) =>
    buildSdkTool(name, tools[name] as ToolDefinition, signal, requestStop, onToolEnd),
  );

  const serverName = "agent_loop_tools";
  const instance = createSdkMcpServer({
    name: serverName,
    version: "1.0.0",
    tools: sdkTools,
  });
  return { name: serverName, config: instance };
}

function inProcessToolAllowedNames(tools: ToolSet): string[] {
  return Object.keys(tools).flatMap((name) => [name, `mcp__agent_loop_tools__${name}`]);
}

function buildSdkTool(
  name: string,
  def: ToolDefinition,
  signal?: AbortSignal,
  requestStop?: (reason?: string) => void,
  onToolEnd?: (event: { name: string; callId?: string; result?: unknown; error?: string }) => void,
) {
  const shape = claudeToolInputShape(def.inputSchema);
  return tool(name, def.description ?? name, shape, async (args: Record<string, unknown>, meta) => {
    const toolUseBlock = (meta as { toolUseBlock?: { id?: unknown; name?: unknown } } | undefined)
      ?.toolUseBlock;
    const callId = typeof toolUseBlock?.id === "string" ? toolUseBlock.id : undefined;
    const eventName =
      typeof toolUseBlock?.name === "string" ? toolUseBlock.name : `mcp__agent_loop_tools__${name}`;
    if (!def.execute) {
      onToolEnd?.({ name: eventName, callId, error: `Tool "${name}" has no executor.` });
      return {
        content: [{ type: "text", text: `Tool "${name}" has no executor.` }],
        isError: true,
      };
    }
    try {
      const out = await def.execute(args ?? {}, { signal, requestStop });
      onToolEnd?.({ name: eventName, callId, result: out });
      return { content: [{ type: "text", text: stringifyResult(out) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onToolEnd?.({ name: eventName, callId, error: msg });
      return {
        content: [{ type: "text", text: msg }],
        isError: true,
      };
    }
  });
}

/**
 * Claude Agent SDK's `tool()` helper accepts a Zod raw shape, while agent-loop
 * tools may provide a Zod object, raw shape, or JSON Schema. Keep conversion at
 * this adapter boundary and let Zod handle JSON Schema semantics.
 */
export function claudeToolInputShape(schema: unknown): zod.ZodRawShape {
  if (!schema || typeof schema !== "object") return {};
  // A Zod object schema: lift its `.shape`.
  const maybeZod = schema as { shape?: unknown; _def?: unknown };
  if (maybeZod._def && maybeZod.shape && typeof maybeZod.shape === "object") {
    return maybeZod.shape as zod.ZodRawShape;
  }
  // Already a raw shape (record of Zod types).
  const values = Object.values(schema as Record<string, unknown>);
  if (values.length > 0 && values.every(isZodType)) {
    return schema as zod.ZodRawShape;
  }

  try {
    const converted = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    if (isZodObjectWithShape(converted)) return converted.shape;
  } catch {
    // Non-JSON-Schema objects fall through to an open input shape.
  }

  // Anything else: accept arbitrary input.
  return {};
}

function isZodType(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

function isZodObjectWithShape(value: unknown): value is zod.ZodObject<zod.ZodRawShape> {
  return isZodType(value) && typeof (value as { shape?: unknown }).shape === "object";
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
// SDK hooks -> req.hooks bridge + terminal-tool stop boundary
// ---------------------------------------------------------------------------

function makeClaudeHooks(
  req: ResolvedRequest,
  shouldStop: () => boolean,
): ClaudeAgentOptions["hooks"] {
  const preToolUse = async (
    input: PreToolUseHookInput | Record<string, unknown>,
    toolUseID: string | undefined,
  ): Promise<HookJSONOutput> => {
    const name = String((input as { tool_name?: unknown }).tool_name ?? "unknown");
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
    if (decision.action === "approve") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
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

  const postToolBatch = async (
    _input: PostToolBatchHookInput | Record<string, unknown>,
  ): Promise<HookJSONOutput> => {
    if (!shouldStop()) return {};
    return {
      continue: false,
      reason: "Terminal tool requested stop.",
    };
  };

  return {
    PreToolUse: [{ hooks: [preToolUse] }],
    PostToolBatch: [{ hooks: [postToolBatch] }],
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
  emittedToolResults?: Set<string>,
): {
  events: LoopEvent[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
} {
  const events: LoopEvent[] = [];

  if (message.type === "assistant") {
    const content = (message.message.content ?? []) as unknown as Array<Record<string, unknown>>;
    for (const block of content) {
      if (
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        block.thinking.length > streamState.streamedThinking.length
      ) {
        const newThinking = block.thinking.slice(streamState.streamedThinking.length);
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
      if (emittedToolResults?.has(m.parent_tool_use_id)) return { events };
      emittedToolResults?.add(m.parent_tool_use_id);
      events.push({
        type: "tool_call_end",
        name: toolNames.get(m.parent_tool_use_id) ?? "unknown",
        callId: m.parent_tool_use_id,
        result: m.tool_use_result,
      });
    }
  } else if (message.type === "stream_event") {
    const event = (message as { event?: unknown }).event as Record<string, unknown> | undefined;
    const eventType = String(event?.type ?? "");
    if (eventType === "content_block_delta") {
      const delta = (event?.delta as Record<string, unknown> | undefined) ?? {};
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        streamState.streamedText += delta.text;
        events.push({ type: "text", text: delta.text });
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
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

  // Capture per-turn usage from assistant messages too, so a run that is
  // cancelled before the final `result` arrives (the common case under
  // sikong, which stops the run on a terminal tool call) still reports usage.
  // The `result` message, when it arrives, is authoritative and overrides this.
  if (message.type === "assistant") {
    const u = mapAssistantUsage(message);
    if (u) return { events, usage: u };
  }

  return { events };
}

function mapAssistantUsage(message: SDKMessage):
  | {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  | undefined {
  const usage = (message as { message?: { usage?: Record<string, unknown> } }).message?.usage;
  if (!usage) return undefined;
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0);
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

type ClaudeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

/**
 * DeepSeek's Anthropic-compatible endpoint reports `output_tokens` ONLY in the
 * final `result` message — streaming `assistant` messages carry output_tokens=0.
 * sikong stops the worker run on a terminal tool call, so the run is usually
 * CANCELLED before the result arrives, leaving outputTokens=0 despite real
 * generation (answer text + reasoning). When the captured output is 0 but content
 * was streamed, estimate it from the streamed character count (~4 chars/token) so
 * cost accounting isn't silently zero. A real reported value is never overridden,
 * so this is a no-op for real Anthropic (which streams output_tokens as it goes).
 */
export function fillEstimatedOutput(
  usage: ClaudeUsage,
  streamState: { streamedText: string; streamedThinking: string },
): ClaudeUsage {
  const chars = streamState.streamedText.length + streamState.streamedThinking.length;
  if (chars === 0) return usage;

  // DeepSeek's Anthropic-compatible endpoint reports token usage only in the
  // final result message. When the run stops before that (terminal tool call),
  // estimate from streamed character counts (~4 chars/token for output, ~6
  // chars/token for input as a conservative heuristic). A real reported value
  // is never overridden.
  let { inputTokens, outputTokens } = usage;

  if (outputTokens === 0 && chars > 0) {
    outputTokens = Math.ceil(chars / 4);
  }

  if (inputTokens === 0 && chars > 0) {
    // Estimate input from output using a conservative ratio (~3:1 for coding
    // tasks) when no real input usage was reported.
    inputTokens = Math.ceil(outputTokens * 3);
  }

  const totalTokens =
    inputTokens + outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;

  if (usage.outputTokens > 0 && usage.inputTokens > 0) return usage;
  return { ...usage, inputTokens, outputTokens, totalTokens };
}

function mapResultUsage(message: SDKMessage & { type: "result" }): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} {
  const usage = (message as { usage?: Record<string, unknown> }).usage ?? {};
  // Anthropic's input_tokens EXCLUDES cached tokens; cache read/creation are
  // reported (and billed) separately. Keep them apart for accurate costing.
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0);
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}
