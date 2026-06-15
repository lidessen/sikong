import type { AgentLoop, ToolSet } from "agent-loop";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  addWorkspacePreference,
  acceptPlan,
  acceptStageReview,
  acceptTask,
  completeWorkerRun,
  createTask,
  createWorkspace,
  deleteWorkspace,
  exceedWorkerRunBudget,
  failWorkerRun,
  getTask,
  getWorkspace,
  inspectTaskCompact,
  inspectTaskEvents,
  inspectTaskProjection,
  inspectTaskSummary,
  inspectTaskTrace,
  listWorkspacePreferences,
  listWorkspaces,
  ok,
  recommendFinalReview,
  rejectPlan,
  rejectStageReview,
  rejectTask,
  recordRuntimeProcessFinished,
  reconcileTaskRuntime,
  removeWorkspacePreference,
  startStageReview,
  startWorkerRun,
  submitPlan,
  waitTask,
  type CommandContext,
  type CommandResult,
  type FinishWorkerRunInput,
  type SubmitPlanInput,
} from "../commands";
import { resolveDataDir } from "../data-dir";
import type { TaskProjection } from "../coordination";
import { DaemonProcessClient, DaemonProcessClientError, type DaemonProcessFetch } from "../process";
import { FileSettingsStore, type DefaultAgentRuntime } from "../settings";
import {
  executeOrchestrationAction,
  executeOrchestrationActionProcess,
  runOrchestrationUntilWait,
  type OrchestrationAction,
  type OrchestrationInput,
  type OrchestrationProcessExecutionClient,
} from "../orchestration";
import type { RuntimeAssemblyConfig } from "../runtime";

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  processClient?: OrchestrationProcessExecutionClient;
  daemonFetch?: DaemonProcessFetch;
  webFetch?: DaemonProcessFetch;
  daemonSpawner?: DaemonSpawner;
  packageCwd?: string;
}

export interface DaemonSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface DaemonSpawnResult {
  pid?: number;
}

export type DaemonSpawner = (spec: DaemonSpawnSpec) => Promise<DaemonSpawnResult>;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

type CliCommandData = Record<string, unknown>;

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  try {
    const parsed = parseArgs(argv);
    if (flag(parsed, "help") || flag(parsed, "h")) return text(0, usage());
    if (flag(parsed, "version") || flag(parsed, "v")) {
      return text(0, JSON.stringify({ ok: true, data: { version: "0.0.0" } }) + "\n");
    }

    const dataDir = value(parsed, "data-dir");
    const workspaceId = value(parsed, "workspace");
    const outputMode = flag(parsed, "text") ? "text" : "json";
    const ctx: CommandContext = {
      dataDir: resolveDataDir({ dataDir, env }).dir,
      ...(workspaceId ? { workspaceId } : {}),
      outputMode,
    };

    const result = await dispatch(ctx, parsed, env, options);
    return render(result, outputMode);
  } catch (err) {
    return render(
      {
        ok: false,
        error: {
          code: "invalid_input",
          message: err instanceof Error ? err.message : String(err),
        },
      },
      "json",
    );
  }
}

