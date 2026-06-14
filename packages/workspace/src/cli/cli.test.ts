import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeDir } from "../data-dir";
import { runCli } from "./index";
import { getTask, recordRuntimeProcessStarted, submitPlan, type CommandContext } from "../commands";
import type { OrchestrationProcessExecutionClient } from "../orchestration";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-cli-"));

function json(stdout: string): unknown {
  return JSON.parse(stdout);
}

function planningProcessClient(): OrchestrationProcessExecutionClient & {
  startedSpecs: unknown[];
  requestJson?: unknown;
} {
  const state: {
    startedSpecs: unknown[];
    requestJson?: unknown;
  } = { startedSpecs: [] };
  return {
    get startedSpecs() {
      return state.startedSpecs;
    },
    get requestJson() {
      return state.requestJson;
    },
    async startProcess(spec) {
      state.startedSpecs.push(spec);
      const requestPath = spec.args?.[2];
      if (!requestPath) throw new Error("request path missing");
      state.requestJson = JSON.parse(await Bun.file(requestPath).text());
      const request = state.requestJson as {
        context: { dataDir: string; workspaceId: string };
        action: { type: string; spec?: { taskId: string } };
      };
      if (request.action.type === "start_planning_worker" && request.action.spec) {
        const context: CommandContext = {
          dataDir: request.context.dataDir,
          workspaceId: request.context.workspaceId,
        };
        const submitted = await submitPlan(context, {
          taskId: request.action.spec.taskId,
          stages: [
            {
              title: "Implement",
              objective: "Submit plan through process-backed CLI drive.",
              acceptance: ["Plan is submitted."],
            },
          ],
        });
        if (!submitted.ok) throw new Error(submitted.error.message);
      }
      return {
        runId: spec.runId,
        workspaceId: spec.workspaceId,
        taskId: spec.taskId,
        state: "running",
        spec,
        startedAt: "2026-06-14T00:00:00Z",
      };
    },
    async waitProcessRun(runId) {
      const spec = state.startedSpecs[0] as {
        workspaceId: string;
        taskId?: string;
      };
      return {
        runId,
        workspaceId: spec.workspaceId,
        taskId: spec.taskId,
        state: "finished",
        spec: state.startedSpecs[0] as never,
        startedAt: "2026-06-14T00:00:00Z",
        finishedAt: "2026-06-14T00:00:01Z",
        result: {
          runId,
          workspaceId: spec.workspaceId,
          taskId: spec.taskId,
          status: "succeeded",
          command: "bun",
          args: [],
          stdout:
            JSON.stringify({
              ok: true,
              data: {
                resultType: "loop_completed",
                actionType: "start_planning_worker",
                loopResult: { status: "completed" },
              },
            }) + "\n",
          stderr: "",
          exitCode: 0,
          startedAt: "2026-06-14T00:00:00Z",
          finishedAt: "2026-06-14T00:00:01Z",
          durationMs: 1,
        },
      };
    },
  };
}

function keysOf(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const keys: string[] = [];
  const stack = [value as Record<string, unknown>];
  for (const item of stack) {
    for (const [key, child] of Object.entries(item)) {
      keys.push(key);
      if (child && typeof child === "object") stack.push(child as Record<string, unknown>);
    }
  }
  return keys;
}

