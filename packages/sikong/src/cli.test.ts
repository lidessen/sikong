import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JsonWorkspaceChronicleStore, JsonWorkspaceEventStore, JsonWorkspaceProjectionStore } from "./store";
import { JsonSteerMailbox } from "./engine/steer-mailbox";
import { GENERAL_WORKFLOW } from "./workflow/builtin";
import { initTask, project } from "./workflow/reducer";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-cli-"));
const cliPath = new URL("./cli.ts", import.meta.url).pathname;

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

describe("sikong CLI", () => {
  test("create --parent links a child task and submit transition records lead acceptance", async () => {
    const dir = await tmp();
    try {
      const parent = Bun.spawnSync([
        process.execPath,
        cliPath,
        "create",
        "parent work",
        "--dir",
        dir,
        "--workflow",
        "general",
        "--id",
        "parent",
      ]);
      expect(parent.exitCode).toBe(0);

      const child = Bun.spawnSync([
        process.execPath,
        cliPath,
        "create",
        "child work",
        "--dir",
        dir,
        "--workflow",
        "general",
        "--parent",
        "parent",
        "--id",
        "child",
      ]);
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(child.stdout))).toMatchObject({
        task: { id: "child", parentId: "parent" },
      });

      const setSummary = Bun.spawnSync([
        process.execPath,
        cliPath,
        "submit",
        "child",
        "set-field",
        "summary",
        "child done",
        "--dir",
        dir,
      ]);
      expect(setSummary.exitCode).toBe(0);
      const transition = Bun.spawnSync([
        process.execPath,
        cliPath,
        "submit",
        "child",
        "transition",
        "lead accepted child result",
        "--dir",
        dir,
      ]);
      expect(transition.exitCode).toBe(0);

      const task = Bun.spawnSync([process.execPath, cliPath, "task", "child", "--dir", dir]);
      expect(task.exitCode).toBe(0);
      const detail = JSON.parse(new TextDecoder().decode(task.stdout));
      expect(detail.task).toMatchObject({
        id: "child",
        parentId: "parent",
      });
      expect(detail.timeline.map((event: { type: string }) => event.type)).toContain("transition.requested");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("submit steer records a mailbox entry for an active wake", async () => {
    const dir = await tmp();
    try {
      const created = Bun.spawnSync([
        process.execPath,
        cliPath,
        "create",
        "needs correction",
        "--dir",
        dir,
        "--workflow",
        "general",
        "--id",
        "steer-task",
      ]);
      expect(created.exitCode).toBe(0);

      const steer = Bun.spawnSync([
        process.execPath,
        cliPath,
        "submit",
        "steer-task",
        "steer",
        "prefer the accepted repair, do not block",
        "--dir",
        dir,
      ]);
      expect(steer.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(steer.stdout))).toMatchObject({
        ok: true,
        taskId: "steer-task",
        command: { kind: "steer", message: "prefer the accepted repair, do not block" },
        next: { note: "active wake will receive this steer if one is running" },
      });

      const entries = await new JsonSteerMailbox(dir).list("steer-task");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        taskId: "steer-task",
        source: "lead",
        message: "prefer the accepted repair, do not block",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("submit steer bypasses the run write lock while normal submits do not", async () => {
    const dir = await tmp();
    try {
      const created = Bun.spawnSync([
        process.execPath,
        cliPath,
        "create",
        "needs live correction",
        "--dir",
        dir,
        "--workflow",
        "general",
        "--id",
        "locked-steer-task",
      ]);
      expect(created.exitCode).toBe(0);

      await writeFile(join(dir, ".lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));

      const steer = Bun.spawnSync([
        process.execPath,
        cliPath,
        "submit",
        "locked-steer-task",
        "steer",
        "correct the active wake",
        "--dir",
        dir,
      ]);
      expect(steer.exitCode).toBe(0);
      expect((await new JsonSteerMailbox(dir).list("locked-steer-task")).map((entry) => entry.message)).toEqual([
        "correct the active wake",
      ]);

      const transition = Bun.spawnSync([
        process.execPath,
        cliPath,
        "submit",
        "locked-steer-task",
        "transition",
        "normal submit should wait",
        "--dir",
        dir,
      ]);
      expect(transition.exitCode).toBe(1);
      expect(new TextDecoder().decode(transition.stderr)).toContain("write-locked");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inspect wait returns the next chronicle event", async () => {
    const dir = await tmp();
    try {
      const proc = Bun.spawn(
        [process.execPath, cliPath, "inspect", "wait", "--dir", dir, "--after", "0", "--timeout", "2000", "--poll", "20"],
        { stdout: "pipe", stderr: "pipe" },
      );
      await Bun.sleep(60);
      await new JsonWorkspaceChronicleStore(dir).append({
        type: "wake.start",
        taskId: "t1",
        wakeId: "w1",
        summary: "wake @ test",
      });

      const [code, stdout, stderr] = await Promise.all([proc.exited, readStream(proc.stdout), readStream(proc.stderr)]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        timedOut: false,
        event: { type: "wake.start", taskId: "t1", summary: "wake @ test" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("chronicle --text renders diagnostic facts from event data", async () => {
    const dir = await tmp();
    try {
      const store = new JsonWorkspaceChronicleStore(dir);
      await store.append({
        type: "wake.diagnostics",
        taskId: "t1",
        wakeId: "w1",
        summary: "worker pass",
        data: {
          phase: "worker",
          stateCommands: 0,
          toolCallStarts: { readFile: 2, rg: 1 },
        },
      });
      await store.append({
        type: "wake.commit",
        taskId: "t1",
        wakeId: "w1",
        summary: "commit fallback",
        data: {
          reason: "no_state_commands",
          allowedTools: ["commit_stage", "block"],
          outputFields: ["summary"],
        },
      });

      const out = Bun.spawnSync([
        process.execPath,
        cliPath,
        "chronicle",
        "--dir",
        dir,
        "--task",
        "t1",
        "-n",
        "2",
        "--text",
      ]);
      expect(out.exitCode).toBe(0);
      const text = new TextDecoder().decode(out.stdout);
      expect(text).toContain(
        "wake.diagnostics t1 — worker pass [phase=worker stateCommands=0 tools=readFile:2,rg:1]",
      );
      expect(text).toContain(
        "wake.commit t1 — commit fallback [reason=no_state_commands allowed=commit_stage,block outputFields=summary]",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("actions renders pending lead actions from workspace state", async () => {
    const dir = await tmp();
    try {
      const events = new JsonWorkspaceEventStore(dir);
      const projections = new JsonWorkspaceProjectionStore(dir);
      await events.append("parent", initTask({ taskId: "parent", projectId: "p", workflow: GENERAL_WORKFLOW }));
      await events.append("child", [
        ...initTask({
          taskId: "child",
          projectId: "p",
          workflow: GENERAL_WORKFLOW,
          parentId: "parent",
          fields: { request: "do child work", summary: "child finished" },
        }),
        { taskId: "child", source: "engine", type: "stage.entered", payload: { stageId: "done" } },
      ]);
      await events.append("parent", [
        {
          taskId: "parent",
          source: "engine",
          type: "subtask.created",
          payload: { childId: "child", workflowId: GENERAL_WORKFLOW.id },
        },
      ]);
      await projections.put(project(await events.load("child"), GENERAL_WORKFLOW));
      await projections.put(project(await events.load("parent"), GENERAL_WORKFLOW));

      const textOut = Bun.spawnSync([process.execPath, cliPath, "actions", "--dir", dir, "--text"]);
      expect(textOut.exitCode).toBe(0);
      const text = new TextDecoder().decode(textOut.stdout);
      expect(text).toContain("Pending lead actions:");
      expect(text).toContain("parent [ready_for_parent_review]");

      const jsonOut = Bun.spawnSync([process.execPath, cliPath, "actions", "--dir", dir]);
      expect(jsonOut.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(jsonOut.stdout))).toMatchObject({
        total: 1,
        actions: [
          {
            taskId: "parent",
            classification: "ready_for_parent_review",
            suggestedCommand: "sikong task parent --text",
          },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("create warns when a write-class workflow targets the current directory", async () => {
    const dir = await tmp();
    try {
      // development staffs a coding team (workerRole) and the builtin default
      // project root is "." → the team would edit the cwd; create must warn.
      const dev = Bun.spawnSync([process.execPath, cliPath, "create", "edit code", "--dir", dir, "--workflow", "development", "--id", "w1"]);
      expect(dev.exitCode).toBe(0);
      expect(new TextDecoder().decode(dev.stderr)).toContain("current directory");

      // general is not write-class (no workerRole) → no warning.
      const gen = Bun.spawnSync([process.execPath, cliPath, "create", "just research", "--dir", dir, "--workflow", "general", "--id", "w2"]);
      expect(gen.exitCode).toBe(0);
      expect(new TextDecoder().decode(gen.stderr)).not.toContain("current directory");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