async function dispatch(
  ctx: CommandContext,
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
  options: CliRunOptions,
): Promise<CommandResult<CliCommandData>> {
  const [resource, action, arg] = parsed.positionals;

  if (!resource) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "Command is required." },
    };
  }

  if (resource === "workspace") {
    if (action === "create") {
      return createWorkspace(ctx, {
        id: required(value(parsed, "id"), "--id is required."),
        name: required(value(parsed, "name"), "--name is required."),
      });
    }
    if (action === "list") return listWorkspaces(ctx);
    if (action === "show")
      return getWorkspace(ctx, { workspaceId: required(arg, "workspace id is required.") });
    if (action === "delete") {
      return deleteWorkspace(ctx, { workspaceId: required(arg, "workspace id is required.") });
    }
  }

  if (resource === "preference") {
    if (action === "list")
      return listWorkspacePreferences(ctx, { workspaceId: value(parsed, "workspace") });
    if (action === "add") {
      return addWorkspacePreference(ctx, {
        workspaceId: value(parsed, "workspace"),
        text: required(value(parsed, "text") ?? arg, "--text is required."),
        note: value(parsed, "note"),
      });
    }
    if (action === "remove") {
      return removeWorkspacePreference(ctx, {
        workspaceId: value(parsed, "workspace"),
        preferenceId: required(arg, "preference id is required."),
      });
    }
  }

  if (resource === "task") {
    if (action === "create") {
      return createTask(ctx, {
        workspaceId: value(parsed, "workspace"),
        request: required(value(parsed, "request") ?? arg, "--request is required."),
        cwd: value(parsed, "cwd"),
        repoPath: value(parsed, "repo"),
      });
    }
    if (action === "show")
      return getTask(ctx, {
        workspaceId: value(parsed, "workspace"),
        taskId: required(arg, "task id is required."),
      });
    if (action === "drive") {
      return driveTask(ctx, parsed, arg, env, options);
    }
    if (action === "wait") {
      return waitTask(ctx, {
        ...taskInput(parsed, arg),
        timeoutMs: optionalNonNegativeNumber(
          value(parsed, "timeout-ms"),
          "--timeout-ms must be a non-negative integer.",
        ),
        intervalMs: optionalNumber(
          value(parsed, "interval-ms"),
          "--interval-ms must be a positive integer.",
        ),
      });
    }
    if (action === "submit-plan") {
      return submitPlan(ctx, {
        ...taskInput(parsed, arg),
        ...parsePlanJson(required(value(parsed, "plan-json"), "--plan-json is required.")),
      });
    }
    if (action === "accept-plan") {
      return acceptPlan(ctx, {
        ...taskInput(parsed, arg),
        planId: required(value(parsed, "plan"), "--plan is required."),
        version: requiredNumber(value(parsed, "version"), "--version is required."),
        report: required(value(parsed, "report"), "--report is required."),
      });
    }
    if (action === "reject-plan") {
      return rejectPlan(ctx, {
        ...taskInput(parsed, arg),
        planId: required(value(parsed, "plan"), "--plan is required."),
        version: requiredNumber(value(parsed, "version"), "--version is required."),
        report: required(value(parsed, "report"), "--report is required."),
        requestedChanges: value(parsed, "requested-changes"),
      });
    }
    if (action === "start-worker") {
      return startWorkerRun(ctx, {
        ...taskInput(parsed, arg),
        stageId: value(parsed, "stage"),
        workerId: value(parsed, "worker"),
        objective: value(parsed, "objective"),
      });
    }
    if (action === "complete-worker") {
      return completeWorkerRun(ctx, workerResultInput(parsed, arg));
    }
    if (action === "fail-worker") {
      return failWorkerRun(ctx, workerResultInput(parsed, arg));
    }
    if (action === "exceed-worker-budget") {
      return exceedWorkerRunBudget(ctx, workerResultInput(parsed, arg));
    }
    if (action === "start-stage-review") {
      return startStageReview(ctx, { ...taskInput(parsed, arg), stageId: value(parsed, "stage") });
    }
    if (action === "accept-stage-review") {
      return acceptStageReview(ctx, {
        ...taskInput(parsed, arg),
        reviewId: required(value(parsed, "review"), "--review is required."),
        report: required(value(parsed, "report"), "--report is required."),
      });
    }
    if (action === "reject-stage-review") {
      return rejectStageReview(ctx, {
        ...taskInput(parsed, arg),
        reviewId: required(value(parsed, "review"), "--review is required."),
        report: required(value(parsed, "report"), "--report is required."),
        requestedChanges: value(parsed, "requested-changes"),
      });
    }
    if (action === "recommend-final-review") {
      return recommendFinalReview(ctx, {
        ...taskInput(parsed, arg),
        reviewId: required(value(parsed, "review"), "--review is required."),
        recommendation: recommendation(value(parsed, "recommendation")),
        report: required(value(parsed, "report"), "--report is required."),
      });
    }
    if (action === "accept") {
      return acceptTask(ctx, {
        ...taskInput(parsed, arg),
        report: required(value(parsed, "report"), "--report is required."),
      });
    }
    if (action === "reject") {
      return rejectTask(ctx, {
        ...taskInput(parsed, arg),
        report: required(value(parsed, "report"), "--report is required."),
      });
    }
    if (action === "cancel") {
      return cancelTaskRuntimeProcesses(ctx, parsed, arg, env, options);
    }
    if (action === "reconcile") {
      return reconcileTaskRuntime(ctx, taskInput(parsed, arg));
    }
  }

  if (resource === "inspect") {
    const taskId = required(arg, "task id is required.");
    if (action === "summary")
      return inspectTaskSummary(ctx, { workspaceId: value(parsed, "workspace"), taskId });
    if (action === "compact")
      return inspectTaskCompact(ctx, { workspaceId: value(parsed, "workspace"), taskId });
    if (action === "events")
      return inspectTaskEvents(ctx, { workspaceId: value(parsed, "workspace"), taskId });
    if (action === "projection") {
      return inspectTaskProjection(ctx, { workspaceId: value(parsed, "workspace"), taskId });
    }
    if (action === "trace") {
      return inspectTaskTrace(ctx, {
        workspaceId: value(parsed, "workspace"),
        taskId,
        follow: Boolean(flag(parsed, "follow")),
      });
    }
  }

  if (resource === "daemon") {
    if (action === "start") return daemonStart(parsed, env, options);
    if (action === "status") return daemonStatus(parsed, env, options);
    if (action === "stop") return daemonStop(parsed, env, options);
  }

  return {
    ok: false,
    error: {
      code: "invalid_input",
      message: `Unknown command: ${parsed.positionals.join(" ")}`,
    },
  };
}

