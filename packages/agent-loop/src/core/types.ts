import type { LoopEvent, TokenUsage } from "./events";
import type { Hooks } from "./hooks";

/**
 * Canonical runtime identifiers (match `RuntimeType` in core/provider).
 * Open-ended so custom adapters can add their own.
 */
export type RuntimeId = "claude-code" | "codex" | "cursor" | "ai-sdk" | "mock" | (string & {});

/**
 * Backend-neutral tool definition. Adapters translate this into their native
 * shape (AI SDK `tool()`, an in-process MCP tool for Claude, etc.).
 *
 * `inputSchema` is intentionally `unknown`: pass a Zod schema or a JSON Schema
 * object — the adapter decides how to consume it.
 */
export interface ToolDefinition {
  description?: string;
  inputSchema?: unknown;
  execute?: (
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ) => unknown | Promise<unknown>;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  callId?: string;
  /**
   * Ask the backend to stop at its next safe step / turn boundary. Tool
   * executors should use this for terminal protocol tools instead of directly
   * aborting the run mid-tool-call.
   */
  requestStop?: (reason?: string) => void;
}

export type ToolSet = Record<string, ToolDefinition>;

/**
 * Infer a tool's argument type from a Standard Schema (e.g. any Zod schema,
 * which implements the `~standard` contract). Falls back to a loose record when
 * the schema can't be inferred.
 */
type InferToolArgs<Schema> = Schema extends {
  "~standard": { types?: { output?: infer Output } };
}
  ? Output extends Record<string, unknown>
    ? Output
    : Record<string, unknown>
  : Record<string, unknown>;

/**
 * Author a tool with a typed `execute`. The `args` passed to `execute` are
 * inferred from `inputSchema` (a Zod / Standard Schema), so you get full
 * autocomplete and type-safety without manual casts:
 *
 *   const search = defineTool({
 *     description: "Search the web",
 *     inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
 *     execute: ({ query, limit }) => doSearch(query, limit), // typed
 *   });
 *   loop.run({ prompt, tools: { search } });
 *
 * Returns a plain `ToolDefinition` — runtime shape is unchanged.
 */
export function defineTool<Schema = unknown>(def: {
  description?: string;
  inputSchema?: Schema;
  execute: (args: InferToolArgs<Schema>, ctx: ToolExecutionContext) => unknown | Promise<unknown>;
}): ToolDefinition {
  return def as unknown as ToolDefinition;
}

/** MCP server configuration, normalized across backends. */
export interface McpServerConfig {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
}

export type McpServers = Record<string, McpServerConfig>;

/**
 * Reasoning effort level — a cross-runtime, generic knob for controlling the
 * model's reasoning depth. Mapped per-adapter to the runtime's native concept
 * (e.g. claude-code env var, codex effort param, ai-sdk reasoning budget).
 * Adapters that cannot honor a level ignore it (no capability gate — effort is
 * advisory where unsupported).
 *
 * "low"  — minimal reasoning, fast responses (mechanical / rote work)
 * "medium" — balanced reasoning (the default across the board)
 * "high" — deeper reasoning, more output tokens (hard / divergent work)
 * "max" — maximum reasoning, most expensive but highest quality (design/dialectic)
 */
export type EffortLevel = "low" | "medium" | "high" | "max";

/**
 * A skill is a reusable bundle of instructions + tools + MCP servers. The
 * executor compiles skills into the resolved request: instructions are appended
 * to the system prompt, tools and MCP servers are merged in.
 */
export interface Skill {
  name: string;
  description?: string;
  /** Prompt fragment appended to the system prompt. */
  instructions: string;
  tools?: ToolSet;
  mcp?: McpServers;
  metadata?: Record<string, unknown>;
}

/** Everything one loop invocation needs. */
export interface RunInput {
  prompt: string;
  system?: string;
  skills?: Skill[];
  tools?: ToolSet;
  /** Tools that end this run after their normal executor returns. */
  terminalToolSet?: string[];
  mcp?: McpServers;
  hooks?: Hooks;
  /** Soft cap on agent turns, where the backend honors it. */
  maxSteps?: number;
  signal?: AbortSignal;
  /**
   * Reasoning-effort level for this run. Generic cross-runtime knob:
   * the adapter maps it to its own native concept. Falls back to the provider
   * default when unset.
   */
  effort?: EffortLevel;
  /** Typed-per-adapter escape hatch for backend-native options. */
  runtimeOptions?: unknown;
  metadata?: Record<string, unknown>;
}

export type RunStatus = "completed" | "cancelled" | "error";

export interface RunResult {
  events: LoopEvent[];
  usage: TokenUsage;
  durationMs: number;
  status: RunStatus;
  error?: Error;
  /** Concatenated assistant text across the whole run. */
  text: string;
}

export interface CleanupOptions {
  /**
   * How long to wait for the run to settle after cooperative cancellation.
   * Undefined means the caller only wants the best-effort adapter cleanup path.
   */
  graceMs?: number;
  /** Human-readable reason for audit records and runtime cancellation. */
  reason?: string;
  /**
   * Reserved for adapter-specific hard termination. Defaults to false; callers
   * must opt in, and adapters may still report that hard kill is unavailable.
   */
  hardKill?: boolean;
}

export type CleanupStatus = "settled" | "cancelled_settled" | "unsettled";

export interface CleanupResult {
  status: CleanupStatus;
  elapsedMs: number;
  hardKill: boolean;
  reason?: string;
  runtime?: RuntimeId;
  resultStatus?: RunStatus;
  pid?: number;
  pidUnavailableReason?: string;
  error?: string;
}

export type SteerOutcome = {
  /** "live" = injected mid-turn; "deferred" = next step boundary; "rejected" = backend can't steer. */
  mode: "live" | "deferred" | "rejected";
};

/**
 * A running loop. Consume it whichever way fits:
 *
 *   for await (const ev of run) { ... }        // every normalized event
 *   for await (const chunk of run.textStream)  // assistant text only
 *   const text = await run.text                // full text when done
 *   const { usage, status } = await run.result // the aggregate
 *
 * All views are independent and replayable — iterating one does not drain the
 * others, and you can subscribe even after the run finishes. Iteration never
 * throws: failures surface as an `error` event and `result.status === "error"`.
 */
export interface RunHandle extends AsyncIterable<LoopEvent> {
  /** Assistant text deltas only (the common case). */
  readonly textStream: AsyncIterable<string>;
  /** The full aggregate once the run completes. Never rejects. */
  readonly result: Promise<RunResult>;
  /** Shortcut for `result.then(r => r.text)`. */
  readonly text: Promise<string>;
  /** Shortcut for `result.then(r => r.usage)`. */
  readonly usage: Promise<TokenUsage>;
  /** Inject a steer message. Resolves with how it was applied. */
  steer(message: string): Promise<SteerOutcome>;
  /** Cancel the run. */
  cancel(reason?: string): void;
  /**
   * Request cooperative cleanup and wait for a bounded settlement result.
   * This is not a hard-kill by default; `hardKill` must be explicitly requested
   * and may be unsupported by a backend.
   */
  cleanup(options?: CleanupOptions): Promise<CleanupResult>;
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  missingEnv?: string[];
}
