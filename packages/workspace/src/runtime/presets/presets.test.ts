import { describe, expect, test } from "bun:test";
import { defineTool, type ToolSet } from "agent-loop";
import type { TaskProjection } from "../../coordination";
import {
  createFinalVerificationPreset,
  createPlanningPreset,
  createStageExecutionPreset,
  createStageVerificationPreset,
} from "./index";

const tool = (name: string) =>
  ({
    [name]: defineTool({
      description: name,
      execute: () => ({ ok: true }),
    }),
  }) satisfies ToolSet;

const projection: TaskProjection = {
  taskId: "task_1",
  workspaceId: "sikong",
  request: "Implement the worker preset model.",
  status: "running",
  plan: {
    id: "plan_1",
    version: 1,
    stages: [
      {
        id: "stage_1",
        title: "Implement",
        objective: "Refactor runtime into presets.",
        acceptance: ["Planner preset is a wrapper.", "Verifier preset only evaluates."],
      },
    ],
  },
  currentStageId: "stage_1",
  acceptedStageIds: ["stage_1"],
  activeRoundId: "round_1",
  stageRounds: {
    round_1: {
      id: "round_1",
      stageId: "stage_1",
      status: "planned",
      intent: "Implement runtime preset work.",
      workUnits: [
        {
          id: "work_unit_1",
          title: "Runtime preset work",
          objective: "Refactor runtime into presets.",
        },
      ],
    },
  },
  workerRuns: {
    run_1: {
      runId: "run_1",
      stageId: "stage_1",
      roundId: "round_1",
      workUnitId: "work_unit_1",
      status: "completed",
      result: { summary: "Runtime presets implemented." },
    },
  },
  stageReviews: {},
  finalReview: { reviewId: "final_1", status: "started" },
  eventCount: 1,
};

describe("worker preset wrappers", () => {
  test("planning preset combines inspection tools with submit-plan protocol tools", () => {
    const preset = createPlanningPreset({
      projection: { ...projection, status: "planning" },
      requirementSpec: "Keep planner as a preset wrapper.",
      workspacePreferences: ["Use bun run check."],
      inspectionTools: tool("read_file"),
      protocolTools: tool("submit_plan"),
    });

    expect(preset).toMatchObject({
      workspaceId: "sikong",
      taskId: "task_1",
      tools: {
        read_file: expect.any(Object),
        submit_plan: expect.any(Object),
      },
    });
    expect(preset.prompt).toContain("Lead requirement spec:");
    expect(preset.prompt).toContain("Submit the final plan only through");
  });

  test("stage execution preset uses the current stage and the generic worker task input", () => {
    const preset = createStageExecutionPreset({
      projection,
      roundId: "round_1",
      workUnitId: "work_unit_1",
      baseTaskInput: { loop: fakeLoop },
      executionTools: tool("edit_file"),
    });

    expect(preset).toMatchObject({
      taskId: "task_1",
      roundId: "round_1",
      workUnitId: "work_unit_1",
      taskInput: {
        tools: { edit_file: expect.any(Object) },
      },
    });
    expect(preset.goal).toContain("Stage: Implement");
    expect(preset.goal).toContain("- Planner preset is a wrapper.");
  });

  test("verification presets combine inspection tools with review protocol tools", () => {
    const stagePreset = createStageVerificationPreset({
      projection,
      reviewId: "review_1",
      inspectionTools: tool("read_file"),
      protocolTools: tool("accept_stage_review"),
    });
    expect(stagePreset.tools).toMatchObject({
      read_file: expect.any(Object),
      accept_stage_review: expect.any(Object),
    });
    expect(stagePreset.prompt).toContain("Only evaluate and submit a review decision");
    expect(stagePreset.prompt).toContain("run_1 (completed): Runtime presets implemented.");

    const finalPreset = createFinalVerificationPreset({
      projection,
      reviewId: "final_1",
      inspectionTools: tool("run_command"),
      protocolTools: tool("recommend_final_review"),
    });
    expect(finalPreset.tools).toMatchObject({
      run_command: expect.any(Object),
      recommend_final_review: expect.any(Object),
    });
    expect(finalPreset.prompt).toContain("submit a final recommendation");
  });
});

const fakeLoop = () => {
  throw new Error("fake loop is not used by preset construction");
};