async function daemonStart(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
  options: CliRunOptions,
): Promise<CommandResult<CliCommandData>> {
  const rawAddr = value(parsed, "daemon") ?? env.SIKONG_DAEMON_ADDR;
  const baseUrl = daemonBaseUrl(rawAddr);
  const client = new DaemonProcessClient({
    baseUrl,
    ...(options.daemonFetch ? { fetch: options.daemonFetch } : {}),
  });
  const packageCwd =
    value(parsed, "package-cwd") ?? options.packageCwd ?? join(import.meta.dir, "../../../..");
  const spawn = options.daemonSpawner ?? spawnDaemon;
  const webRequested = flag(parsed, "ui") || flag(parsed, "web");
  const waitOptions = {
    timeoutMs:
      optionalNonNegativeNumber(
        value(parsed, "timeout-ms"),
        "--timeout-ms must be a non-negative integer.",
      ) ?? 2000,
    intervalMs:
      optionalNumber(value(parsed, "interval-ms"), "--interval-ms must be a positive integer.") ??
      50,
  };
  let webResult: Record<string, unknown> | undefined;
  const existingHealth = await tryDaemonHealth(client);
  if (existingHealth.ok) {
    if (webRequested) {
      const web = await ensureWebUI(parsed, env, options, packageCwd, spawn, waitOptions);
      if (!web.ok) return web;
      webResult = web.data;
    }
    return {
      ok: true,
      data: {
        baseUrl,
        started: false,
        alreadyRunning: true,
        health: existingHealth.health,
        ...(webResult ? { web: webResult } : {}),
      },
    };
  }

  let spawned: DaemonSpawnResult;
  try {
    const spawnSpec = await daemonSpawnSpec(packageCwd, daemonAddr(rawAddr));
    spawned = await spawn(spawnSpec);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "daemon_error",
        message: err instanceof Error ? err.message : String(err),
        details: { baseUrl },
      },
    };
  }
  const waited = await waitForDaemonHealth(client, {
    timeoutMs: waitOptions.timeoutMs,
    intervalMs: waitOptions.intervalMs,
  });
  if (!waited.ok) {
    return {
      ok: false,
      error: {
        code: "daemon_error",
        message: "Daemon did not become healthy before timeout.",
        details: { baseUrl, ...(spawned.pid !== undefined ? { pid: spawned.pid } : {}) },
      },
    };
  }
  if (webRequested) {
    const web = await ensureWebUI(parsed, env, options, packageCwd, spawn, waitOptions);
    if (!web.ok) return web;
    webResult = web.data;
  }
  return {
    ok: true,
    data: {
      baseUrl,
      started: true,
      alreadyRunning: false,
      ...(spawned.pid !== undefined ? { pid: spawned.pid } : {}),
      health: waited.health,
      ...(webResult ? { web: webResult } : {}),
    },
  };
}

