import { describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockLoop } from "agent-loop";
import { getDefaultWorker, loadWorkflows, openWorkspace, saveWorkflow, setDefaultWorker } from "./workspace";
import { projectStateDir, resolveWorkspaceDir } from "./workspace-layout";
import type { LoopFactory } from "./engine";
import type { WorkflowDef } from "./workflow/types";

const tmp = () => mkdtemp(join(tmpdir(), "aw-ws-"));

const BUG: WorkflowDef = {
  id: "bug",
  version: "1",
  name: "Bug",
  description: "fix a bug",
  fields: { title: { type: "string", description: "" } },
  stages: [
    { id: "open", category: "in_progress", entry: { op: "always" } },
    { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
  ],
};

const worker = () => mockLoop({ callTool: { name: "request_transition", args: { reason: "done" } } });

describe("workspace (CLI wiring)", () => {
  test("create (intake) then run, over a durable dir, drives a task to done", async () => {
    const dir = await tmp();
    try {
      const ws = await openWorkspace(dir, {
        extraWorkflows: [BUG],
        loop: worker,
        intakeLoop: () => mockLoop({ callTool: { name: "route", args: { workflowId: "bug", fields: { title: "x" } } } }),
      });
      const task = await ws.engine.intake("a bug report", { projectId: "default", taskId: "b1", wake: false });
      expect(task.workflowId).toBe("bug");
      expect((await ws.projections.get("b1"))?.status).toBe("in_progress"); // created, not run

      // A FRESH workspace over the same dir drives it — proves durability + `run`.
      const ws2 = await openWorkspace(dir, { extraWorkflows: [BUG], loop: worker });
      await ws2.engine.runPending();
      expect((await ws2.projections.get("b1"))?.status).toBe("done");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("submit applies a lead command without running a wake", async () => {
    const dir = await tmp();
    try {
      const ws = await openWorkspace(dir, { extraWorkflows: [BUG], loop: () => mockLoop({ response: "x" }) });
      await ws.engine.createTask({ projectId: "default", workflowId: "bug", taskId: "b2", fields: {}, wake: false });
      await ws.engine.submitCommand("b2", { kind: "set_field", field: "title", value: "hi" }, "lead", {
        schedule: false,
      });
      expect((await ws.projections.get("b2"))?.fields.title).toBe("hi");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creds-free: openWorkspace + submit work with no DEEPSEEK key (lazy default loops)", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const dir = await tmp();
    try {
      // DEFAULT loops (not injected): must not resolve the key until a wake fires.
      const ws = await openWorkspace(dir, { extraWorkflows: [BUG] });
      await ws.engine.createTask({ projectId: "default", workflowId: "bug", taskId: "c1", fields: {}, wake: false });
      await ws.engine.submitCommand("c1", { kind: "set_field", field: "title", value: "hi" }, "lead", {
        schedule: false,
      });
      expect((await ws.projections.get("c1"))?.fields.title).toBe("hi");
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a persisted/extra 'general' cannot shadow the builtin fallback", async () => {
    const dir = await tmp();
    try {
      const fakeGeneral: WorkflowDef = {
        id: "general",
        version: "1",
        name: "Fake",
        description: "",
        fields: {},
        stages: [
          { id: "open", category: "in_progress", entry: { op: "always" } },
          { id: "done", category: "done", entry: { op: "always" } },
        ],
      };
      const ws = await openWorkspace(dir, {
        extraWorkflows: [fakeGeneral],
        loop: () => mockLoop({ response: "x" }),
      });
      // The builtin GENERAL declares a `request` field; the fake one doesn't.
      expect(ws.registry.get("general")?.fields.request).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("openWorkspace registers builtin development workflow and keeps it builtin-owned", async () => {
    const dir = await tmp();
    try {
      const fakeDevelopment: WorkflowDef = {
        id: "development",
        version: "1",
        name: "Fake Development",
        description: "",
        fields: {},
        stages: [
          { id: "open", category: "in_progress", entry: { op: "always" } },
          { id: "done", category: "done", entry: { op: "always" } },
        ],
      };
      const ws = await openWorkspace(dir, {
        extraWorkflows: [fakeDevelopment],
        loop: () => mockLoop({ response: "x" }),
      });

      const development = ws.registry.get("development");
      expect(development?.fields.plan).toBeDefined();
      expect(development?.stages.map((s) => s.id)).toEqual(["plan", "design", "implement", "verify", "done"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("default wakes have enough step budget for small development edits", async () => {
    const dir = await tmp();
    let observedMaxSteps: number | undefined;
    try {
      const base = worker();
      const loop: LoopFactory = () => ({
        ...base,
        run(input) {
          if (typeof input !== "string") observedMaxSteps = input.maxSteps;
          return base.run(input);
        },
      });
      const ws = await openWorkspace(dir, { extraWorkflows: [BUG], loop });
      await ws.engine.createTask({ projectId: "default", workflowId: "bug", taskId: "steps", fields: {} });
      await ws.engine.idle();

      expect(observedMaxSteps).toBe(12);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("durable subtask spawning across fresh engines doesn't collide on ids", async () => {
    const CHILD: WorkflowDef = {
      id: "child", version: "1", name: "Child", description: "",
      fields: {},
      stages: [
        { id: "open", category: "in_progress", entry: { op: "always" } },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const PARENT: WorkflowDef = {
      id: "parent", version: "1", name: "Parent", description: "",
      fields: {},
      stages: [
        { id: "split", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask"] },
        { id: "done", category: "done", entry: { op: "childrenDone" } },
      ],
    };
    const loop: LoopFactory = (ctx) =>
      ctx.stageId === "split"
        ? mockLoop({ callTool: { name: "create_subtask", args: { workflowId: "child", input: "x" } } })
        : mockLoop({ callTool: { name: "request_transition", args: { reason: "d" } } });
    const dir = await tmp();
    try {
      const ws1 = await openWorkspace(dir, { extraWorkflows: [CHILD, PARENT], loop });
      // Occupy an id an in-memory counter would re-mint (the old collision bug).
      await ws1.engine.createTask({ projectId: "default", workflowId: "general", taskId: "task_1", wake: false });
      await ws1.engine.createTask({ projectId: "default", workflowId: "parent", taskId: "P", wake: false });
      // A FRESH engine drives P → spawns a child whose id must not collide with task_1.
      const ws2 = await openWorkspace(dir, { extraWorkflows: [CHILD, PARENT], loop });
      await ws2.engine.runPending();
      expect((await ws2.projections.get("P"))?.status).toBe("done");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("saveWorkflow + loadWorkflows round-trip; openWorkspace registers persisted workflows", async () => {
    const dir = await tmp();
    try {
      await saveWorkflow(dir, BUG);
      expect(await readdir(join(dir, "workflows"))).toEqual(["bug@1.yaml"]);
      expect((await loadWorkflows(dir)).map((w) => w.id)).toContain("bug");
      expect(await readFile(join(dir, "workflows", "bug@1.yaml"), "utf8")).toContain("bug");
      const ws = await openWorkspace(dir, { loop: () => mockLoop({ response: "x" }) });
      expect(ws.registry.get("bug")?.id).toBe("bug");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadWorkflows still accepts legacy JSON workflow definitions", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, "workflows"), { recursive: true });
      await writeFile(join(dir, "workflows", "bug@1.json"), JSON.stringify(BUG, null, 2));
      expect((await loadWorkflows(dir)).map((w) => w.id)).toEqual(["bug"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("workspace config is stored as YAML", async () => {
    const dir = await tmp();
    try {
      await setDefaultWorker(dir, "flash");
      expect(await readFile(join(dir, "config.yaml"), "utf8")).toContain("flash");
      expect(await getDefaultWorker(dir)).toBe("flash");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("workspace dir resolution defaults to WAKESPACE_HOME and preserves explicit legacy overrides", () => {
    expect(resolveWorkspaceDir({ dirFlag: "/tmp/explicit", env: { WAKESPACE_DIR: "/tmp/legacy", WAKESPACE_HOME: "/tmp/home" } }).dir).toBe(
      "/tmp/explicit",
    );
    expect(resolveWorkspaceDir({ env: { WAKESPACE_DIR: "/tmp/legacy", WAKESPACE_HOME: "/tmp/home" } }).dir).toBe(
      "/tmp/legacy",
    );
    expect(resolveWorkspaceDir({ env: { WAKESPACE_HOME: "/tmp/home" } }).dir).toBe("/tmp/home");
    expect(resolveWorkspaceDir({ env: {} }).dir).toMatch(/\.wakespace$/);
  });

  test("openWorkspace writes project task state under projects/<id>/state", async () => {
    const dir = await tmp();
    try {
      const ws = await openWorkspace(dir, { extraWorkflows: [BUG], loop: () => mockLoop({ response: "x" }) });
      await ws.projects.put({ id: "web", name: "Web", root: "/repo/web", defaultWorkflowId: "bug" });
      await ws.engine.createTask({ projectId: "web", workflowId: "bug", taskId: "web-task", fields: {}, wake: false });

      const stateDir = projectStateDir(dir, "web");
      expect(await readFile(join(stateDir, "events", "web-task.jsonl"), "utf8")).toContain('"projectId":"web"');
      expect(await readFile(join(stateDir, "projections", "web-task.json"), "utf8")).toContain('"projectId": "web"');
      await expect(
        (await openWorkspace(dir, { extraWorkflows: [BUG], loop: () => mockLoop({ response: "x" }) })).projections.get(
          "web-task",
        ),
      ).resolves.toMatchObject({
        id: "web-task",
        projectId: "web",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
