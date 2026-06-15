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
  type CommandResult,
} from "../commands";
import type { TaskProjection } from "../coordination";
import { runProcess } from "../process";
import {
  createOrchestrationProcessSpec,
  executeOrchestrationAction,
  executeOrchestrationActionProcess,
  planNextOrchestrationAction,
  runOrchestrationUntilWait,
  runOrchestrationRunner,
  startOrchestrationProcess,
  toSerializableOrchestrationAction,
  type OrchestrationAction,
  type OrchestrationInput,
  type OrchestrationExecutionResult,
  type OrchestrationExecutionRuntime,
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

  test("starts parallel stage workers up to workerCount before review", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Run parallel workers.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const submitted = await submitPlan(context, {
        taskId: created.data.taskId,
        stages: [
          {
            title: "Implement",
            objective: "Use two workers for the same stage.",
            acceptance: ["Both worker results are present."],
            workerCount: 2,
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

      expect(next(accepted.data.projection)).toMatchObject({
        type: "start_stage_worker",
      });
      const first = await startWorkerRun(context, { taskId: created.data.taskId });
      if (!first.ok) throw new Error("first worker start failed");
      const afterFirstStart = await getTask(context, { taskId: created.data.taskId });
      if (!afterFirstStart.ok) throw new Error("task get failed");
      expect(next(afterFirstStart.data.projection)).toMatchObject({
        type: "start_stage_worker",
      });

      const second = await startWorkerRun(context, { taskId: created.data.taskId });
      if (!second.ok) throw new Error("second worker start failed");
      const afterSecondStart = await getTask(context, { taskId: created.data.taskId });
      if (!afterSecondStart.ok) throw new Error("task get failed");
      expect(next(afterSecondStart.data.projection)).toMatchObject({
        type: "await_worker_results",
        runningRuns: 2,
        targetRuns: 2,
      });

      const firstDone = await completeWorkerRun(context, {
        taskId: created.data.taskId,
        runId: first.data.runId,
        summary: "First worker done.",
      });
      if (!firstDone.ok) throw new Error("first worker complete failed");
      expect(next(firstDone.data.projection)).toMatchObject({
        type: "await_worker_results",
        runningRuns: 1,
        targetRuns: 2,
      });

      const secondDone = await completeWorkerRun(context, {
        taskId: created.data.taskId,
        runId: second.data.runId,
        summary: "Second worker done.",
      });
      if (!secondDone.ok) throw new Error("second worker complete failed");
      expect(next(secondDone.data.projection)).toMatchObject({
        type: "start_stage_review",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("orchestration subprocess runner", () => {
  test("uses runtimeAssembly config without an external runtime module", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Plan through runtime assembly.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");

      const requestPath = join(dir, "orchestration-request.json");
      await writeFile(
        requestPath,
        JSON.stringify({
          context: { dataDir: dir, workspaceId: "sikong" },
          action: toSerializableOrchestrationAction(next(created.data.projection)),
          runtimeAssembly: {
            backend: {
              name: "mock",
              options: {
                callTool: {
                  name: "submit_plan",
                  args: {
                    stages: [
                      {
                        title: "Implement",
                        objective: "Complete through runtime assembly.",
                        acceptance: ["Plan is submitted."],
                      },
                    ],
                  },
                },
              },
            },
            toolProfiles: {
              planningProtocol: "sikong-planning-protocol",
            },
          },
        }),
      );
      const requestText = await Bun.file(requestPath).text();
      expect(keysOf(JSON.parse(requestText))).not.toContain("tools");
      expect(keysOf(JSON.parse(requestText))).not.toContain("role");
      expect(keysOf(JSON.parse(requestText))).not.toContain("kind");

      const output = await runOrchestrationRunner(["--spec", requestPath]);
      expect(output).toMatchObject({
        ok: true,
        data: {
          resultType: "loop_completed",
          actionType: "start_planning_worker",
        },
      });

      const fresh = await getTask(context, { taskId: created.data.taskId });
      if (!fresh.ok) throw new Error("task get failed");
      expect(fresh.data.projection.status).toBe("plan_submitted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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

describe("orchestration process executor", () => {
  test("executes one action through a daemon process client", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Execute through process client.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const action = next(created.data.projection);
      if (action.type !== "start_planning_worker") throw new Error("expected planning action");

      let requestJson: unknown;
      const startedSpecs: unknown[] = [];
      const result = await executeOrchestrationActionProcess({
        ctx: context,
        action,
        runId: "run_process_action",
        packageCwd: join(import.meta.dir, "../.."),
        runtimeAssembly: {
          backend: "mock",
          toolProfiles: { planningProtocol: "sikong-planning-protocol" },
        },
        client: {
          async startProcess(spec) {
            startedSpecs.push(spec);
            const requestPath = spec.args?.[2];
            if (!requestPath) throw new Error("request path missing");
            requestJson = JSON.parse(await Bun.file(requestPath).text());
            return {
              runId: spec.runId,
              workspaceId: spec.workspaceId,
              taskId: spec.taskId,
              state: "running",
              spec,
              startedAt: "2026-06-14T00:00:00Z",
            };
          },
          async waitProcessRun(runId) {
            return {
              runId,
              workspaceId: "sikong",
              taskId: created.data.taskId,
              state: "finished",
              spec: startedSpecs[0] as never,
              startedAt: "2026-06-14T00:00:00Z",
              finishedAt: "2026-06-14T00:00:01Z",
              result: {
                runId,
                workspaceId: "sikong",
                taskId: created.data.taskId,
                status: "succeeded",
                command: "bun",
                args: [],
                stdout:
                  JSON.stringify({
                    ok: true,
                    data: {
                      resultType: "loop_completed",
                      actionType: "start_planning_worker",
                      loopResult: { status: "completed" },
                    },
                  }) + "\n",
                stderr: "",
                exitCode: 0,
                startedAt: "2026-06-14T00:00:00Z",
                finishedAt: "2026-06-14T00:00:01Z",
                durationMs: 1,
              },
            };
          },
        },
      });

      expect(result).toMatchObject({
        ok: true,
        data: { resultType: "loop_completed", actionType: "start_planning_worker" },
      });
      expect(startedSpecs).toHaveLength(1);
      expect(startedSpecs[0]).toMatchObject({
        runId: "run_process_action",
        workspaceId: "sikong",
        taskId: created.data.taskId,
        command: "bun",
        cwd: join(import.meta.dir, "../.."),
      });
      expect(requestJson).toMatchObject({
        context: { dataDir: dir, workspaceId: "sikong" },
        action: { type: "start_planning_worker" },
        runtimeAssembly: {
          backend: "mock",
          toolProfiles: { planningProtocol: "sikong-planning-protocol" },
        },
      });
      expect(keysOf(requestJson)).not.toContain("tools");
      expect(keysOf(requestJson)).not.toContain("role");
      expect(keysOf(requestJson)).not.toContain("kind");
      const fresh = await getTask(context, { taskId: created.data.taskId });
      if (!fresh.ok) throw new Error("task get failed");
      expect(fresh.data.projection.runtimeProcessRuns).toMatchObject({
        run_process_action: {
          processRunId: "run_process_action",
          actionType: "start_planning_worker",
          status: "finished",
          processStatus: "succeeded",
          exitCode: 0,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks active stage worker failed when its process times out", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Execute stage through process client.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const submitted = await submitPlan(context, {
        taskId: created.data.taskId,
        stages: [
          {
            title: "Implement",
            objective: "Start then time out.",
            acceptance: ["The worker failure is durable."],
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
      let specSnapshot: unknown;
      let workerRunId = "";
      const result = await executeOrchestrationActionProcess({
        ctx: context,
        action,
        runId: "run_process_timeout",
        packageCwd: join(import.meta.dir, "../.."),
        runtimeAssembly: { backend: "mock" },
        client: {
          async startProcess(spec) {
            specSnapshot = spec;
            return {
              runId: spec.runId,
              workspaceId: spec.workspaceId,
              taskId: spec.taskId,
              state: "running",
              spec,
              startedAt: "2026-06-14T00:00:00Z",
            };
          },
          async waitProcessRun(runId) {
            const started = await startWorkerRun(context, {
              workspaceId: "sikong",
              taskId: created.data.taskId,
              stageId: action.input.stageId,
            });
            if (!started.ok) throw new Error("worker start failed");
            workerRunId = started.data.runId;
            return {
              runId,
              workspaceId: "sikong",
              taskId: created.data.taskId,
              state: "finished",
              spec: specSnapshot as never,
              startedAt: "2026-06-14T00:00:00Z",
              finishedAt: "2026-06-14T00:02:00Z",
              result: {
                runId,
                workspaceId: "sikong",
                taskId: created.data.taskId,
                status: "timed_out",
                command: "bun",
                args: [],
                stdout: "",
                stderr: "",
                exitCode: 143,
                startedAt: "2026-06-14T00:00:00Z",
                finishedAt: "2026-06-14T00:02:00Z",
                durationMs: 120_000,
                timedOut: true,
              },
            };
          },
        },
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "internal_error" },
      });
      const fresh = await getTask(context, { taskId: created.data.taskId });
      if (!fresh.ok) throw new Error("task get failed");
      expect(fresh.data.projection.workerRuns[workerRunId]).toMatchObject({
        status: "failed",
        result: { report: expect.stringContaining("timed_out") },
      });
      expect(fresh.data.projection.runtimeProcessRuns).toMatchObject({
        run_process_timeout: {
          processStatus: "timed_out",
          exitCode: 143,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("orchestration driver", () => {
  test("runs non-lead actions until plan decision is required", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Drive planning to lead decision.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");

      const driven = await runOrchestrationUntilWait({
        ctx: context,
        taskId: created.data.taskId,
        buildInput: input,
        executeAction: async (runCtx, action, runtime) => {
          if (action.type === "start_planning_worker") {
            const submitted = await submitPlan(runCtx, {
              taskId: action.spec.taskId,
              stages: [
                {
                  title: "Implement",
                  objective: "Drive to plan submitted.",
                  acceptance: ["Plan decision is required."],
                },
              ],
            });
            if (!submitted.ok) return submitted;
            return loopCompleted(action.type);
          }
          return await executeOrchestrationAction(runCtx, action, runtime);
        },
      });

      expect(driven).toMatchObject({
        ok: true,
        data: {
          stopReason: "waiting",
          projection: { status: "plan_submitted" },
          steps: [
            { action: { type: "start_planning_worker" } },
            { action: { type: "await_plan_decision" } },
          ],
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs stage execution and reviews until final lead decision is required", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Drive stage to final decision.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const submitted = await submitPlan(context, {
        taskId: created.data.taskId,
        stages: [
          {
            title: "Implement",
            objective: "Complete the driven stage.",
            acceptance: ["Final recommendation exists."],
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

      const driven = await runOrchestrationUntilWait({
        ctx: context,
        taskId: created.data.taskId,
        buildInput: input,
        runtime: {
          runTask: async (taskInput: TaskInput) => ({
            status: "completed",
            rounds: 1,
            report: `Completed ${taskInput.goal}`,
            timeline: [],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }),
        },
        executeAction: async (runCtx, action, runtime) =>
          await executeDrivenStage(runCtx, action, runtime),
      });

      expect(driven).toMatchObject({
        ok: true,
        data: {
          stopReason: "waiting",
          projection: {
            status: "reviewing",
            finalReview: { status: "recommended", recommendation: "accept" },
          },
          steps: [
            { action: { type: "start_stage_worker" } },
            { action: { type: "start_stage_review" } },
            { action: { type: "start_stage_verification_worker" } },
            { action: { type: "start_final_verification_worker" } },
            { action: { type: "await_final_decision" } },
          ],
        },
      });
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

async function executeDrivenStage(
  runCtx: CommandContext,
  action: OrchestrationAction,
  runtime: OrchestrationExecutionRuntime,
): Promise<CommandResult<OrchestrationExecutionResult>> {
  if (action.type === "start_stage_verification_worker") {
    const accepted = await acceptStageReview(runCtx, {
      taskId: action.spec.taskId,
      reviewId: action.reviewId,
      report: "Stage accepted.",
    });
    if (!accepted.ok) return accepted;
    return loopCompleted(action.type);
  }

  if (action.type === "start_final_verification_worker") {
    const recommended = await recommendFinalReview(runCtx, {
      taskId: action.spec.taskId,
      reviewId: action.reviewId,
      recommendation: "accept",
      report: "Final result is acceptable.",
    });
    if (!recommended.ok) return recommended;
    return loopCompleted(action.type);
  }

  return await executeOrchestrationAction(runCtx, action, runtime);
}

function loopCompleted(
  actionType:
    | "start_planning_worker"
    | "start_stage_verification_worker"
    | "start_final_verification_worker",
): CommandResult<OrchestrationExecutionResult> {
  return {
    ok: true,
    data: {
      resultType: "loop_completed",
      actionType,
      loopResult: { status: "completed" },
    },
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
