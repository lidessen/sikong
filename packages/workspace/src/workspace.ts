import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureHomeLayout, workspaceDir, workspaceFile } from "./layout";
import { readYamlFile, writeYamlFile } from "./yaml";

export interface WorkspaceDef {
  id: string;
  name: string;
}

export interface WorkspaceStore {
  get(id: string): Promise<WorkspaceDef | null>;
  put(workspace: WorkspaceDef): Promise<void>;
  list(): Promise<WorkspaceDef[]>;
  delete(id: string): Promise<void>;
}

export function isValidWorkspaceId(id: string): boolean {
  return !!id && id !== "." && id !== ".." && /^[A-Za-z0-9._-]+$/.test(id);
}

export function requireValidWorkspace(workspace: WorkspaceDef): void {
  if (!isValidWorkspaceId(workspace.id)) {
    throw new Error(`invalid workspace id "${workspace.id}"`);
  }
  if (!workspace.name.trim()) {
    throw new Error("workspace name must be non-empty");
  }
}

export class FileWorkspaceStore implements WorkspaceStore {
  constructor(private readonly homeDir: string) {}

  async get(id: string): Promise<WorkspaceDef | null> {
    if (!isValidWorkspaceId(id)) return null;
    return await readYamlFile<WorkspaceDef>(workspaceFile(this.homeDir, id));
  }

  async put(workspace: WorkspaceDef): Promise<void> {
    requireValidWorkspace(workspace);
    await ensureHomeLayout(this.homeDir);
    await writeYamlFile(workspaceFile(this.homeDir, workspace.id), workspace);
  }

  async list(): Promise<WorkspaceDef[]> {
    let entries: string[];
    try {
      entries = await readdir(join(this.homeDir, "workspaces"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const out: WorkspaceDef[] = [];
    for (const entry of entries) {
      const workspace = await readYamlFile<WorkspaceDef>(
        join(this.homeDir, "workspaces", entry, "workspace.yaml"),
      );
      if (workspace && isValidWorkspaceId(workspace.id)) out.push(workspace);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async delete(id: string): Promise<void> {
    if (!isValidWorkspaceId(id)) throw new Error(`invalid workspace id "${id}"`);
    await rm(workspaceDir(this.homeDir, id), {
      recursive: true,
      force: true,
    });
  }
}
