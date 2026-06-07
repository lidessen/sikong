import { describe, expect, test } from "vitest";
import { estimateWakeTimeout } from "./adaptive-timeout";
import type { StageDef, Task, WorkflowDef } from "../workflow/types";

const workflow: WorkflowDef = {
  id: "development",
  version: "1",
  name: "Development",
  description: "Development workflow",
  fields: {
    request: { type: "string", description: "Request" },
    verification: { type: "string", description: "Verification" },
  },
  stages: [],
};

const task: Task = {
  id: "t",
  projectId: "p",
  workflowId: "development",
  workflowVersion: "1",
  stageId: "verify",
  fields: { request: "Make the package publishable for ordinary daily use." },
  status: "in_progress",
  childIds: [],
  depth: 0,
  cursor: 1,
  createdAt: 1,
  updatedAt: 1,
};

const simpleStage: StageDef = {
  id: "plan",
  category: "in_progress",
  entry: { op: "always" },
  outputFields: ["plan"],
  effort: "medium",
};

const verifyStage: StageDef = {
  id: "verify",
  category: "in_progress",
  entry: { op: "always" },
  outputFields: ["verification", "summary"],
  effort: "high",
  acceptance: [
    { kind: "command", description: "Build", cmd: "bun run build" },
    { kind: "command", description: "Tests", cmd: "bun test" },
    { kind: "projectGate", description: "Project gate evidence" },
  ],
};

describe("adaptive wake timeout", () => {
  test("derives timeout from deterministic wake work units rather than a fixed default", () => {
    const simple = estimateWakeTimeout({
      task,
      workflow,
      stage: simpleStage,
      workerToolNames: [],
      commandToolNames: ["set_field", "request_transition"],
      team: [],
      effort: "medium",
    });
    const verify = estimateWakeTimeout({
      task,
      workflow,
      stage: verifyStage,
      workerToolNames: ["bash", "readFile"],
      commandToolNames: ["set_field", "submit_evidence", "request_transition"],
      team: [
        { id: "child-a", workflowId: "development", status: "in_progress", request: "run verification" },
        { id: "child-b", workflowId: "development", status: "done", summary: "passed" },
      ],
      effort: "high",
    });

    expect(simple.timeoutMs).not.toBe(90_000);
    expect(verify.timeoutMs).toBeGreaterThan(simple.timeoutMs);
    expect(verify.components.map((component) => component.name)).toEqual(
      expect.arrayContaining(["agentTurn", "promptUnits", "outputFields", "toolSurface", "acceptance", "team"]),
    );
    expect(verify.components.find((component) => component.name === "acceptance")?.ms).toBe(540_000);
  });

  test("applies effort multiplier to the raw component sum before clamping", () => {
    const medium = estimateWakeTimeout({
      task,
      workflow,
      stage: verifyStage,
      workerToolNames: ["bash"],
      commandToolNames: ["set_field", "submit_evidence", "request_transition"],
      team: [],
      effort: "medium",
    });
    const high = estimateWakeTimeout({
      task,
      workflow,
      stage: verifyStage,
      workerToolNames: ["bash"],
      commandToolNames: ["set_field", "submit_evidence", "request_transition"],
      team: [],
      effort: "high",
    });

    expect(high.rawMs).toBeGreaterThan(medium.rawMs);
    expect(high.effort).toBe("high");
  });

  test("clamps large wake budgets to the watchdog maximum", () => {
    const huge = estimateWakeTimeout({
      task,
      workflow,
      stage: verifyStage,
      workerToolNames: ["bash"],
      commandToolNames: ["set_field", "submit_evidence", "request_transition"],
      team: [],
      projectMemory: "x".repeat(2_000_000),
      effort: "max",
    });

    expect(huge.rawMs).toBeGreaterThan(huge.maxMs);
    expect(huge.timeoutMs).toBe(huge.maxMs);
  });
});
