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
import { buildPrompt } from "./prompt";
import { JsonScopeLeaseStore } from "./scope-lease";
import { JsonSteerMailbox } from "./steer-mailbox";
import {
  cancellableScriptLoop,
  cleanupHangingLoop,
  eventRunHandle,
  hangingLoop,
  leadAccept,
  newEngine,
  SIMPLE_COMMIT,
  scriptLoop,
  sleep,
} from "./test-helpers";
import { DEVELOPMENT_WORKFLOW, GENERAL_WORKFLOW } from "../workflow/builtin";
import type { Task, WorkflowDef } from "../workflow/types";
import {
  MemoryChronicleStore,
  MemoryEventStore,
  MemoryProjectStore,
  MemoryProjectionStore,
  MemoryWorkflowRegistry,
} from "../store/memory";
import { JsonWorkspaceChronicleStore, JsonWorkspaceEventStore, JsonWorkspaceProjectionStore } from "../store";

const cliPath = new URL("../cli.ts", import.meta.url).pathname;

test("wake prompt exposes lead acceptance rejection reason for single-task repair", () => {
  const wf: WorkflowDef = {
    id: "reviewable",
    version: "1",
    name: "Reviewable",
    description: "reviewable workflow",
    fields: {
      blueprint: { type: "string", description: "blueprint" },
      summary: { type: "string", description: "summary" },
    },
    stages: [
      { id: "review", category: "in_progress", entry: { op: "always" }, outputFields: ["summary"] },
      { id: "done", category: "done", entry: { op: "always" } },
    ],
  };
  const task: Task = {
    id: "t1",
    projectId: "p",
    workflowId: "reviewable",
    workflowVersion: "1",
    stageId: "review",
    fields: { blueprint: "old" },
    status: "in_progress",
    childIds: [],
    depth: 0,
    cursor: 0,
    createdAt: 1,
    updatedAt: 1,
  };

  const prompt = buildPrompt(task, wf, wf.stages[0], [], {
    eventTypes: new Set(["transition.requested"]),
    acceptanceStatus: "rejected",
    acceptanceReason: "fix the evidence state wording",
  });

  expect(prompt).toContain("acceptance: rejected");
  expect(prompt).toContain("latest acceptance reason: fix the evidence state wording");
});

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

  test("delivers mailbox steer commands to the active wake run", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-steer-mailbox-"));
    const events = new MemoryEventStore(() => 1);
    const seen: string[] = [];
    let resolveStarted!: () => void;
    let resolveDone!: () => void;
    let startedOnce = false;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const none = async function* (): AsyncGenerator<never> {};
    const loop: LoopFactory = () => {
      const capabilities: CapabilityList = ["tools", "steer.deferred"];
      return {
        id: "steerable",
        capabilities,
        supports: (c: Capability) => capabilities.includes(c),
        run(): RunHandle {
          if (!startedOnce) {
            startedOnce = true;
            resolveStarted();
          }
          const result = done.then(() => ({
            events: [] as LoopEvent[],
            usage: emptyUsage(),
            durationMs: 0,
            status: "completed" as const,
            text: "",
          }));
          return {
            [Symbol.asyncIterator]: () => none(),
            textStream: none(),
            result,
            text: result.then((r) => r.text),
            usage: result.then((r) => r.usage),
            steer: async (message: string) => {
              seen.push(message);
              resolveDone();
              return { mode: "deferred" as const };
            },
            cancel: () => {},
            cleanup: async () => ({
              status: "settled" as const,
              elapsedMs: 0,
              hardKill: false,
              resultStatus: (await result).status,
            }),
          };
        },
        preflight: async () => ({ ok: true }),
        dispose: async () => {},
      };
    };
    const mailbox = new JsonSteerMailbox(root);
    const engine = new WorkflowEngine({
      events,
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop,
      steerMailbox: mailbox,
    });

    try {
      await engine.createTask({ projectId: "p", taskId: "steer-me", fields: { request: "wait" }, wake: false });
      const running = engine.runPending("steer-me");
      await started;
      await mailbox.submit("steer-me", "Use the accepted repair constraints before deciding.");
      await running;

      expect(seen).toEqual(["Use the accepted repair constraints before deciding."]);
      expect(await mailbox.list("steer-me")).toHaveLength(1);
      expect((await events.load("steer-me")).map((event) => event.type)).toContain("steer.requested");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts CLI steer while a JSON-backed wake is active and locked", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-cli-steer-live-"));
    const events = new JsonWorkspaceEventStore(root);
    const projections = new JsonWorkspaceProjectionStore(root);
    const chronicle = new JsonWorkspaceChronicleStore(root);
    const mailbox = new JsonSteerMailbox(root);
    const seen: string[] = [];
    let resolveStarted!: () => void;
    let resolveDone!: () => void;
    let startedOnce = false;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const none = async function* (): AsyncGenerator<never> {};
    const loop: LoopFactory = () => {
      const capabilities: CapabilityList = ["tools", "steer.deferred"];
      return {
        id: "json-steerable",
        capabilities,
        supports: (c: Capability) => capabilities.includes(c),
        run(): RunHandle {
          if (!startedOnce) {
            startedOnce = true;
            resolveStarted();
          }
          const result = done.then(() => ({
            events: [] as LoopEvent[],
            usage: emptyUsage(),
            durationMs: 0,
            status: "completed" as const,
            text: "",
          }));
          return {
            [Symbol.asyncIterator]: () => none(),
            textStream: none(),
            result,
            text: result.then((r) => r.text),
            usage: result.then((r) => r.usage),
            steer: async (message: string) => {
              seen.push(message);
              resolveDone();
              return { mode: "deferred" as const };
            },
            cancel: () => {},
            cleanup: async () => ({
              status: "settled" as const,
              elapsedMs: 0,
              hardKill: false,
              resultStatus: (await result).status,
            }),
          };
        },
        preflight: async () => ({ ok: true }),
        dispose: async () => {},
      };
    };
    const engine = new WorkflowEngine({
      events,
      projections,
      chronicle,
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop,
      steerMailbox: mailbox,
      wakeTimeoutMs: 5_000,
    });

    try {
      await engine.createTask({ projectId: "p", taskId: "cli-steer-live", fields: { request: "wait" }, wake: false });
      await writeFile(join(root, ".lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
      const running = engine.runPending("cli-steer-live");
      await started;

      const steer = Bun.spawnSync([
        process.execPath,
        cliPath,
        "submit",
        "cli-steer-live",
        "steer",
        "use the live correction channel",
        "--dir",
        root,
      ]);
      expect(new TextDecoder().decode(steer.stderr)).toBe("");
      expect(steer.exitCode).toBe(0);
      await running;

      expect(seen).toEqual(["use the live correction channel"]);
      expect(await mailbox.list("cli-steer-live")).toHaveLength(1);
      expect((await events.load("cli-steer-live")).map((event) => event.type)).toContain("steer.requested");
      expect((await chronicle.recent({ taskId: "cli-steer-live", type: "wake.steer" }))).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    await leadAccept(engine, "dev1");

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

  test("records review-required work log when a worker returns text without state commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-commit-tools-"));
    await writeFile(join(root, "marker.txt"), "done\n", "utf8");
    const chronicle = new MemoryChronicleStore(() => 1);
    let calls = 0;
    const loop: LoopFactory = () =>
      scriptLoop(async (input) => {
        calls++;
        expect(input.tools?.commit_stage).toBeUndefined();
        return "Updated marker but did not record sikong state.";
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
    expect(calls).toBe(1);
    expect(task?.status).toBe("in_progress");
    expect(task?.fields.summary).toBeUndefined();
    const entries = await chronicle.recent({ taskId: "commit1", limit: 20 });
    const workerDiagnostics = entries.find(
      (entry) => entry.type === "wake.diagnostics" && entry.data?.phase === "worker",
    );
    expect(workerDiagnostics?.data).toMatchObject({
      status: "completed",
      stateCommands: 0,
      textPreview: "Updated marker but did not record sikong state.",
    });
    const reviewRequired = entries.find((entry) => entry.type === "wake.review_required");
    expect(reviewRequired?.data).toMatchObject({
      reason: "no_state_commands",
      firstPassTextPreview: "Updated marker but did not record sikong state.",
    });
    expect(entries.map((entry) => entry.type)).not.toContain("wake.commit");
    expect(entries.map((entry) => entry.type)).toContain("wake.end");
  });

  test("records review-required when a worker emits commands without a stage commit signal", async () => {
    const chronicle = new MemoryChronicleStore(() => 1);
    let calls = 0;
    const loop: LoopFactory = () =>
      scriptLoop(async (input) => {
        calls++;
        await input.tools?.append_note?.execute?.({ text: "looked around" }, {});
      }, "ai-sdk");
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      chronicle,
      loop,
    });

    await engine.createTask({ projectId: "p", taskId: "note-only", fields: { request: "inspect" } });
    await engine.idle();

    expect(calls).toBe(1);
    expect((await engine.getTask("note-only"))?.status).toBe("in_progress");
    const reviewRequired = (await chronicle.recent({ taskId: "note-only", type: "wake.review_required", limit: 10 }))[0];
    expect(reviewRequired?.data).toMatchObject({
      reason: "no_stage_commit_commands",
      commandKinds: ["append_note"],
    });
  });

  test("development planning stages wait for review instead of using an automatic no-write commit pass", async () => {
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
    expect(calls).toBe(2);
    expect(planPasses).toBe(1);
    expect(task?.stageId).toBe("plan");
    expect(task?.status).toBe("in_progress");
    expect(task?.fields.plan).toBeUndefined();
  });

  test("a worker pass with no state commands ends normally and leaves review to lead", async () => {
    const errors: string[] = [];
    const chronicle = new MemoryChronicleStore(() => 1);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop: () => scriptLoop(async () => {}),
      chronicle,
      hooks: { onError: ({ error }: { error: Error }) => errors.push(error.message) },
    });

    await engine.createTask({ projectId: "p", taskId: "commit-empty", fields: { request: "validate" } });
    await engine.idle();

    expect((await engine.getTask("commit-empty"))?.status).toBe("in_progress");
    expect(errors).toEqual([]);
    expect((await chronicle.recent({ taskId: "commit-empty", type: "wake.review_required", limit: 10 })).length).toBe(1);
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

  test("scope leases prevent overlapping wakes for conflicting tasks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sikong-engine-leases-"));
    try {
      const ran: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let firstStarted!: () => void;
      const started = new Promise<void>((r) => {
        firstStarted = r;
      });
      const loop: LoopFactory = (ctx) =>
        scriptLoop(async () => {
          ran.push(ctx.task.id);
          if (ctx.task.id === "t1") {
            firstStarted();
            await gate;
          }
        });
      const chronicle = new MemoryChronicleStore(() => 1);
      const engine = new WorkflowEngine({
        events: new MemoryEventStore(() => 1),
        projections: new MemoryProjectionStore(),
        registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
        chronicle,
        scopeLeases: new JsonScopeLeaseStore(dir, () => Date.now()),
        loop,
      });

      await engine.createTask({ projectId: "p", taskId: "t1", fields: {}, scopes: { write: ["file:README.md"] }, wake: false });
      await engine.createTask({ projectId: "p", taskId: "t2", fields: {}, scopes: { write: ["file:README.md"] }, wake: false });
      const running = engine.runPending("t1");
      await started;
      engine.nudge("t2");
      await sleep(30);
      expect(ran).toEqual(["t1"]);
      expect((await chronicle.recent({ type: "wake.waiting" })).map((entry) => entry.taskId)).toContain("t2");

      release();
      await running;
      expect(ran).toEqual(["t1", "t2"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  test("lead cancel preempts the in-flight worker pass", async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    let cancelled = false;
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop: () =>
        cancellableScriptLoop(async (_input, isCancelled) => {
          started();
          while (!isCancelled()) await sleep(5);
          cancelled = true;
        }),
      wakeTimeoutMs: 2_000,
    });

    await engine.createTask({ projectId: "p", taskId: "cancel-preempts-worker", fields: {} });
    await startedP;
    const began = Date.now();
    await engine.submitCommand("cancel-preempts-worker", { kind: "cancel", reason: "operator stop" }, "lead");
    await engine.idle();

    expect(cancelled).toBe(true);
    expect(Date.now() - began).toBeLessThan(500);
    expect((await engine.getTask("cancel-preempts-worker"))?.status).toBe("cancelled");
  });

  test("lead cancel from another engine process preempts through the event log", async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    let cancelled = false;
    const events = new MemoryEventStore(() => 1);
    const projections = new MemoryProjectionStore();
    const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
    const runner = new WorkflowEngine({
      events,
      projections,
      registry,
      loop: () =>
        cancellableScriptLoop(async (_input, isCancelled) => {
          started();
          while (!isCancelled()) await sleep(5);
          cancelled = true;
        }),
      wakeTimeoutMs: 5_000,
    });
    const submitter = new WorkflowEngine({
      events,
      projections,
      registry,
      loop: () => mockLoop({ response: "unused" }),
    });

    await runner.createTask({ projectId: "p", taskId: "cross-process-cancel", fields: {} });
    await startedP;
    const began = Date.now();
    await submitter.submitCommand("cross-process-cancel", { kind: "cancel", reason: "operator stop" }, "lead", {
      schedule: false,
    });
    await runner.idle();

    expect(cancelled).toBe(true);
    expect(Date.now() - began).toBeLessThan(2_000);
    expect((await runner.getTask("cross-process-cancel"))?.status).toBe("cancelled");
  });

  test("lead block can resolve a review-required worker pass", async () => {
    let calls = 0;
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop: () =>
        cancellableScriptLoop(async () => {
          calls++;
          return "plain text without state commands";
        }, "ai-sdk"),
      wakeTimeoutMs: 2_000,
    });

    await engine.createTask({ projectId: "p", taskId: "block-preempts-commit", fields: {} });
    const began = Date.now();
    await engine.submitCommand("block-preempts-commit", { kind: "block", reason: "operator hold" }, "lead");
    await engine.idle();

    expect(calls).toBe(1);
    expect(Date.now() - began).toBeLessThan(500);
    expect((await engine.getTask("block-preempts-commit"))?.status).toBe("blocked");
  });

  test("pending operator messages gate subtask creation until the lead acknowledges them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sikong-lead-message-"));
    try {
      const mailbox = new JsonSteerMailbox(dir);
      const chronicle = new MemoryChronicleStore(() => 1);
      const delegateWorkflow: WorkflowDef = {
        id: "delegate-test",
        version: "1",
        name: "Delegate Test",
        description: "delegation gate test",
        fields: {},
        stages: [
          {
            id: "delegate",
            category: "in_progress",
            entry: { op: "always" },
            tools: ["create_subtask"],
          },
          {
            id: "done",
            category: "done",
            entry: { op: "hasEvent", eventType: "transition.requested" },
          },
        ],
      };
      const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
      registry.register(delegateWorkflow);
      let pass = 0;
      let messageId = "";
      const engine = new WorkflowEngine({
        events: new MemoryEventStore(() => 1),
        projections: new MemoryProjectionStore(),
        chronicle,
        registry,
        steerMailbox: mailbox,
        loop: () =>
          scriptLoop(async (input) => {
            pass++;
            if (pass === 1) {
              await input.tools?.create_subtask?.execute?.({ workflowId: "general", input: "too broad" }, {});
              return;
            }
            await input.tools?.ack_lead_messages?.execute?.({
              ids: [messageId],
              decision: "accepted",
              response: "scope limit accepted; creating one bounded child",
            }, {});
            await input.tools?.create_subtask?.execute?.({ workflowId: "general", input: "bounded child" }, {});
          }),
      });

      await engine.createTask({ projectId: "p", workflowId: "delegate-test", taskId: "lead-gated", wake: false });
      const entry = await mailbox.submit("lead-gated", "keep this to one narrow slice", "scope_limit");
      messageId = entry.id;

      await engine.runPending("lead-gated");
      expect((await engine.getTask("lead-gated"))?.childIds).toHaveLength(0);
      expect(await mailbox.list("lead-gated")).toHaveLength(1);
      expect((await chronicle.recent({ taskId: "lead-gated", type: "command.rejected", limit: 10 }))[0]?.summary)
        .toContain("create_subtask requires lead message acknowledgement");

      await engine.runPending("lead-gated");
      expect((await engine.getTask("lead-gated"))?.childIds).toHaveLength(1);
      expect(await mailbox.list("lead-gated")).toHaveLength(0);
      const timeline = await (engine["o"].events as MemoryEventStore).load("lead-gated");
      expect(timeline.map((event) => event.type)).toContain("lead.messages.acknowledged");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a hung wake is bounded by wakeTimeoutMs and reported, never left to hang", async () => {
    const errors: Error[] = [];
    const chronicle = new MemoryChronicleStore(() => 1);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      chronicle,
      loop: () => hangingLoop(),
      wakeTimeoutMs: 40,
      hooks: { onError: (i: { error: Error }) => errors.push(i.error) },
    });

    await engine.createTask({ projectId: "p", taskId: "h1", fields: {} });
    await engine.idle(); // must resolve even though the backend never returns

    expect(errors.some((e) => /timed out/.test(e.message))).toBe(true);
    expect((await engine.getTask("h1"))?.status).toBe("in_progress");
    const cleanup = (await chronicle.recent({ taskId: "h1", type: "wake.cleanup", limit: 10 }))[0];
    expect(cleanup?.summary).toContain("worker cleanup unsettled");
    expect(cleanup?.data).toMatchObject({
      status: "unsettled",
      reason: "wake timeout",
      hardKill: false,
      pidUnavailableReason: "test backend ignores cancellation",
    });
  });

  test("a hung cleanup method is also bounded by the engine", async () => {
    const errors: Error[] = [];
    const chronicle = new MemoryChronicleStore(() => 1);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      chronicle,
      loop: () => cleanupHangingLoop(),
      wakeTimeoutMs: 10,
      hooks: { onError: (i: { error: Error }) => errors.push(i.error) },
    });

    await engine.createTask({ projectId: "p", taskId: "h-cleanup", fields: {} });
    await engine.idle();

    expect(errors.some((e) => /timed out/.test(e.message))).toBe(true);
    const cleanup = (await chronicle.recent({ taskId: "h-cleanup", type: "wake.cleanup", limit: 10 }))[0];
    expect(cleanup?.data).toMatchObject({
      status: "unsettled",
      reason: "wake timeout",
      hardKill: false,
    });
    expect(String(cleanup?.data?.error)).toContain("cleanup did not settle");
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
    const entries = await chronicle.recent({ taskId: "c1", limit: 50 });
    const types = entries.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["task.created", "wake.start", "task.advanced", "task.terminal", "wake.end"]),
    );
    const wakeStart = entries.find((entry) => entry.type === "wake.start");
    expect(wakeStart?.summary).toMatch(/timeout=\d+s/);
    expect(wakeStart?.data).toMatchObject({
      effort: "medium",
      components: expect.arrayContaining([expect.objectContaining({ name: "agentTurn" })]),
    });
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

  test("diagnostics distinguish terminal-intent closure from runtime cancellation", async () => {
    const chronicle = new MemoryChronicleStore(() => 1);
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      chronicle,
      loop: () =>
        cancellableScriptLoop(async (input) => {
          await input.tools?.set_field?.execute?.({ field: "summary", value: "done" }, {});
          await input.tools?.request_transition?.execute?.({ reason: "done" }, {});
        }),
    });

    await engine.createTask({ projectId: "p", taskId: "terminal-intent-diagnostics" });
    await engine.idle();

    const diagnostics = (
      await chronicle.recent({ taskId: "terminal-intent-diagnostics", type: "wake.diagnostics", limit: 10 })
    )[0];
    expect(diagnostics?.summary).toContain("status=closed_by_state_command");
    expect(diagnostics?.data).toMatchObject({
      status: "closed_by_state_command",
      runtimeStatus: "cancelled",
      closeCommandKinds: ["request_transition"],
      stateCommands: 2,
    });
    expect((await engine.getTask("terminal-intent-diagnostics"))?.status).toBe("done");
  });

  test("review-required work log carries compact tool call facts from the worker pass", async () => {
    const chronicle = new MemoryChronicleStore(() => 1);
    let runCount = 0;
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
        throw new Error("unexpected second run");
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

    expect(runCount).toBe(1);
    const reviewRequired = (await chronicle.recent({ taskId: "facts", type: "wake.review_required", limit: 10 }))[0];
    const toolFacts = String(JSON.stringify(reviewRequired?.data?.toolCallFacts));
    expect(toolFacts).toContain("bunx --bun vitest run packages/agent-loop/src/test/project-tools.test.ts");
    expect(toolFacts).toContain("1 test file passed");
    expect(toolFacts).not.toContain("hidden");
  });
});

