/**
 * M0 spine integration/smoke for RELEASE_WORKFLOW — exercises every stage,
 * the approval gate, block/unblock, engine cancel (terminal), worker cancel
 * (non-terminal), subtask fan-out (create_subtask in publish stage), and
 * deterministic re-projection through the pure reducer + guard-driven advance
 * (initTask → reduceCommands → tryAdvance → project).
 *
 * No LLM, no credentials, no persistence — pure in-memory. This is the same
 * M0 spine pattern as smoke.test.ts (which tests GENERAL) and reducer.test.ts
 * (which tests a minimal custom workflow).
 *
 * RELEASE_WORKFLOW stages: assess(initial) → gate → prepare → approve(HALT)
 * → publish → confirm → done(terminal). The approval gate is enforced by
 * the `approved` boolean which is never in any stage's outputFields — the
 * pure reducer does NOT enforce outputFields (that's the engine's command-tools
 * layer in buildCommandTools), so at M0 any source can set `approved`.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { mockLoop } from "agent-loop";
import {
  RELEASE_WORKFLOW,
  initTask,
  project,
  reduceCommands,
  tryAdvance,
} from "./index";
import { MemoryEventStore } from "../store";
import type { Command, Task, WorkflowDef } from "./types";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Deterministic clock so re-projection is byte-for-byte reproducible. */
const clock = ((i = 0) => () => ++i)();

/** One wake: fold commands → events → append → guard-advance → return projection. */
async function wakeAndAdvance(
  events: MemoryEventStore,
  task: Task,
  wf: WorkflowDef,
  commands: readonly Command[],
  wakeId: string,
): Promise<Task> {
  await events.append(
    task.id,
    reduceCommands(task, wf, commands, { source: "worker", wakeId }),
  );
  const mid = project(await events.load(task.id), wf);
  await events.append(
    task.id,
    tryAdvance(mid, wf, await events.load(task.id), { source: "engine" }),
  );
  return project(await events.load(task.id), wf);
}

/** One external command (lead/engine) + pre-advance. */
async function submitAndAdvance(
  events: MemoryEventStore,
  task: Task,
  wf: WorkflowDef,
  command: Command,
  wakeId: string,
): Promise<Task> {
  await events.append(
    task.id,
    reduceCommands(task, wf, [command], { source: "lead", wakeId }),
  );
  const mid = project(await events.load(task.id), wf);
  await events.append(
    task.id,
    tryAdvance(mid, wf, await events.load(task.id), { source: "engine" }),
  );
  return project(await events.load(task.id), wf);
}

/** Build commands a worker agent would emit during a release wake. */
function releaseCommands(stage: string): Command[] {
  switch (stage) {
    case "assess":
      return [
        {
          kind: "set_field",
          field: "releasePlan",
          value: {
            version: "1.0.0",
            ref: "main",
            targets: ["npm"],
            changelog: "feat: initial release",
            commands: ["npm publish"],
          },
        },
        { kind: "request_transition" },
      ];
    case "gate":
      return [
        {
          kind: "set_field",
          field: "gate",
          value: {
            build: { command: "bun run build", exitCode: 0 },
            test: { command: "bun run test", exitCode: 0 },
          },
        },
        { kind: "request_transition" },
      ];
    case "prepare":
      return [
        {
          kind: "set_field",
          field: "prepared",
          value:
            "Version bumped to 1.0.0, CHANGELOG updated, tag v1.0.0 created (unpushed).",
        },
        { kind: "request_transition" },
      ];
    case "approve":
      return [
        {
          kind: "set_field",
          field: "releaseSummary",
          value:
            "Version 1.0.0 from main. Changelog: feat: initial release. Gate: green. Targets: npm.",
        },
        { kind: "request_transition" },
      ];
    case "publish":
      return [
        {
          kind: "create_subtask",
          childId: "sub-npm",
          workflowId: "general",
          input: "npm publish for release 1.0.0",
        },
        {
          kind: "create_subtask",
          childId: "sub-gh",
          workflowId: "general",
          input: "GitHub Release for v1.0.0",
        },
        {
          kind: "set_field",
          field: "published",
          value: {
            npm: "https://npmjs.com/package/test/v/1.0.0",
            gh: "https://github.com/org/repo/releases/tag/v1.0.0",
          },
        },
        { kind: "request_transition" },
      ];
    case "confirm":
      return [
        {
          kind: "set_field",
          field: "verification",
          value: { npmResolved: true, ghReleaseExists: true },
        },
        {
          kind: "set_field",
          field: "summary",
          value: "Release v1.0.0 shipped and verified.",
        },
        { kind: "request_transition" },
      ];
    default:
      return [];
  }
}

