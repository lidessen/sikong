import type { ProcessRunSnapshot, ProcessRunSpec } from "../process";

export interface OrchestrationProcessClient {
  startProcess(spec: ProcessRunSpec): Promise<ProcessRunSnapshot>;
}

export interface OrchestrationProcessSpecInput {
  runId: string;
  workspaceId: string;
  taskId?: string;
  requestPath: string;
  cwd?: string;
  command?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export function createOrchestrationProcessSpec(
  input: OrchestrationProcessSpecInput,
): ProcessRunSpec {
  return {
    runId: input.runId,
    workspaceId: input.workspaceId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    command: input.command ?? "bun",
    args: ["./src/orchestration/runner.ts", "--spec", input.requestPath],
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.env ? { env: input.env } : {}),
  };
}

export async function startOrchestrationProcess(
  client: OrchestrationProcessClient,
  input: OrchestrationProcessSpecInput,
): Promise<ProcessRunSnapshot> {
  return await client.startProcess(createOrchestrationProcessSpec(input));
}
