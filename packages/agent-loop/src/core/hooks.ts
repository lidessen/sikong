import type { RuntimeId } from "./types";

/** Anything a hook may return: a value or a promise of it. */
type Awaitable<T> = T | Promise<T>;

/** Decision returned by observational hooks (message / step). */
export type HookDecision =
  | { action: "continue" }
  /** Inject a steer message now (routed to the backend's native mechanism). */
  | { action: "steer"; message: string }
  /** Stop the run (cancels the backend). */
  | { action: "stop"; reason?: string };

/** Decision returned by `onToolUse` (requires the `hooks` capability). */
export type ToolHookDecision =
  | HookDecision
  /** Block this tool call. */
  | { action: "deny"; reason?: string }
  /** Run the tool, but with these args instead. */
  | { action: "replaceArgs"; args: Record<string, unknown> };

export interface RunStartContext {
  runtime: RuntimeId;
  system: string;
  prompt: string;
}

export interface MessageHookEvent {
  text: string;
}

export interface ThinkingHookEvent {
  text: string;
}

export interface ToolUseHookEvent {
  name: string;
  callId?: string;
  args?: Record<string, unknown>;
}

export interface ToolResultHookEvent {
  name: string;
  callId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface StepHookEvent {
  index: number;
}

export interface UsageHookEvent {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow?: number;
  usedRatio?: number;
}

/**
 * Cross-backend lifecycle hooks. Every backend supports the observational hooks
 * (start / message / thinking / toolResult / step / usage / end) because the
 * executor drives them off the normalized event stream. Only `onToolUse`'s
 * `deny` / `replaceArgs` decisions require the backend's `hooks` capability —
 * elsewhere `onToolUse` simply never fires.
 */
export interface Hooks {
  onStart?(ctx: RunStartContext): Awaitable<void>;
  onMessage?(ev: MessageHookEvent): Awaitable<HookDecision | void>;
  onThinking?(ev: ThinkingHookEvent): Awaitable<void>;
  onToolUse?(ev: ToolUseHookEvent): Awaitable<ToolHookDecision | void>;
  onToolResult?(ev: ToolResultHookEvent): Awaitable<void>;
  onStep?(ev: StepHookEvent): Awaitable<HookDecision | void>;
  onUsage?(ev: UsageHookEvent): Awaitable<void>;
  onEnd?(result: import("./types").RunResult): Awaitable<void>;
}
