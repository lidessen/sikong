import type { Task, TaskStatus } from "../workflow/types";

/**
 * Priority for a wake. Higher priority wakes run first.
 *   - "critical": lead review, acceptance, or blocking tasks
 *   - "high": subtasks with dependents waiting on them
 *   - "normal": default
 *   - "low": best-effort background work
 */
export type WakePriority = "critical" | "high" | "normal" | "low";

const PRIORITY_ORDER: Record<WakePriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export interface WakeQueueEntry {
  taskId: string;
  priority: WakePriority;
  /** Smaller depth (closer to root) runs first. */
  depth: number;
  /** ISO timestamp of when the task was created. */
  createdAt: number;
  /** How many times this task has been queued (for debugging). */
  enqueueCount: number;
}

export interface WakeQueueOptions {
  /** Max concurrent wakes. Default 4. */
  maxConcurrent?: number;
  /** Max queue depth — new enqueue when full throws. Default 200. */
  maxQueueDepth?: number;
}

const DEFAULT_QUEUE_OPTIONS: Required<WakeQueueOptions> = {
  maxConcurrent: 4,
  maxQueueDepth: 200,
};

/**
 * A priority queue for task wake scheduling. Replaces the engine's ad-hoc
 * `schedule()` → `kick()` path with a proper priority-ordered dispatch.
 *
 * Wakes are ordered by (priority, depth, createdAt) — higher priority first,
 * then shallower depth, then older tasks.
 */
export class WakeQueue {
  private readonly queue: WakeQueueEntry[] = [];
  private inFlight = new Set<string>();
  private readonly opts: Required<WakeQueueOptions>;
  /** Called when a task should be woken. */
  private readonly dispatcher: (taskId: string) => void;

  constructor(
    dispatcher: (taskId: string) => void,
    opts?: WakeQueueOptions,
  ) {
    this.dispatcher = dispatcher;
    this.opts = { ...DEFAULT_QUEUE_OPTIONS, ...opts };
  }

  /** Enqueue a task for waking. Idempotent — if already queued or in flight, no-op. */
  enqueue(taskId: string, priority: WakePriority = "normal", depth: number = 0, createdAt?: number): boolean {
    if (this.inFlight.has(taskId)) return true; // already running
    if (this.queue.some((e) => e.taskId === taskId)) return true; // already queued
    if (this.queue.length >= this.opts.maxQueueDepth) return false; // backpressure

    this.queue.push({
      taskId,
      priority,
      depth,
      createdAt: createdAt ?? Date.now(),
      enqueueCount: 0,
    });
    this.sort();
    this.drain();
    return true;
  }

  /** Mark a task as done (remove from in-flight and drain next). */
  complete(taskId: string): void {
    this.inFlight.delete(taskId);
    this.drain();
  }

  /** Mark a task as started (moves from queue to in-flight). */
  private start(taskId: string): boolean {
    const idx = this.queue.findIndex((e) => e.taskId === taskId);
    if (idx < 0) return false;
    this.queue.splice(idx, 1);
    this.inFlight.add(taskId);
    return true;
  }

  /** True if a task is queued or in flight. */
  isPending(taskId: string): boolean {
    return this.inFlight.has(taskId) || this.queue.some((e) => e.taskId === taskId);
  }

  /** Remove a cancelled task from both queue and in-flight. */
  remove(taskId: string): void {
    this.inFlight.delete(taskId);
    const idx = this.queue.findIndex((e) => e.taskId === taskId);
    if (idx >= 0) this.queue.splice(idx, 1);
  }

  /** Number of tasks currently queued (not yet started). */
  get queued(): number {
    return this.queue.length;
  }

  /** Number of tasks currently in flight (running). */
  get running(): number {
    return this.inFlight.size;
  }

  /** Clear all queued (not in-flight) tasks. */
  clear(): void {
    this.queue.length = 0;
  }

  /** Cancel all queued and in-flight tasks. */
  cancelAll(): void {
    this.clear();
    this.inFlight.clear();
  }

  private sort(): void {
    this.queue.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (pa !== 0) return pa;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.createdAt - b.createdAt;
    });
  }

  private drain(): void {
    while (this.inFlight.size < this.opts.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue[0]!;
      if (!this.start(entry.taskId)) break;
      this.dispatcher(entry.taskId);
    }
  }
}
