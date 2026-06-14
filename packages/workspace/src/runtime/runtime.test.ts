import { describe, expect, test } from "bun:test";
import type { TaskInput, TaskResult as AgentTaskResult } from "agent-loop";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptPlan,
  createTask,
  createWorkspace,
  submitPlan,
  type CommandContext,
} from "../commands";
import { runWorkerTask } from "./index";

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
  test("records a completed runTask result as a worker terminal event", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      const taskId = await readyTask(context, dir);
      const seenGoals: string[] = [];

      const result = await runWorkerTask(context, {
        taskId,
        taskInput: { loop: fakeLoop },
        runTask: async (input: TaskInput): Promise<AgentTaskResult> => {
          seenGoals.push(input.goal);
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
                },
              },
            },
          },
        },
      });
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
      const failedTaskId = await readyTask(context, dir);
      const failed = await runWorkerTask(context, {
        taskId: failedTaskId,
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

      const budgetTaskId = await readyTask(context, dir);
      const budget = await runWorkerTask(context, {
        taskId: budgetTaskId,
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

async function readyTask(context: CommandContext, dir: string): Promise<string> {
  await createWorkspace(context, { id: "sikong", name: "Sikong" });
  const created = await createTask(context, {
    request: "Implement runtime worker adapter.",
    cwd: dir,
  });
  if (!created.ok) throw new Error("task create failed");
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
  return created.data.taskId;
}

const fakeLoop = () => {
  throw new Error("fake loop should not be called by injected runTask");
};
