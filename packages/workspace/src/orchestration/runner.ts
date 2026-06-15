import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { TaskInput } from "agent-loop";
import type { CommandContext, CommandError } from "../commands";
import {
  createRuntimeAssemblyModule,
  type RunWorkerTaskInput,
  type RuntimeAssemblyConfig,
  type WorkerRunSpec,
} from "../runtime";
import type { OrchestrationExecutionResult, OrchestrationExecutionRuntime } from "./execute";
import { executeOrchestrationAction } from "./execute";
import type { OrchestrationAction } from "./tick";

export interface SerializableTaskInput extends Omit<
  TaskInput,
  | "goal"
  | "loop"
  | "gateLoop"
  | "skills"
  | "mcp"
  | "tools"
  | "gateTools"
  | "runHooks"
  | "hooks"
  | "signal"
> {}

export interface SerializableWorkerRunSpec extends Omit<
  WorkerRunSpec,
  "tools" | "skills" | "mcp"
> {}

export interface SerializableStageWorkerInput extends Omit<
  RunWorkerTaskInput,
  "runTask" | "taskInput"
> {
  taskInput?: SerializableTaskInput;
}

export type SerializableOrchestrationAction =
  | {
      type: "start_lead_requirement_spec";
      spec: SerializableWorkerRunSpec;
    }
  | {
      type: "start_planning_worker";
      spec: SerializableWorkerRunSpec;
    }
  | {
      type: "start_lead_plan_decision";
      spec: SerializableWorkerRunSpec;
    }
  | {
      type: "start_lead_round_planning";
      spec: SerializableWorkerRunSpec;
    }
  | {
      type: "start_lead_final_decision";
      spec: SerializableWorkerRunSpec;
    }
  | {
      type: "start_stage_worker";
      input: SerializableStageWorkerInput;
    }
  | {
      type: "await_worker_results";
      taskId: string;
      stageId: string;
      runningRuns: number;
      targetRuns: number;
    }
  | {
      type: "complete_stage_round";
      taskId: string;
      workspaceId: string;
      roundId: string;
    }
  | {
      type: "start_stage_review";
      taskId: string;
      workspaceId: string;
      stageId: string;
    }
  | {
      type: "start_stage_verification_worker";
      spec: SerializableWorkerRunSpec;
      reviewId: string;
    }
  | {
      type: "start_final_verification_worker";
      spec: SerializableWorkerRunSpec;
      reviewId: string;
    }
  | {
      type: "terminal";
      taskId: string;
      outcome: "accepted" | "rejected";
    }
  | {
      type: "blocked";
      taskId: string;
      reason: string;
    };

export interface OrchestrationRunnerContext {
  dataDir: string;
  workspaceId?: string;
  outputMode?: "json" | "text";
}

export interface OrchestrationRunnerRequest {
  context: OrchestrationRunnerContext;
  action: SerializableOrchestrationAction;
  runtimeModule?: string;
  runtimeAssembly?: RuntimeAssemblyConfig;
}

export type OrchestrationRunnerOutput =
  | {
      ok: true;
      data: OrchestrationExecutionResult;
    }
  | {
      ok: false;
      error: CommandError;
    };

export interface OrchestrationRuntimeModule {
  hydrateOrchestrationAction?: (
    request: OrchestrationRunnerRequest,
  ) => OrchestrationAction | Promise<OrchestrationAction>;
  createOrchestrationExecutionRuntime?: (
    request: OrchestrationRunnerRequest,
  ) => OrchestrationExecutionRuntime | Promise<OrchestrationExecutionRuntime>;
}

