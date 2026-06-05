import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  mockLoop,
  defineTool,
  emptyUsage,
  type AgentLoop,
  type Capability,
  type CapabilityList,
  type LoopEvent,
  type RunHandle,
  type RunInput,
  type ToolSet,
} from "agent-loop";
import { WorkflowEngine, type LoopFactory } from "./engine";
import { DEVELOPMENT_LEAD_WORKFLOW, DEVELOPMENT_WORKFLOW, GENERAL_WORKFLOW } from "../workflow/builtin";
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

const SIMPLE_COMMIT: WorkflowDef = {
  id: "simple-commit",
  version: "1",
  name: "Simple Commit",
  description: "single-stage workflow used to test commit fallback behavior",
  fields: {
    summary: { type: "string", description: "result summary" },
  },
  stages: [
    {
      id: "work",
      category: "in_progress",
      entry: { op: "always" },
      outputFields: ["summary"],
    },
    {
      id: "done",
      category: "done",
      entry: { op: "hasEvent", eventType: "transition.requested" },
    },
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

  test("stops the worker pass after a terminal workflow command", async () => {
    let transitionAttempts = 0;
    const loop: LoopFactory = () =>
      cancellableScriptLoop(async (input, isCancelled) => {
        for (let i = 0; i < 20 && !isCancelled(); i++) {
          transitionAttempts++;
          await input.tools?.request_transition?.execute?.({ reason: `done ${i}` }, {});
        }
      }, "ai-sdk");
    const engine = newEngine(loop);

    await engine.createTask({ projectId: "p", taskId: "terminal-worker", fields: { request: "finish" } });
    await engine.idle();

    expect(transitionAttempts).toBe(1);
    expect((await engine.getTask("terminal-worker"))?.status).toBe("done");
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
    const root = await mkdtemp(join(tmpdir(), "sikong-dev-drive-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "dev-test", scripts: { typecheck: "true", test: "true" } }),
    );
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

        if (ctx.stageId === "build") {
          await input.tools?.set_field?.execute?.(
            { field: "implementation", value: "Changed worker discovery output." },
            {},
          );
          await input.tools?.set_field?.execute?.(
            { field: "changedFiles", value: ["packages/sikong/src/worker.ts"] },
            {},
          );
          await input.tools?.request_transition?.execute?.({ reason: "implemented" }, {});
          return;
        }

        await input.tools?.set_field?.execute?.({ field: "verification", value: "Focused tests passed." }, {});
        await input.tools?.set_field?.execute?.({ field: "summary", value: "Development workflow completed." }, {});
        await input.tools?.request_transition?.execute?.({ reason: "verified" }, {});
      });
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    registry.register(DEVELOPMENT_WORKFLOW);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
      registry,
      loop,
    });

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
    expect(task?.fields.changedFiles).toEqual(["packages/sikong/src/worker.ts"]);
  });

  test("runs a forced commit pass when a worker returns text without state commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-commit-tools-"));
    await writeFile(join(root, "marker.txt"), "done\n", "utf8");
    const chronicle = new MemoryChronicleStore(() => 1);
    let calls = 0;
    let commitRuntimeOptions: unknown;
    let commitInputSchema: unknown;
    const loop: LoopFactory = () =>
      scriptLoop(async (input) => {
        calls++;
        if (calls === 1) {
          return "Updated marker but forgot to commit sikong state.";
        }
        commitRuntimeOptions = input.runtimeOptions;
        commitInputSchema = input.tools?.commit_stage?.inputSchema;
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
      chronicle,
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
    expect(commitInputSchema).toMatchObject({
      properties: { fields: { properties: { summary: { type: "string" } } } },
    });
    const entries = await chronicle.recent({ taskId: "commit1", limit: 20 });
    const workerDiagnostics = entries.find(
      (entry) => entry.type === "wake.diagnostics" && entry.data?.phase === "worker",
    );
    expect(workerDiagnostics?.data).toMatchObject({
      status: "completed",
      stateCommands: 0,
      textPreview: "Updated marker but forgot to commit sikong state.",
    });
    const fallback = entries.find((entry) => entry.type === "wake.commit");
    expect(fallback?.data).toMatchObject({
      reason: "no_state_commands",
      allowedTools: ["commit_stage", "block", "cancel"],
      firstPassTextPreview: "Updated marker but forgot to commit sikong state.",
    });
    const commitDiagnostics = entries.find(
      (entry) => entry.type === "wake.diagnostics" && entry.data?.phase === "commit",
    );
    expect(commitDiagnostics?.data).toMatchObject({
      status: "completed",
      stateCommands: 2,
      allowedTools: ["commit_stage", "block", "cancel"],
    });
  });

  test("commit_stage rejects fields with invalid workflow types before reducer rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-commit-field-types-"));
    await writeFile(join(root, "marker.txt"), "before\n", "utf8");
    const chronicle = new MemoryChronicleStore(() => 1);
    let calls = 0;
    let invalidCommit: unknown;
    const loop: LoopFactory = () =>
      scriptLoop(async (input) => {
        calls++;
        if (calls === 1) return;
        await input.tools?.block?.execute?.({ reason: "invalid commit payload" }, {});
        invalidCommit = await input.tools?.commit_stage?.execute?.(
          { fields: { summary: { bad: true } }, reason: "bad payload" },
          {},
        );
      }, "ai-sdk");
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "Project", root }]),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      chronicle,
      loop,
    });

    await engine.createTask({ projectId: "p", taskId: "commit-field-types", fields: { request: "edit marker" } });
    await engine.idle();

    expect(invalidCommit).toMatchObject({ error: 'field "summary" must be string' });
    expect((await engine.getTask("commit-field-types"))?.status).toBe("blocked");
    const entries = await chronicle.recent({ taskId: "commit-field-types", limit: 20 });
    expect(entries.map((entry) => entry.type)).not.toContain("command.rejected");
  });

  test("stops the commit fallback after a successful commit_stage", async () => {
    const chronicle = new MemoryChronicleStore(() => 1);
    let calls = 0;
    let commitStageAttempts = 0;
    const loop: LoopFactory = () =>
      cancellableScriptLoop(async (input, isCancelled) => {
        calls++;
        if (calls === 1) return;
        expect(Object.keys(input.tools ?? {}).sort()).toEqual(["block", "cancel", "commit_stage"]);
        for (let i = 0; i < 20 && !isCancelled(); i++) {
          commitStageAttempts++;
          await input.tools?.commit_stage?.execute?.(
            { fields: { summary: `committed ${i}` }, reason: `complete ${i}` },
            {},
          );
        }
      }, "ai-sdk");
    const registry = new MemoryWorkflowRegistry(SIMPLE_COMMIT);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry,
      chronicle,
      loop,
    });

    await engine.createTask({ projectId: "p", workflowId: "simple-commit", taskId: "commit-stage-once" });
    await engine.idle();

    expect(calls).toBe(2);
    expect(commitStageAttempts).toBe(1);
    expect((await engine.getTask("commit-stage-once"))?.status).toBe("done");
    const commitDiagnostics = (
      await chronicle.recent({ taskId: "commit-stage-once", type: "wake.diagnostics", limit: 20 })
    ).find((entry) => entry.data?.phase === "commit");
    expect(commitDiagnostics?.data).toMatchObject({
      status: "cancelled",
      stateCommands: 2,
      allowedTools: ["commit_stage", "block", "cancel"],
    });
  });

  test("allows a no-write forced commit pass on development planning stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-dev-plan-commit-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "dev-plan", scripts: { typecheck: "true", test: "true" } }),
    );
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
        if (ctx.stageId === "build") {
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
        // At the design stage, only `design` and `alternatives` are in outputFields.
        await input.tools?.commit_stage?.execute?.(
          { fields: { design: "Design the bounded change." }, reason: "designed" },
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
    expect(task?.stageId).toBe("plan");
    expect(task?.status).toBe("in_progress");
    expect(task?.fields.design).toBe("Design the bounded change.");
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
    expect(errors).toContain("worker completed without calling any sikong state tool");
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

  test("merges worker-supplied tools into the wake and lists them in the prompt", async () => {
    // The worker boundary: the engine is coding-agnostic. A worker's own tools
    // arrive via the workerTools resolver and are merged with the command tools;
    // the engine never references project/coding tools itself.
    let sawWorkerTool = false;
    let sawWorkerToolsPrompt = false;
    let workerToolExecuted = false;
    let runtimeOptions: unknown;
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      workerTools: (_ctx, loop): ToolSet =>
        loop.id === "ai-sdk"
          ? {
              inspect_thing: defineTool({
                description: "inspect the project",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
                execute: () => {
                  workerToolExecuted = true;
                  return { ok: true };
                },
              }),
            }
          : {},
      loop: () =>
        scriptLoop(async (input) => {
          sawWorkerTool = Boolean(input.tools?.inspect_thing);
          sawWorkerToolsPrompt =
            Boolean(input.system?.includes("Worker tools")) && Boolean(input.system?.includes("inspect_thing"));
          runtimeOptions = input.runtimeOptions;
          await input.tools?.inspect_thing?.execute?.({}, {});
          await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
        }, "ai-sdk"),
    });

    await engine.createTask({ projectId: "p", taskId: "worker-tools", fields: { request: "inspect" } });
    await engine.idle();

    expect(sawWorkerTool).toBe(true);
    expect(workerToolExecuted).toBe(true);
    expect(sawWorkerToolsPrompt).toBe(true);
    expect(runtimeOptions).toMatchObject({ toolChoice: "required" });
    expect((await engine.getTask("worker-tools"))?.status).toBe("done");
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
        // Intermediate stage prevents vacuous pre-advance through childrenDone
        // before any child has been spawned (childrenDone is now vacuously true
        // with zero children).
        { id: "wait", category: "in_progress", entry: { op: "hasEvent", eventType: "subtask.created" } },
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

  test("the chronicle records wake progress tool events before wake end", async () => {
    const chronicle = new MemoryChronicleStore(() => 1);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      chronicle,
      loop: () => mockLoop({ callTool: { name: "request_transition", args: { reason: "x" } } }),
    });

    await engine.createTask({ projectId: "p", taskId: "progress" });
    await engine.idle();

    const entries = (await chronicle.recent({ taskId: "progress", limit: 50 })).sort((a, b) => a.seq - b.seq);
    const progressStart = entries.find((entry) => entry.type === "wake.progress" && entry.data?.event === "tool_call_start");
    const progressEnd = entries.find((entry) => entry.type === "wake.progress" && entry.data?.event === "tool_call_end");
    const wakeEndIndex = entries.findIndex((entry) => entry.type === "wake.end");

    expect(progressStart?.summary).toBe("tool request_transition started");
    expect(progressEnd?.summary).toBe("tool request_transition ended");
    expect(progressStart?.data).toMatchObject({ phase: "worker", tool: "request_transition" });
    expect(progressEnd?.data).toMatchObject({ phase: "worker", tool: "request_transition" });
    expect(String(progressStart?.data?.argsPreview)).toContain("reason");
    expect(String(progressEnd?.data?.resultPreview)).toContain("acknowledged");
    expect(entries.indexOf(progressStart!)).toBeLessThan(wakeEndIndex);
    expect(entries.indexOf(progressEnd!)).toBeLessThan(wakeEndIndex);
  });

  test("commit fallback sees compact tool call facts from the worker pass", async () => {
    const chronicle = new MemoryChronicleStore(() => 1);
    let runCount = 0;
    let commitSystem = "";
    const loop: LoopFactory = () => ({
      id: "ai-sdk",
      capabilities: ["tools"],
      supports: (c: Capability) => c === "tools",
      run(input: RunInput): RunHandle {
        runCount++;
        if (runCount === 1) {
          return eventRunHandle([
            {
              type: "tool_call_start",
              name: "bash",
              callId: "verify-1",
              args: { command: "bunx --bun vitest run packages/agent-loop/src/test/project-tools.test.ts" },
            },
            {
              type: "tool_call_end",
              name: "bash",
              callId: "verify-1",
              result: { exitCode: 0, stdout: "1 test file passed", secretToken: "hidden" },
            },
          ]);
        }
        commitSystem = input.system ?? "";
        const result = input.tools?.commit_stage?.execute?.(
          { fields: { summary: "verified from facts" }, reason: "commit facts" },
          {},
        );
        return bodyRunHandle(async () => {
          await result;
        });
      },
      preflight: async () => ({ ok: true }),
      dispose: async () => {},
    });
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(SIMPLE_COMMIT),
      chronicle,
      loop,
    });

    await engine.createTask({ projectId: "p", workflowId: "simple-commit", taskId: "facts" });
    await engine.idle();

    expect(commitSystem).toContain("## Observed tool facts");
    expect(commitSystem).toContain("bunx --bun vitest run packages/agent-loop/src/test/project-tools.test.ts");
    expect(commitSystem).toContain("1 test file passed");
    expect(commitSystem).not.toContain("hidden");
    const wakeCommit = (await chronicle.recent({ taskId: "facts", type: "wake.commit", limit: 10 }))[0];
    expect(String(JSON.stringify(wakeCommit?.data?.toolCallFacts))).toContain("vitest run");
  });
});

