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
 * its current stage (+ its children's statuses + acceptance state). Evaluated
 * by the engine, never by an LLM — that is what keeps stage transitions
 * deterministic and auditable, and what makes agent-authored workflows safe
 * (no code injection).
 */
export type Guard =
  | { op: "always" }
  | { op: "never" }
  | { op: "field"; field: string; cmp: FieldCmp; value?: unknown }
  | { op: "hasEvent"; eventType: TaskEventType }
  | { op: "childrenDone" }
  | { op: "childrenSucceeded" }
  | { op: "acceptancePassed" }
  | { op: "and"; all: readonly Guard[] }
  | { op: "or"; any: readonly Guard[] }
  | { op: "not"; guard: Guard };

/** Coarse Kanban category over fully-custom stages. `Task.status` derives from it. */
export type StageCategory = "todo" | "in_progress" | "done";

// ---- Acceptance gates (ADR 0024) ------------------------------------------

/**
 * A structured, machine-checkable acceptance criterion for a stage. The verifier
 * worker (a grounded executor, not the implementing worker) executes these checks
 * and reports a verdict before the stage transition is admitted.
 *
 * Expand the union to add more check kinds as needed.
 */
export type AcceptanceCheck =
  | {
      kind: "command";
      /** Human-readable description of what this checks. */
      description: string;
      /** Shell command to run. Must exit 0 (or `expectExit`) to pass. */
      cmd: string;
      /** Expected exit code; defaults to 0. */
      expectExit?: number;
    }
  | {
      kind: "fileExists";
      description: string;
      /** Path to the file that must exist. */
      path: string;
    }
  | {
      kind: "grep";
      description: string;
      /** File to search. */
      path: string;
      /** Pattern to search for. */
      pattern: string;
      /** true = pattern must match; false = pattern must NOT match. */
      expectMatch: boolean;
    }
  | {
      kind: "projectGate";
      description: string;
      // Shorthand for the project's standard verification (typecheck + test).
      // Expanded to concrete commands at runtime by the verifier.
    };

/** Per-check result from a single acceptance-verification run. */
export interface AcceptanceVerdictDetail {
  /** The `description` of the check this result corresponds to. */
  checkDescription: string;
  passed: boolean;
  /** Evidence captured during execution (stdout, file listing, etc.). */
  evidence: string;
  /** Actionable suggestion when the check failed. */
  suggestion?: string;
}

/** The four verdicts a verifier can return. */
export type AcceptanceVerdict = "passed" | "failed" | "abandon";

export interface StageDef {
  id: string;
  category: StageCategory;
  /** Admission predicate: a task may enter this stage only when `entry` holds. */
  entry: Guard;
  /** Registered skill names equipped while in this stage (resolved at M3). */
  skills?: readonly string[];
  /** Registered tool names exposed while in this stage (resolved at M3). */
  tools?: readonly string[];
  /**
   * Fields this stage is expected to write. When present, the set_field tool is
   * constrained to this list so a worker cannot overwrite stable input fields
   * while trying to commit stage progress.
   */
  outputFields?: readonly string[];
  /** Stage guidance appended to the wake's system prompt. */
  instructions?: string;
  /** Cron escalation hint: fire a staleness tick after this long (used at M5). */
  escalateAfterMs?: number;
  /**
   * Reasoning-effort level for wakes in this stage. Overrides the workspace
   * default when set; the lead can override per-subtask via create_subtask({ effort }).
   * Design/dialectic stages default to "high"/"max"; plan/build/verify to "medium".
   */
  effort?: "low" | "medium" | "high" | "max";
  /**
   * Acceptance checks (ADR 0024) that must pass before the task can leave this
   * stage. The engine runs a grounded verifier worker to execute these checks;
   * the next stage's entry guard should include `{ op: "acceptancePassed" }` to
   * gate on the verdict. When unset or empty, no acceptance requirement applies.
   */
  acceptance?: readonly AcceptanceCheck[];
}

export interface WorkflowDef {
  id: string;
  /** Content hash / incrementing tag. Editing a workflow = a NEW version. */
  version: string;
  name: string;
  /** Used by the intake router to match a requirement (M3). */
  description: string;
  /**
   * Capability a task on this workflow needs, matched against worker `roles` when
   * sikong staffs the task (ADR 0008). Data only — the engine never reads it;
   * assignment happens in the management layer. Unset ⇒ any available worker.
   */
  workerRole?: string;
  fields: FieldsSchema;
  /** Ordered; `stages[0]` is the initial stage entered at creation. */
  stages: readonly StageDef[];
  /**
   * Caps the depth of the team tree rooted at this workflow. A task at D >=
   * maxTeamDepth cannot spawn subtasks — its `create_subtask` commands are
   * rejected at the command level. Unset ⇒ no limit. Root tasks (depth 0) are
   * always allowed regardless of this cap — it only gates subtree growth.
   */
  maxTeamDepth?: number;
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
  /** Run this task's wakes in an isolated workspace (ADR 0010); honored at the worker boundary (git worktree), opaque to the engine. */
  isolate?: boolean;
  /**
   * Reasoning-effort override for this task, set at creation by a parent's
   * `create_subtask({ effort })`. Resolved per-wake: task.effort → stage.effort
   * → workspace default ("medium"). The lead dials it up for hard pieces
   * (design/dialectic → "high"/"max") and down for rote ones (plan/build/verify
   * → "low"/"medium").
   */
  effort?: string;
  /** Task ids this task must wait for before it runs (ADR 0011); the engine defers its wakes until all are terminal. */
  dependsOn?: readonly string[];
  parentId?: string;
  childIds: readonly string[];
  /** Depth in the team tree: 0 for root, parent.depth + 1 for children. */
  depth: number;
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
  | "task.cancelled"
  | "acceptance.verdict";

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
      /**
       * Run this child in an isolated workspace (ADR 0010). Generic + opaque to the
       * engine; the worker boundary maps it to a git worktree for git projects and
       * ignores it otherwise. Use it for parallel children that edit the same code.
       */
      isolate?: boolean;
      /** A logical handle for this subtask, referenced by siblings' `dependsOn` (ADR 0011). */
      key?: string;
      /** Keys of sibling subtasks (same delegate pass) this one must wait for before it runs. */
      dependsOn?: readonly string[];
      /**
       * Reasoning-effort override for this subtask. The lead sets it to dial effort
       * up for hard pieces (design/dialectic → "high"/"max") or down for rote ones
       * (plan/build/verify → "low"/"medium"). Takes precedence over the stage default.
       */
      effort?: "low" | "medium" | "high" | "max";
    }
  | { kind: "block"; reason: string }
  | { kind: "unblock" }
  | { kind: "cancel"; reason?: string }
  | {
      kind: "acceptance_verdict";
      /** Overall verdict from the verifier. */
      verdict: AcceptanceVerdict;
      /** Per-check results from the verification run. */
      details: AcceptanceVerdictDetail[];
      /** Optional prose summary of the verification outcome. */
      summary?: string;
    };

/** Provenance applied to events a command/advance produces. */
export interface ReduceContext {
  source?: EventSource;
  wakeId?: string;
  /** Statuses of this task's children — used to evaluate `childrenDone` guards. */
  children?: readonly TaskStatus[];
}
