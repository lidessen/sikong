import { describe, expect, test } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockLoop } from "agent-loop";
import { DEFAULT_PROJECT, isValidProjectId } from "./project";
import {
  JsonProjectStore,
  MemoryEventStore,
  MemoryProjectionStore,
  MemoryProjectStore,
  MemoryWorkflowRegistry,
} from "./store";
import { WorkflowEngine, type LoopFactory } from "./engine";
import { GENERAL_WORKFLOW } from "./workflow/builtin";
import type { WorkflowDef } from "./workflow/types";

const tmp = () => mkdtemp(join(tmpdir(), "aw-proj-"));

const BUG: WorkflowDef = {
  id: "bug",
  version: "1",
  name: "Bug",
  description: "",
  fields: {},
  stages: [
    { id: "open", category: "in_progress", entry: { op: "always" } },
    { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
  ],
};

describe("projects", () => {
  test("isValidProjectId", () => {
    expect(isValidProjectId("web")).toBe(true);
    expect(isValidProjectId("a/b")).toBe(false);
    expect(isValidProjectId("..")).toBe(false);
    expect(isValidProjectId("")).toBe(false);
  });

  test("JsonProjectStore: builtin default is always available; create + list round-trip", async () => {
    const dir = await tmp();
    try {
      const ps = new JsonProjectStore(dir);
      expect((await ps.get("default"))?.id).toBe("default"); // builtin, no file
      await ps.put({ id: "web", name: "Web", root: "/repo/web", defaultWorker: "flash" });
      expect(await readdir(join(dir, "projects"))).toEqual(["web.yaml"]);
      expect(await readFile(join(dir, "projects", "web.yaml"), "utf8")).toContain("flash");
      expect((await ps.get("web"))?.root).toBe("/repo/web");
      const ids = (await ps.list()).map((p) => p.id).sort();
      expect(ids).toContain("default");
      expect(ids).toContain("web");
      // a fresh instance reads the persisted project
      expect((await new JsonProjectStore(dir).get("web"))?.defaultWorker).toBe("flash");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("createTask rejects an unknown project and uses the project's default workflow", async () => {
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    registry.register(BUG);
    const projects = new MemoryProjectStore([
      DEFAULT_PROJECT,
      { id: "web", name: "Web", root: ".", defaultWorkflowId: "bug" },
    ]);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry,
      projects,
      loop: () => mockLoop({ response: "x" }),
    });

    await expect(engine.createTask({ projectId: "nope", taskId: "t0", wake: false })).rejects.toThrow(
      /unknown project/,
    );
    expect((await engine.createTask({ projectId: "web", taskId: "t1", wake: false })).workflowId).toBe("bug");
    expect((await engine.createTask({ projectId: "default", taskId: "t2", wake: false })).workflowId).toBe(
      "general",
    );
  });

  test("the wake's loop factory receives the task's project (isolation context)", async () => {
    let seenRoot: string | undefined;
    const projects = new MemoryProjectStore([{ id: "web", name: "Web", root: "/repo/web" }]);
    const loop: LoopFactory = (ctx) => {
      seenRoot = ctx.project?.root;
      return mockLoop({ callTool: { name: "request_transition", args: { reason: "x" } } });
    };
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      projects,
      loop,
    });

    await engine.createTask({ projectId: "web", workflowId: "general", taskId: "w1" });
    await engine.idle();
    expect(seenRoot).toBe("/repo/web");
  });
});
