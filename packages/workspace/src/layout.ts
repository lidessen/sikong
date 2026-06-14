import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SIKONG_HOME_ENV = "SIKONG_HOME";

export type HomeDirResolutionSource = "flag" | "SIKONG_HOME" | "default";

export interface HomeDirResolution {
  dir: string;
  source: HomeDirResolutionSource;
}

export function defaultHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[SIKONG_HOME_ENV]?.trim() || join(homedir(), ".sikong");
}

export function resolveHomeDir(
  opts: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): HomeDirResolution {
  const env = opts.env ?? process.env;
  if (opts.homeDir) return { dir: opts.homeDir, source: "flag" };
  const fromEnv = env[SIKONG_HOME_ENV]?.trim();
  if (fromEnv) return { dir: fromEnv, source: "SIKONG_HOME" };
  return { dir: defaultHomeDir(env), source: "default" };
}

export function safeWorkspaceSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function workspaceDir(homeDir: string, workspaceId: string): string {
  return join(homeDir, "workspaces", safeWorkspaceSegment(workspaceId));
}

export function workspaceFile(homeDir: string, workspaceId: string): string {
  return join(workspaceDir(homeDir, workspaceId), "workspace.yaml");
}

export function preferencesFile(homeDir: string, workspaceId: string): string {
  return join(workspaceDir(homeDir, workspaceId), "preferences.yaml");
}

export function taskEventsDir(homeDir: string, workspaceId: string): string {
  return join(workspaceDir(homeDir, workspaceId), "state", "events");
}

export function taskProjectionsDir(homeDir: string, workspaceId: string): string {
  return join(workspaceDir(homeDir, workspaceId), "state", "projections");
}

export function worktreesDir(homeDir: string, workspaceId: string): string {
  return join(workspaceDir(homeDir, workspaceId), "worktrees");
}

export function worktreeDir(homeDir: string, workspaceId: string, taskId: string): string {
  return join(worktreesDir(homeDir, workspaceId), safeWorkspaceSegment(taskId));
}

export async function ensureHomeLayout(homeDir: string): Promise<void> {
  await mkdir(join(homeDir, "state"), { recursive: true });
  await mkdir(join(homeDir, "workspaces"), { recursive: true });
  await mkdir(join(homeDir, "workers"), { recursive: true });
}
