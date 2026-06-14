import { describe, expect, test } from "bun:test";
import { mockLoop } from "agent-loop";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, createWorkspace, type CommandContext } from "../commands";
import { buildClientAgentContext, FileClientWorkLog, runClientAgentTurn } from "./index";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-client-agent-"));

function ctx(dataDir: string): CommandContext {
  let id = 0;
  return {
    dataDir,
    workspaceId: "sikong",
    now: () => new Date("2026-06-14T00:00:00.000Z"),
    id: () => `id_${++id}`,
  };
}

describe("client agent context", () => {
  test("builds a bounded packet from work log and focus, not transcript", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const workLog = new FileClientWorkLog(dir);
      await workLog.append(context, {
        kind: "decision",
        summary: "Prefer explicit context packets over transcript replay.",
        workspaceId: "sikong",
      });
      const task = await createTask(context, {
        request: "Implement Client Agent context.",
        cwd: dir,
      });
      if (!task.ok) throw new Error("task create failed");

      const packet = await buildClientAgentContext({
        ctx: context,
        focus: { workspaceId: "sikong", taskId: task.data.taskId },
        workLog,
      });

      expect(packet.policy).toEqual({
        transcript: "presentation_only",
        memory: "client_work_log",
        taskEvents: "detail_only",
      });
      expect(packet.workLog).toMatchObject([
        { kind: "decision", summary: "Prefer explicit context packets over transcript replay." },
      ]);
      expect(packet.focusedWorkspace?.taskCards).toMatchObject([
        { taskId: task.data.taskId, status: "planning" },
      ]);
      expect(packet.focusedTask?.summary).toMatchObject({
        taskId: task.data.taskId,
        status: "planning",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs one turn with typed tools and an explicit context packet", async () => {
    const dir = await tmp();
    try {
      const context = ctx(dir);
      await createWorkspace(context, { id: "sikong", name: "Sikong" });
      const result = await runClientAgentTurn({
        ctx: context,
        loop: mockLoop(),
        message: "Show current Sikong work.",
        focus: { workspaceId: "sikong" },
      });

      expect(result.context.policy.transcript).toBe("presentation_only");
      expect(result.run.status).toBe("completed");
      expect(result.run.text).toContain("Current user message:");
      expect(result.run.text).toContain("Context packet:");
      expect(result.run.text).toContain("The UI transcript is intentionally omitted.");
      expect(result.run.text).not.toContain("previous assistant reply");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
