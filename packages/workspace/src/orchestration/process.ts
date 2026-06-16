import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  failWorkerRun,
  fail,
  getTask,
  ok,
  recordRuntimeProcessFinished,
  recordRuntimeProcessRunning,
  recordRuntimeProcessStarted,
  type CommandContext,
  type CommandResult,
} from "../commands";
import type { ProcessRunSnapshot, ProcessRunSpec } from "../process";
import type { RuntimeAssemblyConfig } from "../runtime";
import type { OrchestrationExecutionResult, OrchestrationWorkerRunSummary } from "./execute";
import type { OrchestrationRunnerOutput } from "./runner";
import { toSerializableOrchestrationAction } from "./runner";
import type { OrchestrationAction } from "./tick";

export interface OrchestrationProcessClient {
  startProcess(spec: ProcessRunSpec): Promise<ProcessRunSnapshot>;
}

export const DEFAULT_ORCHESTRATION_PROCESS_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_ORCHESTRATION_WAIT_TIMEOUT_MS =
  DEFAULT_ORCHESTRATION_PROCESS_TIMEOUT_MS + 60 * 1000;

export interface OrchestrationProcessExecutionClient extends OrchestrationProcessClient {
  getProcessRun?(runId: string): Promise<ProcessRunSnapshot>;
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
  const command = input.command ?? "bun";
  const args = input.command
    ? ["--spec", input.requestPath]
    : ["./src/orchestration/runner.ts", "--spec", input.requestPath];
  return {
    runId: input.runId,
    workspaceId: input.workspaceId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    command,
    args,
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
  if (input.action.type === "start_stage_workers") {
    return await executeStageWorkerProcesses({ ...input, action: input.action });
  }

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
    const runningMonitor = taskId
      ? monitorProcessRunning(input.ctx, input.client, {
          workspaceId,
          taskId,
          processRunId: runId,
        })
      : undefined;
    const finished = await input.client.waitProcessRun(
      runId,
      input.waitTimeoutMs !== undefined ? { timeoutMs: input.waitTimeoutMs } : {},
    );
    if (runningMonitor) {
      const monitored = await runningMonitor;
      if (monitored && !monitored.ok) return monitored;
    }
    if (taskId && finished.result) {
      const recorded = await recordRuntimeProcessFinished(input.ctx, {
        workspaceId,
        taskId,
        processRunId: runId,
        processStatus: finished.result.status,
        ...(finished.result.exitCode !== undefined ? { exitCode: finished.result.exitCode } : {}),
      });
      if (!recorded.ok) return recorded;
      if (finished.result.status !== "succeeded") {
        const marked = await recordProcessActionFailure(input, {
          workspaceId,
          taskId,
          runId,
          status: finished.result.status,
          exitCode: finished.result.exitCode,
          stderr: finished.result.stderr,
        });
        if (!marked.ok) return marked;
      }
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

async function executeStageWorkerProcesses(
  input: ExecuteOrchestrationActionProcessInput & {
    action: Extract<OrchestrationAction, { type: "start_stage_workers" }>;
  },
): Promise<CommandResult<OrchestrationExecutionResult>> {
  if (input.action.inputs.length === 0) {
    return fail("invalid_input", "start_stage_workers requires at least one worker input.");
  }
  const workspaceId = input.action.inputs[0]?.workspaceId ?? input.ctx.workspaceId;
  if (!workspaceId) return fail("invalid_input", "Workspace id is required.");
  const taskId = input.action.inputs[0]?.taskId;
  if (!taskId) return fail("invalid_input", "Task id is required for stage worker execution.");

  const tempDir = await mkdtemp(join(tmpdir(), "sikong-orchestration-"));
  try {
    const launched = await Promise.all(
      input.action.inputs.map(async (workerInput, index) => {
        const action: OrchestrationAction = {
          type: "start_stage_worker",
          input: workerInput,
        };
        const runId = `orchestration_${randomUUID()}`;
        const requestPath = join(tempDir, `request-${index}.json`);
        await writeFile(
          requestPath,
          JSON.stringify({
            context: {
              dataDir: input.ctx.dataDir,
              workspaceId,
              ...(input.ctx.outputMode ? { outputMode: input.ctx.outputMode } : {}),
            },
            action: toSerializableOrchestrationAction(action),
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
        const recorded = await recordRuntimeProcessStarted(input.ctx, {
          workspaceId,
          taskId,
          processRunId: runId,
          actionType: action.type,
        });
        if (!recorded.ok) return recorded;
        const runningMonitor = monitorProcessRunning(input.ctx, input.client, {
          workspaceId,
          taskId,
          processRunId: runId,
        });
        return ok({ action, runId, runningMonitor });
      }),
    );

    const failedLaunch = launched.find((item) => !item.ok);
    if (failedLaunch && !failedLaunch.ok) return failedLaunch;
    const active = launched.filter((item): item is Extract<typeof item, { ok: true }> => item.ok);

    const finished = await Promise.all(
      active.map(async (item) => {
        const snapshot = await input.client.waitProcessRun(
          item.data.runId,
          input.waitTimeoutMs !== undefined ? { timeoutMs: input.waitTimeoutMs } : {},
        );
        const monitored = await item.data.runningMonitor;
        if (monitored && !monitored.ok) return { ...item.data, snapshot, error: monitored };
        if (snapshot.result) {
          const recorded = await recordRuntimeProcessFinished(input.ctx, {
            workspaceId,
            taskId,
            processRunId: item.data.runId,
            processStatus: snapshot.result.status,
            ...(snapshot.result.exitCode !== undefined
              ? { exitCode: snapshot.result.exitCode }
              : {}),
          });
          if (!recorded.ok) return { ...item.data, snapshot, error: recorded };
          if (snapshot.result.status !== "succeeded") {
            const marked = await recordProcessActionFailure(
              { ...input, action: item.data.action },
              {
                workspaceId,
                taskId,
                runId: item.data.runId,
                status: snapshot.result.status,
                exitCode: snapshot.result.exitCode,
                stderr: snapshot.result.stderr,
              },
            );
            if (!marked.ok) return { ...item.data, snapshot, error: marked };
          }
        }
        return { ...item.data, snapshot };
      }),
    );

    const outputs: OrchestrationWorkerRunSummary[] = [];
    for (const item of finished) {
      if ("error" in item && item.error && !item.error.ok) return item.error;

      if (item.snapshot.state !== "finished" || !item.snapshot.result) {
        return fail("internal_error", "Orchestration process did not finish.", {
          runId: item.runId,
        });
      }
      if (item.snapshot.result.status !== "succeeded") {
        return fail("internal_error", "Orchestration process failed.", {
          runId: item.runId,
          status: item.snapshot.result.status,
          exitCode: item.snapshot.result.exitCode,
          stderr: item.snapshot.result.stderr,
        });
      }

      const parsed = parseRunnerOutput(item.snapshot.result.stdout, item.runId);
      if (!parsed.ok) return parsed;
      if (parsed.data.resultType !== "worker_task_completed") {
        return fail("internal_error", "Stage worker process returned unexpected result.", {
          runId: item.runId,
          resultType: parsed.data.resultType,
        });
      }
      outputs.push(parsed.data.run);
    }

    const latest = await getTask(input.ctx, { workspaceId, taskId });
    if (!latest.ok) return latest;
    return ok({
      resultType: "worker_tasks_completed",
      runs: outputs,
      projection: latest.data.projection,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function monitorProcessRunning(
  ctx: CommandContext,
  client: OrchestrationProcessExecutionClient,
  input: {
    workspaceId: string;
    taskId: string;
    processRunId: string;
  },
): Promise<CommandResult<{ projection: unknown }> | undefined> {
  if (!client.getProcessRun) return undefined;
  for (;;) {
    const snapshot = await client.getProcessRun(input.processRunId);
    if (snapshot.state === "running") {
      return await recordRuntimeProcessRunning(ctx, input);
    }
    if (snapshot.state === "finished") return undefined;
    await sleep(500);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordProcessActionFailure(
  input: ExecuteOrchestrationActionProcessInput,
  result: {
    workspaceId: string;
    taskId: string;
    runId: string;
    status: string;
    exitCode?: number;
    stderr?: string;
  },
): Promise<CommandResult<unknown>> {
  if (input.action.type !== "start_stage_worker") return ok({});
  const actionInput = input.action.input;

  const task = await getTask(input.ctx, {
    workspaceId: result.workspaceId,
    taskId: result.taskId,
  });
  if (!task.ok) return task;

  const run = Object.values(task.data.projection.workerRuns)
    .filter(
      (candidate) =>
        candidate.status === "running" &&
        candidate.roundId === actionInput.roundId &&
        candidate.workUnitId === actionInput.workUnitId,
    )
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];
  if (!run) return ok({});

  const detail = [
    `Orchestration process ${result.runId} ended with ${result.status}.`,
    result.exitCode === undefined ? undefined : `Exit code: ${result.exitCode}.`,
    result.stderr?.trim() ? `stderr: ${result.stderr.trim()}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return await failWorkerRun(input.ctx, {
    workspaceId: result.workspaceId,
    taskId: result.taskId,
    runId: run.runId,
    summary: detail,
    report: detail,
  });
}

function parseRunnerOutput(
  stdout: string,
  runId: string,
): CommandResult<OrchestrationExecutionResult> {
  const output = parseLastRunnerJson(stdout);
  if (!output) {
    return fail("internal_error", "Orchestration process returned invalid JSON.", {
      runId,
      stdoutTail: stdout.slice(-1_000),
    });
  }
  return output.ok ? ok(output.data) : output;
}

function parseLastRunnerJson(stdout: string): OrchestrationRunnerOutput | undefined {
  const lines = stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const parsed = JSON.parse(lines[index] ?? "") as OrchestrationRunnerOutput;
      if (parsed && typeof parsed === "object" && "ok" in parsed) return parsed;
    } catch {
      // Keep scanning older lines; runtime adapters may print diagnostics before the runner result.
    }
  }
  return undefined;
}

function taskIdForAction(action: OrchestrationAction): string | undefined {
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

function workspaceIdForAction(action: OrchestrationAction): string | undefined {
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
