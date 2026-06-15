import { mkdir } from "node:fs/promises";
import { taskRuntimeDir } from "../data-dir";

export interface TaskRuntimeDirInput {
  dataDir: string;
  workspaceId: string;
  taskId: string;
}

export interface TaskRuntimeDirAllocation {
  cwd: string;
}

export async function allocateTaskRuntimeDir(
  input: TaskRuntimeDirInput,
): Promise<TaskRuntimeDirAllocation> {
  const cwd = taskRuntimeDir(input.dataDir, input.workspaceId, input.taskId);
  await mkdir(cwd, { recursive: true });
  return { cwd };
}
