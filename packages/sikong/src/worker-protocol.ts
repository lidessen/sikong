/**
 * sikong-worker JSON-RPC Protocol
 *
 * Communication protocol between the Go daemon (parent) and the Bun worker
 * subprocess (child). Uses JSON-RPC 2.0 over stdin/stdout, newline-delimited.
 *
 * ── Lifecycle ──
 *   Parent spawns: bun packages/sikong/src/worker-host.ts
 *   Child sends    → { jsonrpc:"2.0", id:1, method:"initialize", params:{...} }
 *   Parent responds → { jsonrpc:"2.0", id:1, result:{...} }
 *   Normal operation follows
 *   Child exits when stdin closes or on error
 *
 * ── Methods (parent → child) ──
 *   initialize           Negotiate protocol version + capabilities
 *   runWake              Execute one agent-loop wake run
 *   steer                Inject a steer message into the active wake
 *   cancel               Cancel the active wake
 *
 * ── Methods (child → parent, notifications) ──
 *   wake.text            Assistant text delta
 *   wake.thinking        Thinking/reasoning text delta
 *   wake.tool_call_start Tool call started
 *   wake.tool_call_end   Tool call completed
 *   wake.usage           Token usage update
 *   wake.error           Wake error
 *   wake.end             Wake completed
 *   worker.error         Fatal worker error (no recovery)
 *
 * All line-delimited JSON-RPC 2.0.
 */

// ── Protocol type definitions ───────────────────────────────────────────────

export type WorkerRuntimeType = "ai-sdk" | "claude-code";

export interface WorkerProviderConfig {
  id: string;               // "deepseek" | "anthropic" | "openai"
  model: string;
  apiKey?: string;
  baseURL?: string;
}

export interface WakeWorkerConfig {
  runtime: WorkerRuntimeType;
  provider: WorkerProviderConfig;
  /** Permission mode for claude-code workers. */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  /** Working directory for the wake. */
  cwd?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
}

export interface WakeTaskContext {
  taskId: string;
  workflowId: string;
  workflowVersion: string;
  stageId: string;
  systemPrompt: string;
  userPrompt: string;
  /** Tool definitions (name → { description, inputSchema }). */
  tools?: Record<string, { description?: string; inputSchema?: unknown }>;
  /** MCP server configs. */
  mcpServers?: Record<string, { type?: string; command?: string; args?: string[]; url?: string }>;
  maxSteps?: number;
  effort?: "low" | "medium" | "high" | "max";
  /** Context-window size in tokens, for usedRatio calculation. */
  contextWindow?: number;
}

// ── JSON-RPC structures ────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

// ── Initialize ─────────────────────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: "1.0";
  clientInfo: { name: string; version: string };
}

export interface InitializeResult {
  protocolVersion: "1.0";
  capabilities: {
    /** Worker supports mid-wake steer. */
    steer: boolean;
    /** Worker supports cancel. */
    cancel: boolean;
    /** Worker streams usage events. */
    usage: boolean;
  };
}

// ── runWake ────────────────────────────────────────────────────────────────

export interface RunWakeParams {
  worker: WakeWorkerConfig;
  task: WakeTaskContext;
}

export interface RunWakeResult {
  /** Total token usage for this wake. */
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Duration in milliseconds. */
  durationMs: number;
  /** Final status. */
  status: "completed" | "cancelled" | "error";
  /** Concatenated assistant text. */
  text: string;
  /** Workflow commands captured from command tools during this wake. */
  commands?: WakeCommand[];
  error?: string;
}

export type WakeCommand =
  | { kind: "set_field"; field: string; value: unknown }
  | { kind: "request_transition"; reason?: string }
  | { kind: "append_note"; text: string }
  | { kind: "block"; reason: string }
  | { kind: "cancel"; reason?: string };

// ── steer (parent → child, request) ────────────────────────────────────────

export interface SteerParams {
  message: string;
}

// ── cancel (parent → child, request, no params) ────────────────────────────

// ── Wake event notifications (child → parent) ──────────────────────────────

export interface WakeTextNotification {
  delta: string;
}

export interface WakeThinkingNotification {
  delta: string;
}

export interface WakeToolCallStartNotification {
  name: string;
  callId?: string;
  args: Record<string, unknown>;
}

export interface WakeToolCallEndNotification {
  name: string;
  callId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface WakeUsageNotification {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: "runtime" | "estimate";
  contextWindow?: number;
  usedRatio?: number;
}

export interface WakeErrorNotification {
  message: string;
}

// ── Protocol helper ────────────────────────────────────────────────────────

/** Create a JSON-RPC request to send to the parent. */
export function rpcRequest(method: string, params?: unknown, id?: number | string): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params, id: id ?? nextId() }) + "\n";
}

/** Create a JSON-RPC notification to send to the parent. */
export function rpcNotify(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
}

let _id = 1;
function nextId(): number {
  return _id++;
}