async function daemonStatus(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
  options: CliRunOptions,
): Promise<CommandResult<CliCommandData>> {
  const baseUrl = daemonBaseUrl(value(parsed, "daemon") ?? env.SIKONG_DAEMON_ADDR);
  const client = new DaemonProcessClient({
    baseUrl,
    ...(options.daemonFetch ? { fetch: options.daemonFetch } : {}),
  });
  try {
    const health = await client.health();
    return { ok: true, data: { baseUrl, health } };
  } catch (err) {
    return daemonClientErrorResult(err, baseUrl);
  }
}

async function daemonStop(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
  options: CliRunOptions,
): Promise<CommandResult<CliCommandData>> {
  const baseUrl = daemonBaseUrl(value(parsed, "daemon") ?? env.SIKONG_DAEMON_ADDR);
  const client = new DaemonProcessClient({
    baseUrl,
    ...(options.daemonFetch ? { fetch: options.daemonFetch } : {}),
  });
  try {
    const shutdown = await client.shutdown();
    return { ok: true, data: { baseUrl, stopped: true, shutdown } };
  } catch (err) {
    return daemonClientErrorResult(err, baseUrl);
  }
}

async function cancelTaskRuntimeProcesses(
  ctx: CommandContext,
  parsed: ParsedArgs,
  taskIdArg: string | undefined,
  env: NodeJS.ProcessEnv,
  options: CliRunOptions,
): Promise<CommandResult<CliCommandData>> {
  const task = await getTask(ctx, taskInput(parsed, taskIdArg));
  if (!task.ok) return task;
  const projection = task.data.projection;
  const running = Object.values(projection.runtimeProcessRuns ?? {}).filter(
    (processRun) => processRun.status === "running",
  );
  const baseUrl = daemonBaseUrl(value(parsed, "daemon") ?? env.SIKONG_DAEMON_ADDR);
  const client = new DaemonProcessClient({
    baseUrl,
    ...(options.daemonFetch ? { fetch: options.daemonFetch } : {}),
  });
  const cancelled = [];
  for (const processRun of running) {
    try {
      const snapshot = await client.cancelProcessRun(processRun.processRunId);
      cancelled.push(snapshot);
      if (snapshot.result) {
        const recorded = await recordRuntimeProcessFinished(ctx, {
          workspaceId: projection.workspaceId,
          taskId: projection.taskId,
          processRunId: processRun.processRunId,
          processStatus: snapshot.result.status,
          ...(snapshot.result.exitCode !== undefined ? { exitCode: snapshot.result.exitCode } : {}),
        });
        if (!recorded.ok) return recorded;
      }
    } catch (err) {
      return daemonClientErrorResult(err, baseUrl);
    }
  }
  return {
    ok: true,
    data: {
      taskId: projection.taskId,
      cancelled,
      cancelledCount: cancelled.length,
    },
  };
}

