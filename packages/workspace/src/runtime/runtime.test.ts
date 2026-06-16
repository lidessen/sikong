import { describe, expect, test } from "bun:test";
import {
  defineTool,
  mockLoop,
  type TaskInput,
  type TaskResult as AgentTaskResult,
} from "agent-loop";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptPlan,
  createTask,
  createWorkspace,
  planStageRound,
  inspectTaskDetail,
  submitRequirementSpec,
  submitPlan,
  type CommandContext,
} from "../commands";
import { runWorkerLoop, runWorkerTask } from "./index";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-runtime-"));

function ctx(dataDir: string): CommandContext {
  let id = 0;
  return {
    dataDir,
    workspaceId: "sikong",
    now: () => new Date("2026-06-14T00:00:00.000Z"),
    id: () => `id_${++id}`,
  };
}

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

describe("worker run task bridge", () => {
  test("stops loop-backed protocol runs after a successful protocol tool call", async () => {
    const result = await runWorkerLoop({
      taskId: "task_1",
      prompt: "Submit the plan.",
      loop: mockLoop({ callTool: { name: "submit_plan" } }),
      tools: {
        submit_plan: defineTool({
          execute: async () => ({ ok: true, data: { planId: "plan_1" } }),
        }),
      },
    });

    expect(result.text).toBe("(cancelled)");
  });

  test("records a completed runTask result as a worker terminal event", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      const target = await readyTask(context, dir);
      const seenGoals: string[] = [];

      const result = await runWorkerTask(context, {
        taskId: target.taskId,
        roundId: target.roundId,
        workUnitId: target.workUnitId,
        taskInput: { loop: fakeLoop },
        runTask: async (input: TaskInput): Promise<AgentTaskResult> => {
          seenGoals.push(input.goal);
          await input.hooks?.onRoundStart?.(1, "Use secret token.", "work");
          input.hooks?.onEvent?.(
            { type: "thinking", text: "Inspecting the current files." },
            1,
            "work",
          );
          input.hooks?.onEvent?.(
            {
              type: "tool_call_start",
              name: "readFile",
              callId: "call-1",
              args: { path: "README.md", apiKey: "secret-value" },
            },
            1,
            "work",
          );
          input.hooks?.onEvent?.(
            {
              type: "tool_call_end",
              name: "readFile",
              callId: "call-1",
              result: { text: "content" },
              durationMs: 12,
            },
            1,
            "work",
          );
          await input.hooks?.onRoundEnd?.(1, {
            mode: "work",
            outcome: null,
            report: "Worker completed through runTask.",
          });
          return {
            status: "completed",
            rounds: 1,
            report: "Worker completed through runTask.",
            gateReport: "Gate accepted.",
            result: { ok: true },
            timeline: [],
            usage,
          };
        },
      });

      expect(result).toMatchObject({
        ok: true,
        data: {
          projection: {
            workerRuns: {
              [result.ok ? result.data.runId : "missing"]: {
                status: "completed",
                result: {
                  summary: "Worker completed through runTask.",
                  report: expect.stringContaining("Gate accepted."),
                  observationRef: { runId: result.ok ? result.data.runId : "missing", count: 5 },
                },
              },
            },
          },
        },
      });
      const detail = await inspectTaskDetail(context, { taskId: target.taskId });
      expect(detail).toMatchObject({ ok: true });
      if (!detail.ok) throw new Error("task detail failed");
      expect(detail.data.detail.observations).toEqual([
        expect.objectContaining({
          runId: result.ok ? result.data.runId : "missing",
          observations: expect.arrayContaining([
            expect.objectContaining({
              kind: "thinking",
              summary: "Inspecting the current files.",
            }),
            expect.objectContaining({
              kind: "tool_call",
              toolName: "readFile",
              status: "started",
              argsSummary: expect.stringContaining("[redacted]"),
            }),
            expect.objectContaining({
              kind: "tool_call",
              toolName: "readFile",
              status: "completed",
              durationMs: 12,
            }),
          ]),
        }),
      ]);
      expect(seenGoals[0]).toContain("Task: Implement runtime worker adapter.");
      expect(seenGoals[0]).toContain("Stage: Implement");
      expect(seenGoals[0]).toContain("- Worker result is terminal-tool backed.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("records failed and budget-exceeded runTask results through terminal commands", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      const failedTarget = await readyTask(context, dir);
      const failed = await runWorkerTask(context, {
        taskId: failedTarget.taskId,
        roundId: failedTarget.roundId,
        workUnitId: failedTarget.workUnitId,
        taskInput: { loop: fakeLoop },
        runTask: async (): Promise<AgentTaskResult> => ({
          status: "failed",
          rounds: 1,
          report: "Worker failed with report.",
          timeline: [],
          usage,
        }),
      });
      expect(failed).toMatchObject({
        ok: true,
        data: {
          projection: {
            workerRuns: {
              [failed.ok ? failed.data.runId : "missing"]: { status: "failed" },
            },
          },
        },
      });

      const budgetTarget = await readyTask(context, dir);
      const budget = await runWorkerTask(context, {
        taskId: budgetTarget.taskId,
        roundId: budgetTarget.roundId,
        workUnitId: budgetTarget.workUnitId,
        taskInput: { loop: fakeLoop },
        runTask: async (): Promise<AgentTaskResult> => ({
          status: "budget_exceeded",
          rounds: 2,
          report: "Budget exhausted with remaining work.",
          timeline: [{ round: 1, report: "Partial progress." }],
          usage,
        }),
      });
      expect(budget).toMatchObject({
        ok: true,
        data: {
          projection: {
            workerRuns: {
              [budget.ok ? budget.data.runId : "missing"]: {
                status: "budget_exceeded",
                result: { report: expect.stringContaining("Partial progress.") },
              },
            },
          },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function readyTask(
  context: CommandContext,
  dir: string,
): Promise<{ taskId: string; roundId: string; workUnitId: string }> {
  await createWorkspace(context, { id: "sikong", name: "Sikong" });
  const created = await createTask(context, {
    request: "Implement runtime worker adapter.",
    cwd: dir,
  });
  if (!created.ok) throw new Error("task create failed");
  const spec = await submitRequirementSpec(context, {
    taskId: created.data.taskId,
    summary: "Implement runtime worker adapter.",
  });
  if (!spec.ok) throw new Error("requirement spec submit failed");
  const submitted = await submitPlan(context, {
    taskId: created.data.taskId,
    stages: [
      {
        title: "Implement",
        objective: "Connect runTask to worker terminal result commands.",
        acceptance: ["Worker result is terminal-tool backed."],
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
  const round = await planStageRound(context, {
    taskId: created.data.taskId,
    stageId: accepted.data.projection.currentStageId ?? "",
    intent: "Execute runtime worker adapter work.",
    workUnits: [
      {
        title: "Runtime worker adapter",
        objective: "Connect runTask to worker terminal result commands.",
        instructions: ["Connect only the runtime worker adapter path."],
        deliverables: ["A terminal worker result is recorded through protocol commands."],
        outOfScope: ["Do not modify planner or reviewer behavior."],
      },
    ],
  });
  if (!round.ok) throw new Error("round plan failed");
  return {
    taskId: created.data.taskId,
    roundId: round.data.round.id,
    workUnitId: round.data.round.workUnits[0]!.id,
  };
}

const fakeLoop = () => {
  throw new Error("fake loop should not be called by injected runTask");
};
