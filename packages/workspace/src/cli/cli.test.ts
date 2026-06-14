import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./index";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-cli-"));

function json(stdout: string): unknown {
  return JSON.parse(stdout);
}

describe("workspace cli adapter", () => {
  test("runs workspace and preference commands with JSON output", async () => {
    const dir = await tmp();
    try {
      expect(
        json(
          (
            await runCli([
              "--data-dir",
              dir,
              "workspace",
              "create",
              "--id",
              "sikong",
              "--name",
              "Sikong",
            ])
          ).stdout,
        ),
      ).toMatchObject({
        ok: true,
        data: { workspace: { id: "sikong", name: "Sikong" } },
      });

      expect(json((await runCli(["--data-dir", dir, "workspace", "list"])).stdout)).toMatchObject({
        ok: true,
        data: { workspaces: [{ id: "sikong" }] },
      });

      expect(
        json(
          (
            await runCli([
              "--data-dir",
              dir,
              "--workspace",
              "sikong",
              "preference",
              "add",
              "--text",
              "Run bun run check.",
            ])
          ).stdout,
        ),
      ).toMatchObject({
        ok: true,
        data: { preference: { id: "run-bun-run-check" } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates and inspects tasks", async () => {
    const dir = await tmp();
    try {
      await runCli([
        "--data-dir",
        dir,
        "workspace",
        "create",
        "--id",
        "sikong",
        "--name",
        "Sikong",
      ]);
      const created = json(
        (
          await runCli([
            "--data-dir",
            dir,
            "--workspace",
            "sikong",
            "task",
            "create",
            "--request",
            "Wire CLI adapter.",
            "--cwd",
            dir,
          ])
        ).stdout,
      );

      if (!created || typeof created !== "object" || !("data" in created)) {
        throw new Error("unexpected task create result");
      }
      const taskId = (created as { data: { taskId: string } }).data.taskId;
      expect(taskId).toMatch(/^task_/);
      expect(created).toMatchObject({
        ok: true,
        data: { projection: { taskId } },
      });

      expect(
        json(
          (await runCli(["--data-dir", dir, "--workspace", "sikong", "inspect", "summary", taskId]))
            .stdout,
        ),
      ).toMatchObject({
        ok: true,
        data: { summary: { status: "planning", planStatus: "requested" } },
      });
      expect(
        json(
          (await runCli(["--data-dir", dir, "--workspace", "sikong", "inspect", "compact", taskId]))
            .stdout,
        ),
      ).toMatchObject({
        ok: true,
        data: {
          compact: {
            status: "planning",
            nextAction: { type: "start_planning_worker" },
            waitingForLead: false,
          },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs task protocol commands through JSON CLI inputs", async () => {
    const dir = await tmp();
    try {
      await runCli([
        "--data-dir",
        dir,
        "workspace",
        "create",
        "--id",
        "sikong",
        "--name",
        "Sikong",
      ]);
      const created = json(
        (
          await runCli([
            "--data-dir",
            dir,
            "--workspace",
            "sikong",
            "task",
            "create",
            "--request",
            "Close protocol loop.",
            "--cwd",
            dir,
          ])
        ).stdout,
      ) as { data: { taskId: string } };
      const taskId = created.data.taskId;

      const submitted = json(
        (
          await runCli([
            "--data-dir",
            dir,
            "--workspace",
            "sikong",
            "task",
            "submit-plan",
            taskId,
            "--plan-json",
            JSON.stringify({
              summary: "One stage.",
              stages: [
                {
                  title: "Implement",
                  objective: "Use protocol commands.",
                  acceptance: ["Worker terminal result is recorded."],
                },
              ],
            }),
          ])
        ).stdout,
      ) as { data: { plan: { id: string; version: number } } };

      await runCli([
        "--data-dir",
        dir,
        "--workspace",
        "sikong",
        "task",
        "accept-plan",
        taskId,
        "--plan",
        submitted.data.plan.id,
        "--version",
        String(submitted.data.plan.version),
        "--report",
        "Accepted.",
      ]);

      const worker = json(
        (await runCli(["--data-dir", dir, "--workspace", "sikong", "task", "start-worker", taskId]))
          .stdout,
      ) as { data: { runId: string } };

      expect(
        json(
          (
            await runCli([
              "--data-dir",
              dir,
              "--workspace",
              "sikong",
              "task",
              "complete-worker",
              taskId,
              "--run",
              worker.data.runId,
              "--result-json",
              JSON.stringify({ summary: "Worker result submitted through terminal tool." }),
            ])
          ).stdout,
        ),
      ).toMatchObject({
        ok: true,
        data: { projection: { workerRuns: { [worker.data.runId]: { status: "completed" } } } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns structured errors", async () => {
    const dir = await tmp();
    try {
      const result = await runCli(["--data-dir", dir, "workspace", "show", "missing"]);
      expect(result.exitCode).toBe(1);
      expect(json(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "workspace_not_found" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
