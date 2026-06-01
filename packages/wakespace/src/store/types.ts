import type { NewEvent, Task, TaskEvent, TaskStatus, WorkflowDef } from "../workflow/types";
import type { Project } from "../project";
import type { Worker } from "../worker";

/** Durable store of Projects (the container every task lives under). */
export interface ProjectStore {
  get(id: string): Promise<Project | null>;
  put(project: Project): Promise<void>;
  list(): Promise<Project[]>;
}

/** Durable roster of Workers (no builtins — agents discover + create them). */
export interface WorkerStore {
  get(id: string): Promise<Worker | null>;
  put(worker: Worker): Promise<void>;
  list(): Promise<Worker[]>;
}

/** A workspace-level observability record (what the engine/wakes did). */
export type ChronicleType =
  | "task.created"
  | "intake.routed"
  | "wake.start"
  | "wake.commit"
  | "wake.end"
  | "wake.error"
  | "task.advanced"
  | "task.terminal"
  | "command.rejected";

export interface ChronicleEntry {
  seq: number;
  ts: number;
  type: ChronicleType;
  taskId?: string;
  wakeId?: string;
  /** One-line, agent-readable. */
  summary: string;
  data?: Record<string, unknown>;
}

export interface ChronicleQuery {
  limit?: number;
  taskId?: string;
  type?: ChronicleType | readonly ChronicleType[];
}

/**
 * Append-only observability log, distinct from a task's semantic timeline: the
 * timeline is task facts the reducer folds; the chronicle is the engine's
 * activity stream (wakes, errors) an agent/operator reads to understand a run.
 */
export interface ChronicleStore {
  append(entry: Omit<ChronicleEntry, "seq" | "ts">): Promise<ChronicleEntry>;
  /** Newest-first, capped by `limit` (default reasonable). */
  recent(query?: ChronicleQuery): Promise<ChronicleEntry[]>;
}

/**
 * Append-only event log — the system of record. The store assigns each event a
 * monotonic per-task `seq` and a `ts` on append. (M0.5 backs this with JSONL.)
 */
export interface EventStore {
  /** Append events for a task; returns them stamped with `seq` + `ts`. */
  append(taskId: string, events: readonly NewEvent[]): Promise<TaskEvent[]>;
  /** Load a task's timeline, optionally only events with `seq > fromSeq`. */
  load(taskId: string, fromSeq?: number): Promise<TaskEvent[]>;
}

export interface TaskQuery {
  projectId?: string;
  workflowId?: string;
  status?: TaskStatus | readonly TaskStatus[];
  parentId?: string;
}

/**
 * The queryable read side: current task projections. Rebuilt from the event log
 * via `project()`. (M0.5 backs this with SQLite for indexed queries.)
 */
export interface ProjectionStore {
  get(taskId: string): Promise<Task | null>;
  put(task: Task): Promise<void>;
  query(filter?: TaskQuery): Promise<Task[]>;
}

/**
 * Holds workflow definitions as immutable versions and routes a requirement to
 * a workflow. `register` MUST validate before storing. A running task pins the
 * version it was created with, so older versions are never discarded.
 */
export interface WorkflowRegistry {
  /** Validate + store as `${id}@${version}`. Throws on an invalid definition. */
  register(def: WorkflowDef): void;
  /** A specific version, or the latest registered for `id` when omitted. */
  get(id: string, version?: string): WorkflowDef | undefined;
  /** Route a raw requirement to a workflow; falls back to the default (GENERAL). */
  match(input: string): WorkflowDef;
  /** The latest version of every registered workflow. */
  list(): WorkflowDef[];
}
