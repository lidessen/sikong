import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SIKONG_HOME_ENV = "SIKONG_HOME";
export const SIKONG_DIR_ENV = "SIKONG_DIR";

export type WorkspaceDirSource = "flag" | "SIKONG_DIR" | "SIKONG_HOME" | "default";

export interface ResolvedWorkspaceDir {
  dir: string;
  source: WorkspaceDirSource;
}

export function defaultWorkspaceHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env[SIKONG_HOME_ENV]?.trim();
  return home || join(homedir(), ".sikong");
}

export function resolveWorkspaceDir(opts: { dirFlag?: string; env?: NodeJS.ProcessEnv } = {}): ResolvedWorkspaceDir {
  const env = opts.env ?? process.env;
  if (opts.dirFlag) return { dir: opts.dirFlag, source: "flag" };
  const legacy = env[SIKONG_DIR_ENV]?.trim();
  if (legacy) return { dir: legacy, source: "SIKONG_DIR" };
  const home = env[SIKONG_HOME_ENV]?.trim();
  if (home) return { dir: home, source: "SIKONG_HOME" };
  return { dir: defaultWorkspaceHome(env), source: "default" };
}

export function safeWorkspaceSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function projectDir(root: string, projectId: string): string {
  return join(root, "projects", safeWorkspaceSegment(projectId));
}

export function projectDefinitionRoot(root: string, projectId: string): string {
  return projectDir(root, projectId);
}

export function projectMemoryPath(root: string, projectId: string): string {
  return join(projectDir(root, projectId), "memory.md");
}

export function projectStateDir(root: string, projectId: string): string {
  return join(projectDir(root, projectId), "state");
}

export function workspaceStateDir(root: string): string {
  return join(root, "state");
}

export async function listProjectStateDirs(root: string): Promise<string[]> {
  const dirs = new Set<string>([projectStateDir(root, "default")]);
  let entries: Dirent[];
  try {
    entries = await readdir(join(root, "projects"), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [...dirs];
    throw err;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.add(join(root, "projects", entry.name, "state"));
  }
  return [...dirs];
}
