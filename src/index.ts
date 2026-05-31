// ---- Backend factories (primary API) --------------------------------------
//
//   import { aiSdkLoop, claudeCodeLoop, codexLoop, cursorLoop, mockLoop } from "agent-loop";
//
// Every factory returns the same `AgentLoop` interface; the backend is the only
// thing that differs. Adapters (and their SDKs) load lazily on first use.
export {
  aiSdkLoop,
  claudeCodeLoop,
  codexLoop,
  cursorLoop,
  mockLoop,
} from "./backends";

// ---- The unified loop interface -------------------------------------------
export type { AgentLoop } from "./loop";
/** Advanced: build a loop over a custom `BackendAdapter`. */
export { makeLoop } from "./loop";

// ---- Core types & helpers --------------------------------------------------
export type { LoopEvent, TokenUsage } from "./core/events";
export { addUsage, emptyUsage, estimateTokens } from "./core/events";
export type { EventChannel } from "./core/channel";
export { createEventChannel } from "./core/channel";
export type { Capability, CapabilityList } from "./core/capabilities";
export { canSteer, hasCapability } from "./core/capabilities";
export {
  AgentLoopError,
  CapabilityNotSupportedError,
  PreflightError,
} from "./core/errors";
export type {
  HookDecision,
  Hooks,
  MessageHookEvent,
  RunStartContext,
  StepHookEvent,
  ThinkingHookEvent,
  ToolHookDecision,
  ToolResultHookEvent,
  ToolUseHookEvent,
  UsageHookEvent,
} from "./core/hooks";
export type {
  BackendId,
  McpServerConfig,
  McpServers,
  PreflightResult,
  RunHandle,
  RunInput,
  RunResult,
  RunStatus,
  Skill,
  SteerOutcome,
  ToolDefinition,
  ToolExecutionContext,
  ToolSet,
} from "./core/types";

// ---- Custom-backend authoring ---------------------------------------------
export type {
  AdapterHookBridge,
  BackendAdapter,
  BackendResult,
  BackendRun,
  ResolvedRequest,
} from "./adapter/adapter";
export type { LazyBackend } from "./executor/run-handle";

// ---- Per-backend constructor option types ---------------------------------
export type { AiSdkAdapterOptions } from "./adapters/ai-sdk";
export type { ClaudeAdapterOptions } from "./adapters/claude";
export type { CodexAdapterOptions } from "./adapters/codex";
export type { CursorAdapterOptions } from "./adapters/cursor";
export type { MockAdapterOptions } from "./adapters/mock";
