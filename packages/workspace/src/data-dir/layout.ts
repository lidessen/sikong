import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SIKONG_DATA_DIR_ENV = "SIKONG_DATA_DIR";

export type DataDirResolutionSource = "flag" | "SIKONG_DATA_DIR" | "default";

export interface DataDirResolution {
  dir: string;
  source: DataDirResolutionSource;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[SIKONG_DATA_DIR_ENV]?.trim() || join(homedir(), ".sikong");
}

export function resolveDataDir(
  opts: { dataDir?: string; env?: NodeJS.ProcessEnv } = {},
): DataDirResolution {
  const env = opts.env ?? process.env;
  if (opts.dataDir) return { dir: opts.dataDir, source: "flag" };
  const fromEnv = env[SIKONG_DATA_DIR_ENV]?.trim();
  if (fromEnv) return { dir: fromEnv, source: "SIKONG_DATA_DIR" };
  return { dir: defaultDataDir(env), source: "default" };
}

export function safeWorkspaceSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function workspaceDir(dataDir: string, workspaceId: string): string {
  return join(dataDir, "workspaces", safeWorkspaceSegment(workspaceId));
}

export function workspaceFile(dataDir: string, workspaceId: string): string {
  return join(workspaceDir(dataDir, workspaceId), "workspace.yaml");
}

export function preferencesFile(dataDir: string, workspaceId: string): string {
  return join(workspaceDir(dataDir, workspaceId), "preferences.yaml");
}

export function configFile(dataDir: string): string {
  return join(dataDir, "config.yaml");
}

export function taskEventsDir(dataDir: string, workspaceId: string): string {
  return join(workspaceDir(dataDir, workspaceId), "state", "events");
}

export function taskEventsFile(dataDir: string, workspaceId: string, taskId: string): string {
  return join(taskEventsDir(dataDir, workspaceId), `${safeWorkspaceSegment(taskId)}.jsonl`);
}

export function taskEventsLockFile(dataDir: string, workspaceId: string, taskId: string): string {
  return join(taskEventsDir(dataDir, workspaceId), `${safeWorkspaceSegment(taskId)}.jsonl.lock`);
}

export function taskProjectionsDir(dataDir: string, workspaceId: string): string {
  return join(workspaceDir(dataDir, workspaceId), "state", "projections");
}

export function taskProjectionFile(dataDir: string, workspaceId: string, taskId: string): string {
  return join(taskProjectionsDir(dataDir, workspaceId), `${safeWorkspaceSegment(taskId)}.json`);
}

export function taskObservationsDir(dataDir: string, workspaceId: string, taskId: string): string {
  return join(
    workspaceDir(dataDir, workspaceId),
    "state",
    "observations",
    safeWorkspaceSegment(taskId),
  );
}

export function taskObservationsFile(
  dataDir: string,
  workspaceId: string,
  taskId: string,
  runId: string,
): string {
  return join(
    taskObservationsDir(dataDir, workspaceId, taskId),
    `${safeWorkspaceSegment(runId)}.jsonl`,
  );
}

export function worktreesDir(dataDir: string, workspaceId: string): string {
  return join(workspaceDir(dataDir, workspaceId), "worktrees");
}

export function worktreeDir(dataDir: string, workspaceId: string, taskId: string): string {
  return join(worktreesDir(dataDir, workspaceId), safeWorkspaceSegment(taskId));
}

export function taskRuntimeDirs(dataDir: string, workspaceId: string): string {
  return join(workspaceDir(dataDir, workspaceId), "tasks");
}

export function taskRuntimeDir(dataDir: string, workspaceId: string, taskId: string): string {
  return join(taskRuntimeDirs(dataDir, workspaceId), safeWorkspaceSegment(taskId));
}

export async function ensureDataDirLayout(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, "state"), { recursive: true });
  await mkdir(join(dataDir, "workspaces"), { recursive: true });
  await mkdir(join(dataDir, "workers"), { recursive: true });
}
