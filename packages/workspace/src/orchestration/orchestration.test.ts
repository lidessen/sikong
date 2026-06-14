import { describe, expect, test } from "bun:test";
import { defineTool, type AgentLoop, type TaskInput, type ToolSet } from "agent-loop";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptPlan,
  acceptStageReview,
  completeWorkerRun,
  createTask,
  createWorkspace,
  getTask,
  recommendFinalReview,
  startStageReview,
  startWorkerRun,
  submitPlan,
  type CommandContext,
} from "../commands";
import type { TaskProjection } from "../coordination";
import { runProcess } from "../process";
import {
  createOrchestrationProcessSpec,
  executeOrchestrationAction,
  planNextOrchestrationAction,
  startOrchestrationProcess,
  toSerializableOrchestrationAction,
  type OrchestrationInput,
} from "./index";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-orchestration-"));

function ctx(dataDir: string): CommandContext {
  let id = 0;
  return {
    dataDir,
    workspaceId: "sikong",
    now: () => new Date("2026-06-14T00:00:00.000Z"),
    id: () => `id_${++id}`,
  };
}

const tool = (name: string) =>
  ({
    [name]: defineTool({
      description: name,
      execute: () => ({ ok: true }),
    }),
  }) satisfies ToolSet;

describe("orchestration tick", () => {
  test("plans the next preset action without encoding agent roles", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Implement preset orchestration.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const taskId = created.data.taskId;

      expect(next(created.data.projection)).toMatchObject({
        type: "start_planning_worker",
        spec: {
          taskId,
          tools: { submit_plan: expect.any(Object), read_file: expect.any(Object) },
        },
      });
      expect(
        keysOf(toSerializableOrchestrationAction(next(created.data.projection))),
      ).not.toContain("tools");
      expect(
        keysOf(toSerializableOrchestrationAction(next(created.data.projection))),
      ).not.toContain("skills");
      expect(
        keysOf(toSerializableOrchestrationAction(next(created.data.projection))),
      ).not.toContain("mcp");

      const submitted = await submitPlan(context, {
        taskId,
        stages: [
          {
            title: "Implement",
            objective: "Add preset orchestration.",
            acceptance: ["Preset wrappers exist."],
          },
        ],
      });
      if (!submitted.ok) throw new Error("plan submit failed");
      expect(next(submitted.data.projection)).toMatchObject({
        type: "await_plan_decision",
        planId: submitted.data.plan.id,
      });

      const accepted = await acceptPlan(context, {
        taskId,
        planId: submitted.data.plan.id,
        version: submitted.data.plan.version,
        report: "Accepted.",
      });
      if (!accepted.ok) throw new Error("plan accept failed");
      expect(next(accepted.data.projection)).toMatchObject({
        type: "start_stage_worker",
        input: { stageId: expect.stringMatching(/^stage_/) },
      });

      const started = await startWorkerRun(context, { taskId });
      if (!started.ok) throw new Error("worker start failed");
      const completed = await completeWorkerRun(context, {
        taskId,
        runId: started.data.runId,
        summary: "Stage worker completed.",
      });
      if (!completed.ok) throw new Error("worker complete failed");
      expect(next(completed.data.projection)).toMatchObject({
        type: "start_stage_review",
      });

      const review = await startStageReview(context, { taskId });
      if (!review.ok) throw new Error("stage review start failed");
      expect(next(review.data.projection)).toMatchObject({
        type: "start_stage_verification_worker",
        reviewId: review.data.reviewId,
      });

      const stageAccepted = await acceptStageReview(context, {
        taskId,
        reviewId: review.data.reviewId,
        report: "Stage accepted.",
      });
      if (!stageAccepted.ok) throw new Error("stage accept failed");
      expect(next(stageAccepted.data.projection)).toMatchObject({
        type: "start_final_verification_worker",
        reviewId: expect.stringMatching(/^final_review_/),
      });

      const fresh = await getTask(context, { taskId });
      if (!fresh.ok) throw new Error("task get failed");
      const finalReviewId = fresh.data.projection.finalReview?.reviewId;
      if (!finalReviewId) throw new Error("final review missing");
      const recommended = await recommendFinalReview(context, {
        taskId,
        reviewId: finalReviewId,
        recommendation: "accept",
        report: "Final result is acceptable.",
      });
      if (!recommended.ok) throw new Error("final recommend failed");
      expect(next(recommended.data.projection)).toMatchObject({
        type: "await_final_decision",
        recommendation: "accept",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("orchestration subprocess runner", () => {
  test("executes a stage worker through a daemon process spec boundary", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Run worker in subprocess.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const submitted = await submitPlan(context, {
        taskId: created.data.taskId,
        stages: [
          {
            title: "Implement",
            objective: "Complete via subprocess.",
            acceptance: ["Worker terminal event is recorded."],
          },
        ],
      });
      if (!submitted.ok) throw new Error("plan submit failed");
      const accepted = await acceptPlan(context, {
        taskId: created.data.taskId,
        planId: submitted.data.plan.id,
        version: submitted.data.plan.version,
        report: "Accepted.",
      });
      if (!accepted.ok) throw new Error("plan accept failed");

      const action = next(accepted.data.projection);
      if (action.type !== "start_stage_worker") throw new Error("expected stage worker action");

      const runtimeModule = join(dir, "runtime.mjs");
      await writeFile(
        runtimeModule,
        [
          "export function createOrchestrationExecutionRuntime() {",
          "  return {",
          "    runTask: async (input) => ({",
          "      status: 'completed',",
          "      rounds: 1,",
          "      report: `subprocess completed ${input.goal}`,",
          "      timeline: [],",
          "      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },",
          "    }),",
          "  };",
          "}",
        ].join("\n"),
      );

      const requestPath = join(dir, "orchestration-request.json");
      await writeFile(
        requestPath,
        JSON.stringify({
          context: { dataDir: dir, workspaceId: "sikong" },
          action: toSerializableOrchestrationAction(action),
          runtimeModule,
        }),
      );
      const requestText = await Bun.file(requestPath).text();
      expect(keysOf(JSON.parse(requestText))).not.toContain("tools");
      expect(keysOf(JSON.parse(requestText))).not.toContain("skills");
      expect(keysOf(JSON.parse(requestText))).not.toContain("mcp");

      const spec = createOrchestrationProcessSpec({
        runId: "run_orchestration_subprocess",
        workspaceId: "sikong",
        taskId: created.data.taskId,
        requestPath,
        cwd: join(import.meta.dir, "../.."),
      });
      expect(spec).toMatchObject({
        command: "bun",
        args: ["./src/orchestration/runner.ts", "--spec", requestPath],
      });
      expect(JSON.stringify(spec)).not.toContain("role");
      expect(JSON.stringify(spec)).not.toContain("kind");

      const started = await startOrchestrationProcess(
        {
          startProcess: async (processSpec) => ({
            runId: processSpec.runId,
            workspaceId: processSpec.workspaceId,
            taskId: processSpec.taskId,
            state: "running",
            spec: processSpec,
            startedAt: "2026-06-14T00:00:00Z",
          }),
        },
        {
          runId: "run_orchestration_daemon",
          workspaceId: "sikong",
          taskId: created.data.taskId,
          requestPath,
          cwd: join(import.meta.dir, "../.."),
        },
      );
      expect(started).toMatchObject({
        state: "running",
        spec: { args: ["./src/orchestration/runner.ts", "--spec", requestPath] },
      });

      const processResult = await runProcess(spec);
      expect(processResult).toMatchObject({
        status: "succeeded",
        exitCode: 0,
        stderr: "",
      });
      const output = JSON.parse(processResult.stdout);
      expect(output).toMatchObject({
        ok: true,
        data: {
          resultType: "worker_task_completed",
          run: {
            taskResult: {
              status: "completed",
              report: expect.stringContaining("subprocess completed"),
            },
          },
        },
      });

      const fresh = await getTask(context, { taskId: created.data.taskId });
      if (!fresh.ok) throw new Error("task get failed");
      expect(Object.values(fresh.data.projection.workerRuns)).toContainEqual(
        expect.objectContaining({ status: "completed" }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("orchestration action executor", () => {
  test("runs loop-backed actions without mutating lead decision points", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Plan executor wiring.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");

      const loopResults: unknown[] = [];
      const loop = {
        run(input: unknown) {
          loopResults.push(input);
          return { result: Promise.resolve({ text: "submitted through tool" }) };
        },
      } as AgentLoop;

      const planning = next(created.data.projection);
      expect(planning.type).toBe("start_planning_worker");
      const executed = await executeOrchestrationAction(context, planning, { loop });
      expect(executed).toMatchObject({
        ok: true,
        data: { resultType: "loop_completed", actionType: "start_planning_worker" },
      });
      expect(loopResults).toHaveLength(1);

      const submitted = await submitPlan(context, {
        taskId: created.data.taskId,
        stages: [
          {
            title: "Implement",
            objective: "Wire executor.",
            acceptance: ["Executor returns wait state."],
          },
        ],
      });
      if (!submitted.ok) throw new Error("plan submit failed");
      const wait = await executeOrchestrationAction(context, next(submitted.data.projection), {});
      expect(wait).toMatchObject({
        ok: true,
        data: {
          resultType: "waiting",
          waitFor: "plan_decision",
          planId: submitted.data.plan.id,
          version: submitted.data.plan.version,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("executes stage worker and starts review through command handlers", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Execute one stage.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const submitted = await submitPlan(context, {
        taskId: created.data.taskId,
        stages: [
          {
            title: "Implement",
            objective: "Complete the stage.",
            acceptance: ["A terminal worker result exists."],
          },
        ],
      });
      if (!submitted.ok) throw new Error("plan submit failed");
      const accepted = await acceptPlan(context, {
        taskId: created.data.taskId,
        planId: submitted.data.plan.id,
        version: submitted.data.plan.version,
        report: "Accepted.",
      });
      if (!accepted.ok) throw new Error("plan accept failed");

      const workerAction = next(accepted.data.projection);
      expect(workerAction.type).toBe("start_stage_worker");
      const workerResult = await executeOrchestrationAction(context, workerAction, {
        runTask: async (input: TaskInput) => ({
          status: "completed",
          rounds: 1,
          report: `Completed ${input.goal}`,
          timeline: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
      });
      if (!workerResult.ok || workerResult.data.resultType !== "worker_task_completed") {
        throw new Error("worker action did not complete");
      }
      expect(workerResult.data.run.taskResult.status).toBe("completed");

      const reviewAction = next(workerResult.data.projection);
      expect(reviewAction.type).toBe("start_stage_review");
      const reviewResult = await executeOrchestrationAction(context, reviewAction, {});
      expect(reviewResult).toMatchObject({
        ok: true,
        data: {
          resultType: "stage_review_started",
          reviewId: expect.stringMatching(/^review_/),
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function next(projection: TaskProjection) {
  return planNextOrchestrationAction(input(projection));
}

function input(projection: TaskProjection): OrchestrationInput {
  return {
    projection,
    tools: {
      planningProtocolTools: tool("submit_plan"),
      stageReviewProtocolTools: tool("accept_stage_review"),
      finalReviewProtocolTools: tool("recommend_final_review"),
      inspectionTools: tool("read_file"),
      executionTools: tool("edit_file"),
    },
    workerTaskInput: { loop: fakeLoop },
  };
}

function keysOf(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const keys: string[] = [];
  const stack = [value as Record<string, unknown>];
  for (const item of stack) {
    for (const [key, child] of Object.entries(item)) {
      keys.push(key);
      if (child && typeof child === "object") stack.push(child as Record<string, unknown>);
    }
  }
  return keys;
}

const fakeLoop = () => {
  throw new Error("fake loop is not used by orchestration planning");
};
