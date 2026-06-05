import { describe, expect, test } from "vitest";
import { apply, applyEventsToTask, initTask, project, reduceCommands, tryAdvance } from "./reducer";
import { CommandRejectedError } from "./errors";
import type { AcceptanceCheck, NewEvent, Task, TaskEvent, WorkflowDef } from "./types";
import { MemoryEventStore } from "../store/memory";

const WF: WorkflowDef = {
  id: "wf",
  version: "1",
  name: "Test",
  description: "",
  fields: {
    score: { type: "number", description: "" },
    approved: { type: "boolean", description: "" },
    label: { type: "enum", enum: ["a", "b"], description: "" },
  },
  stages: [
    { id: "todo", category: "todo", entry: { op: "always" } },
    { id: "work", category: "in_progress", entry: { op: "field", field: "score", cmp: "gte", value: 5 } },
    { id: "done", category: "done", entry: { op: "field", field: "approved", cmp: "eq", value: true } },
  ],
};

const stamp = (events: NewEvent[]): TaskEvent[] => events.map((e, i) => ({ ...e, seq: i + 1, ts: 1 }));
const initial = (wf: WorkflowDef = WF): Task =>
  project(stamp(initTask({ taskId: "t", projectId: "p", workflow: wf })), wf);

async function applyAndAdvance(
  es: MemoryEventStore,
  task: Task,
  wf: WorkflowDef,
  commands: Parameters<typeof reduceCommands>[2],
): Promise<Task> {
  await es.append(task.id, reduceCommands(task, wf, commands, { source: "worker" }));
  const mid = project(await es.load(task.id), wf);
  await es.append(task.id, tryAdvance(mid, wf, await es.load(task.id)));
  return project(await es.load(task.id), wf);
}

describe("project / initTask", () => {
  test("opens on the initial stage with derived status", () => {
    const t = initial();
    expect(t.stageId).toBe("todo");
    expect(t.status).toBe("todo");
    expect(t.fields).toEqual({});
    expect(t.cursor).toBe(1);
  });

  test("pinned-version mismatch throws on projection", () => {
    const events = stamp(initTask({ taskId: "t", projectId: "p", workflow: WF }));
    expect(() => project(events, { ...WF, version: "2" })).toThrow(/workflow mismatch/);
  });

  test("apply / tryAdvance also defend the pinned version (not just project)", () => {
    const t = initial();
    expect(() => apply(t, { ...WF, version: "2" }, { kind: "set_field", field: "score", value: 1 })).toThrow(
      /workflow mismatch/,
    );
    expect(() => tryAdvance(t, { ...WF, version: "2" }, [])).toThrow(/workflow mismatch/);
  });

  test("empty timeline throws", () => {
    expect(() => project([], WF)).toThrow();
  });

  test("depth defaults to 0 for root tasks", () => {
    const t = initial();
    expect(t.depth).toBe(0);
    expect(t.parentId).toBeUndefined();
  });

  test("depth is set from initTask params", () => {
    const events = stamp(initTask({ taskId: "t2", projectId: "p", workflow: WF, depth: 2 }));
    const t = project(events, WF);
    expect(t.depth).toBe(2);
  });

  test("depth propagates through applyEventsToTask with subtask.created", () => {
    let t = initial();
    const childEvent = {
      type: "subtask.created" as const,
      taskId: "t",
      source: "worker" as const,
      payload: { childId: "c1", workflowId: "general", input: "x" },
    };
    t = applyEventsToTask(t, stamp([childEvent]), WF);
    expect(t.childIds).toEqual(["c1"]);
    expect(t.depth).toBe(0); // parent depth unchanged
  });
});

