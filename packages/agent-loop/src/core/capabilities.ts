/**
 * What a backend can actually do.
 *
 * Adapters declare a `capabilities` array. The executor checks it before using
 * a feature and either degrades honestly or throws `CapabilityNotSupportedError`
 * — it never silently pretends a backend supports something it doesn't.
 */
export type Capability =
  /** Accepts caller-provided tools (`RunInput.tools`). */
  | "tools"
  /** Accepts MCP server configs (`RunInput.mcp`). */
  | "mcp"
  /**
   * Supports native pre-tool interception, so `hooks.onToolUse` can
   * deny / replace-args before a tool executes. Without this, `onToolUse`
   * never fires (post-hoc observation still works via `onToolResult`).
   */
  | "hooks"
  /** Can inject a steer message mid-turn (e.g. Codex `turn/steer`). */
  | "steer.live"
  /** Can inject a steer message, applied at the next step boundary. */
  | "steer.deferred"
  /** Emits `thinking` events. */
  | "thinking"
  /** Emits `usage` events during the run (not just at the end). */
  | "usage"
  /** Can resume a prior session/thread. */
  | "sessionResume"
  /** Can be cancelled mid-run. */
  | "interrupt";

export type CapabilityList = readonly Capability[];

export function hasCapability(caps: CapabilityList, cap: Capability): boolean {
  return caps.includes(cap);
}

/** True if the backend can steer at all (live or deferred). */
export function canSteer(caps: CapabilityList): boolean {
  return caps.includes("steer.live") || caps.includes("steer.deferred");
}
