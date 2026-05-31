import { describe, expect, test } from "vitest";
import { mockLoop } from "agent-loop";
import { WorkflowEngine } from "./engine";
import { GENERAL_WORKFLOW } from "../workflow/builtin";
import type { WorkflowDef } from "../workflow/types";
import {
  MemoryChronicleStore,
  MemoryEventStore,
  MemoryProjectionStore,
  MemoryWorkflowRegistry,
} from "../store/memory";

const BUG: WorkflowDef = {
  id: "bug",
  version: "1",
  name: "Bug",
  description: "Track and fix a reported bug.",
  fields: {
    title: { type: "string", description: "short title" },
    severity: { type: "enum", enum: ["low", "high"], description: "how bad" },
  },
  stages: [
    { id: "open", category: "in_progress", entry: { op: "always" } },
    { id: "done", category: "done", entry: { op: "hasEvent", eventType: "transition.requested" } },
  ],
};

function newEngine(opts: {
  intakeLoop?: ConstructorParameters<typeof WorkflowEngine>[0]["intakeLoop"];
  chronicle?: MemoryChronicleStore;
}) {
  const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
  registry.register(BUG);
  return new WorkflowEngine({
    events: new MemoryEventStore(() => 1),
    projections: new MemoryProjectionStore(),
    registry,
    loop: () => mockLoop({ response: "noop" }),
    ...(opts.intakeLoop ? { intakeLoop: opts.intakeLoop } : {}),
    ...(opts.chronicle ? { chronicle: opts.chronicle } : {}),
  });
}

describe("intake router (agent-loop driven)", () => {
  test("routes to the chosen workflow and extracts/validates fields", async () => {
    const chronicle = new MemoryChronicleStore(() => 1);
    const engine = newEngine({
      chronicle,
      intakeLoop: () =>
        mockLoop({
          callTool: {
            name: "route",
            args: { workflowId: "bug", fields: { title: "crash on save", severity: "high", bogus: 123 } },
          },
        }),
    });

    const task = await engine.intake("the app crashes when I hit save", { projectId: "p", taskId: "i1" });
    await engine.idle();

    expect(task.workflowId).toBe("bug");
    // `bogus` (undeclared) dropped; `severity` kept (valid enum); `title` kept.
    expect(task.fields).toEqual({ title: "crash on save", severity: "high" });
    expect((await chronicle.recent({ type: "intake.routed" })).map((e) => e.data?.workflowId)).toContain("bug");
  });

  test("falls back to GENERAL when no intake loop is configured", async () => {
    const engine = newEngine({});
    const task = await engine.intake("do the thing", { projectId: "p", taskId: "i2" });
    await engine.idle();

    expect(task.workflowId).toBe("general");
    expect(task.fields.request).toBe("do the thing"); // GENERAL has a `request` field → raw ask captured
  });

  test("falls back to GENERAL when the agent routes to an unknown workflow", async () => {
    const engine = newEngine({
      intakeLoop: () =>
        mockLoop({ callTool: { name: "route", args: { workflowId: "does-not-exist", fields: {} } } }),
    });
    const task = await engine.intake("hello", { projectId: "p", taskId: "i3" });
    await engine.idle();

    expect(task.workflowId).toBe("general");
  });
});