export async function runOrchestrationRunner(
  argv: readonly string[],
): Promise<OrchestrationRunnerOutput> {
  try {
    const request = await readRequest(argv);
    const runtimeModule = await loadRuntimeModule(request);
    const action = await hydrateAction(request, runtimeModule);
    const runtime = await loadRuntime(request, runtimeModule);
    const result = await executeOrchestrationAction(
      commandContext(request.context),
      action,
      runtime,
    );
    return compactRunnerOutput(result);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function compactRunnerOutput(output: OrchestrationRunnerOutput): OrchestrationRunnerOutput {
  if (!output.ok) return output;
  if (output.data.resultType !== "worker_task_completed") return output;
  return {
    ok: true,
    data: {
      ...output.data,
      projection: compactProjection(output.data.projection),
    },
  };
}

function compactProjection<T extends { workerRuns?: unknown }>(projection: T): T {
  if (!projection.workerRuns || typeof projection.workerRuns !== "object") return projection;
  const workerRuns: Record<string, unknown> = {};
  for (const [runId, run] of Object.entries(projection.workerRuns)) {
    workerRuns[runId] = compactWorkerRun(run);
  }
  return {
    ...projection,
    workerRuns,
  };
}

function compactWorkerRun(run: unknown): unknown {
  if (!run || typeof run !== "object") return run;
  const record = run as Record<string, unknown>;
  const result = record.result;
  if (!result || typeof result !== "object") return run;
  const { observations: _observations, ...restResult } = result as Record<string, unknown>;
  return {
    ...record,
    result: restResult,
  };
}

export async function readOrchestrationRunnerRequest(
  argv: readonly string[],
): Promise<OrchestrationRunnerRequest> {
  return await readRequest(argv);
}

export function toSerializableOrchestrationAction(
  action: OrchestrationAction,
): SerializableOrchestrationAction {
  switch (action.type) {
    case "start_lead_requirement_spec":
    case "start_planning_worker":
    case "start_lead_plan_decision":
    case "start_lead_round_planning":
    case "start_lead_final_decision":
      return { type: action.type, spec: serializableWorkerRunSpec(action.spec) };
    case "start_stage_verification_worker":
      return {
        type: action.type,
        reviewId: action.reviewId,
        spec: serializableWorkerRunSpec(action.spec),
      };
    case "start_final_verification_worker":
      return {
        type: action.type,
        reviewId: action.reviewId,
        spec: serializableWorkerRunSpec(action.spec),
      };
    case "start_stage_worker":
      return {
        type: action.type,
        input: {
          ...action.input,
          taskInput: serializableTaskInput(action.input.taskInput),
        },
      };
    default:
      return action;
  }
}

async function readRequest(argv: readonly string[]): Promise<OrchestrationRunnerRequest> {
  const specPath = readFlag(argv, "spec");
  const text = specPath ? await readFile(specPath, "utf8") : await Bun.stdin.text();
  if (!text.trim()) throw new Error("orchestration runner request JSON is required");
  return JSON.parse(text) as OrchestrationRunnerRequest;
}

async function loadRuntimeModule(
  request: OrchestrationRunnerRequest,
): Promise<OrchestrationRuntimeModule> {
  if (!request.runtimeModule) {
    return request.runtimeAssembly ? createRuntimeAssemblyModule(request.runtimeAssembly) : {};
  }
  const moduleUrl = moduleSpecifierToImport(request.runtimeModule);
  const mod = (await import(moduleUrl)) as OrchestrationRuntimeModule;
  if (!mod.createOrchestrationExecutionRuntime && !mod.hydrateOrchestrationAction) {
    throw new Error(
      "runtime module must export createOrchestrationExecutionRuntime or hydrateOrchestrationAction",
    );
  }
  return mod;
}

async function loadRuntime(
  request: OrchestrationRunnerRequest,
  runtimeModule: OrchestrationRuntimeModule,
): Promise<OrchestrationExecutionRuntime> {
  if (!runtimeModule.createOrchestrationExecutionRuntime) return {};
  return await runtimeModule.createOrchestrationExecutionRuntime(request);
}

function commandContext(context: OrchestrationRunnerContext): CommandContext {
  return {
    dataDir: context.dataDir,
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context.outputMode ? { outputMode: context.outputMode } : {}),
  };
}

async function hydrateAction(
  request: OrchestrationRunnerRequest,
  runtimeModule: OrchestrationRuntimeModule,
): Promise<OrchestrationAction> {
  if (runtimeModule.hydrateOrchestrationAction) {
    return await runtimeModule.hydrateOrchestrationAction(request);
  }
  const { action } = request;
  if (action.type !== "start_stage_worker") return action;
  return {
    ...action,
    input: {
      ...action.input,
      taskInput: action.input.taskInput ?? {},
    } as Extract<OrchestrationAction, { type: "start_stage_worker" }>["input"],
  };
}

function serializableWorkerRunSpec(spec: WorkerRunSpec): SerializableWorkerRunSpec {
  return {
    workspaceId: spec.workspaceId,
    taskId: spec.taskId,
    prompt: spec.prompt,
    ...(spec.runtimeOptions !== undefined ? { runtimeOptions: spec.runtimeOptions } : {}),
    ...(spec.metadata ? { metadata: spec.metadata } : {}),
  };
}

function serializableTaskInput(input: Omit<TaskInput, "goal">): SerializableTaskInput {
  return {
    ...(input.system ? { system: input.system } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.runtimeOptions !== undefined ? { runtimeOptions: input.runtimeOptions } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
    ...(input.maxStepsPerRun !== undefined ? { maxStepsPerRun: input.maxStepsPerRun } : {}),
    ...(input.finishMaxSteps !== undefined ? { finishMaxSteps: input.finishMaxSteps } : {}),
    ...(input.gateMaxSteps !== undefined ? { gateMaxSteps: input.gateMaxSteps } : {}),
  };
}

function moduleSpecifierToImport(specifier: string): string {
  if (specifier.startsWith("file://")) return specifier;
  if (isAbsolute(specifier) || specifier.startsWith(".")) return pathToFileURL(specifier).href;
  return specifier;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const token = String(argv[index] ?? "");
    if (token === `--${name}`) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`--${name} requires a value`);
      return String(value);
    }
    const prefix = `--${name}=`;
    if (token.startsWith(prefix)) return token.slice(prefix.length);
  }
  return undefined;
}

if (import.meta.main) {
  const result = await runOrchestrationRunner(Bun.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
