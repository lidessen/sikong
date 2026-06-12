import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { workspaceStateDir } from "../workspace-layout";
import { withFileLock } from "../store/file-lock";
import type { Task, TaskScopes, WorkflowDef } from "../workflow/types";

export type ScopeMode = "read" | "write";

export interface ScopeLease {
  mode: ScopeMode;
  scope: string;
}

export interface ActiveScopeLease extends ScopeLease {
  taskId: string;
  wakeId: string;
  projectId: string;
  ownerPid?: number;
  acquiredAt: number;
  expiresAt: number;
}

export interface ScopeLeaseConflict {
  requested: ActiveScopeLease;
  active: ActiveScopeLease;
}

export type ScopeLeaseAcquireResult =
  | { acquired: true; leases: readonly ActiveScopeLease[] }
  | { acquired: false; conflicts: readonly ScopeLeaseConflict[] };

export interface ScopeLeaseStore {
  acquire(input: {
    taskId: string;
    wakeId: string;
    projectId: string;
    leases: readonly ScopeLease[];
    ttlMs: number;
    ownerPid?: number;
  }): Promise<ScopeLeaseAcquireResult>;
  release(taskId: string, wakeId: string): Promise<void>;
  refresh(taskId: string, wakeId: string, ttlMs: number): Promise<void>;
  list(): Promise<ActiveScopeLease[]>;
}

export function cleanScope(scope: string): string {
  return scope.trim().replaceAll(/\/+/g, "/").replace(/\/$/, "");
}

export function validScope(scope: string): boolean {
  const cleaned = cleanScope(scope);
  return /^[a-z][a-z0-9_-]*:[^\s]+$/i.test(cleaned);
}

export function normalizeTaskScopes(scopes: TaskScopes | undefined): TaskScopes | undefined {
  const read = [...new Set((scopes?.read ?? []).map(cleanScope).filter(Boolean))];
  const write = [...new Set((scopes?.write ?? []).map(cleanScope).filter(Boolean))];
  if (!read.length && !write.length) return undefined;
  return {
    ...(read.length ? { read } : {}),
    ...(write.length ? { write } : {}),
  };
}

export function effectiveTaskScopeLeases(task: Task, wf: WorkflowDef): ScopeLease[] {
  const scopes = normalizeTaskScopes(task.scopes);
  if (!scopes) {
    return [{ mode: wf.workerRole ? "write" : "read", scope: `project:${task.projectId}` }];
  }
  return [
    ...(scopes.read ?? []).map((scope) => ({ mode: "read" as const, scope })),
    ...(scopes.write ?? []).map((scope) => ({ mode: "write" as const, scope })),
  ];
}

function scopeType(scope: string): string {
  const idx = scope.indexOf(":");
  return idx < 0 ? scope : scope.slice(0, idx);
}

function scopeValue(scope: string): string {
  const idx = scope.indexOf(":");
  return idx < 0 ? "" : scope.slice(idx + 1);
}

function sameOrAncestor(a: string, b: string): boolean {
  if (a === b) return true;
  const at = scopeType(a);
  const bt = scopeType(b);
  if (at !== bt) return false;
  const av = scopeValue(a);
  const bv = scopeValue(b);
  return av.length > 0 && (bv.startsWith(`${av}/`) || av.startsWith(`${bv}/`));
}

export function scopeLeasesConflict(a: ActiveScopeLease, b: ActiveScopeLease): boolean {
  if (a.mode === "read" && b.mode === "read") return false;
  if (a.scope === b.scope) return true;
  const at = scopeType(a.scope);
  const bt = scopeType(b.scope);
  if (at === "project" || bt === "project") {
    const projectScope = at === "project" ? a : b;
    const other = projectScope === a ? b : a;
    return scopeValue(projectScope.scope) === other.projectId;
  }
  if (a.projectId !== b.projectId) return false;
  return sameOrAncestor(a.scope, b.scope);
}

function isExpired(lease: ActiveScopeLease, now: number): boolean {
  return lease.expiresAt <= now;
}

export class JsonScopeLeaseStore implements ScopeLeaseStore {
  constructor(
    private readonly dir: string,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private get file(): string {
    return join(workspaceStateDir(this.dir), "scope-leases.json");
  }

  private async readActive(now = this.clock()): Promise<ActiveScopeLease[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as ActiveScopeLease[];
      return Array.isArray(parsed) ? parsed.filter((lease) => !isExpired(lease, now)) : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async writeActive(leases: readonly ActiveScopeLease[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(leases, null, 2));
    await rename(tmp, this.file);
  }

  async acquire(input: {
    taskId: string;
    wakeId: string;
    projectId: string;
    leases: readonly ScopeLease[];
    ttlMs: number;
    ownerPid?: number;
  }): Promise<ScopeLeaseAcquireResult> {
    return await withFileLock(this.file, async () => {
      const now = this.clock();
      const active = (await this.readActive(now)).filter(
        (lease) => !(lease.taskId === input.taskId && lease.wakeId === input.wakeId),
      );
      const requested = input.leases.map((lease): ActiveScopeLease => ({
        taskId: input.taskId,
        wakeId: input.wakeId,
        projectId: input.projectId,
        mode: lease.mode,
        scope: cleanScope(lease.scope),
        ...(input.ownerPid !== undefined ? { ownerPid: input.ownerPid } : {}),
        acquiredAt: now,
        expiresAt: now + input.ttlMs,
      }));
      const conflicts: ScopeLeaseConflict[] = [];
      for (const req of requested) {
        for (const act of active) {
          if (scopeLeasesConflict(req, act)) conflicts.push({ requested: req, active: act });
        }
      }
      if (conflicts.length) {
        await this.writeActive(active);
        return { acquired: false, conflicts };
      }
      await this.writeActive([...active, ...requested]);
      return { acquired: true, leases: requested };
    });
  }

  async release(taskId: string, wakeId: string): Promise<void> {
    await withFileLock(this.file, async () => {
      const now = this.clock();
      const active = (await this.readActive(now)).filter(
        (lease) => !(lease.taskId === taskId && lease.wakeId === wakeId),
      );
      await this.writeActive(active);
    });
  }

  async refresh(taskId: string, wakeId: string, ttlMs: number): Promise<void> {
    await withFileLock(this.file, async () => {
      const now = this.clock();
      const active = (await this.readActive(now)).map((lease) =>
        lease.taskId === taskId && lease.wakeId === wakeId ? { ...lease, expiresAt: now + ttlMs } : lease,
      );
      await this.writeActive(active);
    });
  }

  async list(): Promise<ActiveScopeLease[]> {
    return await withFileLock(this.file, async () => {
      const active = await this.readActive();
      await this.writeActive(active);
      return active;
    });
  }
}
