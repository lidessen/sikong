import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileTaskEventStore,
  FileTaskProjectionStore,
  deriveTaskPhase,
  describeRound,
  reduceTaskEvents,
  type PlanDef,
  type TaskEvent,
} from "./index";
import { taskEventsFile, taskEventsLockFile, taskProjectionFile } from "../data-dir";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-coordination-"));

type TestEventInput = {
  type: TaskEvent["type"];
  [key: string]: unknown;
};

const plan: PlanDef = {
  id: "plan_1",
  version: 1,
  summary: "Research, implement, verify.",
  stages: [
    {
      id: "stage_research",
      title: "Research",
      objective: "Understand the current code and constraints.",
      acceptance: ["Relevant files are inspected.", "Constraints are summarized."],
    },
    {
      id: "stage_implement",
      title: "Implement",
      objective: "Apply the requested change.",
      acceptance: ["Code is changed.", "Focused tests pass."],
    },
  ],
};

function event(input: TestEventInput): TaskEvent {
  const index = counter++;
  return {
    id: `event_${index}`,
    taskId: "task_1",
    workspaceId: "sikong",
    createdAt: `2026-06-14T00:00:${String(index).padStart(2, "0")}Z`,
    ...input,
  } as TaskEvent;
}

let counter = 0;

describe("coordination reducer", () => {
  test("projects plan, worker, review, and terminal task state", () => {
    counter = 0;
    const projection = reduceTaskEvents([
      event({
        type: "task.created",
        request: "Refactor workspace engine.",
        runtime: { repoPath: "/repo" },
      }),
      event({ type: "plan.requested", brief: "Keep it small." }),
      event({ type: "plan.submitted", plan }),
      event({ type: "plan.accepted", planId: "plan_1", version: 1, report: "Plan is acceptable." }),
      event({ type: "stage.started", stageId: "stage_research" }),
      event({
        type: "worker_run.started",
        runId: "run_1",
        stageId: "stage_research",
        workerId: "worker_a",
        objective: "Inspect files.",
      }),
      event({
        type: "worker_run.completed",
        runId: "run_1",
        stageId: "stage_research",
        result: { summary: "Research complete.", report: "Found reducer boundary." },
      }),
      event({ type: "stage.review.started", reviewId: "review_1", stageId: "stage_research" }),
      event({
        type: "stage.review.accepted",
        reviewId: "review_1",
        stageId: "stage_research",
        report: "Research criteria satisfied.",
      }),
      event({
        type: "stage.advanced",
        fromStageId: "stage_research",
        toStageId: "stage_implement",
      }),
      event({ type: "final.review.started", reviewId: "final_1" }),
      event({
        type: "final.review.recommended",
        reviewId: "final_1",
        recommendation: "accept",
        report: "Overall task is satisfied.",
      }),
      event({ type: "task.accepted", report: "Accepted by lead." }),
      event({ type: "task.completed", outcome: "accepted", report: "Task closed." }),
    ]);

    expect(projection).toMatchObject({
      taskId: "task_1",
      workspaceId: "sikong",
      request: "Refactor workspace engine.",
      runtime: { repoPath: "/repo" },
      status: "completed",
      plan,
      planDecision: {
        status: "accepted",
        planId: "plan_1",
        version: 1,
        report: "Plan is acceptable.",
      },
      currentStageId: "stage_implement",
      acceptedStageIds: ["stage_research"],
      terminal: {
        outcome: "accepted",
        report: "Task closed.",
      },
      eventCount: 14,
    });
    expect(projection?.workerRuns.run_1).toMatchObject({
      status: "completed",
      workerId: "worker_a",
      result: { summary: "Research complete." },
    });
    expect(projection?.stageReviews.review_1).toMatchObject({
      status: "accepted",
      report: "Research criteria satisfied.",
    });
    expect(projection?.finalReview).toMatchObject({
      status: "recommended",
      recommendation: "accept",
    });
  });

  test("keeps task in planning after plan rejection", () => {
    counter = 0;
    const projection = reduceTaskEvents([
      event({ type: "task.created", request: "Plan this." }),
      event({ type: "plan.requested" }),
      event({ type: "plan.submitted", plan }),
      event({
        type: "plan.rejected",
        planId: "plan_1",
        version: 1,
        report: "Too broad.",
        requestedChanges: "Use fewer stages.",
      }),
    ]);

    expect(projection).toMatchObject({
      status: "planning",
      planDecision: {
        status: "rejected",
        requestedChanges: "Use fewer stages.",
      },
    });
  });

  test("derives a simple execution state machine from projection facts", () => {
    counter = 0;
    const round = {
      id: "round_1",
      stageId: "stage_research",
      intent: "Collect stage evidence.",
      workUnits: [
        {
          id: "work_unit_1",
          title: "Inspect",
          objective: "Inspect relevant files.",
          instructions: ["Inspect only the relevant files."],
          deliverables: ["Inspection summary."],
          outOfScope: ["Implementation."],
        },
        {
          id: "work_unit_2",
          title: "Probe",
          objective: "Probe a risky path.",
          instructions: ["Probe only the risky path."],
          deliverables: ["Probe summary."],
          outOfScope: ["Implementation."],
        },
      ],
    };
    const projection = reduceTaskEvents([
      event({ type: "task.created", request: "Execute a stable round." }),
      event({ type: "plan.requested" }),
      event({ type: "plan.submitted", plan }),
      event({ type: "plan.accepted", planId: "plan_1", version: 1, report: "Plan accepted." }),
      event({ type: "stage.started", stageId: "stage_research" }),
      event({ type: "stage_round.planned", round }),
      event({
        type: "worker_run.started",
        runId: "run_1",
        stageId: "stage_research",
        roundId: "round_1",
        workUnitId: "work_unit_1",
      }),
      event({
        type: "worker_run.completed",
        runId: "run_1",
        stageId: "stage_research",
        result: { summary: "Inspection complete." },
      }),
      event({
        type: "worker_run.started",
        runId: "run_2",
        stageId: "stage_research",
        roundId: "round_1",
        workUnitId: "work_unit_2",
      }),
      event({
        type: "worker_run.failed",
        runId: "run_2",
        stageId: "stage_research",
        result: { summary: "Probe failed.", report: "Probe failed." },
      }),
    ]);

    if (!projection) throw new Error("projection missing");
    expect(deriveTaskPhase(projection)).toBe("executing");
    expect(describeRound(projection, projection.stageRounds.round_1!)).toMatchObject({
      workUnits: 2,
      startedRuns: 2,
      terminalRuns: 2,
      completedRuns: 1,
      failedRuns: 1,
      readyToComplete: true,
    });
  });

  test("rejects events from another task in the same projection", () => {
    counter = 0;
    const events = [
      event({ type: "task.created", request: "One" }),
      {
        ...event({ type: "plan.requested" }),
        taskId: "task_2",
      },
    ];

    expect(() => reduceTaskEvents(events)).toThrow("task event does not belong");
  });
});

