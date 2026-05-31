import type { LoopEvent, TokenUsage } from "./events";
import type { Hooks } from "./hooks";

/** Built-in backend identifiers. Open-ended so custom adapters can add their own. */
export type BackendId =
  | "claude"
  | "codex"
  | "cursor"
  | "ai-sdk"
  | "mock"
  | (string & {});

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
}

export type ToolSet = Record<string, ToolDefinition>;

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
  mcp?: McpServers;
  hooks?: Hooks;
  /** Soft cap on agent turns, where the backend honors it. */
  maxSteps?: number;
  signal?: AbortSignal;
  /** Typed-per-adapter escape hatch for backend-native options. */
  backendOptions?: unknown;
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

export type SteerOutcome = {
  /** "live" = injected mid-turn; "deferred" = next step boundary; "rejected" = backend can't steer. */
  mode: "live" | "deferred" | "rejected";
};

/**
 * A running loop: async-iterable of normalized events, plus a result promise and
 * controls. Iterate the events as they stream; `await handle.result` for the
 * aggregate.
 */
export interface RunHandle extends AsyncIterable<LoopEvent> {
  readonly result: Promise<RunResult>;
  /** Inject a steer message. Resolves with how it was applied. */
  steer(message: string): Promise<SteerOutcome>;
  /** Cancel the run. */
  cancel(reason?: string): void;
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  missingEnv?: string[];
}
