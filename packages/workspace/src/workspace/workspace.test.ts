import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTask,
  createWorkspace,
  driveTask,
  FileWorkspacePreferencesFactory,
  FileWorkspaceStore,
  FileSettingsStore,
  configFile,
  ensureDataDirLayout,
  isValidWorkspaceId,
  preferencesFile,
  type ProcessRunSpec,
  resolveDataDir,
  submitPlan,
  submitRequirementSpec,
  taskEventsDir,
  taskProjectionsDir,
  taskRuntimeDir,
  taskRuntimeDirs,
  type CommandContext,
  workspaceDir,
  worktreeDir,
  worktreesDir,
} from "../index";
import type { OrchestrationProcessExecutionClient } from "../orchestration";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-workspace-"));

function planningProcessClient(): OrchestrationProcessExecutionClient & {
  requestJson?: unknown;
} {
  const state: { spec?: ProcessRunSpec; requestJson?: unknown } = {};
  return {
    get requestJson() {
      return state.requestJson;
    },
    async startProcess(spec) {
      state.spec = spec;
      const requestPath = spec.args?.[2];
      if (!requestPath) throw new Error("request path missing");
      state.requestJson = JSON.parse(await Bun.file(requestPath).text()) as unknown;
      const request = state.requestJson as {
        context: { dataDir: string; workspaceId: string };
        action: { type: string; spec?: { taskId: string } };
      };
      if (request.action.type === "start_lead_requirement_spec" && request.action.spec) {
        const submitted = await submitRequirementSpec(
          {
            dataDir: request.context.dataDir,
            workspaceId: request.context.workspaceId,
          },
          {
            taskId: request.action.spec.taskId,
            summary: "Drive from typed command.",
          },
        );
        if (!submitted.ok) throw new Error("requirement spec submit failed");
      }
      if (request.action.type === "start_planning_worker" && request.action.spec) {
        const submitted = await submitPlan(
          {
            dataDir: request.context.dataDir,
            workspaceId: request.context.workspaceId,
          },
          {
            taskId: request.action.spec.taskId,
            stages: [
              {
                title: "Implement",
                objective: "Drive from typed command.",
                acceptance: ["Plan is submitted."],
              },
            ],
          },
        );
        if (!submitted.ok) throw new Error(submitted.error.message);
      }
      return {
        runId: spec.runId,
        workspaceId: spec.workspaceId,
        ...(spec.taskId ? { taskId: spec.taskId } : {}),
        state: "queued",
        spec,
        queuedAt: "2026-06-14T00:00:00Z",
      };
    },
    async waitProcessRun(runId) {
      if (!state.spec) throw new Error("process was not started");
      const request = state.requestJson as { action?: { type?: string } };
      return {
        runId,
        workspaceId: state.spec.workspaceId,
        ...(state.spec.taskId ? { taskId: state.spec.taskId } : {}),
        state: "finished",
        spec: state.spec,
        startedAt: "2026-06-14T00:00:00.000Z",
        finishedAt: "2026-06-14T00:00:01.000Z",
        result: {
          runId,
          workspaceId: state.spec.workspaceId,
          ...(state.spec.taskId ? { taskId: state.spec.taskId } : {}),
          status: "succeeded",
          command: "bun",
          args: [],
          stdout:
            JSON.stringify({
              ok: true,
              data: {
                resultType: "loop_completed",
                actionType: request.action?.type ?? "start_planning_worker",
                loopResult: { status: "completed" },
              },
            }) + "\n",
          stderr: "",
          exitCode: 0,
          startedAt: "2026-06-14T00:00:00.000Z",
          finishedAt: "2026-06-14T00:00:01.000Z",
          durationMs: 1,
        },
      };
    },
  };
}

