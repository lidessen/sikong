import { describe, expect, test } from "vitest";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockLoop } from "agent-loop";
import { discoverWorkers, isValidWorkerId, type Worker } from "./worker";
import {
  JsonWorkerStore,
  MemoryEventStore,
  MemoryProjectionStore,
  MemoryWorkerStore,
  MemoryWorkflowRegistry,
} from "./store";
import { openWorkspace } from "./workspace";
import { WorkflowEngine } from "./engine";
import { GENERAL_WORKFLOW } from "./workflow/builtin";

const tmp = () => mkdtemp(join(tmpdir(), "aw-wk-"));
const FLASH: Worker = {
  id: "flash",
  name: "Flash",
  description: "cheap/fast",
  runtime: "ai-sdk",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  permissionMode: "acceptEdits",
};

describe("workers", () => {
  test("isValidWorkerId", () => {
    expect(isValidWorkerId("flash")).toBe(true);
    expect(isValidWorkerId("a/b")).toBe(false);
    expect(isValidWorkerId("")).toBe(false);
  });

  test("MemoryWorkerStore + JsonWorkerStore round-trip (no builtins)", async () => {
    expect(await new MemoryWorkerStore().list()).toEqual([]); // no builtins
    const dir = await tmp();
    try {
      const ws = new JsonWorkerStore(dir);
      expect(await ws.list()).toEqual([]);
      await ws.put(FLASH);
      expect(await readdir(join(dir, "workers"))).toEqual(["flash.yaml"]);
      expect(await readFile(join(dir, "workers", "flash.yaml"), "utf8")).toContain("deepseek");
      expect((await ws.get("flash"))?.model).toBe("deepseek-v4-flash");
      expect((await ws.get("flash"))?.permissionMode).toBe("acceptEdits");
      expect((await new JsonWorkerStore(dir).list()).map((w) => w.id)).toEqual(["flash"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("discoverWorkers returns the environment shape", async () => {
    const d = await discoverWorkers();
    expect(Array.isArray(d.providers)).toBe(true);
    expect(Array.isArray(d.providerDetails)).toBe(true);
    expect(Array.isArray(d.runtimes)).toBe(true);
    expect(Array.isArray(d.runtimeDetails)).toBe(true);
    expect(Array.isArray(d.compatibility)).toBe(true);
    expect(d).not.toHaveProperty("suggestions");
    expect(d.providerDetails.map((p) => p.id).sort()).toEqual(["anthropic", "deepseek", "openai"]);
    for (const c of d.compatibility) expect(d.runtimeDetails.find((r) => r.id === c.runtime)?.usableAsWorker).toBe(true);
  });

  test("discoverWorkers reports codex and cursor as facts without making suggestions", async () => {
    const dir = await tmp();
    const oldPath = process.env.PATH;
    const oldCursorKey = process.env.CURSOR_API_KEY;
    try {
      const codex = join(dir, "codex");
      await writeFile(codex, "#!/bin/sh\nexit 0\n");
      await chmod(codex, 0o755);
      process.env.PATH = `${dir}:${oldPath ?? ""}`;
      process.env.CURSOR_API_KEY = "test-cursor-key";

      const d = await discoverWorkers();
      expect(d.runtimes).toContain("codex");
      expect(d.runtimes).toContain("cursor");
      expect(d.runtimeDetails.find((r) => r.id === "codex")?.usableAsWorker).toBe(false);
      expect(d.runtimeDetails.find((r) => r.id === "cursor")?.usableAsWorker).toBe(false);
      expect(d).not.toHaveProperty("suggestions");
      expect(d.compatibility.map((c) => c.runtime as string)).not.toContain("codex");
      expect(d.compatibility.map((c) => c.runtime as string)).not.toContain("cursor");
    } finally {
      process.env.PATH = oldPath;
      if (oldCursorKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = oldCursorKey;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("createTask records the hired workerId on the task", async () => {
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop: () => mockLoop({ response: "x" }),
    });
    const t = await engine.createTask({ projectId: "p", taskId: "t1", workerId: "flash", wake: false });
    expect(t.workerId).toBe("flash");
  });

  test("a wake with no worker in the roster fails clearly", async () => {
    const errors: string[] = [];
    const dir = await tmp();
    try {
      // No injected loop + no workers → the default loop must report "no worker hired".
      const ws = await openWorkspace(dir, { hooks: { onError: ({ error }) => errors.push(error.message) } });
      await ws.engine.createTask({ projectId: "default", workflowId: "general", taskId: "t1" });
      await ws.engine.idle();
      expect(errors.some((m) => /no worker hired/.test(m))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
