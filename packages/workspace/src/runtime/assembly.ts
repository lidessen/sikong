import {
  aiSdkLoop,
  claudeCodeLoop,
  codexLoop,
  createAiSdkTools,
  cursorLoop,
  anthropic,
  deepseek,
  mockLoop,
  openai,
  type AgentLoop,
  type AiSdkLoopOptions,
  type AiSdkToolOptions,
  type ClaudeLoopOptions,
  type CodexLoopOptions,
  type CursorLoopOptions,
  type ModelProvider,
  type TaskInput,
  type TaskResult,
  type ToolSet,
} from "agent-loop";
import { getTask } from "../commands";
import type { OrchestrationExecutionRuntime } from "../orchestration/execute";
import type {
  OrchestrationRunnerRequest,
  SerializableOrchestrationAction,
  OrchestrationRuntimeModule,
} from "../orchestration/runner";
import type { OrchestrationAction } from "../orchestration/tick";
import {
  createFinalReviewProtocolTools,
  createLeadProtocolTools,
  createPlanningProtocolTools,
  createStageReviewProtocolTools,
} from "./protocol-tools";
import { mergeToolSets } from "./presets/tools";

export interface RuntimeBackendConfig {
  name: string;
  options?: unknown;
}

export interface RuntimeAssemblyToolProfiles {
  inspection?: string;
  execution?: string;
  leadProtocol?: string;
  planningProtocol?: string;
  stageReviewProtocol?: string;
  finalReviewProtocol?: string;
}

export interface RuntimeAssemblyConfig {
  backend?: string | RuntimeBackendConfig;
  toolProfiles?: RuntimeAssemblyToolProfiles;
}

export interface RuntimeAssemblyContext {
  request?: OrchestrationRunnerRequest;
}

export type RuntimeBackendFactory = (
  config: RuntimeBackendConfig,
  context: RuntimeAssemblyContext,
) => AgentLoop | Promise<AgentLoop>;

export type ToolProfileFactory = (
  context: RuntimeAssemblyContext,
) => ToolSet | undefined | Promise<ToolSet | undefined>;

export class RuntimeAssemblyRegistry {
  private readonly backends = new Map<string, RuntimeBackendFactory>();
  private readonly toolProfiles = new Map<string, ToolProfileFactory>();

  registerBackend(name: string, factory: RuntimeBackendFactory): this {
    this.backends.set(name, factory);
    return this;
  }

  registerToolProfile(name: string, factory: ToolProfileFactory): this {
    this.toolProfiles.set(name, factory);
    return this;
  }

  async createExecutionRuntime(
    config: RuntimeAssemblyConfig = {},
    context: RuntimeAssemblyContext = {},
  ): Promise<OrchestrationExecutionRuntime> {
    const loop = await this.createLoop(config.backend ?? "mock", context);
    return {
      loop,
      runTask: async (input) => runTaskWithLoop(loop, input),
    };
  }

  async hydrateAction(
    action: OrchestrationAction,
    config: RuntimeAssemblyConfig = {},
    context: RuntimeAssemblyContext = {},
  ): Promise<OrchestrationAction> {
    const profiles = config.toolProfiles ?? {};
    switch (action.type) {
      case "start_lead_requirement_spec":
      case "start_lead_plan_decision":
      case "start_lead_round_planning":
      case "start_lead_final_decision":
        return {
          ...action,
          spec: {
            ...action.spec,
            tools: mergeToolSets(
              await this.resolveToolProfile(profiles.inspection, context),
              await this.resolveToolProfile(profiles.leadProtocol, context),
            ),
          },
        };
      case "start_planning_worker":
        return {
          ...action,
          spec: {
            ...action.spec,
            tools: mergeToolSets(
              await this.resolveToolProfile(profiles.inspection, context),
              await this.resolveToolProfile(profiles.planningProtocol, context),
            ),
          },
        };
      case "start_stage_verification_worker":
        return {
          ...action,
          spec: {
            ...action.spec,
            tools: mergeToolSets(
              await this.resolveToolProfile(profiles.inspection, context),
              await this.resolveToolProfile(profiles.stageReviewProtocol, context),
            ),
          },
        };
      case "start_final_verification_worker":
        return {
          ...action,
          spec: {
            ...action.spec,
            tools: mergeToolSets(
              await this.resolveToolProfile(profiles.inspection, context),
              await this.resolveToolProfile(profiles.finalReviewProtocol, context),
            ),
          },
        };
      case "start_stage_worker":
        return {
          ...action,
          input: {
            ...action.input,
            taskInput: {
              ...action.input.taskInput,
              tools: mergeToolSets(
                action.input.taskInput?.tools,
                await this.resolveToolProfile(profiles.execution, context),
              ),
            },
          },
        };
      case "start_stage_workers":
        return {
          ...action,
          inputs: await Promise.all(
            action.inputs.map(async (input) => ({
              ...input,
              taskInput: {
                ...input.taskInput,
                tools: mergeToolSets(
                  input.taskInput?.tools,
                  await this.resolveToolProfile(profiles.execution, context),
                ),
              },
            })),
          ),
        };
      default:
        return action;
    }
  }

