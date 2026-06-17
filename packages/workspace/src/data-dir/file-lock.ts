import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface FileLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
}

async function isStaleLock(lockFile: string): Promise<boolean> {
  try {
    const raw = await readFile(lockFile, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    if (typeof parsed.pid !== "number" || parsed.pid <= 0) return true;
    try {
      process.kill(parsed.pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}

export async function withFileLock<T>(
  lockFile: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retryDelayMs = opts.retryDelayMs ?? 25;
  const startedAt = Date.now();

  await mkdir(dirname(lockFile), { recursive: true });

  for (;;) {
    try {
      await writeFile(
        lockFile,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
        { flag: "wx" },
      );

      try {
        return await fn();
      } finally {
        await rm(lockFile, { force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await isStaleLock(lockFile)) {
        await rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out acquiring file lock: ${lockFile}`);
      }
      await sleep(retryDelayMs);
    }
  }
}
