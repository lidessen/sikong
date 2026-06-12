import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function staleLock(lockDir: string, staleMs: number): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as {
      pid?: number;
      ts?: number;
    };
    if (typeof owner.ts !== "number" || Date.now() - owner.ts > staleMs) return true;
    if (typeof owner.pid === "number" && !pidAlive(owner.pid)) return true;
    return false;
  } catch {
    try {
      const info = await stat(lockDir);
      return Date.now() - info.mtimeMs > staleMs;
    } catch {
      return true;
    }
  }
}

/** Cross-process, short critical-section lock for file-backed stores. */
export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T>,
  opts: { staleMs?: number; retryMs?: number } = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const lockDir = `${target}.lock`;
  for (;;) {
    try {
      await mkdir(dirname(lockDir), { recursive: true });
      await mkdir(lockDir);
      await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await staleLock(lockDir, staleMs)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      await sleep(retryMs);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}
