import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeDir } from "../data-dir";
import {
  addWorkspacePreference,
  acceptPlan,
  acceptStageReview,
  acceptTask,
  completeWorkerRun,
  createTask,
  createWorkspace,
  exceedWorkerRunBudget,
  failWorkerRun,
  deleteWorkspace,
  getTask,
  getWorkspace,
  inspectTaskCompact,
  inspectTaskEvents,
  inspectTaskSummary,
  inspectTaskTrace,
  listTasks,
  listWorkspacePreferences,
  listWorkspaces,
  recommendFinalReview,
  recordRuntimeProcessFinished,
  recordRuntimeProcessStarted,
  rejectPlan,
  removeWorkspacePreference,
  startStageReview,
  startWorkerRun,
  submitPlan,
  waitTask,
  type CommandContext,
} from "./index";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-commands-"));

function ctx(dataDir: string): CommandContext {
  let id = 0;
  return {
    dataDir,
    workspaceId: "sikong",
    now: () => new Date("2026-06-14T00:00:00.000Z"),
    id: () => `id_${++id}`,
  };
}

describe("workspace command handlers", () => {
  test("creates, lists, reads, and deletes workspaces", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);

      expect(await createWorkspace(context, { id: "sikong", name: "Sikong" })).toEqual({
        ok: true,
        data: { workspace: { id: "sikong", name: "Sikong" } },
      });
      expect(await createWorkspace(context, { id: "sikong", name: "Sikong" })).toMatchObject({
        ok: false,
        error: { code: "workspace_exists" },
      });
      expect(await listWorkspaces(context)).toMatchObject({
        ok: true,
        data: { workspaces: [{ id: "sikong", name: "Sikong" }] },
      });
      expect(await getWorkspace(context, { workspaceId: "sikong" })).toMatchObject({
        ok: true,
        data: { workspace: { id: "sikong" } },
      });
      expect(await deleteWorkspace(context, { workspaceId: "sikong" })).toEqual({
        ok: true,
        data: { workspaceId: "sikong" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("preference command handlers", () => {
  test("adds, lists, and removes workspace preferences", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });

      const added = await addWorkspacePreference(context, {
        text: "Run bun run check before handoff.",
      });
      expect(added).toMatchObject({
        ok: true,
        data: {
          preference: { id: "run-bun-run-check", text: "Run bun run check before handoff." },
        },
      });

      expect(await listWorkspacePreferences(context)).toMatchObject({
        ok: true,
        data: { preferences: [{ id: "run-bun-run-check" }] },
      });
      expect(
        await removeWorkspacePreference(context, { preferenceId: "run-bun-run-check" }),
      ).toEqual({
        ok: true,
        data: { preferenceId: "run-bun-run-check" },
      });
      expect(await listWorkspacePreferences(context)).toEqual({
        ok: true,
        data: { preferences: [] },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("task command handlers", () => {
  test("creates a durable task and exposes show, summary, events, and trace", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });

      const created = await createTask(context, {
        request: "Implement command handlers.",
        cwd: dir,
      });

      expect(created).toMatchObject({
        ok: true,
        data: {
          taskId: "task_id_1",
          projection: {
            taskId: "task_id_1",
            workspaceId: "sikong",
            status: "planning",
            request: "Implement command handlers.",
            planDecision: { status: "requested" },
            eventCount: 2,
          },
        },
      });

      if (!created.ok) throw new Error("task create failed");
      const taskId = created.data.taskId;

      expect(await getTask(context, { taskId })).toMatchObject({
        ok: true,
        data: { projection: { taskId, status: "planning" } },
      });
      expect(await listTasks(context)).toMatchObject({
        ok: true,
        data: { tasks: [{ taskId, workspaceId: "sikong", status: "planning" }] },
      });
      expect(await inspectTaskSummary(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          summary: {
            taskId,
            workspaceId: "sikong",
            status: "planning",
            planStatus: "requested",
          },
        },
      });
      expect(await inspectTaskCompact(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          compact: {
            taskId,
            workspaceId: "sikong",
            status: "planning",
            nextAction: { type: "start_planning_worker" },
            waitingForLead: false,
          },
        },
      });
      expect(await inspectTaskEvents(context, { taskId })).toMatchObject({
        ok: true,
        data: { events: [{ type: "task.created" }, { type: "plan.requested" }] },
      });
      expect(await inspectTaskTrace(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          trace: [
            { type: "task.created", summary: "Implement command handlers." },
            { type: "plan.requested", summary: "Implement command handlers." },
          ],
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exposes runtime process facts through summary, compact, and trace", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Inspect runtime process facts.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const taskId = created.data.taskId;

      expect(
        await recordRuntimeProcessStarted(context, {
          taskId,
          processRunId: "process_1",
          actionType: "start_planning_worker",
        }),
      ).toMatchObject({ ok: true });

      expect(await inspectTaskSummary(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          summary: {
            runtimeProcesses: 1,
            runningRuntimeProcesses: 1,
          },
        },
      });
      expect(await inspectTaskCompact(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          compact: {
            runtimeProcesses: { total: 1, running: 1 },
            latestRuntimeProcess: {
              processRunId: "process_1",
              actionType: "start_planning_worker",
              status: "running",
            },
          },
        },
      });

      expect(
        await recordRuntimeProcessFinished(context, {
          taskId,
          processRunId: "process_1",
          processStatus: "cancelled",
        }),
      ).toMatchObject({ ok: true });

      expect(await inspectTaskTrace(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          trace: expect.arrayContaining([
            expect.objectContaining({ type: "runtime_process.started" }),
            expect.objectContaining({ type: "runtime_process.finished" }),
          ]),
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates a workspace-owned worktree for git runtime context", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const repo = await createGitRepo(join(dir, "source"));

      const created = await createTask(context, {
        request: "Work in an isolated git worktree.",
        repoPath: repo,
      });

      const expectedCwd = worktreeDir(dir, "sikong", "task_id_1");
      expect(created).toMatchObject({
        ok: true,
        data: {
          taskId: "task_id_1",
          projection: {
            runtime: {
              cwd: expectedCwd,
              repoPath: repo,
            },
          },
        },
      });
      expect(await Bun.file(join(expectedCwd, "README.md")).text()).toBe("hello\n");
      expect(expectedCwd).not.toBe(repo);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("records plan decisions, worker terminal results, reviews, and task completion", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Implement the accepted design.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const taskId = created.data.taskId;

      const submitted = await submitPlan(context, {
        taskId,
        summary: "Implement in two stages.",
        stages: [
          {
            title: "Implement",
            objective: "Apply the protocol commands.",
            acceptance: ["Commands are present.", "Tests cover the protocol."],
          },
          {
            title: "Verify",
            objective: "Run checks.",
            acceptance: ["Full check passes."],
          },
        ],
      });
      expect(submitted).toMatchObject({
        ok: true,
        data: {
          plan: { version: 1, stages: [{ title: "Implement" }, { title: "Verify" }] },
          projection: { status: "plan_submitted" },
        },
      });
      if (!submitted.ok) throw new Error("plan submit failed");
      const { id: planId, version } = submitted.data.plan;
      expect(await inspectTaskCompact(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          compact: {
            status: "plan_submitted",
            nextAction: { type: "await_plan_decision", planId, version },
            waitingForLead: true,
          },
        },
      });
      expect(await waitTask(context, { taskId, timeoutMs: 0 })).toMatchObject({
        ok: true,
        data: {
          compact: {
            status: "plan_submitted",
            nextAction: { type: "await_plan_decision", planId, version },
            waitingForLead: true,
          },
        },
      });

      expect(
        await rejectPlan(context, {
          taskId,
          planId: "wrong",
          version,
          report: "Wrong plan.",
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "invalid_state" },
      });

      const accepted = await acceptPlan(context, {
        taskId,
        planId,
        version,
        report: "Lead accepts the plan.",
      });
      expect(accepted).toMatchObject({
        ok: true,
        data: {
          projection: { status: "running", currentStageId: expect.stringMatching(/^stage_/) },
        },
      });

      const started = await startWorkerRun(context, { taskId, workerId: "worker-a" });
      if (!started.ok) throw new Error("worker start failed");
      const runId = started.data.runId;
      expect(started).toMatchObject({
        ok: true,
        data: { runId: expect.stringMatching(/^run_/) },
      });

      expect(
        await failWorkerRun(context, {
          taskId,
          runId,
          summary: "Could not finish.",
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });

      await expect(
        completeWorkerRun(context, {
          taskId,
          runId,
          summary: "Implemented protocol commands.",
          report: "Commands and tests were added.",
        }),
      ).resolves.toMatchObject({
        ok: true,
        data: { projection: { workerRuns: { [runId]: { status: "completed" } } } },
      });
      expect(await inspectTaskCompact(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          compact: {
            status: "running",
            nextAction: { type: "start_stage_review" },
            latestWorkerResult: { runId, status: "completed" },
          },
        },
      });

      const review = await startStageReview(context, { taskId });
      if (!review.ok) throw new Error("stage review start failed");
      const reviewId = review.data.reviewId;
      expect(review).toMatchObject({
        ok: true,
        data: { reviewId: expect.stringMatching(/^review_/) },
      });

      const stageAccepted = await acceptStageReview(context, {
        taskId,
        reviewId,
        report: "Stage criteria satisfied.",
      });
      expect(stageAccepted).toMatchObject({
        ok: true,
        data: {
          projection: { status: "running", acceptedStageIds: [expect.stringMatching(/^stage_/)] },
        },
      });

      const secondRun = await startWorkerRun(context, { taskId, workerId: "worker-b" });
      if (!secondRun.ok) throw new Error("second worker start failed");
      const secondRunId = secondRun.data.runId;
      expect(
        await exceedWorkerRunBudget(context, {
          taskId,
          runId: secondRunId,
          summary: "Verification budget exhausted.",
          note: "Run the full check next.",
        }),
      ).toMatchObject({
        ok: true,
        data: {
          projection: { workerRuns: { [secondRunId]: { status: "budget_exceeded" } } },
        },
      });

      const secondReview = await startStageReview(context, { taskId });
      if (!secondReview.ok) throw new Error("second stage review start failed");
      const secondReviewId = secondReview.data.reviewId;
      const finalStarted = await acceptStageReview(context, {
        taskId,
        reviewId: secondReviewId,
        report: "Verification stage accepted.",
      });
      expect(finalStarted).toMatchObject({
        ok: true,
        data: { projection: { status: "reviewing", finalReview: { status: "started" } } },
      });
      if (!finalStarted.ok) throw new Error("final review did not start");
      const finalReviewId = finalStarted.data.projection.finalReview?.reviewId;
      if (!finalReviewId) throw new Error("missing final review id");

      expect(
        await recommendFinalReview(context, {
          taskId,
          reviewId: finalReviewId,
          recommendation: "accept",
          report: "Overall task is acceptable.",
        }),
      ).toMatchObject({
        ok: true,
        data: { projection: { finalReview: { status: "recommended", recommendation: "accept" } } },
      });
      expect(
        await acceptTask(context, { taskId, report: "Lead accepts final result." }),
      ).toMatchObject({
        ok: true,
        data: { projection: { status: "completed", terminal: { outcome: "accepted" } } },
      });

      const events = await inspectTaskEvents(context, { taskId });
      expect(events).toMatchObject({
        ok: true,
        data: {
          events: expect.arrayContaining([
            expect.objectContaining({ type: "plan.submitted" }),
            expect.objectContaining({ type: "plan.accepted" }),
            expect.objectContaining({ type: "worker_run.completed" }),
            expect.objectContaining({ type: "worker_run.budget_exceeded" }),
            expect.objectContaining({ type: "final.review.recommended" }),
            expect.objectContaining({ type: "task.completed" }),
          ]),
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns structured errors for missing workspace and runtime paths", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);

      expect(await createTask(context, { request: "No workspace." })).toMatchObject({
        ok: false,
        error: { code: "workspace_not_found" },
      });

      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      expect(
        await createTask(context, { request: "Bad cwd.", cwd: join(dir, "missing") }),
      ).toMatchObject({
        ok: false,
        error: { code: "runtime_cwd_not_found" },
      });
      expect(await getTask(context, { taskId: "missing" })).toMatchObject({
        ok: false,
        error: { code: "task_not_found" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function createGitRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await runGit(path, ["init"]);
  await writeFile(join(path, "README.md"), "hello\n");
  await runGit(path, ["add", "README.md"]);
  await runGit(path, [
    "-c",
    "user.email=sikong@example.local",
    "-c",
    "user.name=Sikong Test",
    "commit",
    "-m",
    "initial",
  ]);
  return await realpath(path);
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(stderr);
}
