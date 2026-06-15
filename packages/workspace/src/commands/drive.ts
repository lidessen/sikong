import type { AgentLoop, ToolSet } from "agent-loop";
import { join } from "node:path";
import type { TaskProjection } from "../coordination";
import { FileSettingsStore } from "../settings";
import { LocalProcessExecutionClient } from "../process";
import { defaultRuntimeAssembly, type RuntimeAssemblyConfig } from "../runtime";
import { reconcileTaskRuntime } from "./task";
import {
  executeOrchestrationAction,
  executeOrchestrationActionProcess,
  runOrchestrationUntilWait,
  type OrchestrationAction,
  type OrchestrationDriverResult,
  type OrchestrationInput,
  type OrchestrationProcessExecutionClient,
} from "../orchestration";
import { fail, type CommandContext, type CommandResult } from "./types";

export interface DriveTaskInput {
  taskId: string;
  workspaceId?: string;
  maxActions?: number;
  processTimeoutMs?: number;
  waitTimeoutMs?: number;
  command?: string;
  packageCwd?: string;
  runtimeAssembly?: RuntimeAssemblyConfig;
  processClient?: OrchestrationProcessExecutionClient;
}

export async function driveTask(
  ctx: CommandContext,
  input: DriveTaskInput,
): Promise<CommandResult<OrchestrationDriverResult>> {
  if (!input.taskId.trim()) return fail("invalid_input", "taskId is required.");
  const settings = await new FileSettingsStore(ctx.dataDir).read();
  const workerAssembly =
    input.runtimeAssembly ?? defaultRuntimeAssembly(settings.defaults.worker, "worker");
  const leadAssembly =
    input.runtimeAssembly ?? defaultRuntimeAssembly(settings.defaults.lead, "lead");
  const planningAssembly =
    input.runtimeAssembly ?? defaultRuntimeAssembly(settings.defaults.worker, "planning");
  const reviewAssembly =
    input.runtimeAssembly ?? defaultRuntimeAssembly(settings.defaults.worker, "review");
  const client = input.processClient ?? new LocalProcessExecutionClient();
  const packageCwd =
    input.packageCwd ?? process.env.SIKONG_PACKAGE_CWD ?? join(import.meta.dir, "../..");
  const command = input.command ?? process.env.SIKONG_ORCHESTRATION_RUNNER_COMMAND;

  try {
    const reconciled = await reconcileTaskRuntime(ctx, {
      workspaceId: input.workspaceId,
      taskId: input.taskId,
    });
    if (!reconciled.ok) return reconciled;
    return await runOrchestrationUntilWait({
      ctx,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      buildInput: (projection) => orchestrationInput(projection),
      maxActions: input.maxActions,
      executeAction: async (runCtx, action) => {
        if (!requiresRuntimeProcess(action)) {
          return await executeOrchestrationAction(runCtx, action, {});
        }
        return await executeOrchestrationActionProcess({
          client,
          ctx: runCtx,
          action,
          runtimeAssembly: runtimeAssemblyForAction(action, {
            lead: leadAssembly,
            planning: planningAssembly,
            review: reviewAssembly,
            worker: workerAssembly,
          }),
          packageCwd,
          command,
          timeoutMs: input.processTimeoutMs,
          waitTimeoutMs: input.waitTimeoutMs,
        });
      },
    });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : String(err));
  }
}

function orchestrationInput(projection: TaskProjection): OrchestrationInput {
  return {
    projection,
    tools: {
      leadProtocolTools: emptyTools(),
      planningProtocolTools: emptyTools(),
      stageReviewProtocolTools: emptyTools(),
      finalReviewProtocolTools: emptyTools(),
    },
    workerTaskInput: { loop: fakeLoop },
  };
}

function requiresRuntimeProcess(action: OrchestrationAction): boolean {
  return (
    action.type === "start_lead_requirement_spec" ||
    action.type === "start_planning_worker" ||
    action.type === "start_lead_plan_decision" ||
    action.type === "start_lead_round_planning" ||
    action.type === "start_lead_final_decision" ||
    action.type === "start_stage_worker" ||
    action.type === "start_stage_verification_worker" ||
    action.type === "start_final_verification_worker"
  );
}

function isLeadAction(action: OrchestrationAction): boolean {
  return (
    action.type === "start_lead_requirement_spec" ||
    action.type === "start_lead_plan_decision" ||
    action.type === "start_lead_round_planning" ||
    action.type === "start_lead_final_decision"
  );
}

function runtimeAssemblyForAction(
  action: OrchestrationAction,
  assemblies: {
    lead: RuntimeAssemblyConfig;
    planning: RuntimeAssemblyConfig;
    review: RuntimeAssemblyConfig;
    worker: RuntimeAssemblyConfig;
  },
): RuntimeAssemblyConfig {
  if (isLeadAction(action)) return assemblies.lead;
  if (action.type === "start_planning_worker") return assemblies.planning;
  if (
    action.type === "start_stage_verification_worker" ||
    action.type === "start_final_verification_worker"
  ) {
    return assemblies.review;
  }
  return assemblies.worker;
}

function emptyTools(): ToolSet {
  return {};
}

function fakeLoop(): AgentLoop {
  throw new Error("driveTask uses runtimeAssembly inside the runner process.");
}
