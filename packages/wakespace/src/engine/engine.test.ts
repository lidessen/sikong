import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  mockLoop,
  emptyUsage,
  type AgentLoop,
  type Capability,
  type CapabilityList,
  type LoopEvent,
  type RunHandle,
  type RunInput,
} from "agent-loop";
import { WorkflowEngine, type LoopFactory } from "./engine";
import { DEVELOPMENT_WORKFLOW, GENERAL_WORKFLOW } from "../workflow/builtin";
import type { WorkflowDef } from "../workflow/types";
import {
  MemoryChronicleStore,
  MemoryEventStore,
  MemoryProjectStore,
  MemoryProjectionStore,
  MemoryWorkflowRegistry,
} from "../store/memory";

function newEngine(loop: LoopFactory, extra: WorkflowDef[] = [], hooks = {}) {
  const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
  for (const wf of extra) registry.register(wf);
  return new WorkflowEngine({
    events: new MemoryEventStore(() => 1),
    projections: new MemoryProjectionStore(),
    registry,
    loop,
    hooks,
  });
}

const TWO_STEP: WorkflowDef = {
  id: "eng",
  version: "1",
  name: "Eng",
  description: "two field gates",
  fields: {
    a: { type: "boolean", description: "first gate" },
    b: { type: "boolean", description: "second gate" },
  },
  stages: [
    { id: "s0", category: "todo", entry: { op: "always" } },
    { id: "s1", category: "in_progress", entry: { op: "field", field: "a", cmp: "eq", value: true } },
    { id: "s2", category: "done", entry: { op: "field", field: "b", cmp: "eq", value: true } },
  ],
};