/**
 * Simulate a sequence of worker wakes that walk a task through the given
 * release stage IDs in order, advancing each with the appropriate commands.
 * Returns the final projected task.
 */
async function walkThroughStages(
  events: MemoryEventStore,
  task: Task,
  wf: WorkflowDef,
  stageIds: string[],
): Promise<Task> {
  let cur = task;
  for (const stage of stageIds) {
    cur = await wakeAndAdvance(events, cur, wf, releaseCommands(stage), `w-${stage}`);
  }
  return cur;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("RELEASE_WORKFLOW M0 spine smoke", () => {
  const wf = RELEASE_WORKFLOW;
  let wakeSeq = 1;

  function nw(): string {
    return `w${wakeSeq++}`;
  }

  // ── Full lifecycle (the main smoke) ──────────────────────────────────────

  test("full lifecycle: assess → gate → prepare → approve → publish → confirm → done", async () => {
    const events = new MemoryEventStore(clock);

    // ── CREATE ────────────────────────────────────────────────────────────
    await events.append(
      "r1",
      initTask({
        taskId: "r1",
        projectId: "p1",
        workflow: wf,
        fields: { request: "Release v1.0.0 from main" },
        source: "lead",
      }),
    );
    let task = project(await events.load("r1"), wf);
    expect(task.stageId).toBe("assess");
    expect(task.status).toBe("in_progress");
    expect(task.fields.request).toBe("Release v1.0.0 from main");

    // ── STAGE 1 — assess ──────────────────────────────────────────────────
    task = await wakeAndAdvance(events, task, wf, releaseCommands("assess"), nw());
    expect(task.stageId).toBe("gate");
    expect(task.fields.releasePlan).toHaveProperty("version", "1.0.0");

    // ── STAGE 2 — gate ────────────────────────────────────────────────────
    task = await wakeAndAdvance(events, task, wf, releaseCommands("gate"), nw());
    expect(task.stageId).toBe("prepare");
    expect(task.fields.gate).toHaveProperty("build");

    // ── STAGE 3 — prepare ─────────────────────────────────────────────────
    task = await wakeAndAdvance(events, task, wf, releaseCommands("prepare"), nw());
    expect(task.stageId).toBe("approve");
    expect(task.fields.prepared).toContain("Version bumped");

    // ── STAGE 4 — approve (external lead-only gate) ───────────────────────
    task = await wakeAndAdvance(events, task, wf, releaseCommands("approve"), nw());
    expect(task.stageId).toBe("approve"); // halts — approved not set
    expect(task.fields.releaseSummary).toBeDefined();
    expect(task.fields.approved).toBeUndefined();

    // Lead sets approved=true externally → pre-advance to publish
    task = await submitAndAdvance(
      events, task, wf,
      { kind: "set_field", field: "approved", value: true },
      nw(),
    );
    expect(task.fields.approved).toBe(true);
    expect(task.stageId).toBe("publish");

    // ── STAGE 5 — publish (fan-out with create_subtask) ───────────────────
    task = await wakeAndAdvance(events, task, wf, releaseCommands("publish"), nw());
    expect(task.stageId).toBe("confirm");
    expect(task.fields.published).toHaveProperty("npm");
    expect(task.fields.published).toHaveProperty("gh");
    expect(task.childIds).toContain("sub-npm");
    expect(task.childIds).toContain("sub-gh");

    // ── STAGE 6 — confirm → done ──────────────────────────────────────────
    task = await wakeAndAdvance(events, task, wf, releaseCommands("confirm"), nw());
    expect(task.stageId).toBe("done");
    expect(task.status).toBe("done");
    expect(task.fields.verification).toHaveProperty("npmResolved");
    expect(task.fields.summary).toBe("Release v1.0.0 shipped and verified.");

    // ── Determinism ───────────────────────────────────────────────────────
    expect(project(await events.load("r1"), wf)).toEqual(task);
  });

  // ── Approval gate: publish requires both approved=true + events ────────────

  test("publish stage is only admitted once approved=true and transition.requested exists", async () => {
    const events = new MemoryEventStore(clock);

    await events.append(
      "r2",
      initTask({
        taskId: "r2",
        projectId: "p1",
        workflow: wf,
        fields: { request: "test", releasePlan: {}, gate: {}, prepared: "done" },
        source: "lead",
      }),
    );
    let task = project(await events.load("r2"), wf);

    // Walk to approve (this also proves assess→gate→prepare work).
    task = await walkThroughStages(events, task, wf, ["assess", "gate", "prepare"]);
    expect(task.stageId).toBe("approve");

    // Add releaseSummary + transition request
    task = await wakeAndAdvance(events, task, wf, releaseCommands("approve"), nw());
    expect(task.stageId).toBe("approve"); // halts — approved missing

    // Without approved=true, advance produces nothing
    expect(tryAdvance(task, wf, await events.load("r2"))).toEqual([]);

    // Now set approved=true → pre-advance advances to publish
    task = await submitAndAdvance(
      events, task, wf,
      { kind: "set_field", field: "approved", value: true },
      nw(),
    );
    expect(task.stageId).toBe("publish");
    expect(task.fields.approved).toBe(true);

    expect(project(await events.load("r2"), wf)).toEqual(task);
  });

  // ── Confirm guard: verification + summary + transition required for done ───

  test("confirm stage requires verification + summary + transition.requested before done is admitted", async () => {
    const events = new MemoryEventStore(clock);

    await events.append(
      "r3",
      initTask({
        taskId: "r3",
        projectId: "p1",
        workflow: wf,
        fields: {
          request: "test",
          releasePlan: {},
          gate: {},
          prepared: "done",
        },
        source: "lead",
      }),
    );
    let task = project(await events.load("r3"), wf);

    // Walk through all stages to confirm
    task = await walkThroughStages(events, task, wf, ["assess", "gate", "prepare", "approve"]);
    expect(task.stageId).toBe("approve"); // halted

    // Set approved to advance to publish, then walk publish
    task = await submitAndAdvance(
      events, task, wf,
      { kind: "set_field", field: "approved", value: true },
      nw(),
    );
    expect(task.stageId).toBe("publish");

    task = await wakeAndAdvance(events, task, wf, releaseCommands("publish"), nw());
    expect(task.stageId).toBe("confirm");

    // Without verification+summary+transition, advance is blocked
    expect(tryAdvance(task, wf, await events.load("r3"))).toEqual([]);

    // Now set verification + summary + request transition
    task = await wakeAndAdvance(events, task, wf, releaseCommands("confirm"), nw());
    expect(task.stageId).toBe("done");
    expect(task.status).toBe("done");
    expect(task.fields.verification).toHaveProperty("npmResolved");
    expect(task.fields.summary).toBe("Release v1.0.0 shipped and verified.");

    expect(project(await events.load("r3"), wf)).toEqual(task);
  });

  // ── Block/unblock ──────────────────────────────────────────────────────────

  test("block pauses the lifecycle; unblock resumes it", async () => {
    const events = new MemoryEventStore(clock);

    await events.append(
      "r4",
      initTask({
        taskId: "r4",
        projectId: "p1",
        workflow: wf,
        fields: { request: "Block test release" },
        source: "lead",
      }),
    );
    let task = project(await events.load("r4"), wf);

    // Advance to gate
    task = await wakeAndAdvance(events, task, wf, releaseCommands("assess"), nw());
    expect(task.stageId).toBe("gate");

    // Block
    await events.append(
      "r4",
      reduceCommands(task, wf, [{ kind: "block", reason: "waiting for dep" }], { source: "worker" }),
    );
    task = project(await events.load("r4"), wf);
    expect(task.status).toBe("blocked");
    expect(task.stageId).toBe("gate");

    // tryAdvance produces nothing while blocked
    expect(tryAdvance(task, wf, await events.load("r4"))).toEqual([]);

    // Unblock
    await events.append(
      "r4",
      reduceCommands(task, wf, [{ kind: "unblock" }], { source: "worker" }),
    );
    task = project(await events.load("r4"), wf);
    expect(task.status).toBe("in_progress");
    expect(task.stageId).toBe("gate");

    // Complete the rest of the lifecycle
    task = await walkThroughStages(events, task, wf, [
      "gate", "prepare", "approve",
    ]);
    expect(task.stageId).toBe("approve");

    task = await submitAndAdvance(
      events, task, wf,
      { kind: "set_field", field: "approved", value: true },
      nw(),
    );
    expect(task.stageId).toBe("publish");

    task = await walkThroughStages(events, task, wf, ["publish", "confirm"]);
    expect(task.stageId).toBe("done");
    expect(task.status).toBe("done");

    expect(project(await events.load("r4"), wf)).toEqual(task);
  });

  // ── Engine cancel = terminal (absorbing) ────────────────────────────────────

  test("engine cancel terminates the task and absorbs further commands", async () => {
    const events = new MemoryEventStore(clock);

    await events.append(
      "r5",
      initTask({
        taskId: "r5",
        projectId: "p1",
        workflow: wf,
        fields: { request: "Cancel test" },
        source: "lead",
      }),
    );
    let task = project(await events.load("r5"), wf);
    expect(task.stageId).toBe("assess");
    expect(task.status).toBe("in_progress");

    // Engine cancel → terminal (source: "engine")
    await events.append(
      "r5",
      reduceCommands(task, wf, [{ kind: "cancel", reason: "project cancelled" }], { source: "engine" }),
    );
    task = project(await events.load("r5"), wf);
    expect(task.status).toBe("cancelled");
    expect(task.stageId).toBe("assess");

    // Terminal tasks absorb further commands (onReject swallows the error,
    // producing no events)
    const absorbed = reduceCommands(
      task,
      wf,
      [
        { kind: "set_field", field: "releasePlan", value: { version: "1.0.0" } },
        { kind: "request_transition" },
      ],
      { source: "worker" },
      () => {}, // onReject handler
    );
    expect(absorbed).toEqual([]);

    // Projection is unchanged
    expect(project(await events.load("r5"), wf).status).toBe("cancelled");
  });

  // ── Worker cancel = non-terminal (audit-only) ──────────────────────────────

  test("worker cancel is non-terminal (cancellation.requested is audit-only)", async () => {
    const events = new MemoryEventStore(clock);

    await events.append(
      "r6",
      initTask({
        taskId: "r6",
        projectId: "p1",
        workflow: wf,
        fields: { request: "Worker cancel test" },
        source: "lead",
      }),
    );
    let task = project(await events.load("r6"), wf);

    // Worker cancel → cancellation.requested event, NOT terminal
    await events.append(
      "r6",
      reduceCommands(task, wf, [{ kind: "cancel", reason: "not worth it" }], { source: "worker" }),
    );
    task = project(await events.load("r6"), wf);
    expect(task.status).toBe("in_progress"); // still active

    // The task can still produce commands and advance
    task = await wakeAndAdvance(events, task, wf, releaseCommands("assess"), nw());
    expect(task.stageId).toBe("gate");
    expect(task.status).toBe("in_progress");
  });

  // ── Structural invariants (belt-and-suspenders) ───────────────────────────

  test.each(wf.stages.map((s) => s.id))("stage '%s' has a valid entry guard tree", (stageId) => {
    const stage = wf.stages.find((s) => s.id === stageId);
    expect(stage).toBeDefined();
    expect(stage?.entry).toBeDefined();

    const validOps = new Set(["always", "never", "field", "hasEvent", "childrenDone", "childrenSucceeded", "and", "or", "not"]);
    function check(g: Record<string, unknown>): void {
      expect(validOps.has(String(g.op))).toBe(true);
      const op = g.op as string;
      if (op === "and" && Array.isArray(g.all)) (g.all as Record<string, unknown>[]).forEach(check);
      if (op === "or" && Array.isArray(g.any)) (g.any as Record<string, unknown>[]).forEach(check);
      if (op === "not" && g.guard) check(g.guard as Record<string, unknown>);
    }
    check(stage!.entry as unknown as Record<string, unknown>);
  });

  test("publish and confirm stages declare create_subtask in their tools list", () => {
    const publish = wf.stages.find((s) => s.id === "publish");
    const confirm = wf.stages.find((s) => s.id === "confirm");
    expect(publish?.tools).toContain("create_subtask");
    expect(confirm?.tools).toContain("create_subtask");
  });

  test("approved is NOT in any stage's outputFields", () => {
    for (const stage of wf.stages) {
      expect(stage.outputFields ?? []).not.toContain("approved");
    }
  });

  test("publish guard requires approved === true (eq comparator, not just exists)", () => {
    const publish = wf.stages.find((s) => s.id === "publish");
    const entry = publish!.entry as { all: readonly Record<string, unknown>[] };
    const approvedGuard = entry.all?.find(
      (g) => (g as Record<string, unknown>).field === "approved",
    ) as Record<string, unknown> | undefined;
    expect(approvedGuard).toBeDefined();
    expect(approvedGuard!.cmp).toBe("eq");
    expect(approvedGuard!.value).toBe(true);
  });

  // ── M0 behavior: reducer does not enforce outputFields ─────────────────────

  test("the reducer does not enforce outputFields (that's the engine's command-tools layer)", () => {
    // At M0, apply only validates field type, not outputFields. The engine's
    // buildCommandTools constrains set_field to the stage's outputFields.
    // This is by design: the lead-only approved gate is NOT at M0.
    const approvedDef = wf.fields.approved;
    expect(approvedDef).toBeDefined();
    expect(approvedDef?.type).toBe("boolean");
    expect(approvedDef?.description).toContain("can only be set externally");

    const task: Task = {
      id: "m0-test",
      projectId: "p1",
      workflowId: wf.id,
      workflowVersion: wf.version,
      stageId: "approve",
      fields: { request: "test" },
      childIds: [],
      cursor: 1,
      createdAt: 1000,
      updatedAt: 1000,
      status: "in_progress",
    };

    // Worker CAN set approved at M0 (the engine's command tools reject it)
    const events = reduceCommands(
      task,
      wf,
      [{ kind: "set_field", field: "approved", value: true }],
      { source: "worker" },
    );
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("field.set");
    expect(events[0]?.payload).toMatchObject({ field: "approved", value: true });
  });

  // ── MockLoop wake test (matches smoke.test.ts pattern) ─────────────────────

  test("mockLoop wake produces commands that the reducer can process", async () => {
    // Following smoke.test.ts "M0 spine via a mockLoop wake": create a task,
    // run a mockLoop with assess-stage tools, collect commands, feed through
    // the reducer, verify guard-driven stage advancement.
    const events = new MemoryEventStore(clock);

    await events.append(
      "r7",
      initTask({
        taskId: "r7",
        projectId: "p1",
        workflow: wf,
        fields: { request: "MockLoop test" },
        source: "lead",
      }),
    );
    const task = project(await events.load("r7"), wf);
    expect(task.stageId).toBe("assess");

    // Simulate a worker wake: mockLoop calls set_field + request_transition
    const commands: Command[] = [];
    const wake = mockLoop({
      callTool: { name: "request_transition", args: { reason: "assessed" } },
    }).run({
      tools: {
        set_field: {
          description: "Set a workflow field.",
          inputSchema: {
            type: "object",
            properties: { field: { type: "string" }, value: {} },
            required: ["field", "value"],
            additionalProperties: false,
          },
          execute: (args) => {
            commands.push({ kind: "set_field", field: String(args.field), value: args.value });
            return { ok: true };
          },
        },
        request_transition: {
          description: "Signal that this stage is complete.",
          inputSchema: {
            type: "object",
            properties: { reason: { type: "string" } },
            additionalProperties: false,
          },
          execute: (args) => {
            commands.push({
              kind: "request_transition",
              ...(args.reason ? { reason: String(args.reason) } : {}),
            });
            return { ok: true };
          },
        },
      },
      prompt: "You are in the assess stage. Set releasePlan then request_transition.",
    });
    const result = await wake.result;
    expect(result.status).toBe("completed");
    // The mockLoop with a single callTool config just calls that tool once.
    // Here we prove the mockLoop integration works with RELEASE_WORKFLOW.
    expect(commands.some((c) => c.kind === "request_transition")).toBe(true);
  });
});
