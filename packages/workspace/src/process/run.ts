import type { ProcessRunResult, ProcessRunSpec } from "./types";

export interface RunProcessOptions {
  now?: () => Date;
}

export async function runProcess(
  spec: ProcessRunSpec,
  opts: RunProcessOptions = {},
): Promise<ProcessRunResult> {
  validateProcessRunSpec(spec);

  const now = opts.now ?? (() => new Date());
  const started = now();
  const startedAt = started.toISOString();
  const startedMs = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  if (spec.timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, spec.timeoutMs);
  }

  const proc = Bun.spawn([spec.command, ...(spec.args ?? [])], {
    cwd: spec.cwd,
    env: {
      ...process.env,
      ...spec.env,
    },
    stdin: spec.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    signal: controller.signal,
  });

  if (spec.stdin !== undefined && proc.stdin) {
    await proc.stdin.write(spec.stdin);
    proc.stdin.end();
  }

  const [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);

  let exitCode: number | undefined;
  try {
    exitCode = await proc.exited;
  } catch (err) {
    if (!timedOut) throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  const finishedAt = now().toISOString();
  const status = timedOut ? "timed_out" : exitCode === 0 ? "succeeded" : "failed";

  return {
    runId: spec.runId,
    workspaceId: spec.workspaceId,
    ...(spec.taskId ? { taskId: spec.taskId } : {}),
    status,
    command: spec.command,
    args: spec.args ?? [],
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    ...(spec.labels ? { labels: spec.labels } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    stdout,
    stderr,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.now() - startedMs),
    ...(timedOut ? { timedOut: true } : {}),
  };
}

export function validateProcessRunSpec(spec: ProcessRunSpec): void {
  if (!spec.runId.trim()) throw new Error("process runId must be non-empty");
  if (!spec.workspaceId.trim()) throw new Error("process workspaceId must be non-empty");
  if (!spec.command.trim()) throw new Error("process command must be non-empty");
  if (spec.timeoutMs !== undefined && spec.timeoutMs <= 0) {
    throw new Error("process timeoutMs must be positive");
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}