describe("Acceptance evidence + lead review (ADR 0024 revised)", () => {
  const REVIEW_WF: WorkflowDef = {
    id: "review-wf",
    version: "1",
    name: "ReviewWf",
    description: "",
    fields: {},
    stages: [
      {
        id: "work",
        category: "in_progress",
        entry: { op: "always" },
        acceptance: [{ kind: "projectGate", description: "typecheck/test evidence" }],
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

  function makeReviewEngine(loop: AgentLoop = mockLoop({ callTool: { name: "request_transition", args: { reason: "done" } } })) {
    const engine = new WorkflowEngine({
      events: new MemoryEventStore(() => 1),
      projections: new MemoryProjectionStore(),
      registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
      loop: () => loop,
    });
    engine["o"].registry.register(REVIEW_WF);
    return engine;
  }

  test("worker evidence and transition do not admit done without lead acceptance", async () => {
    const engine = makeReviewEngine(
      scriptLoop(async (input) => {
        await input.tools?.submit_evidence?.execute?.(
          {
            summary: "typecheck/test passed",
            checks: [{ label: "typecheck", command: "bun run typecheck", exitCode: 0, passed: true }],
          },
          {},
        );
        await input.tools?.request_transition?.execute?.({ reason: "ready for lead review" }, {});
      }),
    );

    await engine.createTask({ projectId: "p", workflowId: "review-wf", taskId: "review-no-accept" });
    await engine.idle();

    const task = await engine.getTask("review-no-accept");
    expect(task?.status).toBe("in_progress");
    expect(task?.stageId).toBe("work");
    const events = await (engine["o"].events as MemoryEventStore).load("review-no-accept");
    expect(events.some((e) => e.type === "acceptance.evidence")).toBe(true);
  });

  test("lead acceptance admits done after evidence and transition", async () => {
    const engine = makeReviewEngine(
      scriptLoop(async (input) => {
        await input.tools?.submit_evidence?.execute?.({ summary: "tests passed" }, {});
        await input.tools?.request_transition?.execute?.({ reason: "ready" }, {});
      }),
    );

    await engine.createTask({ projectId: "p", workflowId: "review-wf", taskId: "review-accept" });
    await engine.idle();
    await engine.submitCommand(
      "review-accept",
      { kind: "acceptance_decision", decision: "accepted", reason: "evidence reviewed by lead" },
      "lead",
    );

    await engine.idle();

    const task = await engine.getTask("review-accept");
    expect(task?.status).toBe("done");
    expect(task?.stageId).toBe("done");
  });

  test("lead rejection keeps the task open", async () => {
    const engine = makeReviewEngine(
      scriptLoop(async (input) => {
        await input.tools?.submit_evidence?.execute?.({ summary: "tests passed but feature incomplete" }, {});
        await input.tools?.request_transition?.execute?.({ reason: "ready" }, {});
      }),
    );

    await engine.createTask({ projectId: "p", workflowId: "review-wf", taskId: "review-reject" });
    await engine.idle();
    await engine.submitCommand(
      "review-reject",
      { kind: "acceptance_decision", decision: "rejected", reason: "requirement not met" },
      "lead",
      { schedule: false },
    );
    await engine.idle();

    const task = await engine.getTask("review-reject");
    expect(task?.status).toBe("in_progress");
    expect(task?.stageId).toBe("work");
  });

  test("worker cannot accept its own work", async () => {
    const engine = makeReviewEngine();
    await engine.createTask({ projectId: "p", workflowId: "review-wf", taskId: "review-worker-accept" });

    await expect(
      engine.submitCommand(
        "review-worker-accept",
        { kind: "acceptance_decision", decision: "accepted", reason: "self-approved" },
        "worker",
      ),
    ).rejects.toThrow(/lead\/engine-only/);
  });
});
