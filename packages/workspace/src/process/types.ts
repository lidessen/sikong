export interface ProcessRunSpec {
  runId: string;
  workspaceId: string;
  taskId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  labels?: Record<string, string>;
  stdin?: string;
}

export type ProcessRunStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

export interface ProcessRunResult {
  runId: string;
  workspaceId: string;
  taskId?: string;
  status: ProcessRunStatus;
  command: string;
  args: string[];
  cwd?: string;
  labels?: Record<string, string>;
  exitCode?: number;
  signal?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timedOut?: boolean;
  cancelled?: boolean;
}

export type ProcessRunState = "queued" | "running" | "finished";

export interface ProcessRunSnapshot {
  runId: string;
  workspaceId: string;
  taskId?: string;
  state: ProcessRunState;
  spec: ProcessRunSpec;
  result?: ProcessRunResult;
  error?: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}