describe("Acceptance verifier (ADR 0024 Layers 3+4)", () => {
  test("passing acceptance checks admit next stage transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-acc-pass-"));
    await writeFile(join(root, "done.txt"), "ready\n", "utf8");

    const ACC_WF: WorkflowDef = {
      id: "acc-pass",
      version: "1",
      name: "AccPass",
      description: "",
      fields: {},
      stages: [
        {
          id: "work",
          category: "in_progress",
          entry: { op: "always" },
          acceptance: [{ kind: "fileExists", description: "done file", path: "done.txt" }],
        },
        {
          id: "done",
          category: "done",
          entry: {
            op: "and",
            all: [
              { op: "hasEvent", eventType: "transition.requested" },
              { op: "acceptancePassed" },
            ],
          },
        },
      ],
    };

    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop: () => mockLoop({ callTool: { name: "request_transition", args: { reason: "done" } } }),
    });
    engine["o"].registry.register(ACC_WF);

    await engine.createTask({ projectId: "p", workflowId: "acc-pass", taskId: "acc-pass-1" });
    await engine.idle();

    const task = await engine.getTask("acc-pass-1");
    expect(task?.status).toBe("done");
    expect(task?.stageId).toBe("done");
  });

  test("failed acceptance checks prevent stage transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-acc-fail-"));

    const ACC_WF: WorkflowDef = {
      id: "acc-fail",
      version: "1",
      name: "AccFail",
      description: "",
      fields: {},
      stages: [
        {
          id: "work",
          category: "in_progress",
          entry: { op: "always" },
          acceptance: [{ kind: "fileExists", description: "missing file", path: "missing.txt" }],
        },
        {
          id: "done",
          category: "done",
          entry: {
            op: "and",
            all: [
              { op: "hasEvent", eventType: "transition.requested" },
              { op: "acceptancePassed" },
            ],
          },
        },
      ],
    };

    const chronicle = new MemoryChronicleStore(() => 1);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      chronicle,
      loop: () => mockLoop({ callTool: { name: "request_transition", args: { reason: "done" } } }),
    });
    engine["o"].registry.register(ACC_WF);

    await engine.createTask({ projectId: "p", workflowId: "acc-fail", taskId: "acc-fail-1" });
    await engine.idle();

    const task = await engine.getTask("acc-fail-1");
    expect(task?.status).toBe("in_progress");
    expect(task?.stageId).toBe("work");

    // Verify the acceptance.verdict event was recorded
    const events = await (engine["o"].events as MemoryEventStore).load("acc-fail-1");
    expect(events.some((e) => e.type === "acceptance.verdict" && e.payload.verdict === "failed")).toBe(true);

    // Verify chronicle recorded the acceptance event
    const log = await chronicle.recent({ taskId: "acc-fail-1", limit: 50 });
    expect(log.some((e) => e.type === "wake.acceptance")).toBe(true);
  });

  test("first acceptance failure schedules a correction wake", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-acc-corr-"));
    let wakeCount = 0;

    const ACC_WF: WorkflowDef = {
      id: "acc-corr",
      version: "1",
      name: "AccCorr",
      description: "",
      fields: {},
      stages: [
        {
          id: "work",
          category: "in_progress",
          entry: { op: "always" },
          acceptance: [{ kind: "fileExists", description: "missing", path: "never.txt" }],
        },
        {
          id: "done",
          category: "done",
          entry: {
            op: "and",
            all: [
              { op: "hasEvent", eventType: "transition.requested" },
              { op: "acceptancePassed" },
            ],
          },
        },
      ],
    };

    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop: () => {
        wakeCount++;
        return mockLoop({ callTool: { name: "request_transition", args: { reason: "done" } } });
      },
    });
    engine["o"].registry.register(ACC_WF);

    await engine.createTask({ projectId: "p", workflowId: "acc-corr", taskId: "acc-corr-1" });
    await engine.idle();

    // First wake fails acceptance → correction wake scheduled → second wake also fails → no more
    expect(wakeCount).toBe(2);
    const task = await engine.getTask("acc-corr-1");
    expect(task?.stageId).toBe("work");
    expect(task?.status).toBe("in_progress");
  });

  test("acceptance checks are skipped for stages without acceptance", async () => {
    const chronicle = new MemoryChronicleStore(() => 1);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      chronicle,
      loop: () => mockLoop({ callTool: { name: "request_transition", args: { reason: "done" } } }),
    });

    await engine.createTask({ projectId: "p", taskId: "noaccept" });
    await engine.idle();

    expect((await engine.getTask("noaccept"))?.status).toBe("done");
    const log = await chronicle.recent({ taskId: "noaccept", limit: 50 });
    expect(log.filter((e) => e.type === "wake.acceptance")).toHaveLength(0);
  });

  test("acceptance checks with projectGate check", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-acc-gate-"));
    // Create a minimal project with passing scripts
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "gate-test",
        scripts: { typecheck: "true", test: "true" },
      }),
    );

    const GATE_WF: WorkflowDef = {
      id: "gate-wf",
      version: "1",
      name: "GateWf",
      description: "",
      fields: {},
      stages: [
        {
          id: "build",
          category: "in_progress",
          entry: { op: "always" },
          acceptance: [{ kind: "projectGate", description: "verify project" }],
        },
        {
          id: "done",
          category: "done",
          entry: {
            op: "and",
            all: [
              { op: "hasEvent", eventType: "transition.requested" },
              { op: "acceptancePassed" },
            ],
          },
        },
      ],
    };

    const chronicle = new MemoryChronicleStore(() => 1);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      chronicle,
      loop: () => mockLoop({ callTool: { name: "request_transition", args: { reason: "done" } } }),
    });
    engine["o"].registry.register(GATE_WF);

    await engine.createTask({ projectId: "p", workflowId: "gate-wf", taskId: "gate-1" });
    await engine.idle();

    const task = await engine.getTask("gate-1");
    expect(task?.status).toBe("done");
    expect(task?.stageId).toBe("done");
    const log = await chronicle.recent({ taskId: "gate-1", limit: 50 });
    expect(log.some((e) => e.type === "wake.acceptance")).toBe(true);
  });
});