describe("coordination stores", () => {
  test("appends JSONL events and rebuilds file-backed projection", async () => {
    counter = 0;
    const dir = await tmp();
    try {
      const eventStore = new FileTaskEventStore(dir);
      const projectionStore = new FileTaskProjectionStore(dir);
      const events = [
        event({ type: "task.created", request: "Store task events." }),
        event({ type: "plan.requested" }),
        event({ type: "plan.submitted", plan }),
      ];

      await eventStore.appendMany(events);

      expect(await eventStore.read("sikong", "task_1")).toEqual(events);
      expect(await readFile(taskEventsFile(dir, "sikong", "task_1"), "utf8")).toContain(
        "plan.submitted",
      );

      const projection = await projectionStore.rebuild("sikong", "task_1", events);
      expect(projection).toMatchObject({
        status: "plan_submitted",
        eventCount: 3,
      });
      expect(await projectionStore.read("sikong", "task_1")).toEqual(projection);
      expect(await readFile(taskProjectionFile(dir, "sikong", "task_1"), "utf8")).toContain(
        "plan_submitted",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not batch append events from different tasks", async () => {
    counter = 0;
    const dir = await tmp();
    try {
      const eventStore = new FileTaskEventStore(dir);
      const first = event({ type: "task.created", request: "One" });
      const second = {
        ...event({ type: "task.created", request: "Two" }),
        taskId: "task_2",
      };

      await expect(eventStore.appendMany([first, second])).rejects.toThrow(
        "cannot append events for multiple tasks",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serializes concurrent same-task append and projection rebuilds", async () => {
    counter = 0;
    const dir = await tmp();
    try {
      const eventStore = new FileTaskEventStore(dir);
      await eventStore.appendManyAndRebuildProjection([
        event({ type: "task.created", request: "Coordinate concurrent workers." }),
        event({ type: "plan.requested" }),
      ]);

      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          eventStore.appendManyAndRebuildProjection([
            event({
              type: "worker_run.completed",
              runId: `run_${index}`,
              stageId: "stage_1",
              result: { summary: `Worker ${index} complete.` },
            }),
          ]),
        ),
      );

      const events = await eventStore.read("sikong", "task_1");
      expect(events).toHaveLength(10);

      const projection = await new FileTaskProjectionStore(dir).read("sikong", "task_1");
      expect(projection).toMatchObject({
        taskId: "task_1",
        eventCount: 10,
      });
      expect(Object.keys(projection?.workerRuns ?? {})).toHaveLength(8);
      await expect(access(taskEventsLockFile(dir, "sikong", "task_1"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
