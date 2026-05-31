import type { CapabilityList } from "../core/capabilities";
import type { LoopEvent, TokenUsage } from "../core/events";
import type { ToolHookDecision, ToolUseHookEvent } from "../core/hooks";
import type {
  RuntimeId,
  McpServers,
  PreflightResult,
  ToolSet,
} from "../core/types";

/**
 * The bridge the executor hands to an adapter so the adapter can consult the
 * caller's `onToolUse` hook at its *native* pre-tool interception point.
 *
 * Only adapters with the `hooks` capability call this. Adapters that observe
 * tools after the fact rely on the executor reading their event stream instead.
 */
export interface AdapterHookBridge {
  /** Ask whether/how a tool call should proceed. Defaults to continue. */
  toolUse(ev: ToolUseHookEvent): Promise<ToolHookDecision>;
}

/**
 * The fully-resolved request the executor passes to `adapter.start`. Skills are
 * already compiled into `system` / `tools` / `mcp` — adapters never see skills.
 */
export interface ResolvedRequest {
  system: string;
  prompt: string;
  tools: ToolSet;
  mcp: McpServers;
  maxSteps?: number;
  signal?: AbortSignal;
  runtimeOptions?: unknown;
  hooks: AdapterHookBridge;
}

export interface BackendResult {
  usage: TokenUsage;
  durationMs: number;
}

/**
 * A backend-native run in progress. Adapters return this from `start`. The
 * executor wraps it: drives hooks off the event stream, accumulates the result,
 * and exposes a `RunHandle`.
 */
export interface BackendRun extends AsyncIterable<LoopEvent> {
  readonly result: Promise<BackendResult>;
  /** Present iff the backend declares a steer capability. */
  steer?(message: string): Promise<"live" | "deferred">;
  cancel(reason?: string): void;
}

/**
 * What every backend implements. Keep this small: the executor layer provides
 * skills, hook dispatch, steer routing and capability gating on top.
 */
export interface BackendAdapter {
  readonly id: RuntimeId;
  readonly capabilities: CapabilityList;
  /** Start one loop. Must not block; return the in-progress run immediately. */
  start(req: ResolvedRequest): BackendRun;
  /** Optional: check CLI/SDK/API-key availability before running. */
  preflight?(): Promise<PreflightResult>;
  /** Optional: release long-lived resources (subprocesses, browsers, ...). */
  dispose?(): Promise<void>;
}
