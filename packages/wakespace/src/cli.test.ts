import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JsonWorkspaceChronicleStore } from "./store";

const tmp = () => mkdtemp(join(tmpdir(), "wakespace-cli-"));
const cliPath = new URL("./cli.ts", import.meta.url).pathname;

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

describe("wakespace CLI", () => {
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
});
