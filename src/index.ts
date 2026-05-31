import type { BackendAdapter } from "./adapter/adapter";
import { Executor } from "./executor/executor";
import { createAdapter } from "./adapters/registry";
import type { BackendId } from "./core/types";

export { Executor } from "./executor/executor";

/**
 * Create an executor over a backend.
 *
 * Pass an adapter instance (recommended for real backends, which need options):
 *   createExecutor(new ClaudeAdapter({ model: "sonnet" }))
 *
 * Or a built-in id for zero-config backends:
 *   createExecutor("mock")
 */
export function createExecutor(backend: BackendAdapter): Executor;
export function createExecutor(id: BackendId, options?: unknown): Executor;
export function createExecutor(
  backend: BackendAdapter | BackendId,
  options?: unknown,
): Executor {
  const adapter =
    typeof backend === "string" ? createAdapter(backend, options) : backend;
  return new Executor(adapter);
}

// ---- Core types & helpers --------------------------------------------------
export type {
  LoopEvent,
  TokenUsage,
} from "./core/events";
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

// ---- Adapter authoring surface --------------------------------------------
export type {
  AdapterHookBridge,
  BackendAdapter,
  BackendResult,
  BackendRun,
  ResolvedRequest,
} from "./adapter/adapter";
export { createAdapter } from "./adapters/registry";

// ---- Built-in zero-dep adapter --------------------------------------------
export { MockAdapter } from "./adapters/mock";
export type { MockAdapterOptions } from "./adapters/mock";
