import type { CapabilityList } from "./core/capabilities";

/**
 * Per-backend capability lists — the single source of truth used by the loop
 * factories for capability gating and `loop.capabilities`, without having to
 * load the backend's SDK. Each adapter also declares the same list internally;
 * these mirror what the adapters actually wire (verified by live smoke runs).
 */
export const AISDK_CAPS: CapabilityList = [
  "tools",
  "hooks",
  "thinking",
  "usage",
  "steer.deferred",
  "interrupt",
];

export const CLAUDE_CAPS: CapabilityList = [
  "tools",
  "mcp",
  "hooks",
  "thinking",
  "usage",
  "steer.deferred",
  "sessionResume",
  "interrupt",
];

export const CODEX_CAPS: CapabilityList = ["mcp", "steer.live", "thinking", "usage", "interrupt"];

export const CURSOR_CAPS: CapabilityList = ["tools", "mcp", "thinking", "usage", "interrupt"];

export const MOCK_CAPS: CapabilityList = [
  "tools",
  "mcp",
  "hooks",
  "steer.deferred",
  "thinking",
  "usage",
  "interrupt",
];
