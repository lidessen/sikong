import type { AgentLoop, ToolSet } from "agent-loop";
import { join } from "node:path";
import type { TaskProjection } from "../coordination";
import { FileSettingsStore } from "../settings";
import { LocalProcessExecutionClient } from "../process";
import type { RuntimeAssemblyConfig } from "../runtime";
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
  const runtimeAssembly = input.runtimeAssembly ?? (await workerRuntimeAssembly(ctx.dataDir));
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
          runtimeAssembly,
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

async function workerRuntimeAssembly(dataDir: string): Promise<RuntimeAssemblyConfig> {
  const settings = await new FileSettingsStore(dataDir).read();
  const runtime = settings.defaults.worker;
  const options =
    runtime.provider || runtime.model
      ? {
          ...(runtime.provider ? { provider: runtime.provider } : {}),
          ...(runtime.model ? { model: runtime.model } : {}),
          ...(runtime.backend === "claude-code"
            ? {
                permissionMode: "bypassPermissions",
                allowedTools: ["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "LS"],
              }
            : {}),
        }
      : undefined;
  return {
    backend: options ? { name: runtime.backend, options } : runtime.backend,
    toolProfiles: {
      ...(runtime.backend === "ai-sdk"
        ? {
            inspection: "ai-sdk-local-inspection",
            execution: "ai-sdk-local-execution",
          }
        : {}),
      planningProtocol: "sikong-planning-protocol",
      stageReviewProtocol: "sikong-stage-review-protocol",
      finalReviewProtocol: "sikong-final-review-protocol",
    },
  };
}

function orchestrationInput(projection: TaskProjection): OrchestrationInput {
  return {
    projection,
    tools: {
      planningProtocolTools: emptyTools(),
      stageReviewProtocolTools: emptyTools(),
      finalReviewProtocolTools: emptyTools(),
    },
    workerTaskInput: { loop: fakeLoop },
  };
}

function requiresRuntimeProcess(action: OrchestrationAction): boolean {
  return (
    action.type === "start_planning_worker" ||
    action.type === "start_stage_worker" ||
    action.type === "start_stage_verification_worker" ||
    action.type === "start_final_verification_worker"
  );
}

function emptyTools(): ToolSet {
  return {};
}

function fakeLoop(): AgentLoop {
  throw new Error("driveTask uses runtimeAssembly inside the runner process.");
}
