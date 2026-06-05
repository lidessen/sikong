// Lead-authored per-task acceptance checks (ADR 0027).
//
// This is the LEAD-AUTHORED spec for the feature: the implementing worker must make
// these pass against the real engine. It proves the key property — a worker cannot
// reach `done` by satisfying only the stage's own (worker-influenced) acceptance;
// the lead's task-level checks are merged at the gate and must pass for real.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { mockLoop } from "agent-loop";
import { WorkflowEngine } from "./engine";
import type { WorkflowDef } from "../workflow/types";
import {
  MemoryEventStore,
  MemoryProjectStore,
  MemoryProjectionStore,
  MemoryWorkflowRegistry,
} from "../store/memory";
import { GENERAL_WORKFLOW } from "../workflow/builtin";

// A workflow whose `work` stage carries a static acceptance check that PASSES, and a
// done stage gated on `acceptancePassed`. The task-level acceptance is what varies.
const GATED_WF: WorkflowDef = {
  id: "lead-acc-wf",
  version: "1",
  name: "LeadAccWf",
  description: "",
  fields: {},
  stages: [
    {
      id: "work",
      category: "in_progress",
      entry: { op: "always" },
      acceptance: [{ kind: "fileExists", description: "stage check (always passes)", path: "stage.txt" }],
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

function makeEngine(root: string) {
  const engine = new WorkflowEngine({
    events: new MemoryEventStore(() => 1),
    projections: new MemoryProjectionStore(),
    projects: new MemoryProjectStore([{ id: "p", name: "P", root }]),
    registry: new MemoryWorkflowRegistry(GENERAL_WORKFLOW),
    loop: () => mockLoop({ callTool: { name: "request_transition", args: { reason: "done" } } }),
  });
  engine["o"].registry.register(GATED_WF);
  return engine;
}

describe("lead-authored task acceptance (ADR 0027)", () => {
  test("blocks done when a lead task check fails, even though the stage check passes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-leadacc-block-"));
    await writeFile(join(root, "stage.txt"), "ok\n", "utf8"); // stage acceptance passes
    // The lead requires a file the worker did NOT produce → merged gate must fail.
    const engine = makeEngine(root);
    await engine.createTask({
      projectId: "p",
      workflowId: "lead-acc-wf",
      taskId: "lead-acc-block",
      acceptance: [{ kind: "fileExists", description: "lead-required artifact", path: "lead-required.txt" }],
    });
    await engine.idle();

    const task = await engine.getTask("lead-acc-block");
    expect(task?.status).toBe("in_progress");
    expect(task?.stageId).toBe("work");
  });

  test("admits done when both the stage check and the lead task checks pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-leadacc-pass-"));
    await writeFile(join(root, "stage.txt"), "ok\n", "utf8");
    await writeFile(join(root, "lead-required.txt"), "ok\n", "utf8"); // lead check now satisfied
    const engine = makeEngine(root);
    await engine.createTask({
      projectId: "p",
      workflowId: "lead-acc-wf",
      taskId: "lead-acc-pass",
      acceptance: [{ kind: "fileExists", description: "lead-required artifact", path: "lead-required.txt" }],
    });
    await engine.idle();

    const task = await engine.getTask("lead-acc-pass");
    expect(task?.status).toBe("done");
    expect(task?.stageId).toBe("done");
  });
});