describe("WorkflowEngine wake cycle", () => {
  test("drives a multi-stage task to done across self-continued wakes", async () => {
    const loop: LoopFactory = (ctx) =>
      ctx.stageId === "s0"
        ? mockLoop({ callTool: { name: "set_field", args: { field: "a", value: true } } })
        : mockLoop({ callTool: { name: "set_field", args: { field: "b", value: true } } });
    const engine = newEngine(loop, [TWO_STEP]);

    await engine.createTask({ projectId: "p", workflowId: "eng", taskId: "t1" });
    await engine.idle();

    const t = await engine.getTask("t1");
    expect(t?.stageId).toBe("s2");
    expect(t?.status).toBe("done");
    expect(t?.fields).toMatchObject({ a: true, b: true });
  });

  test("drives a GENERAL task to done via request_transition", async () => {
    const loop: LoopFactory = () =>
      mockLoop({ callTool: { name: "request_transition", args: { reason: "did it" } } });
    const engine = newEngine(loop);

    await engine.createTask({ projectId: "p", taskId: "g1", fields: { request: "do X" } });
    await engine.idle();

    expect((await engine.getTask("g1"))?.status).toBe("done");
  });

  test("worker cancel records an approval request instead of terminating the task", async () => {
    const events = new MemoryEventStore(() => 1);
    const engine = new WorkflowEngine({
      events,
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop: () => mockLoop({ callTool: { name: "cancel", args: { reason: "not worth doing" } } }),
    });

    await engine.createTask({ projectId: "p", taskId: "worker-cancel", fields: { request: "do X" } });
    await engine.idle();

    expect((await engine.getTask("worker-cancel"))?.status).toBe("in_progress");
    expect((await events.load("worker-cancel")).map((e) => e.type)).toContain("cancellation.requested");
    expect((await events.load("worker-cancel")).map((e) => e.type)).not.toContain("task.cancelled");
  });

  test("drives DEVELOPMENT through plan, design, implement, verify, and done", async () => {
    const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        if (ctx.stageId === "plan") {
          await input.tools?.set_field?.execute?.({ field: "plan", value: "Plan the bounded change." }, {});
          await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
          return;
        }

        if (ctx.stageId === "design") {
          await input.tools?.set_field?.execute?.({ field: "design", value: "Use the established pattern." }, {});
          await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
          return;
        }

        if (ctx.stageId === "implement") {
          await input.tools?.set_field?.execute?.(
            { field: "implementation", value: "Changed worker discovery output." },
            {},
          );
          await input.tools?.set_field?.execute?.(
            { field: "changedFiles", value: ["packages/wakespace/src/worker.ts"] },
            {},
          );
          await input.tools?.request_transition?.execute?.({ reason: "implemented" }, {});
          return;
        }

        await input.tools?.set_field?.execute?.({ field: "verification", value: "Focused tests passed." }, {});
        await input.tools?.set_field?.execute?.({ field: "summary", value: "Development workflow completed." }, {});
        await input.tools?.request_transition?.execute?.({ reason: "verified" }, {});
      });
    const engine = newEngine(loop, [DEVELOPMENT_WORKFLOW]);

    await engine.createTask({
      projectId: "p",
      workflowId: "development",
      taskId: "dev1",
      fields: { request: "change worker discover" },
    });
    await engine.idle();

    const task = await engine.getTask("dev1");
    expect(task?.status).toBe("done");
    expect(task?.stageId).toBe("done");
    expect(task?.fields).toMatchObject({
      plan: "Plan the bounded change.",
      design: "Use the established pattern.",
      implementation: "Changed worker discovery output.",
      verification: "Focused tests passed.",
      summary: "Development workflow completed.",
    });
    expect(task?.fields.changedFiles).toEqual(["packages/wakespace/src/worker.ts"]);
  });

  test("runs a forced commit pass when a worker returns text without state commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "wakespace-commit-tools-"));
    await writeFile(join(root, "marker.txt"), "done\n", "utf8");
    let calls = 0;
    let commitRuntimeOptions: unknown;
    const loop: LoopFactory = () =>
      scriptLoop(async (input) => {
        calls++;
        if (calls === 1) {
          await input.tools?.writeFile?.execute?.({ path: "marker.txt", content: "done\n" }, {});
          return;
        }
        commitRuntimeOptions = input.runtimeOptions;
        expect(Object.keys(input.tools ?? {}).sort()).toEqual(["block", "cancel", "commit_stage"]);
        await input.tools?.commit_stage?.execute?.(
          { fields: { summary: "validated by worker commit pass" }, reason: "committed" },
          {},
        );
      }, "ai-sdk");
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "Project", root }]),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop,
    });

    await engine.createTask({ projectId: "p", taskId: "commit1", fields: { request: "validate" } });
    await engine.idle();

    const task = await engine.getTask("commit1");
    expect(calls).toBe(2);
    expect(task?.status).toBe("done");
    expect(task?.fields.summary).toBe("validated by worker commit pass");
    expect(commitRuntimeOptions).toMatchObject({ toolChoice: "required" });
    expect(commitRuntimeOptions).toMatchObject({ activeTools: ["commit_stage", "block", "cancel"] });
    expect(commitRuntimeOptions).toMatchObject({
      providerOptions: { deepseek: { thinking: { type: "disabled" } } },
    });
  });

  test("blocks an ungrounded forced commit pass when no project write ran", async () => {
    let calls = 0;
    const loop: LoopFactory = () =>
      scriptLoop(async (input) => {
        calls++;
        if (calls === 1) return;
        expect(Object.keys(input.tools ?? {}).sort()).toEqual(["block"]);
        await input.tools?.block?.execute?.({ reason: "no project writeFile evidence" }, {});
      }, "ai-sdk");
    const engine = newEngine(loop);

    await engine.createTask({ projectId: "p", taskId: "commit-ungrounded", fields: { request: "validate" } });
    await engine.idle();

    const task = await engine.getTask("commit-ungrounded");
    expect(calls).toBe(2);
    expect(task?.status).toBe("blocked");
  });

  test("allows a no-write forced commit pass on development planning stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "wakespace-dev-plan-commit-"));
    let calls = 0;
    let planPasses = 0;
    const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        calls++;
        if (ctx.stageId === "plan") {
          planPasses++;
          if (planPasses === 1) return;
          expect(Object.keys(input.tools ?? {}).sort()).toEqual(["block", "cancel", "commit_stage"]);
          await input.tools?.commit_stage?.execute?.(
            { fields: { plan: "Plan first, then implement." }, reason: "planned" },
            {},
          );
          return;
        }
        if (ctx.stageId === "design") {
          await input.tools?.set_field?.execute?.({ field: "design", value: "Small typed policy." }, {});
          await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
          return;
        }
        if (ctx.stageId === "implement") {
          await input.tools?.writeFile?.execute?.({ path: "marker.txt", content: "done\n" }, {});
          await input.tools?.set_field?.execute?.({ field: "implementation", value: "Changed marker." }, {});
          await input.tools?.set_field?.execute?.({ field: "changedFiles", value: ["marker.txt"] }, {});
          await input.tools?.request_transition?.execute?.({ reason: "implemented" }, {});
          return;
        }
        await input.tools?.set_field?.execute?.({ field: "verification", value: "Checked marker." }, {});
        await input.tools?.set_field?.execute?.({ field: "summary", value: "Development completed." }, {});
        await input.tools?.request_transition?.execute?.({ reason: "verified" }, {});
      }, "ai-sdk");
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    registry.register(DEVELOPMENT_WORKFLOW);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "Project", root }]),
      registry,
      loop,
    });

    await engine.createTask({
      projectId: "p",
      workflowId: "development",
      taskId: "dev-plan-commit",
      fields: { request: "plan the change" },
    });
    await engine.idle();

    const task = await engine.getTask("dev-plan-commit");
    expect(calls).toBe(5);
    expect(planPasses).toBe(2);
    expect(task?.stageId).toBe("done");
    expect(task?.status).toBe("done");
    expect(task?.fields.plan).toBe("Plan first, then implement.");
  });

  test("forced commit stage wins over block in the same commit pass", async () => {
    let calls = 0;
    let commitSystem = "";
    const loop: LoopFactory = () =>
      scriptLoop(async (input) => {
        calls++;
        if (calls === 1) return;
        if (!input.tools?.commit_stage) return;
        commitSystem = input.system ?? "";
        await input.tools?.block?.execute?.({ reason: "confused" }, {});
        await input.tools?.commit_stage?.execute?.(
          { fields: { plan: "Bounded plan from request." }, reason: "planned" },
          {},
        );
        await input.tools?.block?.execute?.({ reason: "late confusion" }, {});
      }, "ai-sdk");
    const engine = newEngine(loop, [DEVELOPMENT_WORKFLOW]);

    await engine.createTask({
      projectId: "p",
      workflowId: "development",
      taskId: "commit-stage-wins",
      fields: { request: "plan the change" },
    });
    await engine.idle();

    const task = await engine.getTask("commit-stage-wins");
    expect(commitSystem).toContain("Current task fields");
    expect(commitSystem).toContain("plan the change");
    expect(task?.stageId).toBe("design");
    expect(task?.status).toBe("in_progress");
    expect(task?.fields.plan).toBe("Bounded plan from request.");
  });

  test("reports a wake error when even the forced commit pass emits no state commands", async () => {
    const errors: string[] = [];
    const engine = newEngine(
      () => scriptLoop(async () => {}),
      [],
      { onError: ({ error }: { error: Error }) => errors.push(error.message) },
    );

    await engine.createTask({ projectId: "p", taskId: "commit-empty", fields: { request: "validate" } });
    await engine.idle();

    expect((await engine.getTask("commit-empty"))?.status).toBe("in_progress");
    expect(errors).toContain("worker completed without calling any wakespace state tool");
  });

  test("an external command can finish a stage with no agent wake (pre-advance)", async () => {
    const wf: WorkflowDef = {
      id: "lead",
      version: "1",
      name: "Lead",
      description: "",
      fields: { ok: { type: "boolean", description: "" } },
      stages: [
        { id: "open", category: "in_progress", entry: { op: "always" } },
        { id: "done", category: "done", entry: { op: "field", field: "ok", cmp: "eq", value: true } },
      ],
    };
    let factoryCalls = 0;
    const loop: LoopFactory = () => {
      factoryCalls++;
      return mockLoop({ response: "noop" });
    };
    const engine = newEngine(loop, [wf]);

    await engine.createTask({ projectId: "p", workflowId: "lead", taskId: "l1", wake: false });
    await engine.submitCommand("l1", { kind: "set_field", field: "ok", value: true }, "lead");
    await engine.idle();

    expect((await engine.getTask("l1"))?.status).toBe("done");
    expect(factoryCalls).toBe(0); // pre-advance completed it; no agent turn spent
  });

  test("an illegal tool-call is rejected without crashing the wake", async () => {
    const loop: LoopFactory = () =>
      mockLoop({ callTool: { name: "set_field", args: { field: "ghost", value: 1 } } });
    const rejects: { command: unknown; reason: string }[] = [];
    const engine = newEngine(loop, [], {
      onReject: (i: { command: unknown; reason: string }) => rejects.push(i),
    });

    await engine.createTask({ projectId: "p", taskId: "r1", fields: {} });
    await engine.idle();

    expect(rejects).toHaveLength(1);
    const t = await engine.getTask("r1");
    expect(t?.status).toBe("in_progress");
    expect(t?.stageId).toBe("open");
  });

  test("single-writer: wake bodies for one task never overlap; mid-wake signals coalesce", async () => {
    let active = 0;
    let maxActive = 0;
    let bodies = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((r) => {
      firstStarted = r;
    });
    let n = 0;

    const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        active++;
        maxActive = Math.max(maxActive, active);
        bodies++;
        try {
          if (n++ === 0) {
            firstStarted();
            await gate; // hold the first wake's body open while we fire signals
          }
          input.tools?.set_field?.execute?.({ field: ctx.stageId === "s0" ? "a" : "b", value: true }, {});
        } finally {
          active--;
        }
      });
    const engine = newEngine(loop, [TWO_STEP]);

    await engine.createTask({ projectId: "p", workflowId: "eng", taskId: "c1" });
    await started; // the first wake's body is in-flight, holding the gate

    engine.nudge("c1");
    engine.nudge("c1");
    engine.nudge("c1");
    expect(active).toBe(1); // signals can't start a second body

    release();
    await engine.idle();

    expect(maxActive).toBe(1); // no two bodies ever overlapped
    expect(bodies).toBe(2); // s0 + s1 — the three nudges coalesced, not five wakes
    expect((await engine.getTask("c1"))?.status).toBe("done");
  });

  test("an errored agent run is surfaced, not silently swallowed as a no-op wake", async () => {
    const errors: Error[] = [];
    const ends: { status: string; error?: Error }[] = [];
    const loop: LoopFactory = () => mockLoop({ failWith: "boom" });
    const engine = newEngine(loop, [], {
      onError: (i: { error: Error }) => errors.push(i.error),
      onWakeEnd: (i: { status: string; error?: Error }) => ends.push(i),
    });

    await engine.createTask({ projectId: "p", taskId: "e1", fields: {} });
    await engine.idle();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("boom");
    expect(ends.at(-1)?.error?.message).toContain("boom");
    expect((await engine.getTask("e1"))?.status).toBe("in_progress");
  });

  test("a cancel racing a wake never writes a worker event after the terminal event", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    const events = new MemoryEventStore(() => 1);
    const loop: LoopFactory = () =>
      scriptLoop(async (input) => {
        started();
        await gate;
        input.tools?.set_field?.execute?.({ field: "summary", value: "late" }, {});
        input.tools?.request_transition?.execute?.({}, {});
      });
    const engine = new WorkflowEngine({
      events,
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop,
    });

    await engine.createTask({ projectId: "p", taskId: "x1", fields: {} });
    await startedP; // wake in-flight, holding the gate
    await engine.submitCommand("x1", { kind: "cancel", reason: "stop" }, "lead");
    release();
    await engine.idle();

    expect((await engine.getTask("x1"))?.status).toBe("cancelled");
    const log = await events.load("x1");
    const cancelAt = log.findIndex((e) => e.type === "task.cancelled");
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(log.slice(cancelAt + 1).some((e) => e.source === "worker")).toBe(false);
    expect(log.some((e) => e.type === "field.set" || e.type === "transition.requested")).toBe(false);
  });

  test("a hung wake is bounded by wakeTimeoutMs and reported, never left to hang", async () => {
    const errors: Error[] = [];
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop: () => hangingLoop(),
      wakeTimeoutMs: 40,
      hooks: { onError: (i: { error: Error }) => errors.push(i.error) },
    });

    await engine.createTask({ projectId: "p", taskId: "h1", fields: {} });
    await engine.idle(); // must resolve even though the backend never returns

    expect(errors.some((e) => /timed out/.test(e.message))).toBe(true);
    expect((await engine.getTask("h1"))?.status).toBe("in_progress");
  });

  test("createTask rejects an unsafe task id (filename collision / traversal safety)", async () => {
    const engine = newEngine(() => mockLoop({ response: "x" }));
    await expect(engine.createTask({ projectId: "p", taskId: "../evil", wake: false })).rejects.toThrow(
      /invalid task id/,
    );
    await expect(engine.createTask({ projectId: "p", taskId: "a/b", wake: false })).rejects.toThrow(
      /invalid task id/,
    );
  });

  test("createTask rejects a duplicate task id", async () => {
    const engine = newEngine(() => mockLoop({ response: "x" }));
    await engine.createTask({ projectId: "p", taskId: "dup", wake: false });
    await expect(engine.createTask({ projectId: "p", taskId: "dup", wake: false })).rejects.toThrow(
      /already exists/,
    );
  });

  test("a worker field-only command re-persists the projection (no stale read)", async () => {
    const engine = newEngine(() =>
      mockLoop({ callTool: { name: "set_field", args: { field: "summary", value: "partial" } } }),
    );
    await engine.createTask({ projectId: "p", taskId: "f1", fields: {} });
    await engine.idle();
    const t = await engine.getTask("f1");
    expect(t?.fields.summary).toBe("partial"); // reflected even though no transition occurred
    expect(t?.stageId).toBe("open");
    expect(t?.status).toBe("in_progress");
  });

  test("injects project tools for ai-sdk wakes scoped to the task project", async () => {
    const root = await mkdtemp(join(tmpdir(), "wakespace-project-tools-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.txt"), "needle\n", "utf8");
    let sawRg = false;
    let sawProjectPrompt = false;
    let runtimeOptions: unknown;
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "Project", root }]),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop: () =>
        scriptLoop(async (input) => {
          sawRg = Boolean(input.tools?.rg);
          sawProjectPrompt = Boolean(input.system?.includes("Project tools"));
          runtimeOptions = input.runtimeOptions;
          const result = (await input.tools?.rg?.execute?.(
            { pattern: "needle", path: "src" },
            {},
          )) as { matches?: string[] } | undefined;
          expect(result?.matches).toEqual(["src/a.txt:1:needle"]);
          await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
        }, "ai-sdk"),
    });

    await engine.createTask({ projectId: "p", taskId: "ai-tools", fields: { request: "search" } });
    await engine.idle();

    expect(sawRg).toBe(true);
    expect(sawProjectPrompt).toBe(true);
    expect(runtimeOptions).toMatchObject({ toolChoice: "required" });
    expect((await engine.getTask("ai-tools"))?.status).toBe("done");
  });

  test("a worker spawns a subtask and the parent advances on childrenDone (DAG)", async () => {
    const CHILD: WorkflowDef = {
      id: "child",
      version: "1",
      name: "Child",
      description: "",
      fields: {},
      stages: [
        { id: "open", category: "in_progress", entry: { op: "always" } },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const PARENT: WorkflowDef = {
      id: "parent",
      version: "1",
      name: "Parent",
      description: "",
      fields: {},
      stages: [
        { id: "split", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask"] },
        { id: "done", category: "done", entry: { op: "childrenDone" } },
      ],
    };
    const loop: LoopFactory = (ctx) =>
      ctx.stageId === "split"
        ? mockLoop({ callTool: { name: "create_subtask", args: { workflowId: "child", input: "do part" } } })
        : mockLoop({ callTool: { name: "request_transition", args: { reason: "child done" } } });
    const engine = newEngine(loop, [CHILD, PARENT]);

    await engine.createTask({ projectId: "p", workflowId: "parent", taskId: "P" });
    await engine.idle();

    const parent = await engine.getTask("P");
    expect(parent?.status).toBe("done");
    expect(parent?.childIds).toHaveLength(1);
    expect((await engine.getTask(parent!.childIds[0]!))?.status).toBe("done");
  });

  test("the wake budget stops a self-spawning runaway (idle resolves, no OOM)", async () => {
    const CHILD: WorkflowDef = {
      id: "child", version: "1", name: "Child", description: "",
      fields: {},
      stages: [
        { id: "open", category: "in_progress", entry: { op: "always" } },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    // `spin` re-spawns a child on every wake and never advances — a runaway absent the budget.
    const SPIN: WorkflowDef = {
      id: "spin", version: "1", name: "Spin", description: "",
      fields: { done: { type: "boolean", description: "" } },
      stages: [
        { id: "spin", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask"] },
        { id: "end", category: "done", entry: { op: "field", field: "done", cmp: "eq", value: true } },
      ],
    };
    const loop: LoopFactory = (ctx) =>
      ctx.stageId === "spin"
        ? mockLoop({ callTool: { name: "create_subtask", args: { workflowId: "child", input: "x" } } })
        : mockLoop({ callTool: { name: "request_transition", args: { reason: "d" } } });
    const errors: string[] = [];
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    registry.register(CHILD);
    registry.register(SPIN);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry,
      loop,
      maxWakesPerTask: 3,
      hooks: { onError: (i: { error: Error }) => errors.push(i.error.message) },
    });

    await engine.createTask({ projectId: "p", workflowId: "spin", taskId: "S" });
    await engine.idle(); // must resolve, not hang/OOM

    expect(errors.some((m) => /budget/.test(m))).toBe(true);
    const s = await engine.getTask("S");
    expect(s?.stageId).toBe("spin");
    expect(s?.childIds.length ?? 0).toBeLessThanOrEqual(3);
  });

  test("submitCommand rejects create_subtask (worker-only intent)", async () => {
    const engine = newEngine(() => mockLoop({ response: "x" }));
    await engine.createTask({ projectId: "p", taskId: "sc", wake: false });
    await expect(
      engine.submitCommand("sc", { kind: "create_subtask", childId: "x", workflowId: "general", input: "y" }),
    ).rejects.toThrow(/worker-only/);
  });

  test("the chronicle records created / wake / advanced / terminal", async () => {
    const chronicle = new MemoryChronicleStore(() => 1);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      chronicle,
      loop: () => mockLoop({ callTool: { name: "request_transition", args: { reason: "x" } } }),
    });
    await engine.createTask({ projectId: "p", taskId: "c1" });
    await engine.idle();
    const types = (await chronicle.recent({ taskId: "c1", limit: 50 })).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["task.created", "wake.start", "task.advanced", "task.terminal", "wake.end"]),
    );
  });
});

