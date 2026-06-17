import { mkdir, writeFile } from "node:fs/promises";
import { daemonDir, schedulerSignalFile } from "./layout";

export async function touchSchedulerSignal(dataDir: string): Promise<void> {
  const file = schedulerSignalFile(dataDir);
  await mkdir(daemonDir(dataDir), { recursive: true });
  await writeFile(file, `${new Date().toISOString()}\n`);
}
