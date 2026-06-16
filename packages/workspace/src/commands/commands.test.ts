import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskRuntimeDir, worktreeDir } from "../data-dir";
import {
  addWorkspacePreference,
  acceptPlan,
  acceptStageReview,
  acceptTask,
  completeStageRound,
  completeWorkerRun,
  createTask,
  createWorkspace,
  exceedWorkerRunBudget,
  failWorkerRun,
  deleteWorkspace,
  getTask,
  getWorkspace,
  inspectTaskCompact,
  inspectTaskDetail,
  inspectTaskEvents,
  inspectTaskSummary,
  inspectTaskTrace,
  listRunnableTasks,
  listTasks,
  listWorkspacePreferences,
  listWorkspaces,
  recommendFinalReview,
  recordRuntimeProcessFinished,
  recordRuntimeProcessStarted,
  recordWorkerRunObservations,
  reconcileTaskRuntime,
  rejectPlan,
  removeWorkspacePreference,
  planStageRound,
  startStageReview,
  startWorkerRun,
  submitRequirementSpec,
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

function testWorkUnit(title: string, objective: string, acceptance?: string[]) {
  return {
    title,
    objective,
    instructions: [`Complete only: ${objective}`],
    deliverables: [`Evidence that ${title} is complete.`],
    outOfScope: ["Do not complete other work units or later stages."],
    ...(acceptance ? { acceptance } : {}),
  };
}

async function planSingleWorkUnitRound(context: CommandContext, taskId: string) {
  const task = await getTask(context, { taskId });
  if (!task.ok || !task.data.projection.currentStageId) throw new Error("current stage missing");
  const round = await planStageRound(context, {
    taskId,
    stageId: task.data.projection.currentStageId,
    intent: "Execute the next focused work unit.",
    workUnits: [testWorkUnit("Implement", "Complete the current stage work.")],
  });
  if (!round.ok) throw new Error("round plan failed");
  return {
    roundId: round.data.round.id,
    workUnitId: round.data.round.workUnits[0]!.id,
  };
}

async function submitSpec(context: CommandContext, taskId: string) {
  const submitted = await submitRequirementSpec(context, {
    taskId,
    summary: "Implement the requested work.",
  });
  if (!submitted.ok) throw new Error("requirement spec submit failed");
}

async function createAcceptedTaskWithPlan(context: CommandContext): Promise<string> {
  await createWorkspace(context, { id: "sikong", name: "Sikong" });
  const created = await createTask(context, {
    request: "Implement live worker activity.",
    cwd: context.dataDir,
  });
  if (!created.ok) throw new Error("task create failed");
  const taskId = created.data.taskId;
  await submitSpec(context, taskId);
  const submitted = await submitPlan(context, {
    taskId,
    stages: [
      {
        title: "Implement",
        objective: "Complete the implementation.",
        acceptance: ["Worker activity is visible."],
      },
    ],
  });
  if (!submitted.ok) throw new Error("plan submit failed");
  const accepted = await acceptPlan(context, {
    taskId,
    planId: submitted.data.plan.id,
    version: submitted.data.plan.version,
    report: "Accepted.",
  });
  if (!accepted.ok) throw new Error("plan accept failed");
  return taskId;
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
            status: "created",
            request: "Implement command handlers.",
            eventCount: 1,
          },
        },
      });

      if (!created.ok) throw new Error("task create failed");
      const taskId = created.data.taskId;

      expect(await getTask(context, { taskId })).toMatchObject({
        ok: true,
        data: { projection: { taskId, status: "created" } },
      });
      expect(await listTasks(context)).toMatchObject({
        ok: true,
        data: { tasks: [{ taskId, workspaceId: "sikong", status: "created" }] },
      });
      expect(await inspectTaskSummary(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          summary: {
            taskId,
            workspaceId: "sikong",
            status: "created",
          },
        },
      });
      expect(await inspectTaskCompact(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          compact: {
            taskId,
            workspaceId: "sikong",
            status: "created",
            nextAction: { type: "start_lead_requirement_spec" },
            waitingForLead: true,
          },
        },
      });
      expect(await inspectTaskEvents(context, { taskId })).toMatchObject({
        ok: true,
        data: { events: [{ type: "task.created" }] },
      });
      expect(await inspectTaskTrace(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          trace: [{ type: "task.created", summary: "Implement command handlers." }],
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lists runnable tasks for scheduler scans", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });

      const created = await createTask(context, {
        request: "Build the next feature.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");

      expect(await listRunnableTasks(context)).toMatchObject({
        ok: true,
        data: {
          tasks: [
            {
              workspaceId: "sikong",
              taskId: created.data.taskId,
              status: "created",
              nextAction: { type: "start_lead_requirement_spec" },
            },
          ],
        },
      });

      expect(await listRunnableTasks(context, { all: true })).toMatchObject({
        ok: true,
        data: { tasks: [{ taskId: created.data.taskId }] },
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
            queuedRuntimeProcesses: 1,
            runningRuntimeProcesses: 0,
          },
        },
      });
      expect(await inspectTaskCompact(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          compact: {
            runtimeProcesses: { total: 1, queued: 1, running: 0 },
            latestRuntimeProcess: {
              processRunId: "process_1",
              actionType: "start_planning_worker",
              status: "queued",
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

  test("reconciles timed-out stage worker processes into failed worker runs", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Recover a timed-out worker.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const taskId = created.data.taskId;
      await submitSpec(context, taskId);
      const submitted = await submitPlan(context, {
        taskId,
        stages: [
          {
            title: "Implement",
            objective: "Start worker.",
            acceptance: ["Worker can be reconciled."],
          },
        ],
      });
      if (!submitted.ok) throw new Error("plan submit failed");
      const accepted = await acceptPlan(context, {
        taskId,
        planId: submitted.data.plan.id,
        version: submitted.data.plan.version,
        report: "Accepted.",
      });
      if (!accepted.ok) throw new Error("plan accept failed");
      const workTarget = await planSingleWorkUnitRound(context, taskId);
      const startedWorker = await startWorkerRun(context, { taskId, ...workTarget });
      if (!startedWorker.ok) throw new Error("worker start failed");
      await recordRuntimeProcessStarted(context, {
        taskId,
        processRunId: "process_timeout",
        actionType: "start_stage_worker",
      });
      await recordRuntimeProcessFinished(context, {
        taskId,
        processRunId: "process_timeout",
        processStatus: "timed_out",
        exitCode: 143,
      });

      expect(await reconcileTaskRuntime(context, { taskId })).toMatchObject({
        ok: true,
        data: { reconciledCount: 1 },
      });
      const fresh = await getTask(context, { taskId });
      if (!fresh.ok) throw new Error("task get failed");
      expect(fresh.data.projection.workerRuns[startedWorker.data.runId]).toMatchObject({
        status: "failed",
        result: {
          summary: expect.stringContaining("process_timeout"),
          report: expect.stringContaining("timed_out"),
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reconciles finished daemon snapshots into runtime process events", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Recover a finished process snapshot.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const taskId = created.data.taskId;
      await recordRuntimeProcessStarted(context, {
        taskId,
        processRunId: "process_finished_snapshot",
        actionType: "start_stage_worker",
      });

      expect(await inspectTaskSummary(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          summary: {
            runtimeProcesses: 1,
            queuedRuntimeProcesses: 1,
            runningRuntimeProcesses: 0,
          },
        },
      });

      const reconciled = await reconcileTaskRuntime(context, {
        taskId,
        processSnapshots: [
          {
            runId: "process_finished_snapshot",
            workspaceId: "sikong",
            taskId,
            state: "finished",
            startedAt: "2026-06-14T00:00:00.000Z",
            finishedAt: "2026-06-14T00:00:01.000Z",
            spec: {
              runId: "process_finished_snapshot",
              workspaceId: "sikong",
              taskId,
              command: "echo",
            },
            result: {
              runId: "process_finished_snapshot",
              workspaceId: "sikong",
              taskId,
              status: "succeeded",
              command: "echo",
              args: [],
              stdout: "",
              stderr: "",
              exitCode: 0,
              startedAt: "2026-06-14T00:00:00.000Z",
              finishedAt: "2026-06-14T00:00:01.000Z",
              durationMs: 1_000,
            },
          },
        ],
      });

      expect(reconciled).toMatchObject({
        ok: true,
        data: {
          projection: {
            runtimeProcessRuns: {
              process_finished_snapshot: {
                status: "finished",
                processStatus: "succeeded",
                exitCode: 0,
              },
            },
          },
        },
      });
      expect(await inspectTaskSummary(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          summary: {
            runtimeProcesses: 1,
            runningRuntimeProcesses: 0,
          },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reconciles running daemon snapshots into runtime running events", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const created = await createTask(context, {
        request: "Recover a running process snapshot.",
        cwd: dir,
      });
      if (!created.ok) throw new Error("task create failed");
      const taskId = created.data.taskId;
      await recordRuntimeProcessStarted(context, {
        taskId,
        processRunId: "process_running_snapshot",
        actionType: "start_stage_worker",
      });

      const reconciled = await reconcileTaskRuntime(context, {
        taskId,
        processSnapshots: [
          {
            runId: "process_running_snapshot",
            workspaceId: "sikong",
            taskId,
            state: "running",
            spec: {
              runId: "process_running_snapshot",
              workspaceId: "sikong",
              taskId,
              command: "bun",
            },
            queuedAt: "2026-06-14T00:00:00.000Z",
            startedAt: "2026-06-14T00:00:01.000Z",
          },
        ],
      });

      expect(reconciled).toMatchObject({
        ok: true,
        data: {
          reconciledCount: 1,
          projection: {
            runtimeProcessRuns: {
              process_running_snapshot: { status: "running" },
            },
          },
        },
      });
      expect(await inspectTaskSummary(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          summary: {
            queuedRuntimeProcesses: 0,
            runningRuntimeProcesses: 1,
          },
        },
      });
      expect(await inspectTaskTrace(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          trace: expect.arrayContaining([
            expect.objectContaining({ type: "runtime_process.running" }),
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

  test("creates a workspace-owned task runtime dir when no runtime context is provided", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });

      const created = await createTask(context, {
        request: "Create a standalone artifact.",
      });

      const expectedCwd = taskRuntimeDir(dir, "sikong", "task_id_1");
      expect(created).toMatchObject({
        ok: true,
        data: {
          taskId: "task_id_1",
          projection: {
            runtime: {
              cwd: expectedCwd,
            },
          },
        },
      });
      await expect(access(expectedCwd)).resolves.toBeNull();
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
      await submitSpec(context, taskId);

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
            nextAction: { type: "start_lead_plan_decision", planId, version },
            waitingForLead: true,
          },
        },
      });
      expect(await waitTask(context, { taskId, timeoutMs: 0 })).toMatchObject({
        ok: true,
        data: {
          compact: {
            status: "plan_submitted",
            nextAction: { type: "start_lead_plan_decision", planId, version },
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

      const workTarget = await planSingleWorkUnitRound(context, taskId);
      const started = await startWorkerRun(context, {
        taskId,
        workerId: "worker-a",
        ...workTarget,
      });
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
          observations: [
            {
              id: "obs_1",
              kind: "thinking",
              round: 1,
              mode: "work",
              at: "2026-06-14T00:00:00.000Z",
              summary: "Reviewed files and prepared the implementation.",
            },
          ],
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
            nextAction: { type: "complete_stage_round", roundId: workTarget.roundId },
            latestWorkerResult: { runId, status: "completed" },
          },
        },
      });

      const roundCompleted = await completeStageRound(context, {
        taskId,
        roundId: workTarget.roundId,
      });
      if (!roundCompleted.ok) throw new Error("round complete failed");
      expect(await inspectTaskCompact(context, { taskId })).toMatchObject({
        ok: true,
        data: {
          compact: {
            status: "running",
            nextAction: { type: "start_stage_review" },
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

      const secondTarget = await planSingleWorkUnitRound(context, taskId);
      const secondRun = await startWorkerRun(context, {
        taskId,
        workerId: "worker-b",
        ...secondTarget,
      });
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

      const detail = await inspectTaskDetail(context, { taskId });
      expect(detail).toMatchObject({ ok: true });
      if (!detail.ok) throw new Error("task detail failed");
      expect(detail.data.detail.compact).toMatchObject({ taskId, status: "completed" });
      expect(detail.data.detail.projection.plan?.stages).toHaveLength(2);
      expect(detail.data.detail.projection.workerRuns[runId]?.result?.observations).toBeUndefined();
      expect(detail.data.detail.projection.workerRuns[runId]?.result?.observationRef).toEqual({
        runId,
        count: 1,
      });
      expect(detail.data.detail.trace).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "task.completed" })]),
      );
      expect(detail.data.detail.observations).toEqual([
        expect.objectContaining({
          runId,
          observations: [
            expect.objectContaining({
              kind: "thinking",
            }),
          ],
        }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exposes worker observations while the worker is still running", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      const taskId = await createAcceptedTaskWithPlan(context);
      const workTarget = await planSingleWorkUnitRound(context, taskId);
      const started = await startWorkerRun(context, {
        taskId,
        workerId: "worker-live",
        ...workTarget,
      });
      if (!started.ok) throw new Error("worker start failed");

      expect(
        await recordWorkerRunObservations(context, {
          taskId,
          runId: started.data.runId,
          observations: [
            {
              id: "obs_live_1",
              kind: "thinking",
              round: 1,
              mode: "work",
              at: "2026-06-14T00:00:00.000Z",
              summary:
                "Inspecting the active work unit and choosing the first implementation step.",
            },
            {
              id: "obs_live_2",
              kind: "tool_call",
              round: 1,
              mode: "work",
              at: "2026-06-14T00:00:01.000Z",
              summary: "read_file started.",
              toolName: "read_file",
              status: "started",
              argsSummary: '{"path":"src/app.ts"}',
            },
          ],
        }),
      ).toMatchObject({ ok: true, data: { count: 2 } });

      const detail = await inspectTaskDetail(context, { taskId });
      expect(detail).toMatchObject({ ok: true });
      if (!detail.ok) throw new Error("task detail failed");
      expect(detail.data.detail.projection.workerRuns[started.data.runId]?.status).toBe("running");
      expect(detail.data.detail.observations).toEqual([
        expect.objectContaining({
          runId: started.data.runId,
          observations: [
            expect.objectContaining({ kind: "thinking" }),
            expect.objectContaining({ kind: "tool_call", toolName: "read_file" }),
          ],
        }),
      ]);
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
