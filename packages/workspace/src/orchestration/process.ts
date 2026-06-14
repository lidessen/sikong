import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  fail,
  ok,
  recordRuntimeProcessFinished,
  recordRuntimeProcessStarted,
  type CommandContext,
  type CommandResult,
} from "../commands";
import type { ProcessRunSnapshot, ProcessRunSpec } from "../process";
import type { RuntimeAssemblyConfig } from "../runtime";
import type { OrchestrationExecutionResult } from "./execute";
import type { OrchestrationRunnerOutput } from "./runner";
import { toSerializableOrchestrationAction } from "./runner";
import type { OrchestrationAction } from "./tick";

export interface OrchestrationProcessClient {
  startProcess(spec: ProcessRunSpec): Promise<ProcessRunSnapshot>;
}

export interface OrchestrationProcessExecutionClient extends OrchestrationProcessClient {
  waitProcessRun(runId: string, options?: { timeoutMs?: number }): Promise<ProcessRunSnapshot>;
}

export interface OrchestrationProcessSpecInput {
  runId: string;
  workspaceId: string;
  taskId?: string;
  requestPath: string;
  cwd?: string;
  command?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export function createOrchestrationProcessSpec(
  input: OrchestrationProcessSpecInput,
): ProcessRunSpec {
  return {
    runId: input.runId,
    workspaceId: input.workspaceId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    command: input.command ?? "bun",
    args: ["./src/orchestration/runner.ts", "--spec", input.requestPath],
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.env ? { env: input.env } : {}),
  };
}

export async function startOrchestrationProcess(
  client: OrchestrationProcessClient,
  input: OrchestrationProcessSpecInput,
): Promise<ProcessRunSnapshot> {
  return await client.startProcess(createOrchestrationProcessSpec(input));
}

export interface ExecuteOrchestrationActionProcessInput {
  client: OrchestrationProcessExecutionClient;
  ctx: CommandContext;
  action: OrchestrationAction;
  runtimeAssembly?: RuntimeAssemblyConfig;
  packageCwd?: string;
  command?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  waitTimeoutMs?: number;
  runId?: string;
}

export async function executeOrchestrationActionProcess(
  input: ExecuteOrchestrationActionProcessInput,
): Promise<CommandResult<OrchestrationExecutionResult>> {
  const workspaceId = workspaceIdForAction(input.action) ?? input.ctx.workspaceId;
  if (!workspaceId) return fail("invalid_input", "Workspace id is required.");
  const taskId = taskIdForAction(input.action);
  const runId = input.runId ?? `orchestration_${randomUUID()}`;
  const tempDir = await mkdtemp(join(tmpdir(), "sikong-orchestration-"));

  try {
    const requestPath = join(tempDir, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        context: {
          dataDir: input.ctx.dataDir,
          workspaceId,
          ...(input.ctx.outputMode ? { outputMode: input.ctx.outputMode } : {}),
        },
        action: toSerializableOrchestrationAction(input.action),
        ...(input.runtimeAssembly ? { runtimeAssembly: input.runtimeAssembly } : {}),
      }),
    );

    await input.client.startProcess(
      createOrchestrationProcessSpec({
        runId,
        workspaceId,
        taskId,
        requestPath,
        cwd: input.packageCwd,
        command: input.command,
        env: input.env,
        timeoutMs: input.timeoutMs,
      }),
    );
    if (taskId) {
      const recorded = await recordRuntimeProcessStarted(input.ctx, {
        workspaceId,
        taskId,
        processRunId: runId,
        actionType: input.action.type,
      });
      if (!recorded.ok) return recorded;
    }
    const finished = await input.client.waitProcessRun(
      runId,
      input.waitTimeoutMs !== undefined ? { timeoutMs: input.waitTimeoutMs } : {},
    );
    if (taskId && finished.result) {
      const recorded = await recordRuntimeProcessFinished(input.ctx, {
        workspaceId,
        taskId,
        processRunId: runId,
        processStatus: finished.result.status,
        ...(finished.result.exitCode !== undefined ? { exitCode: finished.result.exitCode } : {}),
      });
      if (!recorded.ok) return recorded;
    }

    if (finished.state !== "finished" || !finished.result) {
      return fail("internal_error", "Orchestration process did not finish.", { runId });
    }
    if (finished.result.status !== "succeeded") {
      return fail("internal_error", "Orchestration process failed.", {
        runId,
        status: finished.result.status,
        exitCode: finished.result.exitCode,
        stderr: finished.result.stderr,
      });
    }

    return parseRunnerOutput(finished.result.stdout, runId);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function parseRunnerOutput(
  stdout: string,
  runId: string,
): CommandResult<OrchestrationExecutionResult> {
  let output: OrchestrationRunnerOutput;
  try {
    output = JSON.parse(stdout) as OrchestrationRunnerOutput;
  } catch {
    return fail("internal_error", "Orchestration process returned invalid JSON.", { runId });
  }
  return output.ok ? ok(output.data) : output;
}

function taskIdForAction(action: OrchestrationAction): string | undefined {
  switch (action.type) {
    case "start_planning_worker":
    case "start_stage_verification_worker":
    case "start_final_verification_worker":
      return action.spec.taskId;
    case "start_stage_worker":
      return action.input.taskId;
    default:
      return action.taskId;
  }
}

function workspaceIdForAction(action: OrchestrationAction): string | undefined {
  switch (action.type) {
    case "start_planning_worker":
    case "start_stage_verification_worker":
    case "start_final_verification_worker":
      return action.spec.workspaceId;
    case "start_stage_worker":
      return action.input.workspaceId;
    case "start_stage_review":
      return action.workspaceId;
    default:
      return undefined;
  }
}