  createRuntimeModule(config: RuntimeAssemblyConfig = {}): OrchestrationRuntimeModule {
    return {
      hydrateOrchestrationAction: async (request) =>
        await this.hydrateAction(request.action as OrchestrationAction, config, { request }),
      createOrchestrationExecutionRuntime: async (request) =>
        await this.createExecutionRuntime(config, { request }),
    };
  }

  private async createLoop(
    backend: string | RuntimeBackendConfig,
    context: RuntimeAssemblyContext,
  ): Promise<AgentLoop> {
    const rawConfig = typeof backend === "string" ? { name: backend } : backend;
    const config = {
      ...rawConfig,
      options: await runtimeBackendOptions(rawConfig.name, rawConfig.options, context),
    };
    const factory = this.backends.get(config.name);
    if (!factory) throw new Error(`Unknown runtime backend: ${config.name}`);
    return await factory(config, context);
  }

  private async resolveToolProfile(
    name: string | undefined,
    context: RuntimeAssemblyContext,
  ): Promise<ToolSet | undefined> {
    if (!name) return undefined;
    const factory = this.toolProfiles.get(name);
    if (!factory) throw new Error(`Unknown tool profile: ${name}`);
    return await factory(context);
  }
}

export function createDefaultRuntimeAssemblyRegistry(): RuntimeAssemblyRegistry {
  return new RuntimeAssemblyRegistry()
    .registerBackend("mock", (config) => mockLoop(backendOptions(config.options)))
    .registerBackend("ai-sdk", (config) =>
      aiSdkLoop(backendOptions<AiSdkLoopOptions>(config.options)),
    )
    .registerBackend("claude-code", (config) =>
      claudeCodeLoop(backendOptions<ClaudeLoopOptions>(config.options)),
    )
    .registerBackend("codex", (config) =>
      codexLoop(backendOptions<CodexLoopOptions>(config.options)),
    )
    .registerBackend("cursor", (config) =>
      cursorLoop(backendOptions<CursorLoopOptions>(config.options)),
    )
    .registerToolProfile("empty", () => undefined)
    .registerToolProfile("ai-sdk-local-inspection", createAiSdkLocalInspectionTools)
    .registerToolProfile("ai-sdk-local-execution", createAiSdkLocalExecutionTools)
    .registerToolProfile("sikong-lead-protocol", createLeadProtocolTools)
    .registerToolProfile("sikong-planning-protocol", createPlanningProtocolTools)
    .registerToolProfile("sikong-stage-review-protocol", createStageReviewProtocolTools)
    .registerToolProfile("sikong-final-review-protocol", createFinalReviewProtocolTools);
}

export async function createRuntimeAssembly(
  config: RuntimeAssemblyConfig = {},
  registry = createDefaultRuntimeAssemblyRegistry(),
): Promise<OrchestrationExecutionRuntime> {
  return await registry.createExecutionRuntime(config);
}

export function createRuntimeAssemblyModule(
  config: RuntimeAssemblyConfig = {},
  registry = createDefaultRuntimeAssemblyRegistry(),
): OrchestrationRuntimeModule {
  return registry.createRuntimeModule(config);
}

function runTaskWithLoop(loop: AgentLoop, input: TaskInput): Promise<TaskResult> {
  const { loop: _ignoredLoop, ...rest } = input;
  return loop.runTask(rest);
}

function backendOptions<T extends object = Record<string, unknown>>(options: unknown): T {
  return (options && typeof options === "object" ? options : {}) as T;
}

async function runtimeBackendOptions(
  backend: string,
  options: unknown,
  context: RuntimeAssemblyContext,
): Promise<Record<string, unknown>> {
  const base = runtimeProviderOptions(backend, backendOptions(options));
  const cwd = await resolveRuntimeCwd(context);
  if (!cwd) {
    if (requiresTaskRuntimeCwd(backend, context)) {
      throw new Error(`${backend} task runtime requires an explicit task runtime cwd.`);
    }
    return base;
  }
  if (Object.hasOwn(base, "cwd")) return base;

  if (backend === "claude-code") {
    return {
      ...base,
      cwd,
      allowedPaths: Object.hasOwn(base, "allowedPaths") ? base.allowedPaths : [cwd],
    };
  }

  if (backend === "codex") {
    return {
      ...base,
      cwd,
      fullAuto: Object.hasOwn(base, "fullAuto") ? base.fullAuto : true,
      sandbox: Object.hasOwn(base, "sandbox") ? base.sandbox : "workspace-write",
    };
  }

  if (backend === "cursor") {
    return {
      ...base,
      cwd,
      sandboxEnabled: Object.hasOwn(base, "sandboxEnabled") ? base.sandboxEnabled : false,
    };
  }

  return base;
}