describe("workspace data-dir layout", () => {
  test("resolves data dir from flag, env, then default", () => {
    expect(resolveDataDir({ dataDir: "/tmp/data", env: {} }).source).toBe("flag");
    expect(resolveDataDir({ env: { SIKONG_DATA_DIR: "/tmp/env-data" } }).dir).toBe("/tmp/env-data");
    expect(resolveDataDir({ env: {} }).dir).toContain(".sikong");
  });

  test("creates the data-dir layout and stable workspace paths", async () => {
    const dir = await tmp();
    try {
      await ensureDataDirLayout(dir);

      expect(workspaceDir(dir, "main")).toBe(join(dir, "workspaces", "main"));
      expect(configFile(dir)).toBe(join(dir, "config.yaml"));
      expect(taskEventsDir(dir, "main")).toBe(join(dir, "workspaces", "main", "state", "events"));
      expect(taskProjectionsDir(dir, "main")).toBe(
        join(dir, "workspaces", "main", "state", "projections"),
      );
      expect(taskRuntimeDirs(dir, "main")).toBe(join(dir, "workspaces", "main", "tasks"));
      expect(taskRuntimeDir(dir, "main", "task/one")).toBe(
        join(dir, "workspaces", "main", "tasks", "task_one"),
      );
      expect(worktreesDir(dir, "main")).toBe(join(dir, "workspaces", "main", "worktrees"));
      expect(worktreeDir(dir, "main", "task/one")).toBe(
        join(dir, "workspaces", "main", "worktrees", "task_one"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sikong settings", () => {
  test("reads default runtime settings when config.yaml is absent", async () => {
    const dir = await tmp();
    try {
      const store = new FileSettingsStore(dir);
      expect(await store.read()).toEqual({
        version: 1,
        defaults: {
          clientAgent: { backend: "codex" },
          lead: { backend: "codex" },
          worker: { backend: "codex" },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes normalized runtime settings as YAML", async () => {
    const dir = await tmp();
    try {
      const store = new FileSettingsStore(dir);
      await store.write({
        version: 1,
        defaults: {
          clientAgent: { backend: "codex", model: "gpt-5.1-codex" },
          lead: { backend: "claude-code", provider: "deepseek", model: "deepseek-v4-flash" },
          worker: { backend: "cursor", model: "composer-2" },
        },
      });

      expect(await store.read()).toEqual({
        version: 1,
        defaults: {
          clientAgent: { backend: "codex", model: "gpt-5.1-codex" },
          lead: { backend: "claude-code", provider: "deepseek", model: "deepseek-v4-flash" },
          worker: { backend: "cursor", model: "composer-2" },
        },
      });
      expect(await readFile(configFile(dir), "utf8")).toContain("clientAgent:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves other config fields when writing runtime settings", async () => {
    const dir = await tmp();
    try {
      await ensureDataDirLayout(dir);
      await Bun.write(configFile(dir), "defaultWorkerId: flash\n");

      const store = new FileSettingsStore(dir);
      await store.write({
        version: 1,
        defaults: {
          clientAgent: { backend: "claude-code", provider: "deepseek" },
          lead: { backend: "claude-code", provider: "deepseek" },
          worker: { backend: "claude-code", provider: "deepseek" },
        },
      });

      const raw = await readFile(configFile(dir), "utf8");
      expect(raw).toContain("defaultWorkerId: flash");
      expect(raw).toContain("provider: deepseek");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not expose test-only mock backend through settings", async () => {
    const dir = await tmp();
    try {
      const store = new FileSettingsStore(dir);
      await store.write({
        version: 1,
        defaults: {
          clientAgent: { backend: "mock" },
          lead: { backend: "mock" },
          worker: { backend: "mock" },
        },
      });

      expect(await store.read()).toEqual({
        version: 1,
        defaults: {
          clientAgent: { backend: "codex" },
          lead: { backend: "codex" },
          worker: { backend: "codex" },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("task drive command", () => {
  test("uses worker runtime defaults with planning-safe tools without shelling through CLI", async () => {
    const dir = await tmp();
    try {
      const ctx: CommandContext = { dataDir: dir, workspaceId: "sikong" };
      const client = planningProcessClient();
      await createWorkspace(ctx, { id: "sikong", name: "Sikong" });
      await new FileSettingsStore(dir).write({
        version: 1,
        defaults: {
          clientAgent: { backend: "codex" },
          lead: { backend: "codex" },
          worker: { backend: "claude-code", provider: "deepseek", model: "deepseek-v4-flash" },
        },
      });
      const created = await createTask(ctx, {
        request: "Drive from typed command.",
        cwd: dir,
      });
      if (!created.ok) throw new Error(created.error.message);

      const driven = await driveTask(ctx, {
        taskId: created.data.taskId,
        maxActions: 2,
        processClient: client,
        packageCwd: join(import.meta.dir, "../.."),
      });

      expect(driven).toMatchObject({
        ok: true,
        data: {
          stopReason: "max_actions",
          projection: { status: "plan_submitted" },
        },
      });
      expect(client.requestJson).toMatchObject({
        runtimeAssembly: {
          backend: {
            name: "claude-code",
            options: {
              provider: "deepseek",
              model: "deepseek-v4-flash",
              builtinTools: ["Read", "Glob", "Grep", "LS"],
              allowedTools: ["Read", "Glob", "Grep", "LS"],
              disallowedTools: ["Task", "Agent", "EnterPlanMode", "ExitPlanMode"],
            },
          },
          toolProfiles: {
            planningProtocol: "sikong-planning-protocol",
          },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("workspace store", () => {
  test("validates workspace ids", () => {
    expect(isValidWorkspaceId("sikong")).toBe(true);
    expect(isValidWorkspaceId("a.b-c_1")).toBe(true);
    expect(isValidWorkspaceId("")).toBe(false);
    expect(isValidWorkspaceId(".")).toBe(false);
    expect(isValidWorkspaceId("..")).toBe(false);
    expect(isValidWorkspaceId("a/b")).toBe(false);
  });

  test("stores, lists, reads, and deletes workspace definitions", async () => {
    const dir = await tmp();
    try {
      const store = new FileWorkspaceStore(dir);
      await store.put({ id: "sikong", name: "Sikong" });
      await store.put({ id: "docs", name: "Docs" });

      expect(await store.get("sikong")).toEqual({ id: "sikong", name: "Sikong" });
      expect((await store.list()).map((workspace) => workspace.id)).toEqual(["docs", "sikong"]);
      expect(await readFile(join(dir, "workspaces", "sikong", "workspace.yaml"), "utf8")).toContain(
        "Sikong",
      );

      await store.delete("docs");
      expect(await store.get("docs")).toBeNull();
      expect((await store.list()).map((workspace) => workspace.id)).toEqual(["sikong"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid workspace definitions", async () => {
    const dir = await tmp();
    try {
      const store = new FileWorkspaceStore(dir);
      await expect(store.put({ id: "bad/id", name: "Bad" })).rejects.toThrow(
        "invalid workspace id",
      );
      await expect(store.put({ id: "ok", name: "" })).rejects.toThrow("workspace name");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("workspace preferences", () => {
  test("reads empty preferences when preferences.yaml is absent", async () => {
    const dir = await tmp();
    try {
      const preferences = new FileWorkspacePreferencesFactory(dir).open({
        id: "sikong",
        name: "Sikong",
      });
      expect(await preferences.read()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes and appends preferences as YAML", async () => {
    const dir = await tmp();
    try {
      const preferences = new FileWorkspacePreferencesFactory(dir).open({
        id: "sikong",
        name: "Sikong",
      });

      await preferences.write([{ id: "verify", text: "Run bun run check before handoff." }]);
      const appended = await preferences.append({
        text: "Keep workspace directories separate from agent cwd.",
        note: "Workspace stores Sikong state.",
        sourceTaskId: "task_1",
      });

      expect(appended.id).toBe("keep-workspace-directories-separate");
      expect(await preferences.read()).toEqual([
        { id: "verify", text: "Run bun run check before handoff." },
        {
          id: "keep-workspace-directories-separate",
          text: "Keep workspace directories separate from agent cwd.",
          note: "Workspace stores Sikong state.",
          sourceTaskId: "task_1",
        },
      ]);
      const yaml = await readFile(preferencesFile(dir, "sikong"), "utf8");
      expect(yaml).toContain("preferences:");
      expect(yaml).toContain("keep-workspace-directories-separate");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deduplicates generated preference ids", async () => {
    const dir = await tmp();
    try {
      const preferences = new FileWorkspacePreferencesFactory(dir).open({
        id: "sikong",
        name: "Sikong",
      });
      expect((await preferences.append({ text: "Run bun run check" })).id).toBe(
        "run-bun-run-check",
      );
      expect((await preferences.append({ text: "Run bun run check" })).id).toBe(
        "run-bun-run-check-2",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