function daemonClientErrorResult(err: unknown, baseUrl: string): CommandResult<CliCommandData> {
  if (err instanceof DaemonProcessClientError) {
    return {
      ok: false,
      error: {
        code: "daemon_error",
        message: err.message,
        details: { baseUrl, status: err.status, daemonCode: err.code },
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "daemon_error",
      message: err instanceof Error ? err.message : String(err),
      details: { baseUrl },
    },
  };
}

async function driveTask(
  ctx: CommandContext,
  parsed: ParsedArgs,
  taskIdArg: string | undefined,
  env: NodeJS.ProcessEnv,
  options: CliRunOptions,
): Promise<CommandResult<CliCommandData>> {
  const taskId = required(taskIdArg, "task id is required.");
  const settings = await new FileSettingsStore(ctx.dataDir).read();
  const runtimeAssembly = parseRuntimeAssembly(parsed, settings.defaults.worker);
  const client =
    options.processClient ??
    new DaemonProcessClient({
      baseUrl: daemonBaseUrl(value(parsed, "daemon") ?? env.SIKONG_DAEMON_ADDR),
    });
  const packageCwd =
    value(parsed, "package-cwd") ??
    env.SIKONG_PACKAGE_CWD ??
    options.packageCwd ??
    join(import.meta.dir, "../..");
  const runnerCommand = value(parsed, "command") ?? env.SIKONG_ORCHESTRATION_RUNNER_COMMAND;
  const driven = await runOrchestrationUntilWait({
    ctx,
    taskId,
    workspaceId: value(parsed, "workspace"),
    buildInput: (projection) => orchestrationInput(projection),
    maxActions: optionalNumber(
      value(parsed, "max-actions"),
      "--max-actions must be a positive integer.",
    ),
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
        command: runnerCommand,
        timeoutMs: optionalNumber(
          value(parsed, "process-timeout-ms"),
          "--process-timeout-ms must be a positive integer.",
        ),
        waitTimeoutMs: optionalNumber(
          value(parsed, "wait-timeout-ms"),
          "--wait-timeout-ms must be a positive integer.",
        ),
      });
    },
  });
  return driven as CommandResult<CliCommandData>;
}

function render(result: CommandResult<unknown>, outputMode: "json" | "text"): CliRunResult {
  if (outputMode === "text") {
    if (!result.ok) return text(1, "", `${result.error.code}: ${result.error.message}\n`);
    return text(0, `${JSON.stringify(result.data, null, 2)}\n`);
  }
  return text(result.ok ? 0 : 1, `${JSON.stringify(result)}\n`);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = String(argv[index] ?? "");
    if (!token) continue;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    const raw = token.replace(/^-+/, "");
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      flags[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }

    const next = argv[index + 1] === undefined ? undefined : String(argv[index + 1]);
    if (next && !next.startsWith("-")) {
      flags[raw] = next;
      index += 1;
    } else {
      flags[raw] = true;
    }
  }
  return { positionals, flags };
}

function value(parsed: ParsedArgs, name: string): string | undefined {
  const raw = parsed.flags[name];
  return typeof raw === "string" ? raw : undefined;
}

function flag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function requiredNumber(value: string | undefined, message: string): number {
  const raw = required(value, message);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(message);
  return parsed;
}

function optionalNumber(value: string | undefined, message: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredNumber(value, message);
}

function optionalNonNegativeNumber(value: string | undefined, message: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(message);
  return parsed;
}

