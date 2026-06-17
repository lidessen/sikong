import {
  compactTaskView,
  taskProjectionsDir,
  type TaskCompactView,
  type TaskProjection,
} from "@sikong/workspace";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface WorkspaceRuntimeFacts {
  total: number;
  active: number;
  hasGit: boolean;
  hasDirectory: boolean;
}

export interface WorkspaceProjectionSnapshot {
  facts: WorkspaceRuntimeFacts;
  taskCards: TaskCompactView[];
}

interface CacheEntry {
  mtimeMs: number;
  snapshot: WorkspaceProjectionSnapshot;
}

const cache = new Map<string, CacheEntry>();

export function invalidateWorkspaceProjectionCache(workspaceId?: string): void {
  if (workspaceId) {
    cache.delete(workspaceId);
    return;
  }
  cache.clear();
}

export async function loadWorkspaceProjectionSnapshot(
  dataDir: string,
  workspaceId: string,
): Promise<WorkspaceProjectionSnapshot> {
  const dir = taskProjectionsDir(dataDir, workspaceId);
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(dir)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptySnapshot();
    }
    throw err;
  }

  const cached = cache.get(workspaceId);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.snapshot;
  }

  const snapshot = await scanWorkspaceProjections(dir);
  cache.set(workspaceId, { mtimeMs, snapshot });
  return snapshot;
}

async function scanWorkspaceProjections(dir: string): Promise<WorkspaceProjectionSnapshot> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptySnapshot();
    }
    throw err;
  }

  const taskCards: TaskCompactView[] = [];
  let active = 0;
  let hasGit = false;
  let hasDirectory = false;

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const projection = JSON.parse(await readFile(join(dir, entry), "utf8")) as TaskProjection;
    if (!projection.terminal) active += 1;
    if (projection.runtime?.repoPath) hasGit = true;
    if (projection.runtime?.cwd) hasDirectory = true;
    taskCards.push(compactTaskView(projection));
  }

  taskCards.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  return {
    facts: {
      total: taskCards.length,
      active,
      hasGit,
      hasDirectory,
    },
    taskCards,
  };
}

function emptySnapshot(): WorkspaceProjectionSnapshot {
  return {
    facts: { total: 0, active: 0, hasGit: false, hasDirectory: false },
    taskCards: [],
  };
}
