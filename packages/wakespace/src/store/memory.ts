import { assertValidWorkflow } from "../workflow/validate";
import type { NewEvent, Task, TaskEvent, TaskStatus, WorkflowDef } from "../workflow/types";
import { DEFAULT_PROJECT, type Project } from "../project";
import type { Worker } from "../worker";
import type {
  ChronicleEntry,
  ChronicleQuery,
  ChronicleStore,
  EventStore,
  ProjectionStore,
  ProjectStore,
  TaskQuery,
  WorkerStore,
  WorkflowRegistry,
} from "./types";

/** In-memory `WorkerStore` (no builtins). */
export class MemoryWorkerStore implements WorkerStore {
  private readonly workers = new Map<string, Worker>();
  constructor(seed: readonly Worker[] = []) {
    for (const w of seed) this.workers.set(w.id, w);
  }
  async get(id: string): Promise<Worker | null> {
    return this.workers.get(id) ?? null;
  }
  async put(worker: Worker): Promise<void> {
    this.workers.set(worker.id, worker);
  }
  async list(): Promise<Worker[]> {
    return [...this.workers.values()];
  }
}

/** In-memory `ProjectStore`. Seeded with the builtin `default` project. */
export class MemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, Project>();
  constructor(seed: readonly Project[] = [DEFAULT_PROJECT]) {
    for (const p of seed) this.projects.set(p.id, p);
  }
  async get(id: string): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }
  async put(project: Project): Promise<void> {
    this.projects.set(project.id, project);
  }
  async list(): Promise<Project[]> {
    return [...this.projects.values()];
  }
}

/** Matches a chronicle entry against a query (shared by memory + jsonl stores). */
export function matchesChronicle(entry: ChronicleEntry, query: ChronicleQuery = {}): boolean {
  if (query.taskId !== undefined && entry.taskId !== query.taskId) return false;
  if (query.type !== undefined) {
    const types = Array.isArray(query.type) ? query.type : [query.type];
    if (!types.includes(entry.type)) return false;
  }
  return true;
}

/** In-memory `EventStore`. Assigns `seq` (1-based) and `ts` on append. */
export class MemoryEventStore implements EventStore {
  private readonly logs = new Map<string, TaskEvent[]>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  async append(taskId: string, events: readonly NewEvent[]): Promise<TaskEvent[]> {
    const log = this.logs.get(taskId) ?? [];
    const stamped: TaskEvent[] = events.map((e, i) => ({
      ...e,
      taskId,
      seq: log.length + i + 1,
      ts: this.clock(),
    }));
    this.logs.set(taskId, [...log, ...stamped]);
    return stamped;
  }

  async load(taskId: string, fromSeq = 0): Promise<TaskEvent[]> {
    const log = this.logs.get(taskId) ?? [];
    return fromSeq > 0 ? log.filter((e) => e.seq > fromSeq) : [...log];
  }
}

/** In-memory `ProjectionStore`. */
export class MemoryProjectionStore implements ProjectionStore {
  private readonly tasks = new Map<string, Task>();

  async get(taskId: string): Promise<Task | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async put(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async query(filter: TaskQuery = {}): Promise<Task[]> {
    const status = filter.status
      ? new Set<TaskStatus>(Array.isArray(filter.status) ? filter.status : [filter.status])
      : undefined;
    return [...this.tasks.values()].filter(
      (t) =>
        (filter.projectId === undefined || t.projectId === filter.projectId) &&
        (filter.workflowId === undefined || t.workflowId === filter.workflowId) &&
        (filter.parentId === undefined || t.parentId === filter.parentId) &&
        (status === undefined || status.has(t.status)),
    );
  }
}

/** In-memory `ChronicleStore`. */
export class MemoryChronicleStore implements ChronicleStore {
  private readonly entries: ChronicleEntry[] = [];

  constructor(private readonly clock: () => number = () => Date.now()) {}

  async append(entry: Omit<ChronicleEntry, "seq" | "ts">): Promise<ChronicleEntry> {
    const full: ChronicleEntry = { ...entry, seq: this.entries.length + 1, ts: this.clock() };
    this.entries.push(full);
    return full;
  }

  async recent(query: ChronicleQuery = {}): Promise<ChronicleEntry[]> {
    const limit = query.limit ?? 50;
    return this.entries
      .filter((e) => matchesChronicle(e, query))
      .sort((a, b) => b.seq - a.seq || b.ts - a.ts)
      .slice(0, limit);
  }
}

/**
 * In-memory `WorkflowRegistry`. Seeded with a fallback (GENERAL) workflow.
 * `match` is a naive substring router for M0 — the real intake classifier is M3.
 */
export class MemoryWorkflowRegistry implements WorkflowRegistry {
  private readonly byKey = new Map<string, WorkflowDef>(); // `${id}@${version}`
  private readonly latest = new Map<string, string>(); // id -> version

  constructor(private readonly fallback: WorkflowDef) {
    this.register(fallback);
  }

  register(def: WorkflowDef): void {
    assertValidWorkflow(def);
    this.byKey.set(`${def.id}@${def.version}`, def);
    this.latest.set(def.id, def.version);
  }

  get(id: string, version?: string): WorkflowDef | undefined {
    const v = version ?? this.latest.get(id);
    return v ? this.byKey.get(`${id}@${v}`) : undefined;
  }

  match(input: string): WorkflowDef {
    const needle = input.toLowerCase();
    for (const def of this.list())
      if (def.id !== this.fallback.id && needle.includes(def.name.toLowerCase())) return def;
    return this.fallback;
  }

  list(): WorkflowDef[] {
    return [...this.latest.entries()].flatMap(([id, v]) => {
      const def = this.byKey.get(`${id}@${v}`);
      return def ? [def] : [];
    });
  }
}
