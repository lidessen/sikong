// Lead-authored per-task acceptance checks (ADR 0027).
//
// These checks are review criteria, not engine-executed tests. The worker submits
// evidence; a lead acceptance event is the only thing that admits `done`.
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

// A workflow whose `work` stage carries static acceptance criteria, and whose
// done stage is gated on explicit lead acceptance.
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
  test("blocks done until the lead accepts, even when worker submits evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-leadacc-block-"));
    await writeFile(join(root, "stage.txt"), "ok\n", "utf8");
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

  test("admits done when the lead accepts the submitted evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "sikong-leadacc-pass-"));
    await writeFile(join(root, "stage.txt"), "ok\n", "utf8");
    const engine = makeEngine(root);
    await engine.createTask({
      projectId: "p",
      workflowId: "lead-acc-wf",
      taskId: "lead-acc-pass",
      acceptance: [{ kind: "fileExists", description: "lead-required artifact", path: "lead-required.txt" }],
    });
    await engine.idle();
    await engine.submitCommand(
      "lead-acc-pass",
      { kind: "acceptance_decision", decision: "accepted", reason: "lead reviewed evidence" },
      "lead",
    );
    await engine.idle();

    const task = await engine.getTask("lead-acc-pass");
    expect(task?.status).toBe("done");
    expect(task?.stageId).toBe("done");
  });
});
