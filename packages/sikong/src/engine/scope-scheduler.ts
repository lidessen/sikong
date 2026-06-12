import { effectiveTaskScopeLeases, type ScopeLease, type ScopeLeaseConflict, type ScopeLeaseStore } from "./scope-lease";
import type { Task, WorkflowDef } from "../workflow/types";

const SCOPE_LEASE_TTL_MS = 30 * 60 * 1000;

export type ScopeAcquireResult =
  | { acquired: true }
  | {
      acquired: false;
      summary: string;
      data: Record<string, unknown>;
    };

function summarizeScopeLeases(leases: readonly ScopeLease[]): string {
  return leases.map((lease) => `${lease.mode}:${lease.scope}`).join(", ");
}

function summarizeScopeConflicts(conflicts: readonly ScopeLeaseConflict[]): Record<string, unknown>[] {
  return conflicts.slice(0, 20).map((conflict) => ({
    requested: `${conflict.requested.mode}:${conflict.requested.scope}`,
    active: `${conflict.active.mode}:${conflict.active.scope}`,
    activeTaskId: conflict.active.taskId,
    activeWakeId: conflict.active.wakeId,
    projectId: conflict.active.projectId,
    expiresAt: conflict.active.expiresAt,
  }));
}

export class ScopeLeaseScheduler {
  private readonly waiters = new Set<string>();

  constructor(
    private readonly store: ScopeLeaseStore,
    private readonly ownerPid: number | undefined = process.pid,
  ) {}

  async acquire(task: Task, wf: WorkflowDef, wakeId: string): Promise<ScopeAcquireResult> {
    const requested = effectiveTaskScopeLeases(task, wf);
    const acquired = await this.store.acquire({
      taskId: task.id,
      wakeId,
      projectId: task.projectId,
      leases: requested,
      ttlMs: SCOPE_LEASE_TTL_MS,
      ...(this.ownerPid !== undefined ? { ownerPid: this.ownerPid } : {}),
    });
    if (acquired.acquired) return { acquired: true };

    this.waiters.add(task.id);
    return {
      acquired: false,
      summary: `wake waiting for scope leases: ${summarizeScopeLeases(requested)}`,
      data: { requested, conflicts: summarizeScopeConflicts(acquired.conflicts) },
    };
  }

  async release(taskId: string, wakeId: string): Promise<string[]> {
    await this.store.release(taskId, wakeId);
    if (this.waiters.size === 0) return [];
    const ids = [...this.waiters];
    this.waiters.clear();
    return ids;
  }
}