function requiresTaskRuntimeCwd(backend: string, context: RuntimeAssemblyContext): boolean {
  const actionType = context.request?.action.type;
  return (
    (backend === "claude-code" || backend === "codex" || backend === "cursor") &&
    (actionType === "start_planning_worker" ||
      actionType === "start_stage_worker" ||
      actionType === "start_stage_workers" ||
      actionType === "start_stage_verification_worker" ||
      actionType === "start_final_verification_worker")
  );
}

function runtimeProviderOptions(
  backend: string,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const providerName = typeof options.provider === "string" ? options.provider.trim() : "";
  if (!providerName) return options;

  const { provider: _providerName, ...rest } = options;
  if (backend === "cursor") return rest;

  const model =
    typeof options.model === "string" && options.model.trim() ? options.model : undefined;
  return {
    ...rest,
    provider: createRuntimeProvider(providerName, model),
  };
}

function createRuntimeProvider(providerName: string, model?: string): ModelProvider {
  switch (providerName) {
    case "deepseek":
      return deepseek(model ? { model } : {});
    case "anthropic":
      return anthropic(model ? { model } : {});
    case "openai":
      return openai(model ? { model } : {});
    default:
      throw new Error(`Unknown runtime provider: ${providerName}`);
  }
}

async function createAiSdkLocalInspectionTools(context: RuntimeAssemblyContext): Promise<ToolSet> {
  return pickTools(await createAiSdkLocalTools(context), [
    "readFile",
    "viewFile",
    "rg",
    "grep",
    "web_fetch",
    "web_search",
  ]);
}

async function createAiSdkLocalExecutionTools(context: RuntimeAssemblyContext): Promise<ToolSet> {
  return await createAiSdkLocalTools(context);
}

async function createAiSdkLocalTools(context: RuntimeAssemblyContext): Promise<ToolSet> {
  const cwd = await resolveRuntimeCwd(context);
  if (!cwd) {
    throw new Error("AI SDK local tools require task runtime cwd.");
  }
  return await createAiSdkTools({
    cwd,
  } satisfies AiSdkToolOptions);
}

function pickTools(tools: ToolSet, names: readonly string[]): ToolSet {
  const picked: ToolSet = {};
  for (const name of names) {
    if (tools[name]) picked[name] = tools[name];
  }
  return picked;
}

async function resolveRuntimeCwd(context: RuntimeAssemblyContext): Promise<string | undefined> {
  const request = context.request;
  const taskId = request ? taskIdFromAction(request.action) : undefined;
  if (!request || !taskId) return undefined;

  try {
    const loaded = await getTask(
      {
        dataDir: request.context.dataDir,
        ...(request.context.workspaceId ? { workspaceId: request.context.workspaceId } : {}),
        ...(request.context.outputMode ? { outputMode: request.context.outputMode } : {}),
      },
      {
        ...((workspaceIdFromAction(request.action) ?? request.context.workspaceId)
          ? { workspaceId: workspaceIdFromAction(request.action) ?? request.context.workspaceId }
          : {}),
        taskId,
      },
    );
    return loaded.ok ? loaded.data.projection.runtime?.cwd : undefined;
  } catch {
    return undefined;
  }
}

function taskIdFromAction(action: SerializableOrchestrationAction): string | undefined {
  switch (action.type) {
    case "start_lead_requirement_spec":
    case "start_planning_worker":
    case "start_lead_plan_decision":
    case "start_lead_round_planning":
    case "start_lead_final_decision":
    case "start_stage_verification_worker":
    case "start_final_verification_worker":
      return action.spec.taskId;
    case "start_stage_worker":
      return action.input.taskId;
    case "start_stage_workers":
      return action.inputs[0]?.taskId;
    default:
      return action.taskId;
  }
}

function workspaceIdFromAction(action: SerializableOrchestrationAction): string | undefined {
  switch (action.type) {
    case "start_lead_requirement_spec":
    case "start_planning_worker":
    case "start_lead_plan_decision":
    case "start_lead_round_planning":
    case "start_lead_final_decision":
    case "start_stage_verification_worker":
    case "start_final_verification_worker":
      return action.spec.workspaceId;
    case "start_stage_worker":
      return action.input.workspaceId;
    case "start_stage_workers":
      return action.inputs[0]?.workspaceId;
    case "start_stage_review":
      return action.workspaceId;
    default:
      return undefined;
  }
}
