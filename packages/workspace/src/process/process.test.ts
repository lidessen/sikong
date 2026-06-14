import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonProcessClient,
  DaemonProcessClientError,
  runProcess,
  type DaemonProcessFetch,
} from "./index";
import { runProcessRunner } from "./runner";

const tmp = () => mkdtemp(join(tmpdir(), "sikong-process-"));

describe("process runner", () => {
  test("runs a successful subprocess and captures stdout", async () => {
    const result = await runProcess({
      runId: "run_1",
      workspaceId: "sikong",
      command: "bun",
      args: ["-e", "console.log('hello')"],
    });

    expect(result).toMatchObject({
      runId: "run_1",
      workspaceId: "sikong",
      status: "succeeded",
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("captures non-zero exit as failed result", async () => {
    const result = await runProcess({
      runId: "run_2",
      workspaceId: "sikong",
      command: "bun",
      args: ["-e", "console.error('bad'); process.exit(7)"],
    });

    expect(result).toMatchObject({
      status: "failed",
      exitCode: 7,
      stderr: "bad\n",
    });
  });

  test("passes cwd, env, and stdin to subprocess", async () => {
    const dir = await tmp();
    try {
      await writeFile(join(dir, "input.txt"), "from-cwd");
      const result = await runProcess({
        runId: "run_3",
        workspaceId: "sikong",
        command: "bun",
        args: [
          "-e",
          "const stdin = await Bun.stdin.text(); const file = await Bun.file('input.txt').text(); console.log(`${process.env.SIKONG_TEST}:${file}:${stdin}`)",
        ],
        cwd: dir,
        env: { SIKONG_TEST: "env-value" },
        stdin: "stdin-value",
      });

      expect(result).toMatchObject({
        status: "succeeded",
        cwd: dir,
        stdout: "env-value:from-cwd:stdin-value\n",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks subprocess as timed_out", async () => {
    const result = await runProcess({
      runId: "run_4",
      workspaceId: "sikong",
      command: "bun",
      args: ["-e", "await new Promise((resolve) => setTimeout(resolve, 5000))"],
      timeoutMs: 50,
    });

    expect(result.status).toBe("timed_out");
    expect(result.timedOut).toBe(true);
  });

  test("runner reads spec from file", async () => {
    const dir = await tmp();
    try {
      const specFile = join(dir, "spec.json");
      await writeFile(
        specFile,
        JSON.stringify({
          runId: "run_file",
          workspaceId: "sikong",
          command: "bun",
          args: ["-e", "console.log('from-file')"],
        }),
      );

      expect(await runProcessRunner(["--spec", specFile])).toMatchObject({
        ok: true,
        data: {
          runId: "run_file",
          status: "succeeded",
          stdout: "from-file\n",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runner reports invalid spec input", async () => {
    const dir = await tmp();
    try {
      const specFile = join(dir, "bad.json");
      await writeFile(
        specFile,
        JSON.stringify({ runId: "", workspaceId: "sikong", command: "bun" }),
      );

      expect(await runProcessRunner(["--spec", specFile])).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("process-runner entrypoint", () => {
  test("prints stable JSON result", async () => {
    const dir = await tmp();
    try {
      const specFile = join(dir, "spec.json");
      await writeFile(
        specFile,
        JSON.stringify({
          runId: "run_entry",
          workspaceId: "sikong",
          command: "bun",
          args: ["-e", "console.log('entry')"],
        }),
      );

      const proc = Bun.spawn(["bun", "./src/process/runner.ts", "--spec", specFile], {
        cwd: join(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        data: {
          runId: "run_entry",
          status: "succeeded",
          stdout: "entry\n",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("daemon process client", () => {
  test("sends generic process requests to daemon endpoints", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch: DaemonProcessFetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/health")) {
        return Response.json({ ok: true });
      }
      if (url.endsWith("/process-runs")) {
        return Response.json(
          {
            runId: "run_daemon",
            workspaceId: "sikong",
            state: "running",
            spec: JSON.parse(String(init?.body)),
            startedAt: "2026-06-14T00:00:00Z",
          },
          { status: 202 },
        );
      }
      if (url.endsWith("/process-runs/run_daemon/wait?timeoutMs=1000")) {
        return Response.json({
          runId: "run_daemon",
          workspaceId: "sikong",
          state: "finished",
          spec: { runId: "run_daemon", workspaceId: "sikong", command: "bun" },
          result: {
            runId: "run_daemon",
            workspaceId: "sikong",
            status: "succeeded",
            command: "bun",
            args: [],
            exitCode: 0,
            stdout: "ok\n",
            stderr: "",
            startedAt: "2026-06-14T00:00:00Z",
            finishedAt: "2026-06-14T00:00:01Z",
            durationMs: 1,
          },
          startedAt: "2026-06-14T00:00:00Z",
          finishedAt: "2026-06-14T00:00:01Z",
        });
      }
      if (url.endsWith("/process-runs/run_daemon/cancel")) {
        return Response.json({
          runId: "run_daemon",
          workspaceId: "sikong",
          state: "running",
          spec: { runId: "run_daemon", workspaceId: "sikong", command: "bun" },
          startedAt: "2026-06-14T00:00:00Z",
        });
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    };

    const client = new DaemonProcessClient({ baseUrl: "http://127.0.0.1:1234/", fetch: mockFetch });

    await expect(client.health()).resolves.toEqual({ ok: true });
    await expect(
      client.startProcess({
        runId: "run_daemon",
        workspaceId: "sikong",
        command: "bun",
        args: ["--version"],
      }),
    ).resolves.toMatchObject({ runId: "run_daemon", state: "running" });
    await expect(client.waitProcessRun("run_daemon", { timeoutMs: 1000 })).resolves.toMatchObject({
      state: "finished",
      result: { status: "succeeded", stdout: "ok\n" },
    });
    await expect(client.cancelProcessRun("run_daemon")).resolves.toMatchObject({
      runId: "run_daemon",
      state: "running",
    });

    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:1234/health",
      "http://127.0.0.1:1234/process-runs",
      "http://127.0.0.1:1234/process-runs/run_daemon/wait?timeoutMs=1000",
      "http://127.0.0.1:1234/process-runs/run_daemon/cancel",
    ]);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[3]?.init?.method).toBe("POST");
  });

  test("surfaces daemon error responses", async () => {
    const client = new DaemonProcessClient({
      baseUrl: "http://127.0.0.1:1234",
      fetch: async () =>
        Response.json(
          { error: { code: "wait_timeout", message: "still running" } },
          { status: 504 },
        ),
    });

    await expect(client.waitProcessRun("missing")).rejects.toMatchObject({
      name: "DaemonProcessClientError",
      status: 504,
      code: "wait_timeout",
      message: "still running",
    } satisfies Partial<DaemonProcessClientError>);
  });
});