function parseRuntimeAssembly(
  parsed: ParsedArgs,
  defaultRuntime: DefaultAgentRuntime = { backend: "mock" },
): RuntimeAssemblyConfig {
  const raw = value(parsed, "runtime-assembly-json");
  if (raw)
    return parseJson(
      raw,
      "--runtime-assembly-json must be a JSON object.",
    ) as RuntimeAssemblyConfig;

  const explicitBackend = value(parsed, "backend");
  const backend = explicitBackend ?? defaultRuntime.backend;
  const backendOptions = value(parsed, "backend-options-json");
  const defaultBackendOptions =
    !explicitBackend && (defaultRuntime.provider || defaultRuntime.model)
      ? {
          ...(defaultRuntime.provider ? { provider: defaultRuntime.provider } : {}),
          ...(defaultRuntime.model ? { model: defaultRuntime.model } : {}),
        }
      : undefined;
  const options = backendOptions
    ? parseJson(backendOptions, "--backend-options-json must be a JSON object.")
    : defaultBackendOptions;
  return {
    backend: options
      ? {
          name: backend,
          options,
        }
      : backend,
    toolProfiles: {
      ...(backend === "ai-sdk"
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

function daemonBaseUrl(value: string | undefined): string {
  const raw = value ?? "http://127.0.0.1:8765";
  return raw.startsWith("http://") || raw.startsWith("https://") ? raw : `http://${raw}`;
}

function daemonAddr(value: string | undefined): string {
  const raw = value ?? "127.0.0.1:8765";
  return raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function daemonSpawnSpec(packageCwd: string, addr: string): Promise<DaemonSpawnSpec> {
  const distDaemon = join(packageCwd, "dist", "sikongd");
  if (await pathExists(join(packageCwd, "cmd", "sikongd"))) {
    await buildDaemonBinary(packageCwd, distDaemon);
    return {
      command: distDaemon,
      args: [],
      cwd: packageCwd,
      env: { SIKONG_DAEMON_ADDR: addr },
    };
  }
  if (await pathExists(distDaemon)) {
    return {
      command: distDaemon,
      args: [],
      cwd: packageCwd,
      env: { SIKONG_DAEMON_ADDR: addr },
    };
  }
  return {
    command: "go",
    args: ["run", "./cmd/sikongd"],
    cwd: packageCwd,
    env: { SIKONG_DAEMON_ADDR: addr },
  };
}

function webUISpawnSpec(packageCwd: string, port: string): DaemonSpawnSpec {
  return {
    command: "go",
    args: ["run", "./cmd/sikong", "ui", "--no-build", "--port", port],
    cwd: packageCwd,
    env: { SIKONG_CLIENT_API_PORT: port },
  };
}

async function ensureWebUI(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
  options: CliRunOptions,
  packageCwd: string,
  spawn: DaemonSpawner,
  waitOptions: { timeoutMs: number; intervalMs: number },
): Promise<CommandResult<Record<string, unknown>>> {
  const port = webUIPort(parsed, env);
  const baseUrl = webUIBaseUrl(port);
  const webFetch = options.webFetch ?? fetch;
  const existing = await tryWebHealth(baseUrl, webFetch);
  if (existing.ok) {
    return ok(webResultFields(port, undefined, existing.health, true));
  }

  let spawned: DaemonSpawnResult;
  try {
    spawned = await spawn(webUISpawnSpec(packageCwd, port));
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "daemon_error",
        message: err instanceof Error ? err.message : String(err),
        details: { webUrl: baseUrl },
      },
    };
  }
  const waited = await waitForWebHealth(baseUrl, webFetch, waitOptions);
  if (!waited.ok) {
    return {
      ok: false,
      error: {
        code: "daemon_error",
        message: "Web UI did not become healthy before timeout.",
        details: { webUrl: baseUrl, ...(spawned.pid !== undefined ? { pid: spawned.pid } : {}) },
      },
    };
  }
  return ok(webResultFields(port, spawned, waited.health, false));
}

function webUIPort(parsed: ParsedArgs, env: NodeJS.ProcessEnv): string {
  return (
    value(parsed, "ui-port") ?? value(parsed, "web-port") ?? env.SIKONG_CLIENT_API_PORT ?? "8776"
  );
}

function webUIBaseUrl(port: string): string {
  return `http://127.0.0.1:${port}`;
}

function webResultFields(
  port: string,
  spawned: DaemonSpawnResult | undefined,
  health: { ok: boolean },
  alreadyRunning: boolean,
): Record<string, unknown> {
  return {
    started: !alreadyRunning,
    alreadyRunning,
    port,
    url: webUIBaseUrl(port),
    health,
    ...(spawned?.pid !== undefined ? { pid: spawned.pid } : {}),
  };
}

async function buildDaemonBinary(packageCwd: string, outputPath: string): Promise<void> {
  await mkdir(join(packageCwd, "dist"), { recursive: true });
  const proc = Bun.spawn(["go", "build", "-o", outputPath, "./cmd/sikongd"], {
    cwd: packageCwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`failed to build sikongd: ${stderr || stdout || `exit ${exitCode}`}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function spawnDaemon(spec: DaemonSpawnSpec): Promise<DaemonSpawnResult> {
  const subprocess = Bun.spawn([spec.command, ...spec.args], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  (subprocess as { unref?: () => void }).unref?.();
  return { pid: subprocess.pid };
}

async function tryDaemonHealth(
  client: DaemonProcessClient,
): Promise<{ ok: true; health: { ok: boolean } } | { ok: false }> {
  try {
    return { ok: true, health: await client.health() };
  } catch {
    return { ok: false };
  }
}

async function tryWebHealth(
  baseUrl: string,
  fetcher: DaemonProcessFetch,
): Promise<{ ok: true; health: { ok: boolean } } | { ok: false }> {
  try {
    const response = await fetcher(`${baseUrl}/api/health`);
    if (!response.ok) return { ok: false };
    const health = (await response.json()) as { ok?: boolean };
    return health.ok === true ? { ok: true, health: { ok: true } } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function waitForDaemonHealth(
  client: DaemonProcessClient,
  options: { timeoutMs: number; intervalMs: number },
): Promise<{ ok: true; health: { ok: boolean } } | { ok: false }> {
  const deadline = Date.now() + options.timeoutMs;
  do {
    const health = await tryDaemonHealth(client);
    if (health.ok) return health;
    if (options.timeoutMs === 0) break;
    await sleep(Math.min(options.intervalMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return { ok: false };
}

async function waitForWebHealth(
  baseUrl: string,
  fetcher: DaemonProcessFetch,
  options: { timeoutMs: number; intervalMs: number },
): Promise<{ ok: true; health: { ok: boolean } } | { ok: false }> {
  const deadline = Date.now() + options.timeoutMs;
  do {
    const health = await tryWebHealth(baseUrl, fetcher);
    if (health.ok) return health;
    if (options.timeoutMs === 0) break;
    await sleep(Math.min(options.intervalMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return { ok: false };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  throw new Error("CLI drive uses runtimeAssembly inside the runner process.");
}

function taskInput(
  parsed: ParsedArgs,
  taskId: string | undefined,
): { workspaceId?: string; taskId: string } {
  return {
    workspaceId: value(parsed, "workspace"),
    taskId: required(taskId, "task id is required."),
  };
}

function parsePlanJson(text: string): Pick<SubmitPlanInput, "summary" | "stages"> {
  const parsed = parseJson(text, "--plan-json must be a JSON object.");
  if (!Array.isArray(parsed.stages)) throw new Error("--plan-json.stages must be an array.");
  return {
    ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
    stages: parsed.stages.map((stage, index) => {
      if (!isRecord(stage)) throw new Error(`--plan-json.stages[${index}] must be an object.`);
      if (!Array.isArray(stage.acceptance)) {
        throw new Error(`--plan-json.stages[${index}].acceptance must be an array.`);
      }
      return {
        title: stringField(stage, "title", `--plan-json.stages[${index}].title is required.`),
        objective: stringField(
          stage,
          "objective",
          `--plan-json.stages[${index}].objective is required.`,
        ),
        acceptance: stage.acceptance.map((item) => {
          if (typeof item !== "string") {
            throw new Error(`--plan-json.stages[${index}].acceptance must contain strings.`);
          }
          return item;
        }),
        ...(stage.workerCount !== undefined
          ? {
              workerCount: numberField(
                stage,
                "workerCount",
                `--plan-json.stages[${index}].workerCount must be a positive integer.`,
              ),
            }
          : {}),
      };
    }),
  };
}

function workerResultInput(parsed: ParsedArgs, taskId: string | undefined): FinishWorkerRunInput {
  return {
    ...taskInput(parsed, taskId),
    runId: required(value(parsed, "run"), "--run is required."),
    ...parseResultJson(required(value(parsed, "result-json"), "--result-json is required.")),
  };
}

function parseResultJson(text: string): Pick<FinishWorkerRunInput, "summary" | "report" | "note"> {
  const parsed = parseJson(text, "--result-json must be a JSON object.");
  return {
    summary: stringField(parsed, "summary", "--result-json.summary is required."),
    ...(typeof parsed.report === "string" ? { report: parsed.report } : {}),
    ...(typeof parsed.note === "string" ? { note: parsed.note } : {}),
  };
}

function parseJson(text: string, message: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error(message);
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(message);
    throw err;
  }
}

function stringField(record: Record<string, unknown>, key: string, message: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function numberField(record: Record<string, unknown>, key: string, message: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(message);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recommendation(value: string | undefined): "accept" | "reject" {
  if (value === "accept" || value === "reject") return value;
  throw new Error("--recommendation must be accept or reject.");
}

function text(exitCode: number, stdout = "", stderr = ""): CliRunResult {
  return { exitCode, stdout, stderr };
}

function usage(): string {
  return `sikong

Usage:
  sikong --data-dir <path> workspace create --id <id> --name <name>
  sikong workspace list
  sikong workspace show <workspaceId>
  sikong workspace delete <workspaceId>
  sikong preference list --workspace <workspaceId>
  sikong preference add --workspace <workspaceId> --text <text>
  sikong preference remove --workspace <workspaceId> <preferenceId>
  sikong task create --workspace <workspaceId> --request <text> [--cwd <path>] [--repo <path>]
  sikong task show <taskId> --workspace <workspaceId>
  sikong task drive <taskId> --workspace <workspaceId> [--backend <name>] [--daemon <url>]
  sikong task wait <taskId> --workspace <workspaceId> [--timeout-ms <n>]
  sikong task submit-plan <taskId> --workspace <workspaceId> --plan-json <json>
  sikong task accept-plan <taskId> --workspace <workspaceId> --plan <planId> --version <n> --report <text>
  sikong task reject-plan <taskId> --workspace <workspaceId> --plan <planId> --version <n> --report <text>
  sikong task start-worker <taskId> --workspace <workspaceId>
  sikong task complete-worker <taskId> --workspace <workspaceId> --run <runId> --result-json <json>
  sikong task fail-worker <taskId> --workspace <workspaceId> --run <runId> --result-json <json>
  sikong task exceed-worker-budget <taskId> --workspace <workspaceId> --run <runId> --result-json <json>
  sikong task start-stage-review <taskId> --workspace <workspaceId>
  sikong task accept-stage-review <taskId> --workspace <workspaceId> --review <reviewId> --report <text>
  sikong task reject-stage-review <taskId> --workspace <workspaceId> --review <reviewId> --report <text>
  sikong task recommend-final-review <taskId> --workspace <workspaceId> --review <reviewId> --recommendation <accept|reject> --report <text>
  sikong task accept <taskId> --workspace <workspaceId> --report <text>
  sikong task reject <taskId> --workspace <workspaceId> --report <text>
  sikong task cancel <taskId> --workspace <workspaceId> [--daemon <url>]
  sikong task reconcile <taskId> --workspace <workspaceId>
  sikong daemon start [--daemon <url>] [--ui|--web] [--ui-port <port>]
  sikong daemon status [--daemon <url>]
  sikong daemon stop [--daemon <url>]
  sikong inspect summary <taskId> --workspace <workspaceId>
  sikong inspect compact <taskId> --workspace <workspaceId>
  sikong inspect events <taskId> --workspace <workspaceId>
  sikong inspect projection <taskId> --workspace <workspaceId>
  sikong inspect trace <taskId> --workspace <workspaceId>
`;
}

if (import.meta.main) {
  const result = await runCli(Bun.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
