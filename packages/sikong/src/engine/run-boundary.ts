import { emptyUsage, type CleanupResult, type RunHandle, type RunResult } from "agent-loop";

export const INTAKE_TIMEOUT_MS = 90_000;

const RUN_CLEANUP_GRACE_MS = 1_000;
const RUN_CLEANUP_TIMEOUT_MS = RUN_CLEANUP_GRACE_MS + 250;

function erroredResult(error: Error): RunResult {
  return {
    events: [],
    usage: emptyUsage(),
    durationMs: 0,
    status: "error",
    error,
    text: "",
  };
}

export async function boundedRun(
  consume: Promise<RunResult>,
  ms: number | undefined,
  onTimeout: () => void | CleanupResult | Promise<void | CleanupResult>,
  onCleanup?: (cleanup: CleanupResult) => void | Promise<void>,
): Promise<RunResult> {
  const safe = consume.catch((err) => erroredResult(err instanceof Error ? err : new Error(String(err))));
  if (!ms) return safe;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const emitCleanup = async (cleanup: CleanupResult): Promise<void> => {
    await Promise.resolve(onCleanup?.(cleanup)).catch(() => {});
  };
  const timeout = new Promise<RunResult>((resolve) => {
    timer = setTimeout(() => void (async () => {
      const cleanup = await Promise.resolve(onTimeout()).catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        return {
          status: "unsettled" as const,
          reason: "timeout",
          elapsedMs: 0,
          hardKill: false,
          error: error.message,
        };
      });
      if (cleanup) await emitCleanup(cleanup);
      resolve(erroredResult(new Error(`wake timed out after ${ms}ms`)));
    })(), ms);
  });
  const result = await Promise.race([safe, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

export async function cleanupRun(run: RunHandle, reason: string): Promise<CleanupResult> {
  const startedAt = Date.now();
  const cleanup = run
    .cleanup({ reason, graceMs: RUN_CLEANUP_GRACE_MS, hardKill: false })
    .catch((err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        status: "unsettled" as const,
        reason,
        elapsedMs: Date.now() - startedAt,
        hardKill: false,
        error: error.message,
      };
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CleanupResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        status: "unsettled",
        reason,
        elapsedMs: Date.now() - startedAt,
        hardKill: false,
        error: `cleanup did not settle within ${RUN_CLEANUP_TIMEOUT_MS}ms`,
      });
    }, RUN_CLEANUP_TIMEOUT_MS);
  });
  const result = await Promise.race([cleanup, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