/** A loop whose run() executes `body` (which may await), resolving when it finishes. */
function scriptLoop(body: (input: RunInput) => Promise<void>, id = "scripted"): AgentLoop {
  const capabilities: CapabilityList = ["tools"];
  return {
    id,
    capabilities,
    supports: (c: Capability) => capabilities.includes(c),
    run(input: RunInput): RunHandle {
      const work = body(input);
      const result = work.then(() => ({
        events: [] as LoopEvent[],
        usage: emptyUsage(),
        durationMs: 0,
        status: "completed" as const,
        text: "",
      }));
      const none = async function* (): AsyncGenerator<never> {};
      return {
        [Symbol.asyncIterator]: () => none(),
        textStream: none(),
        result,
        text: result.then((r) => r.text),
        usage: result.then((r) => r.usage),
        steer: async () => ({ mode: "rejected" as const }),
        cancel: () => {},
      };
    },
    preflight: async () => ({ ok: true }),
    dispose: async () => {},
  };
}

/** A backend that never returns and ignores cancellation — simulates a wedged run. */
function hangingLoop(): AgentLoop {
  const capabilities: CapabilityList = ["tools"];
  const never = new Promise<never>(() => {});
  const none = async function* (): AsyncGenerator<never> {};
  return {
    id: "hang",
    capabilities,
    supports: (c: Capability) => capabilities.includes(c),
    run(): RunHandle {
      return {
        [Symbol.asyncIterator]: () => none(),
        textStream: none(),
        result: never,
        text: never,
        usage: never,
        steer: async () => ({ mode: "rejected" as const }),
        cancel: () => {},
      };
    },
    preflight: async () => ({ ok: true }),
    dispose: async () => {},
  };
}
