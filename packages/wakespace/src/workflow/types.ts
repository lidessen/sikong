/**
 * M0 — the workflow kernel data model.
 *
 * A **WorkflowDef** is pure, serializable data (fields schema + stages + guards
 * + skill/tool *names*) — which is exactly what lets an agent author one at
 * runtime. A **Task** is an instance of a workflow; its append-only event
 * timeline is the system of record, and `fields` is the projection an agent
 * reads. Guards are declarative predicates (data, not code) so transitions stay
 * deterministic and auditable: the agent emits Commands (intents), a
 * deterministic reducer validates them against the schema + the next stage's
 * guard, and only then records Events. "Agent proposes, workflow disposes."
 *
 * Nothing here imports agent-loop — these are plain types + pure functions.
 */

// ---- Workflow definition (registerable data) ------------------------------

export type FieldType = "string" | "number" | "boolean" | "enum" | "ref" | "json";

/** One typed field on a workflow, with its meaning (for the agent). */
export interface FieldDef {
  type: FieldType;
  /** What this field means — surfaced to the agent. */
  description: string;
  /** Allowed values; required when `type === "enum"`. */
  enum?: readonly string[];
  /** Advisory: gates that need this populated should say so via a guard. */
  required?: boolean;
}

export type FieldsSchema = Record<string, FieldDef>;

export type FieldCmp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "exists";

/**
 * A declarative, serializable predicate over a task's fields + the events in
 * its current stage (+ its children's statuses). Evaluated by the engine, never
 * by an LLM — that is what keeps stage transitions deterministic and auditable,
 * and what makes agent-authored workflows safe (no code injection).
 */
export type Guard =
  | { op: "always" }
  | { op: "never" }
  | { op: "field"; field: string; cmp: FieldCmp; value?: unknown }
  | { op: "hasEvent"; eventType: TaskEventType }
  | { op: "childrenDone" }
  | { op: "childrenSucceeded" }
  | { op: "and"; all: readonly Guard[] }
  | { op: "or"; any: readonly Guard[] }
  | { op: "not"; guard: Guard };

/** Coarse Kanban category over fully-custom stages. `Task.status` derives from it. */
export type StageCategory = "todo" | "in_progress" | "done";

export interface StageDef {
  id: string;
  category: StageCategory;
  /** Admission predicate: a task may enter this stage only when `entry` holds. */
  entry: Guard;
  /** Registered skill names equipped while in this stage (resolved at M3). */
  skills?: readonly string[];
  /** Registered tool names exposed while in this stage (resolved at M3). */
  tools?: readonly string[];
  /** Stage guidance appended to the wake's system prompt. */
  instructions?: string;
  /** Cron escalation hint: fire a staleness tick after this long (used at M5). */
  escalateAfterMs?: number;
}

export interface WorkflowDef {
  id: string;
  /** Content hash / incrementing tag. Editing a workflow = a NEW version. */
  version: string;
  name: string;
  /** Used by the intake router to match a requirement (M3). */
  description: string;
  fields: FieldsSchema;
  /** Ordered; `stages[0]` is the initial stage entered at creation. */
  stages: readonly StageDef[];
}

// ---- Task instance --------------------------------------------------------

export type TaskStatus = "todo" | "in_progress" | "done" | "blocked" | "cancelled";

export interface Task {
  id: string;
  projectId: string;
  workflowId: string;
  /** The workflow version this instance is pinned to for its whole life. */
  workflowVersion: string;
  /** Current stage. */
  stageId: string;
  /** Projection of the timeline — the snapshot an agent reads, not the log. */
  fields: Readonly<Record<string, unknown>>;
  /** Derived from the current stage's category, with blocked/cancelled overrides. */
  status: TaskStatus;
  /** The hired worker (model/runtime), set at creation; resolution falls back to project/workspace defaults. */
  workerId?: string;
  parentId?: string;
  childIds: readonly string[];
  /** `seq` of the last event folded into this projection. */
  cursor: number;
  createdAt: number;
  updatedAt: number;
}

// ---- Event timeline (system of record) ------------------------------------

export type EventSource = "lead" | "worker" | "cron" | "engine" | "external";

export type TaskEventType =
  | "task.created"
  | "field.set"
  | "transition.requested"
  | "stage.entered"
  | "note.appended"
  | "subtask.created"
  | "task.blocked"
  | "task.unblocked"
  | "cancellation.requested"
  | "task.cancelled";

export interface TaskEvent {
  /** Monotonic per task, starting at 1. Assigned by the EventStore on append. */
  seq: number;
  taskId: string;
  /** Wall-clock ms. Assigned by the EventStore on append. */
  ts: number;
  source: EventSource;
  type: TaskEventType;
  payload: Record<string, unknown>;
  /** Correlates an event with the wake that produced it (set at M1). */
  wakeId?: string;
}

/** An event before the store assigns its `seq`/`ts`. The reducer emits these. */
export type NewEvent = Omit<TaskEvent, "seq" | "ts">;

// ---- Commands (agent intents, validated by the reducer) -------------------

// A task finishes by being admitted (guard-driven) into a terminal `done`-category
// stage — there is no `complete` command (that would let an agent bypass the
// workflow). The final summary/result lives in fields the terminal stage requires.
export type Command =
  | { kind: "set_field"; field: string; value: unknown }
  | { kind: "request_transition"; reason?: string }
  | { kind: "append_note"; text: string }
  | {
      kind: "create_subtask";
      childId: string;
      workflowId: string;
      input: string;
      blocksParent?: boolean;
    }
  | { kind: "block"; reason: string }
  | { kind: "unblock" }
  | { kind: "cancel"; reason?: string };

/** Provenance applied to events a command/advance produces. */
export interface ReduceContext {
  source?: EventSource;
  wakeId?: string;
  /** Statuses of this task's children — used to evaluate `childrenDone` guards. */
  children?: readonly TaskStatus[];
}