describe("DEVELOPMENT workflow (team delegation)", () => {
  // Creates a temp project dir with passing typecheck+test scripts so the
  // acceptance gate (projectGate) on the verify/review stage succeeds.
  async function withProjectRoot(fn: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "sikong-dev-eng-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "dev-test", scripts: { typecheck: "true", test: "true" } }),
    );
    try {
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("a parent plans, delegates to a child, then reviews the team's result", async () => {
    await withProjectRoot(async (root) => {
      let parentReviewSystem = "";
      const loop: LoopFactory = (ctx) =>
        scriptLoop(async (input) => {
          if (ctx.workflow.id === "simple-commit") {
          // a team member: do the work and report a structured summary
          await input.tools?.set_field?.execute?.({ field: "summary", value: "child handled part 1" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "done part 1" }, {});
          return;
        }
        // the parent (adaptive DEVELOPMENT)
        if (ctx.stageId === "design") {
          await input.tools?.set_field?.execute?.({ field: "design", value: "decisions" }, {});
          await input.tools?.set_field?.execute?.({ field: "alternatives", value: [{ option: "B", pros: "simpler", why_rejected: "weaker fit" }] }, {});
          await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
          return;
        }
        if (ctx.stageId === "plan") {
          await input.tools?.set_field?.execute?.({ field: "plan", value: "One piece: part 1." }, {});
          await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
          return;
        }
        if (ctx.stageId === "build") {
          await input.tools?.create_subtask?.execute?.({ workflowId: "simple-commit", input: "do part 1" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
          return;
        }
        // verify — the parent must see its team here
        // Team snapshot now lives in the per-wake message (prompt), not the
        // stable system prompt (prefix-cache split) — check both.
        parentReviewSystem = `${input.system ?? ""}\n${input.prompt ?? ""}`;
        await input.tools?.set_field?.execute?.({ field: "verification", value: "Reviewed team results." }, {});
        await input.tools?.set_field?.execute?.({ field: "summary", value: "Team completed the effort." }, {});
        await input.tools?.request_transition?.execute?.({ reason: "verified" }, {});
      });
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    registry.register(DEVELOPMENT_WORKFLOW);
    registry.register(SIMPLE_COMMIT);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
      registry,
      loop,
    });

    await engine.createTask({
      projectId: "p",
      workflowId: "development",
      taskId: "parent1",
      fields: { request: "ship the effort" },
    });
    await engine.idle();

    const task = await engine.getTask("parent1");
    expect(task?.status).toBe("done");
    expect(task?.fields.summary).toBe("Team completed the effort.");
    expect(task?.childIds.length).toBe(1);
    const childId = task!.childIds[0]!;
    expect((await engine.getTask(childId))?.status).toBe("done");
    // the parent saw its team — id, status, and the child's structured summary — in verify
    expect(parentReviewSystem).toContain("## Team (your subtasks)");
    expect(parentReviewSystem).toContain(childId);
    expect(parentReviewSystem).toContain("child handled part 1");
    });
  });

  test("a parent can run another round in verify before finishing (multi-round)", async () => {
    await withProjectRoot(async (root) => {
      let verifyPasses = 0;
      const loop: LoopFactory = (ctx) =>
        scriptLoop(async (input) => {
          if (ctx.workflow.id === "simple-commit") {
            await input.tools?.set_field?.execute?.({ field: "summary", value: "child finished" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "child done" }, {});
            return;
          }
          if (ctx.stageId === "design") {
            await input.tools?.set_field?.execute?.({ field: "design", value: "decisions" }, {});
            await input.tools?.set_field?.execute?.({ field: "alternatives", value: [{ option: "B", pros: "simpler", why_rejected: "weaker fit" }] }, {});
            await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
            return;
          }
          if (ctx.stageId === "plan") {
            await input.tools?.set_field?.execute?.({ field: "plan", value: "Part A first, then maybe a follow-up." }, {});
            await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
            return;
          }
          if (ctx.stageId === "build") {
            await input.tools?.create_subtask?.execute?.({ workflowId: "simple-commit", input: "part A" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
            return;
          }
          // verify
          verifyPasses++;
          if (verifyPasses === 1) {
            // need another round: spawn a follow-up, do NOT set summary yet
            await input.tools?.create_subtask?.execute?.({ workflowId: "simple-commit", input: "part B" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "another round" }, {});
            return;
          }
          await input.tools?.set_field?.execute?.({ field: "verification", value: "Verified all rounds." }, {});
          await input.tools?.set_field?.execute?.({ field: "summary", value: "All rounds complete." }, {});
          await input.tools?.request_transition?.execute?.({ reason: "complete" }, {});
        });
      const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
      registry.register(DEVELOPMENT_WORKFLOW);
      registry.register(SIMPLE_COMMIT);
      const engine = new WorkflowEngine({
        events: new MemoryEventStore(() => 1),
        projections: new MemoryProjectionStore(),
        projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
        registry,
        loop,
      });

      await engine.createTask({
        projectId: "p",
        workflowId: "development",
        taskId: "parent-multi",
        fields: { request: "two-round effort" },
      });
      await engine.idle();

      const task = await engine.getTask("parent-multi");
      expect(verifyPasses).toBe(2); // re-woken for a second verify round after the follow-up finished
      expect(task?.status).toBe("done");
      expect(task?.fields.summary).toBe("All rounds complete.");
      expect(task?.childIds.length).toBe(2); // initial team member + the follow-up
      for (const cid of task!.childIds) expect((await engine.getTask(cid))?.status).toBe("done");
    });
  });

  test("an isolated subtask marks the child and runs the worker-boundary hooks (ADR 0010)", async () => {
    await withProjectRoot(async (root) => {
      const isolated: string[] = [];
      const released: string[] = [];
      const loop: LoopFactory = (ctx) =>
        scriptLoop(async (input) => {
          if (ctx.workflow.id === "simple-commit") {
            await input.tools?.set_field?.execute?.({ field: "summary", value: "isolated child done" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
            return;
          }
          if (ctx.stageId === "design") {
            await input.tools?.set_field?.execute?.({ field: "design", value: "decisions" }, {});
            await input.tools?.set_field?.execute?.({ field: "alternatives", value: [{ option: "B", pros: "simpler", why_rejected: "weaker fit" }] }, {});
            await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
            return;
          }
          if (ctx.stageId === "plan") {
            await input.tools?.set_field?.execute?.({ field: "plan", value: "one isolated piece" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
            return;
          }
          if (ctx.stageId === "build") {
            await input.tools?.create_subtask?.execute?.({ workflowId: "simple-commit", input: "part X", isolate: true }, {});
            await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
            return;
          }
          await input.tools?.set_field?.execute?.({ field: "summary", value: "done" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "reviewed" }, {});
        });
      const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
      registry.register(DEVELOPMENT_WORKFLOW);
      registry.register(SIMPLE_COMMIT);
      const engine = new WorkflowEngine({
        events: new MemoryEventStore(() => 1),
        projections: new MemoryProjectionStore(),
        projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
        registry,
        loop,
        isolateWorkspace: (ctx, project) => {
          isolated.push(ctx.task.id);
          return project;
        },
        releaseWorkspace: (task) => {
          released.push(task.id);
        },
      });

      await engine.createTask({ projectId: "p", workflowId: "development", taskId: "iso-parent", fields: { request: "x" } });
      await engine.idle();

      const parent = await engine.getTask("iso-parent");
      expect(parent?.status).toBe("done");
      expect(parent?.childIds.length).toBe(1);
      const childId = parent!.childIds[0]!;
      const child = await engine.getTask(childId);
      expect(child?.isolate).toBe(true); // the child carries the isolation flag
      expect(child?.status).toBe("done");
      // the worker boundary saw the isolated child on its wake, and released it on terminal
      expect(isolated).toContain(childId);
      expect(released).toContain(childId);
      // the parent itself was never isolated
      expect(isolated).not.toContain("iso-parent");
    });
  });

  test("a child whose wakes keep failing is auto-failed so the parent unblocks (ADR 0010 #2)", async () => {
    await withProjectRoot(async (root) => {
      let childWakes = 0;
      const loop: LoopFactory = (ctx) => {
        if (ctx.workflow.id === "simple-commit") {
          // a stuck/failing child: its wake errors every time (e.g. a build that times out)
          return scriptLoop(async () => {
            childWakes++;
            throw new Error("simulated build failure");
          }, "ai-sdk");
        }
        return scriptLoop(async (input) => {
          if (ctx.stageId === "design") {
            await input.tools?.set_field?.execute?.({ field: "design", value: "decisions" }, {});
            await input.tools?.set_field?.execute?.({ field: "alternatives", value: [{ option: "B", pros: "simpler", why_rejected: "weaker fit" }] }, {});
            await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
            return;
          }
          if (ctx.stageId === "plan") {
            await input.tools?.set_field?.execute?.({ field: "plan", value: "one piece" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
            return;
          }
          if (ctx.stageId === "build") {
            await input.tools?.create_subtask?.execute?.({ workflowId: "simple-commit", input: "do x" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
            return;
          }
          // verify
          await input.tools?.set_field?.execute?.({ field: "verification", value: "Child failed; effort closed." }, {});
          await input.tools?.set_field?.execute?.({ field: "summary", value: "child failed; effort closed" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
        });
      };
      const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
      registry.register(DEVELOPMENT_WORKFLOW);
      registry.register(SIMPLE_COMMIT);
      const engine = new WorkflowEngine({
        events: new MemoryEventStore(() => 1),
        projections: new MemoryProjectionStore(),
        projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
        registry,
        loop,
        maxWakeRetries: 1, // one retry, then terminal-fail
      });

      await engine.createTask({ projectId: "p", workflowId: "development", taskId: "fail-parent", fields: { request: "x" } });
      await engine.idle();

      const parent = await engine.getTask("fail-parent");
      expect(childWakes).toBeGreaterThanOrEqual(2); // initial + one retry before auto-fail
      const childId = parent!.childIds[0]!;
      expect((await engine.getTask(childId))?.status).toBe("cancelled"); // auto-failed → terminal
      expect(parent?.status).toBe("done"); // childrenDone resolved — the parent was NOT wedged
    });
  });

  test("the parent can order subtasks with dependsOn — a dependent runs only after its prerequisite (ADR 0011)", async () => {
    await withProjectRoot(async (root) => {
      const order: string[] = [];
      const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        if (ctx.workflow.id === "general") {
          order.push(String(ctx.task.fields.request)); // record run order
          await input.tools?.set_field?.execute?.({ field: "summary", value: `did ${ctx.task.fields.request}` }, {});
          await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
          return;
        }
        if (ctx.stageId === "design") {
          await input.tools?.set_field?.execute?.({ field: "design", value: "decisions" }, {});
          await input.tools?.set_field?.execute?.({ field: "alternatives", value: [{ option: "B", pros: "simpler", why_rejected: "weaker fit" }] }, {});
          await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
          return;
        }
        if (ctx.stageId === "plan") {
          await input.tools?.set_field?.execute?.({ field: "plan", value: "A then B" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
          return;
        }
        if (ctx.stageId === "build") {
          await input.tools?.create_subtask?.execute?.({ workflowId: "general", input: "A", key: "a" }, {});
          await input.tools?.create_subtask?.execute?.({ workflowId: "general", input: "B", key: "b", dependsOn: ["a"] }, {});
          await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
          return;
        }
        // verify
        await input.tools?.set_field?.execute?.({ field: "verification", value: "both layers done" }, {});
        await input.tools?.set_field?.execute?.({ field: "summary", value: "both layers done" }, {});
        await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
      });
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    registry.register(DEVELOPMENT_WORKFLOW);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
      registry,
      loop,
    });

    await engine.createTask({ projectId: "p", workflowId: "development", taskId: "dag-parent", fields: { request: "x" } });
    await engine.idle();

    const parent = await engine.getTask("dag-parent");
    expect(order).toEqual(["A", "B"]); // B waited for A (dependency respected), not parallel
    expect(parent?.status).toBe("done");
    expect(parent?.childIds.length).toBe(2);
    for (const c of parent!.childIds) expect((await engine.getTask(c))?.status).toBe("done");
    // the dependent carries the resolved prerequisite id
    const tasks = await Promise.all(parent!.childIds.map((c) => engine.getTask(c)));
    const b = tasks.find((t) => t?.fields.request === "B");
    const a = tasks.find((t) => t?.fields.request === "A");
    expect(b?.dependsOn).toEqual([a?.id]);
    });
  });

  test("DEVELOPMENT_LEAD_WORKFLOW alias still delegates and completes end-to-end", async () => {
    await withProjectRoot(async (root) => {
      const loop: LoopFactory = (ctx) =>
        scriptLoop(async (input) => {
          if (ctx.workflow.id === SIMPLE_COMMIT.id) {
            await input.tools?.set_field?.execute?.({ field: "summary", value: "alias child done" }, {});
            await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
            return;
          }
          if (ctx.stageId === "design") {
            await input.tools?.set_field?.execute?.({ field: "design", value: "alias test" }, {});
            await input.tools?.set_field?.execute?.({ field: "alternatives", value: [{ option: "A", pros: "fast", why_rejected: "weaker fit" }] }, {});
            await input.tools?.request_transition?.execute?.({ reason: "designed" }, {});
          return;
        }
        if (ctx.stageId === "plan") {
          await input.tools?.set_field?.execute?.({ field: "plan", value: "delegate" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "planned" }, {});
          return;
        }
        if (ctx.stageId === "build") {
          await input.tools?.create_subtask?.execute?.({ workflowId: "simple-commit", input: "alias sub" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
          return;
        }
        // verify
        await input.tools?.set_field?.execute?.({ field: "verification", value: "alias verified" }, {});
        await input.tools?.set_field?.execute?.({ field: "summary", value: "alias done" }, {});
        await input.tools?.request_transition?.execute?.({ reason: "verified" }, {});
      });
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    registry.register(DEVELOPMENT_LEAD_WORKFLOW);
    registry.register(SIMPLE_COMMIT);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
      registry,
      loop,
    });

    await engine.createTask({
      projectId: "p",
      workflowId: "development-lead",
      taskId: "alias-test",
      fields: { request: "alias smoke" },
    });
    await engine.idle();

    const task = await engine.getTask("alias-test");
    expect(task?.status).toBe("done");
    expect(task?.childIds).toHaveLength(1);
    expect((await engine.getTask(task!.childIds[0]!))?.status).toBe("done");
    });
  });

  test("depth propagates from parent to child subtask", async () => {
    const CHILD: WorkflowDef = {
      id: "child-depth", version: "1", name: "Child", description: "", fields: {},
      stages: [
        { id: "open", category: "in_progress", entry: { op: "always" } },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const PARENT: WorkflowDef = {
      id: "parent-depth", version: "1", name: "Parent", description: "", fields: {},
      stages: [
        { id: "split", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask"] },
        // Intermediate guard prevents vacuous pre-advance through childrenDone
        // before any child has been spawned (childrenDone is vacuously true
        // with zero children per ADR 0020).
        { id: "wait", category: "in_progress", entry: { op: "hasEvent", eventType: "subtask.created" } },
        { id: "review", category: "in_progress", entry: { op: "childrenDone" } },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        if (ctx.workflow.id === "child-depth") {
          await input.tools?.request_transition?.execute?.({}, {});
          return;
        }
        if (ctx.stageId === "split") {
          await input.tools?.create_subtask?.execute?.({ workflowId: "child-depth", input: "do part" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
          return;
        }
        await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
      });
    const engine = newEngine(loop, [CHILD, PARENT]);

    await engine.createTask({ projectId: "p", workflowId: "parent-depth", taskId: "P-depth" });
    await engine.idle();

    const parent = await engine.getTask("P-depth");
    expect(parent?.depth).toBe(0);
    const child = await engine.getTask(parent!.childIds[0]!);
    expect(child?.depth).toBe(1);
  });

  test("maxTeamDepth in a workflow prevents subtask creation beyond the cap", async () => {
    const CHILD: WorkflowDef = {
      id: "child-cap", version: "1", name: "Child", description: "", fields: {},
      // Also capped so a child spawned by CAPPED (depth 1) cannot itself spawn subtasks.
      maxTeamDepth: 1,
      stages: [
        // create_subtask is available so the test can prove the reducer rejects beyond maxTeamDepth.
        // request_transition also listed so the child can complete normally.
        { id: "open", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask", "request_transition"] },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const CAPPED: WorkflowDef = {
      id: "capped", version: "1", name: "Capped", description: "",
      maxTeamDepth: 1, // only root can create children; depth 1 cannot
      fields: {},
      stages: [
        { id: "split", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask"] },
        // Intermediate guard prevents vacuous pre-advance through childrenDone
        // (now vacuously true with zero children) before any child is spawned.
        { id: "wait", category: "in_progress", entry: { op: "hasEvent", eventType: "subtask.created" } },
        { id: "review", category: "in_progress", entry: { op: "childrenDone" } },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    let rejects: string[] = [];
    const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        if (ctx.workflow.id === "child-cap") {
          // child at depth 1 tries to spawn a subtask — should be rejected by maxTeamDepth
          if (ctx.stageId === "open") {
            await input.tools?.create_subtask?.execute?.({ workflowId: "general", input: "deep nested" }, {});
          }
          await input.tools?.request_transition?.execute?.({}, {});
          return;
        }
        if (ctx.stageId === "split") {
          await input.tools?.create_subtask?.execute?.({ workflowId: "child-cap", input: "first level" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
          return;
        }
        await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
      });
    const engine = newEngine(loop, [CHILD, CAPPED], {
      onReject: (i: { command: unknown; reason: string }) => rejects.push(i.reason),
    });

    await engine.createTask({ projectId: "p", workflowId: "capped", taskId: "C1" });
    await engine.idle();

    const parent = await engine.getTask("C1");
    expect(parent?.childIds).toHaveLength(1); // first subtask (depth 0 → 1) succeeds
    const child = await engine.getTask(parent!.childIds[0]!);
    expect(child?.depth).toBe(1);
    expect(child?.status).toBe("done"); // the child completed OK
    // The child at depth 1 tried to spawn a subtask at depth 2 but maxTeamDepth=1 rejects it
    expect(rejects.some((r) => /max team depth/.test(r))).toBe(true);
  });

  test("engine-level maxTeamDepth bounds workflows without explicit caps", async () => {
    const CHILD: WorkflowDef = {
      id: "child-engine", version: "1", name: "Child", description: "", fields: {},
      // No maxTeamDepth — bounded by the engine-level default instead.
      stages: [
        { id: "open", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask", "request_transition"] },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const PARENT: WorkflowDef = {
      id: "parent-engine", version: "1", name: "Parent", description: "", fields: {},
      // No maxTeamDepth — bounded by the engine-level default.
      stages: [
        { id: "split", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask"] },
        { id: "wait", category: "in_progress", entry: { op: "hasEvent", eventType: "subtask.created" } },
        { id: "review", category: "in_progress", entry: { op: "childrenDone" } },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    let rejects: string[] = [];
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    registry.register(CHILD);
    registry.register(PARENT);
    const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        if (ctx.workflow.id === "child-engine") {
          // child at depth 1 tries to spawn — rejected by engine-level maxTeamDepth=1
          if (ctx.stageId === "open") {
            await input.tools?.create_subtask?.execute?.({ workflowId: "general", input: "nested" }, {});
          }
          await input.tools?.request_transition?.execute?.({}, {});
          return;
        }
        if (ctx.stageId === "split") {
          await input.tools?.create_subtask?.execute?.({ workflowId: "child-engine", input: "first level" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "delegated" }, {});
          return;
        }
        await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
      });
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry,
      maxTeamDepth: 1, // engine-level cap: only root can spawn
      loop,
      hooks: { onReject: (i: { reason: string }) => rejects.push(i.reason) },
    });

    await engine.createTask({ projectId: "p", workflowId: "parent-engine", taskId: "E1" });
    await engine.idle();

    const parent = await engine.getTask("E1");
    expect(parent?.childIds).toHaveLength(1); // first subtask succeeds
    const child = await engine.getTask(parent!.childIds[0]!);
    expect(child?.depth).toBe(1);
    expect(child?.status).toBe("done");
    // The child at depth 1 tried to spawn but engine-level maxTeamDepth=1 rejects it
    expect(rejects.some((r) => /max team depth/.test(r))).toBe(true);
  });

  test("a 3rd-tier create_subtask is refused by maxTeamDepth (default: 2)", async () => {
    // Root (depth 0) creates child (depth 1) ✓
    // Child (depth 1) creates grandchild (depth 2) ✓
    // Grandchild (depth 2) tries to create great-grandchild (depth 3) ✗
    const TIER: WorkflowDef = {
      id: "tier",
      version: "1",
      name: "Tier",
      description: "",
      // Default maxTeamDepth=2: three tiers allowed (0→1→2), the 4th (2→3) refused
      maxTeamDepth: 2,
      fields: {},
      stages: [
        { id: "open", category: "in_progress", entry: { op: "always" }, tools: ["create_subtask", "request_transition"] },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const rejects: string[] = [];
    const loop: LoopFactory = (ctx) =>
      scriptLoop(async (input) => {
        if (ctx.stageId === "open") {
          if (ctx.task.depth < 2) {
            // Depth 0 (root) or 1 (child): allowed to spawn
            await input.tools?.create_subtask?.execute?.({ workflowId: "tier", input: "sub" }, {});
          } else {
            // Depth 2 (grandchild, 3rd tier): tries and is rejected by maxTeamDepth
            await input.tools?.create_subtask?.execute?.({ workflowId: "general", input: "deep" }, {});
          }
        }
        await input.tools?.request_transition?.execute?.({}, {});
      });
    const engine = newEngine(loop, [TIER], {
      onReject: (i: { reason: string }) => rejects.push(i.reason),
    });

    await engine.createTask({ projectId: "p", workflowId: "tier", taskId: "T0" });
    await engine.idle();

    const root = await engine.getTask("T0");
    expect(root?.childIds).toHaveLength(1);
    const child = await engine.getTask(root!.childIds[0]!);
    expect(child?.childIds).toHaveLength(1);
    const grandchild = await engine.getTask(child!.childIds[0]!);
    expect(grandchild?.status).toBe("done");
    // Grandchild's attempt to spawn at depth 3 was rejected by max team depth
    expect(rejects.some((r) => /max team depth/.test(r))).toBe(true);
  });
});

function eventRunHandle(events: LoopEvent[]): RunHandle {
  const result = Promise.resolve({
    events,
    usage: emptyUsage(),
    durationMs: 0,
    status: "completed" as const,
    text: "",
  });
  const iter = async function* (): AsyncGenerator<LoopEvent> {
    for (const event of events) yield event;
  };
  const none = async function* (): AsyncGenerator<never> {};
  return {
    [Symbol.asyncIterator]: () => iter(),
    textStream: none(),
    result,
    text: result.then((r) => r.text),
    usage: result.then((r) => r.usage),
    steer: async () => ({ mode: "rejected" as const }),
    cancel: () => {},
  };
}

function bodyRunHandle(body: () => Promise<void>): RunHandle {
  const result = body().then(() => ({
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
}

/** A loop whose run() executes `body` (which may await), resolving when it finishes. */
function scriptLoop(body: (input: RunInput) => Promise<string | void>, id = "scripted"): AgentLoop {
  const capabilities: CapabilityList = ["tools"];
  return {
    id,
    capabilities,
    supports: (c: Capability) => capabilities.includes(c),
    run(input: RunInput): RunHandle {
      // Mirror the real RunHandle contract: result NEVER rejects — a body that
      // throws surfaces as status:"error" (so text/usage don't leak unhandled
      // rejections, and the engine's circuit-breaker sees an errored wake).
      const result = Promise.resolve()
        .then(() => body(input))
        .then(
          (text) => ({
            events: [] as LoopEvent[],
            usage: emptyUsage(),
            durationMs: 0,
            status: "completed" as const,
            text: text ?? "",
          }),
          (err: unknown) => ({
            events: [] as LoopEvent[],
            usage: emptyUsage(),
            durationMs: 0,
            status: "error" as const,
            error: err instanceof Error ? err : new Error(String(err)),
            text: "",
          }),
        );
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

/** A script loop that lets tests observe whether the engine cancelled the run. */
function cancellableScriptLoop(
  body: (input: RunInput, isCancelled: () => boolean) => Promise<string | void>,
  id = "scripted-cancellable",
): AgentLoop {
  const capabilities: CapabilityList = ["tools"];
  return {
    id,
    capabilities,
    supports: (c: Capability) => capabilities.includes(c),
    run(input: RunInput): RunHandle {
      let cancelled = false;
      const work = body(input, () => cancelled);
      const result = work.then((text) => ({
        events: [] as LoopEvent[],
        usage: emptyUsage(),
        durationMs: 0,
        status: cancelled ? ("cancelled" as const) : ("completed" as const),
        text: text ?? "",
      }));
      const none = async function* (): AsyncGenerator<never> {};
      return {
        [Symbol.asyncIterator]: () => none(),
        textStream: none(),
        result,
        text: result.then((r) => r.text),
        usage: result.then((r) => r.usage),
        steer: async () => ({ mode: "rejected" as const }),
        cancel: () => {
          cancelled = true;
        },
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