describe("workspace cli adapter", () => {
  test("runs workspace and preference commands with JSON output", async () => {
    const dir = await tmp();
    try {
      expect(
        json(
          (
            await runCli([
              "--data-dir",
              dir,
              "workspace",
              "create",
              "--id",
              "sikong",
              "--name",
              "Sikong",
            ])
          ).stdout,
        ),
      ).toMatchObject({
        ok: true,
        data: { workspace: { id: "sikong", name: "Sikong" } },
      });

      expect(json((await runCli(["--data-dir", dir, "workspace", "list"])).stdout)).toMatchObject({
        ok: true,
        data: { workspaces: [{ id: "sikong" }] },
      });

      expect(
        json(
          (
            await runCli([
              "--data-dir",
              dir,
              "--workspace",
              "sikong",
              "preference",
              "add",
              "--text",
              "Run bun run check.",
            ])
          ).stdout,
        ),
      ).toMatchObject({
        ok: true,
        data: { preference: { id: "run-bun-run-check" } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates and inspects tasks", async () => {
    const dir = await tmp();
    try {
      await runCli([
        "--data-dir",
        dir,
        "workspace",
        "create",
        "--id",
        "sikong",
        "--name",
        "Sikong",
      ]);
      const created = json(
        (
          await runCli([
            "--data-dir",
            dir,
            "--workspace",
            "sikong",
            "task",
            "create",
            "--request",
            "Wire CLI adapter.",
            "--cwd",
            dir,
          ])
        ).stdout,
      );

      if (!created || typeof created !== "object" || !("data" in created)) {
        throw new Error("unexpected task create result");
      }
      const taskId = (created as { data: { taskId: string } }).data.taskId;
      expect(taskId).toMatch(/^task_/);
      expect(created).toMatchObject({
        ok: true,
        data: { projection: { taskId } },
      });

      expect(
        json(
          (await runCli(["--data-dir", dir, "--workspace", "sikong", "inspect", "summary", taskId]))
            .stdout,
        ),
      ).toMatchObject({
        ok: true,
        data: { summary: { status: "planning", planStatus: "requested" } },
      });
      expect(
        json(
          (await runCli(["--data-dir", dir, "--workspace", "sikong", "inspect", "compact", taskId]))
            .stdout,
        ),
      ).toMatchObject({
        ok: true,
        data: {
          compact: {
            status: "planning",
            nextAction: { type: "start_planning_worker" },
            waitingForLead: false,
          },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates git-backed tasks in workspace-owned worktrees", async () => {
    const dir = await tmp();
    try {
      await runCli([
        "--data-dir",
        dir,
        "workspace",
        "create",
        "--id",
        "sikong",
        "--name",
        "Sikong",
      ]);
      const repo = await createGitRepo(join(dir, "source"));

      const created = json(
        (
          await runCli([
            "--data-dir",
            dir,
            "--workspace",
            "sikong",
            "task",
            "create",
            "--request",
            "Use git worktree.",
            "--repo",
            repo,
          ])
        ).stdout,
      ) as { data: { taskId: string; projection: { runtime: { cwd: string; repoPath: string } } } };

      const taskId = created.data.taskId;
      expect(created).toMatchObject({
        ok: true,
        data: {
          taskId: expect.stringMatching(/^task_/),
          projection: {
            runtime: {
              repoPath: repo,
            },
          },
        },
      });
      const expectedCwd = worktreeDir(dir, "sikong", taskId);
      expect(created.data.projection.runtime.cwd).toBe(expectedCwd);
      expect(await Bun.file(join(expectedCwd, "README.md")).text()).toBe("hello\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs task protocol commands through JSON CLI inputs", async () => {
    const dir = await tmp();
    try {
      await runCli([
        "--data-dir",
        dir,
        "workspace",
        "create",
        "--id",
        "sikong",
        "--name",
        "Sikong",
      ]);
      const created = json(
        (
          await runCli([
            "--data-dir",
            dir,
            "--workspace",
            "sikong",
            "task",
            "create",
            "--request",
            "Close protocol loop.",
            "--cwd",
            dir,
          ])
        ).stdout,
      ) as { data: { taskId: string } };
      const taskId = created.data.taskId;

      const submitted = json(
        (
          await runCli([
            "--data-dir",
            dir,
            "--workspace",
            "sikong",
            "task",
            "submit-plan",
            taskId,
            "--plan-json",
            JSON.stringify({
              summary: "One stage.",
              stages: [
                {
                  title: "Implement",
                  objective: "Use protocol commands.",
                  acceptance: ["Worker terminal result is recorded."],
                },
              ],
            }),
          ])
        ).stdout,
      ) as { data: { plan: { id: string; version: number } } };

      expect(
        json(
          (
            await runCli([
              "--data-dir",
              dir,
              "--workspace",
              "sikong",
              "task",
              "wait",
              taskId,
              "--timeout-ms",
              "0",
            ])
          ).stdout,
        ),
      ).toMatchObject({
        ok: true,
        data: {
          compact: {
            status: "plan_submitted",
            nextAction: {
              type: "await_plan_decision",
              planId: submitted.data.plan.id,
              version: submitted.data.plan.version,
            },
            waitingForLead: true,
          },
        },
      });

      await runCli([
        "--data-dir",
        dir,
        "--workspace",
        "sikong",
        "task",
        "accept-plan",
        taskId,
        "--plan",
        submitted.data.plan.id,
        "--version",
        String(submitted.data.plan.version),
        "--report",
        "Accepted.",
      ]);

      const worker = json(
        (await runCli(["--data-dir", dir, "--workspace", "sikong", "task", "start-worker", taskId]))
          .stdout,
      ) as { data: { runId: string } };

      expect(
        json(
          (
            await runCli([
              "--data-dir",
              dir,
              "--workspace",
              "sikong",
              "task",
              "complete-worker",
              taskId,
              "--run",
              worker.data.runId,
              "--result-json",
              JSON.stringify({ summary: "Worker result submitted through terminal tool." }),
            ])
          ).stdout,
        ),
      ).toMatchObject({
        ok: true,
        data: { projection: { workerRuns: { [worker.data.runId]: { status: "completed" } } } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drives a task through the process-backed orchestration executor", async () => {
    const dir = await tmp();
    try {
      await runCli([
        "--data-dir",
        dir,
        "workspace",
        "create",
        "--id",
        "sikong",
        "--name",
        "Sikong",
      ]);
      const created = json(
        (
          await runCli([
            "--data-dir",
            dir,
            "--workspace",
            "sikong",
            "task",
            "create",
            "--request",
            "Drive through CLI.",
            "--cwd",
            dir,
          ])
        ).stdout,
      ) as { data: { taskId: string } };
      const taskId = created.data.taskId;
      const client = planningProcessClient();

      const driven = json(
        (
          await runCli(
            [
              "--data-dir",
              dir,
              "--workspace",
              "sikong",
              "task",
              "drive",
              taskId,
              "--backend",
              "mock",
              "--max-actions",
              "4",
            ],
            process.env,
            { processClient: client, packageCwd: join(import.meta.dir, "../..") },
          )
        ).stdout,
      );

      expect(driven).toMatchObject({
        ok: true,
        data: {
          stopReason: "waiting",
          projection: { status: "plan_submitted" },
          steps: [
            { action: { type: "start_planning_worker" } },
            { action: { type: "await_plan_decision" } },
          ],
        },
      });
      expect(client.startedSpecs).toHaveLength(1);
      expect(client.requestJson).toMatchObject({
        runtimeAssembly: {
          backend: "mock",
          toolProfiles: { planningProtocol: "sikong-planning-protocol" },
        },
      });
      expect(keysOf(client.requestJson)).not.toContain("tools");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("checks daemon status through the health endpoint", async () => {
    const requests: string[] = [];
    const result = await runCli(["daemon", "status", "--daemon", "127.0.0.1:9876"], process.env, {
      daemonFetch: async (input) => {
        requests.push(input);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(json(result.stdout)).toMatchObject({
      ok: true,
      data: {
        baseUrl: "http://127.0.0.1:9876",
        health: { ok: true },
      },
    });
    expect(requests).toEqual(["http://127.0.0.1:9876/health"]);
  });

  test("starts daemon through a background process and waits for health", async () => {
    const dir = await tmp();
    try {
      const requests: string[] = [];
      const spawned: unknown[] = [];
      let healthCalls = 0;

      const result = await runCli(
        [
          "daemon",
          "start",
          "--daemon",
          "127.0.0.1:9876",
          "--package-cwd",
          dir,
          "--timeout-ms",
          "200",
          "--interval-ms",
          "1",
        ],
        process.env,
        {
          daemonFetch: async (input) => {
            requests.push(input);
            if (input.endsWith("/health")) {
              healthCalls += 1;
              if (healthCalls === 1) {
                return Response.json(
                  { error: { code: "not_running", message: "not running" } },
                  { status: 503 },
                );
              }
              return Response.json({ ok: true });
            }
            return Response.json(
              { error: { code: "not_found", message: "not found" } },
              { status: 404 },
            );
          },
          daemonSpawner: async (spec) => {
            spawned.push(spec);
            return { pid: 12345 };
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(json(result.stdout)).toMatchObject({
        ok: true,
        data: {
          baseUrl: "http://127.0.0.1:9876",
          started: true,
          alreadyRunning: false,
          pid: 12345,
          health: { ok: true },
        },
      });
      expect(spawned).toEqual([
        {
          command: "go",
          args: ["run", "./cmd/sikongd"],
          cwd: dir,
          env: { SIKONG_DAEMON_ADDR: "127.0.0.1:9876" },
        },
      ]);
      expect(requests).toEqual(["http://127.0.0.1:9876/health", "http://127.0.0.1:9876/health"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not spawn daemon when it is already healthy", async () => {
    const spawned: unknown[] = [];
    const result = await runCli(["daemon", "start", "--daemon", "127.0.0.1:9876"], process.env, {
      daemonFetch: async (input) => {
        expect(input).toBe("http://127.0.0.1:9876/health");
        return Response.json({ ok: true });
      },
      daemonSpawner: async (spec) => {
        spawned.push(spec);
        return { pid: 12345 };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(json(result.stdout)).toMatchObject({
      ok: true,
      data: {
        baseUrl: "http://127.0.0.1:9876",
        started: false,
        alreadyRunning: true,
        health: { ok: true },
      },
    });
    expect(spawned).toEqual([]);
  });

  test("stops daemon through the shutdown endpoint", async () => {
    const requests: Array<{ input: string; method: string }> = [];
    const result = await runCli(["daemon", "stop", "--daemon", "127.0.0.1:9876"], process.env, {
      daemonFetch: async (input, init) => {
        requests.push({ input, method: init?.method ?? "GET" });
        return Response.json({ ok: true });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(json(result.stdout)).toMatchObject({
      ok: true,
      data: {
        baseUrl: "http://127.0.0.1:9876",
        stopped: true,
        shutdown: { ok: true },
      },
    });
    expect(requests).toEqual([{ input: "http://127.0.0.1:9876/shutdown", method: "POST" }]);
  });

  test("cancels running runtime processes recorded on a task", async () => {
    const dir = await tmp();
    try {
      await runCli([
        "--data-dir",
        dir,
        "workspace",
        "create",
        "--id",
        "sikong",
        "--name",
        "Sikong",
      ]);
      const created = json(
        (
          await runCli([
            "--data-dir",
            dir,
            "--workspace",
            "sikong",
            "task",
            "create",
            "--request",
            "Cancel active runtime process.",
            "--cwd",
            dir,
          ])
        ).stdout,
      ) as { data: { taskId: string } };
      const taskId = created.data.taskId;
      const context: CommandContext = { dataDir: dir, workspaceId: "sikong" };
      const recorded = await recordRuntimeProcessStarted(context, {
        taskId,
        processRunId: "process_1",
        actionType: "start_planning_worker",
      });
      if (!recorded.ok) throw new Error(recorded.error.message);
      const requests: string[] = [];

      const cancelled = json(
        (
          await runCli(
            [
              "--data-dir",
              dir,
              "--workspace",
              "sikong",
              "task",
              "cancel",
              taskId,
              "--daemon",
              "127.0.0.1:9876",
            ],
            process.env,
            {
              daemonFetch: async (input, init) => {
                requests.push(`${init?.method ?? "GET"} ${input}`);
                return new Response(
                  JSON.stringify({
                    runId: "process_1",
                    workspaceId: "sikong",
                    taskId,
                    state: "finished",
                    startedAt: "2026-06-14T00:00:00Z",
                    finishedAt: "2026-06-14T00:00:01Z",
                    result: {
                      runId: "process_1",
                      workspaceId: "sikong",
                      taskId,
                      status: "cancelled",
                      command: "bun",
                      args: [],
                      stdout: "",
                      stderr: "",
                      startedAt: "2026-06-14T00:00:00Z",
                      finishedAt: "2026-06-14T00:00:01Z",
                      durationMs: 1,
                      cancelled: true,
                    },
                  }),
                  { headers: { "content-type": "application/json" } },
                );
              },
            },
          )
        ).stdout,
      );

      expect(cancelled).toMatchObject({
        ok: true,
        data: {
          taskId,
          cancelledCount: 1,
          cancelled: [{ runId: "process_1", state: "finished" }],
        },
      });
      expect(requests).toEqual(["POST http://127.0.0.1:9876/process-runs/process_1/cancel"]);
      const fresh = await getTask(context, { taskId });
      if (!fresh.ok) throw new Error(fresh.error.message);
      expect(fresh.data.projection.runtimeProcessRuns).toMatchObject({
        process_1: {
          status: "finished",
          processStatus: "cancelled",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns structured errors", async () => {
    const dir = await tmp();
    try {
      const result = await runCli(["--data-dir", dir, "workspace", "show", "missing"]);
      expect(result.exitCode).toBe(1);
      expect(json(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "workspace_not_found" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function createGitRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await runGit(path, ["init"]);
  await writeFile(join(path, "README.md"), "hello\n");
  await runGit(path, ["add", "README.md"]);
  await runGit(path, [
    "-c",
    "user.email=sikong@example.local",
    "-c",
    "user.name=Sikong Test",
    "commit",
    "-m",
    "initial",
  ]);
  return await realpath(path);
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(stderr);
}
