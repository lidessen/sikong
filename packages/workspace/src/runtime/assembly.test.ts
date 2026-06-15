import { describe, expect, test } from "bun:test";
import { defineTool, mockLoop } from "agent-loop";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptPlan,
  completeWorkerRun,
  createTask,
  createWorkspace,
  getTask,
  planStageRound,
  startStageReview,
  startWorkerRun,
  submitRequirementSpec,
  type CommandContext,
} from "../commands";
import {
  RuntimeAssemblyRegistry,
  createDefaultRuntimeAssemblyRegistry,
  createRuntimeAssembly,
  createRuntimeAssemblyModule,
} from "./index";
import type { OrchestrationRunnerRequest } from "../orchestration";
import type { OrchestrationAction } from "../orchestration";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-runtime-assembly-"));

function ctx(dataDir: string): CommandContext {
  let id = 0;
  return {
    dataDir,
    workspaceId: "sikong",
    now: () => new Date("2026-06-14T00:00:00.000Z"),
    id: () => `id_${++id}`,
  };
}

describe("runtime assembly registry", () => {
  test("creates execution runtime from a named backend", async () => {
    const runtime = await createRuntimeAssembly({
      backend: { name: "mock", options: { response: "assembled" } },
    });

    if (!runtime.loop) throw new Error("loop missing");
    const result = await runtime.loop.run("hello").result;
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  test("creates provider-backed runtimes from assembly options", async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-key";
    try {
      const runtime = await createRuntimeAssembly({
        backend: {
          name: "claude-code",
          options: { provider: "deepseek", model: "deepseek-v4-flash" },
        },
      });

      expect(runtime.loop?.id).toBe("claude-code");
    } finally {
      if (previous === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = previous;
      }
    }
  });

  test("hydrates loop and task actions with named tool profiles", async () => {
    const registry = createDefaultRuntimeAssemblyRegistry()
      .registerToolProfile("inspection", () => tool("read_file"))
      .registerToolProfile("planning-protocol", () => tool("submit_plan"))
      .registerToolProfile("execution", () => tool("edit_file"));

    const planned = await registry.hydrateAction(
      {
        type: "start_planning_worker",
        spec: {
          workspaceId: "sikong",
          taskId: "task_1",
          prompt: "Plan.",
        },
      },
      {
        toolProfiles: {
          inspection: "inspection",
          planningProtocol: "planning-protocol",
        },
      },
    );
    expect(planned).toMatchObject({
      type: "start_planning_worker",
      spec: {
        tools: {
          read_file: expect.any(Object),
          submit_plan: expect.any(Object),
        },
      },
    });

    const stageWorker = await registry.hydrateAction(
      {
        type: "start_stage_worker",
        input: {
          workspaceId: "sikong",
          taskId: "task_1",
          roundId: "round_1",
          workUnitId: "work_unit_1",
          taskInput: {},
        },
      } as OrchestrationAction,
      { toolProfiles: { execution: "execution" } },
    );
    expect(stageWorker).toMatchObject({
      type: "start_stage_worker",
      input: { taskInput: { tools: { edit_file: expect.any(Object) } } },
    });
  });

  test("default protocol profiles submit durable task decisions", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Exercise protocol profiles.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const spec = await submitRequirementSpec(context, {
        taskId: created.data.taskId,
        summary: "Submit durable task decisions.",
      });
      if (!spec.ok) throw new Error("requirement spec submit failed");

      const planningModule = createRuntimeAssemblyModule({
        toolProfiles: { planningProtocol: "sikong-planning-protocol" },
      });
      const planningAction = await planningModule.hydrateOrchestrationAction?.({
        context: { dataDir: dir, workspaceId: "sikong" },
        action: {
          type: "start_planning_worker",
          spec: {
            workspaceId: "sikong",
            taskId: created.data.taskId,
            prompt: "Plan.",
          },
        },
      });
      if (planningAction?.type !== "start_planning_worker") {
        throw new Error("planning action not hydrated");
      }
      const submit = planningAction.spec.tools?.submit_plan?.execute;
      if (!submit) throw new Error("submit_plan missing");
      const submitted = await submit(
        {
          summary: "One stage.",
          stages: [
            {
              title: "Implement",
              objective: "Complete the task.",
              acceptance: ["Task is complete."],
            },
          ],
        },
        {},
      );
      expect(submitted).toMatchObject({ ok: true });

      const plan = await getTask(context, { taskId: created.data.taskId });
      if (!plan.ok || !plan.data.projection.plan) throw new Error("plan missing");
      const accepted = await acceptPlan(context, {
        taskId: created.data.taskId,
        planId: plan.data.projection.plan.id,
        version: plan.data.projection.plan.version,
        report: "Accepted.",
      });
      if (!accepted.ok) throw new Error("plan accept failed");
      const round = await planStageRound(context, {
        taskId: created.data.taskId,
        stageId: accepted.data.projection.currentStageId ?? "",
        intent: "Execute runtime assembly test work.",
        workUnits: [{ title: "Work", objective: "Complete assembly test work." }],
      });
      if (!round.ok) throw new Error("round plan failed");
      const started = await startWorkerRun(context, {
        taskId: created.data.taskId,
        roundId: round.data.round.id,
        workUnitId: round.data.round.workUnits[0]!.id,
      });
      if (!started.ok) throw new Error("worker start failed");
      const completed = await completeWorkerRun(context, {
        taskId: created.data.taskId,
        runId: started.data.runId,
        summary: "Done.",
      });
      if (!completed.ok) throw new Error("worker complete failed");
      const review = await startStageReview(context, { taskId: created.data.taskId });
      if (!review.ok) throw new Error("stage review start failed");

      const stageReviewModule = createRuntimeAssemblyModule({
        toolProfiles: { stageReviewProtocol: "sikong-stage-review-protocol" },
      });
      const stageReviewAction = await stageReviewModule.hydrateOrchestrationAction?.({
        context: { dataDir: dir, workspaceId: "sikong" },
        action: {
          type: "start_stage_verification_worker",
          reviewId: review.data.reviewId,
          spec: {
            workspaceId: "sikong",
            taskId: created.data.taskId,
            prompt: "Review stage.",
          },
        },
      });
      if (stageReviewAction?.type !== "start_stage_verification_worker") {
        throw new Error("stage review action not hydrated");
      }
      const acceptStage = stageReviewAction.spec.tools?.accept_stage_review?.execute;
      if (!acceptStage) throw new Error("accept_stage_review missing");
      const stageAccepted = await acceptStage({ report: "Stage accepted." }, {});
      expect(stageAccepted).toMatchObject({ ok: true });

      const final = await getTask(context, { taskId: created.data.taskId });
      const finalReviewId = final.ok ? final.data.projection.finalReview?.reviewId : undefined;
      if (!finalReviewId) throw new Error("final review missing");
      const finalReviewModule = createRuntimeAssemblyModule({
        toolProfiles: { finalReviewProtocol: "sikong-final-review-protocol" },
      });
      const finalReviewAction = await finalReviewModule.hydrateOrchestrationAction?.({
        context: { dataDir: dir, workspaceId: "sikong" },
        action: {
          type: "start_final_verification_worker",
          reviewId: finalReviewId,
          spec: {
            workspaceId: "sikong",
            taskId: created.data.taskId,
            prompt: "Review final.",
          },
        },
      });
      if (finalReviewAction?.type !== "start_final_verification_worker") {
        throw new Error("final review action not hydrated");
      }
      const recommend = finalReviewAction.spec.tools?.recommend_final_review?.execute;
      if (!recommend) throw new Error("recommend_final_review missing");
      const recommended = await recommend(
        { recommendation: "accept", report: "Ready to accept." },
        {},
      );
      expect(recommended).toMatchObject({ ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("default AI SDK local tool profiles resolve task runtime cwd", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Hydrate local AI SDK tools.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");

      const planningModule = createRuntimeAssemblyModule({
        toolProfiles: { inspection: "ai-sdk-local-inspection" },
      });
      const planningAction = await planningModule.hydrateOrchestrationAction?.({
        context: { dataDir: dir, workspaceId: "sikong" },
        action: {
          type: "start_planning_worker",
          spec: {
            workspaceId: "sikong",
            taskId: created.data.taskId,
            prompt: "Inspect.",
          },
        },
      });
      if (planningAction?.type !== "start_planning_worker") {
        throw new Error("planning action not hydrated");
      }
      expect(planningAction.spec.tools).toMatchObject({
        readFile: expect.any(Object),
        viewFile: expect.any(Object),
        rg: expect.any(Object),
        web_fetch: expect.any(Object),
      });
      expect(planningAction.spec.tools?.writeFile).toBeUndefined();
      expect(planningAction.spec.tools?.bash).toBeUndefined();

      const executionModule = createRuntimeAssemblyModule({
        toolProfiles: { execution: "ai-sdk-local-execution" },
      });
      const executionAction = await executionModule.hydrateOrchestrationAction?.({
        context: { dataDir: dir, workspaceId: "sikong" },
        action: {
          type: "start_stage_worker",
          input: {
            workspaceId: "sikong",
            taskId: created.data.taskId,
            roundId: "round_1",
            workUnitId: "work_unit_1",
            taskInput: {},
          },
        },
      });
      if (executionAction?.type !== "start_stage_worker") {
        throw new Error("execution action not hydrated");
      }
      expect(executionAction.input.taskInput.tools).toMatchObject({
        bash: expect.any(Object),
        readFile: expect.any(Object),
        writeFile: expect.any(Object),
        replaceInFile: expect.any(Object),
        insertInFile: expect.any(Object),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exposes an orchestration runtime module without role semantics", async () => {
    const registry = new RuntimeAssemblyRegistry()
      .registerBackend("mock", () => mockLoop())
      .registerToolProfile("inspection", () => tool("read_file"));
    const module = createRuntimeAssemblyModule(
      {
        backend: "mock",
        toolProfiles: { inspection: "inspection" },
      },
      registry,
    );
    const request: OrchestrationRunnerRequest = {
      context: { dataDir: "/tmp/sikong", workspaceId: "sikong" },
      action: {
        type: "start_planning_worker",
        spec: { workspaceId: "sikong", taskId: "task_1", prompt: "Plan." },
      },
    };

    const action = await module.hydrateOrchestrationAction?.(request);
    const runtime = await module.createOrchestrationExecutionRuntime?.(request);

    expect(action).toMatchObject({
      type: "start_planning_worker",
      spec: { tools: { read_file: expect.any(Object) } },
    });
    expect(runtime?.loop?.id).toBe("mock");
    expect(JSON.stringify(request)).not.toContain("role");
    expect(JSON.stringify(request)).not.toContain("kind");
  });
});

function tool(name: string) {
  return {
    [name]: defineTool({
      description: name,
      execute: () => ({ ok: true }),
    }),
  };
}
