// ---- Backend factories (primary API) --------------------------------------
//
//   import { aiSdkLoop, claudeCodeLoop, codexLoop, cursorLoop, mockLoop } from "agent-loop";
//
// Every factory returns the same `AgentLoop` interface; the runtime is the only
// thing that differs. Adapters (and their SDKs) load lazily on first use.
export { aiSdkLoop, claudeCodeLoop, codexLoop, cursorLoop, mockLoop } from "./backends";
export type {
  AiSdkLoopOptions,
  ClaudeLoopOptions,
  CodexLoopOptions,
  CursorLoopOptions,
} from "./backends";

// ---- Providers (orthogonal to runtime) ------------------------------------
//
//   import { deepseek, claudeCodeLoop, aiSdkLoop } from "agent-loop";
//   const provider = deepseek({ apiKey });   // one credential…
//   claudeCodeLoop({ provider });            // …drives claude-code
//   aiSdkLoop({ provider });                 // …and ai-sdk
export {
  anthropic,
  anthropicCompatible,
  deepseek,
  gateway,
  modelPricing,
  openai,
  openaiCompatible,
} from "./providers";
export {
  ProviderRuntimeError,
  codexProviderOverrides,
  resolveRuntimeConfig,
} from "./core/provider";
export {
  configureProviders,
  isAutoDiscoverEnabled,
  MissingCredentialError,
  resolveApiKey,
} from "./core/credentials";
export type { ProvidersConfig } from "./core/credentials";
export type {
  AiSdkProviderSpec,
  AiSdkRuntimeConfig,
  ClaudeRuntimeConfig,
  CodexRuntimeConfig,
  CursorRuntimeConfig,
  ModelPricing,
  ModelProvider,
  RuntimeConfig,
  RuntimeConfigFor,
  RuntimeType,
} from "./core/provider";

// ---- The unified loop interface -------------------------------------------
export type { AgentLoop, AgentLoopTaskInput } from "./loop";
/** Advanced: build a loop over a custom `BackendAdapter`. */
export { makeLoop } from "./loop";

// ---- Task layer (outer "ralph" loop over many runs) -----------------------
//
//   import { claudeCodeLoop, deepseek } from "agent-loop";
//   const loop = claudeCodeLoop({ provider: deepseek() });
//   const r = await loop.runTask({ goal });
export { runTask, createExitTools, createGateTools } from "./task";
export type {
  TaskInput,
  TaskHooks,
  TaskResult,
  TaskRoundEnd,
  TaskRoundMode,
  TaskStatus,
  TaskTimelineEntry,
  ExitOutcome,
  ExitToolMode,
  ExitToolOptions,
  GateOutcome,
  GateToolOptions,
  TaskReadContext,
} from "./task";

// ---- Core types & helpers --------------------------------------------------
export type { LoopEvent, TokenUsage } from "./core/events";
export { addUsage, emptyUsage, estimateTokens } from "./core/events";
export type { EventChannel } from "./core/channel";
export { createEventChannel } from "./core/channel";
export type { Capability, CapabilityList } from "./core/capabilities";
export { canSteer, hasCapability } from "./core/capabilities";
export { AgentLoopError, CapabilityNotSupportedError, PreflightError } from "./core/errors";
export {
  createAiSdkTools,
  classifyCommand,
  createEscalationOnToolUse,
  isSandboxFailure,
  isToolchainFailure,
  runOnHost,
} from "./tools";
export type {
  CommandClassifier,
  EscalationDecision,
  HostRunResult,
  AiSdkToolOptions,
  SandboxEscalationConfig,
} from "./tools";
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
export { defineTool } from "./core/types";
export type {
  CleanupOptions,
  CleanupResult,
  CleanupStatus,
  EffortLevel,
  RuntimeId,
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
} from "./core/adapter";
export type { LazyBackend } from "./executor/run-handle";

// ---- Per-backend constructor option types ---------------------------------
export type { AiSdkAdapterOptions, AiSdkRuntimeOptions } from "./adapters/ai-sdk";
export type { ClaudeAdapterOptions } from "./adapters/claude";
export type { CodexAdapterOptions } from "./adapters/codex";
export { discoverCursorModels, resolveCursorModelId } from "./adapters/cursor";
export type { CursorAdapterOptions, CursorModelOption } from "./adapters/cursor";
export type { MockAdapterOptions } from "./adapters/mock";
