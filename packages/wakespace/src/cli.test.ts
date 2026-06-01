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
