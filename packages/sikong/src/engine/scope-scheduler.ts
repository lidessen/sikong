import { effectiveTaskScopeLeases, type ScopeLease, type ScopeLeaseConflict, type ScopeLeaseStore } from "./scope-lease";
import type { Task, WorkflowDef } from "../workflow/types";

const SCOPE_LEASE_TTL_MS = 30 * 60 * 1000;
const SCOPE_LEASE_REFRESH_INTERVAL_MS = 60_000; // refresh every 60s

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
  /** Active refresh timers keyed by taskId. */
  private readonly refreshTimers = new Map<string, ReturnType<typeof setInterval>>();

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
    this.stopRefresh(taskId);
    await this.store.release(taskId, wakeId);
    if (this.waiters.size === 0) return [];
    const ids = [...this.waiters];
    this.waiters.clear();
    return ids;
  }

  /**
   * Start a periodic lease refresh loop for a running wake. Prevents the lease
   * from expiring while the wake is active. Call in the wake's startup path
   * after acquiring leases; call `stopRefresh` on wake end.
   */
  startRefresh(taskId: string, wakeId: string): void {
    if (this.refreshTimers.has(taskId)) return; // already refreshing
    const timer = setInterval(() => {
      void this.store.refresh(taskId, wakeId, SCOPE_LEASE_TTL_MS).catch(() => {
        // best-effort: if refresh fails, the lease will expire naturally
      });
    }, SCOPE_LEASE_REFRESH_INTERVAL_MS);
    this.refreshTimers.set(taskId, timer);
  }

  /** Stop the lease refresh loop for a task. */
  stopRefresh(taskId: string): void {
    const timer = this.refreshTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.refreshTimers.delete(taskId);
    }
  }

  /** Stop all refresh loops (engine shutdown). */
  stopAllRefreshes(): void {
    for (const [taskId] of this.refreshTimers) this.stopRefresh(taskId);
  }

  /**
   * Check whether any waiting tasks can now acquire their leases (because
   * conflicting leases expired or were released by another process). Returns
   * task ids that should be re-scheduled.
   */
  async checkWaiters(): Promise<string[]> {
    if (this.waiters.size === 0) return [];
    // Read all active leases to trigger cleanup of expired ones
    const active = await this.store.list();
    const released: string[] = [];
    for (const taskId of this.waiters) {
      // We can't re-check without the original task/wf context, but we can
      // surface the task id so the engine reloads it from the event log and
      // re-attempts acquisition in the next wake cycle.
      released.push(taskId);
    }
    this.waiters.clear();
    return released;
  }
}