describe("apply (the aggregate)", () => {
  test("set_field validates against the schema", () => {
    expect(() => apply(initial(), WF, { kind: "set_field", field: "nope", value: 1 })).toThrow(
      CommandRejectedError,
    );
    expect(() => apply(initial(), WF, { kind: "set_field", field: "score", value: "x" })).toThrow(
      CommandRejectedError,
    );
    expect(() => apply(initial(), WF, { kind: "set_field", field: "label", value: "c" })).toThrow(
      CommandRejectedError,
    );
    expect(apply(initial(), WF, { kind: "set_field", field: "label", value: "a" })[0]?.type).toBe(
      "field.set",
    );
  });

  test("request_transition records who asked + from where", () => {
    const [ev] = apply(initial(), WF, { kind: "request_transition", reason: "ready" });
    expect(ev?.type).toBe("transition.requested");
    expect(ev?.payload).toMatchObject({ fromStage: "todo", reason: "ready" });
  });

  test("lead cancel is terminal — accepts no further commands", () => {
    let t = initial();
    t = applyEventsToTask(t, stamp(apply(t, WF, { kind: "cancel", reason: "drop" }, { source: "lead" })), WF);
    expect(t.status).toBe("cancelled");
    expect(() => apply(t, WF, { kind: "set_field", field: "score", value: 1 })).toThrow(
      CommandRejectedError,
    );
  });

  test("worker cancel requests approval without terminating the task", () => {
    let t = initial();
    const events = apply(t, WF, { kind: "cancel", reason: "not worth doing" }, { source: "worker" });
    expect(events[0]?.type).toBe("cancellation.requested");
    expect(events[0]?.payload).toMatchObject({ reason: "not worth doing" });
    t = applyEventsToTask(t, stamp(events), WF);
    expect(t.status).toBe("todo");
    expect(apply(t, WF, { kind: "set_field", field: "score", value: 1 })[0]?.type).toBe("field.set");
  });

  test("block / unblock toggles status; double-block is rejected", () => {
    let t = initial();
    t = applyEventsToTask(t, stamp(apply(t, WF, { kind: "block", reason: "waiting" })), WF);
    expect(t.status).toBe("blocked");
    expect(() => apply(t, WF, { kind: "block", reason: "again" })).toThrow(CommandRejectedError);
    t = applyEventsToTask(t, stamp(apply(t, WF, { kind: "unblock" })), WF);
    expect(t.status).toBe("todo");
    expect(t.stageId).toBe("todo");
  });

  test("reduceCommands threads each command's effect into the next", () => {
    // unblock is only legal once block (the prior command) has taken effect.
    const events = reduceCommands(initial(), WF, [{ kind: "block", reason: "x" }, { kind: "unblock" }]);
    expect(events.map((e) => e.type)).toEqual(["task.blocked", "task.unblocked"]);
  });

  test("create_subtask beyond maxTeamDepth is rejected", () => {
    const cappedWf: WorkflowDef = {
      ...WF,
      id: "capped",
      version: "1",
      maxTeamDepth: 2,
    };
    // Build a task at depth 2 (one below the cap — can still create children)
    const t1 = project(
      stamp(initTask({ taskId: "t1", projectId: "p", workflow: cappedWf, depth: 1 })),
      cappedWf,
    );
    const ev = apply(t1, cappedWf, {
      kind: "create_subtask",
      childId: "c1",
      workflowId: "general",
      input: "x",
    });
    expect(ev[0]?.type).toBe("subtask.created");

    // Build a task at depth 2 (equal to maxTeamDepth — create_subtask rejected)
    const t2 = project(
      stamp(initTask({ taskId: "t2", projectId: "p", workflow: cappedWf, depth: 2 })),
      cappedWf,
    );
    expect(() =>
      apply(t2, cappedWf, {
        kind: "create_subtask",
        childId: "c2",
        workflowId: "general",
        input: "y",
      }),
    ).toThrow(CommandRejectedError);
  });

  test("create_subtask with acceptance sets child's acceptance on the event (ADR 0027)", () => {
    const checks: AcceptanceCheck[] = [
      { kind: "fileExists", description: "lead check", path: "out.txt" },
    ];
    const t1 = project(
      stamp(initTask({ taskId: "t1", projectId: "p", workflow: WF, depth: 0 })),
      WF,
    );
    const ev = apply(t1, WF, {
      kind: "create_subtask",
      childId: "c1",
      workflowId: "general",
      input: "x",
      acceptance: checks,
    });
    expect(ev[0]?.type).toBe("subtask.created");
    expect(ev[0]?.payload.acceptance).toEqual(checks);
  });
});

describe("tryAdvance (guard-driven progression)", () => {
  test("advances exactly as far as the guards allow, then is terminal", async () => {
    const es = new MemoryEventStore(() => 1);
    await es.append("t", initTask({ taskId: "t", projectId: "p", workflow: WF }));
    let t = project(await es.load("t"), WF);

    t = await applyAndAdvance(es, t, WF, [{ kind: "set_field", field: "score", value: 7 }]);
    expect(t.stageId).toBe("work"); // todo→work (score≥5); blocked from done (approved unset)
    expect(t.status).toBe("in_progress");

    t = await applyAndAdvance(es, t, WF, [{ kind: "set_field", field: "approved", value: true }]);
    expect(t.stageId).toBe("done");
    expect(t.status).toBe("done");

    // done is terminal + absorbing: no further command, not even cancel.
    expect(() => apply(t, WF, { kind: "set_field", field: "score", value: 99 })).toThrow(
      CommandRejectedError,
    );
    expect(() => apply(t, WF, { kind: "cancel" })).toThrow(CommandRejectedError);
  });

  test("does not advance while blocked", () => {
    let t = initial();
    t = applyEventsToTask(t, stamp(apply(t, WF, { kind: "block", reason: "hold" })), WF);
    t = applyEventsToTask(t, stamp(apply(t, WF, { kind: "set_field", field: "score", value: 9 })), WF);
    expect(tryAdvance(t, WF, [])).toEqual([]);
  });

  test("transition requests do not survive block and unblock", async () => {
    const wf: WorkflowDef = {
      id: "block-window",
      version: "1",
      name: "Block Window",
      description: "",
      fields: {},
      stages: [
        { id: "open", category: "in_progress", entry: { op: "always" } },
        { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const es = new MemoryEventStore(() => 1);
    await es.append("t", initTask({ taskId: "t", projectId: "p", workflow: wf }));
    let t = project(await es.load("t"), wf);

    await es.append("t", reduceCommands(t, wf, [{ kind: "request_transition" }, { kind: "block", reason: "hold" }]));
    t = project(await es.load("t"), wf);
    await es.append("t", reduceCommands(t, wf, [{ kind: "unblock" }]));
    t = project(await es.load("t"), wf);

    expect(tryAdvance(t, wf, await es.load("t"))).toEqual([]);
  });

  test("hasEvent guards do not leak across stage boundaries", async () => {
    const leaky: WorkflowDef = {
      id: "leak",
      version: "1",
      name: "Leak",
      description: "",
      fields: {},
      stages: [
        { id: "a", category: "todo", entry: { op: "always" } },
        { id: "b", category: "in_progress", entry: { op: "hasEvent", eventType: "transition.requested" } },
        { id: "c", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
      ],
    };
    const es = new MemoryEventStore(() => 1);
    await es.append("t", initTask({ taskId: "t", projectId: "p", workflow: leaky }));
    let t = project(await es.load("t"), leaky);

    // One request_transition in stage "a" admits "b" — but must NOT cascade into
    // "c", whose identical guard sees only "b"'s (empty) current-stage events.
    t = await applyAndAdvance(es, t, leaky, [{ kind: "request_transition" }]);
    expect(t.stageId).toBe("b");
    expect(t.status).toBe("in_progress");
  });
});
