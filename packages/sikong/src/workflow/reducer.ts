import { evalGuard, type AcceptanceStatus, type GuardEnv } from "./guard";
import { CommandRejectedError } from "./errors";
import { validateAcceptanceChecks } from "./validate";
import type {
  AcceptanceCheck,
  Command,
  EventSource,
  FieldDef,
  NewEvent,
  ReduceContext,
  StageCategory,
  StageDef,
  Task,
  TaskEvent,
  TaskStatus,
  WorkflowDef,
} from "./types";

/** An event that may or may not have been stamped (`seq`/`ts`) by the store yet. */
type EventLike = TaskEvent | NewEvent;

/** done + cancelled are terminal and absorbing — no command or event changes a terminal task. */
function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
}

/**
 * The pinning invariant, defended at every entry point (not just full
 * projection): a task may only be reduced/advanced against the exact workflow
 * version it was created with, so an edited workflow can never corrupt an
 * in-flight instance.
 */
function assertPinned(task: Task, wf: WorkflowDef): void {
  if (task.workflowId !== wf.id || task.workflowVersion !== wf.version)
    throw new Error(
      `workflow mismatch — task ${task.id} is pinned to ${task.workflowId}@${task.workflowVersion}, given def is ${wf.id}@${wf.version}`,
    );
}

// ---- apply: a single command → events (the aggregate) ---------------------

/**
 * Validate a command against the current task + workflow invariants and return
 * the events it produces. Throws `CommandRejectedError` on an illegal command —
 * this is where "agent proposes, workflow disposes" is enforced. Pure: does not
 * fold, does not touch a store. Completion is NOT a command: a task finishes by
 * being admitted (guard-driven) into a terminal `done`-category stage.
 */
export function apply(
  task: Task,
  wf: WorkflowDef,
  command: Command,
  ctx: ReduceContext = {},
): NewEvent[] {
  assertPinned(task, wf);
  const source: EventSource = ctx.source ?? "worker";
  const mk = (type: NewEvent["type"], payload: Record<string, unknown>): NewEvent => ({
    taskId: task.id,
    source,
    type,
    payload,
    ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}),
  });
  const reject = (message: string): never => {
    throw new CommandRejectedError(message, task.id, command.kind);
  };

  if (isTerminal(task.status))
    reject(`task ${task.id} is ${task.status} and accepts no further commands`);

  switch (command.kind) {
    case "set_field": {
      const def = wf.fields[command.field];
      if (!def) reject(`unknown field "${command.field}"`);
      else if (!isValidFieldValue(def, command.value))
        reject(`value for "${command.field}" is not a valid ${def.type}`);
      return [mk("field.set", { field: command.field, value: command.value })];
    }
    case "request_transition":
      return [
        mk("transition.requested", {
          fromStage: task.stageId,
          ...(command.reason ? { reason: command.reason } : {}),
        }),
      ];
    case "append_note":
      return [mk("note.appended", { text: command.text })];
    case "create_subtask": {
      // Enforce maxTeamDepth: a task whose depth already meets or exceeds the
      // workflow's cap cannot spawn further subtasks.
      const cap = wf.maxTeamDepth;
      if (cap !== undefined && task.depth >= cap)
        reject(
          `max team depth (${cap}) reached — task is at depth ${task.depth} and cannot create more subtasks`,
        );
      // Validate acceptance check shapes (ADR 0027) — reuse stage-acceptance validation.
      const accIssues = validateAcceptanceChecks(command.acceptance, "create_subtask");
      if (accIssues.length)
        reject(`create_subtask has invalid acceptance checks: ${accIssues.map((i) => i.message).join("; ")}`);
      // The engine mints the child id before recording this; a blank id would be
      // a link to no task (and wedge a childrenDone gate forever).
      if (!command.childId.trim()) reject("create_subtask requires a non-empty child id (engine-minted)");
      return [
        mk("subtask.created", {
          childId: command.childId,
          workflowId: command.workflowId,
          input: command.input,
          blocksParent: command.blocksParent ?? false,
          ...(command.key ? { key: command.key } : {}),
          ...(command.effort ? { effort: command.effort } : {}),
          ...(command.acceptance?.length ? { acceptance: [...command.acceptance] } : {}),
        }),
      ];
    }
    case "block":
      if (task.status === "blocked") reject(`task ${task.id} is already blocked`);
      return [mk("task.blocked", { reason: command.reason })];
    case "unblock":
      if (task.status !== "blocked") reject(`task ${task.id} is not blocked`);
      return [mk("task.unblocked", {})];
    case "cancel":
      return [
        // Lead approves cancellation; the engine itself terminally fails a wedged
        // task (staleness circuit-breaker, ADR 0010). A worker `cancel` is only a
        // request until a lead/engine approves it.
        source === "lead" || source === "engine"
          ? mk("task.cancelled", command.reason ? { reason: command.reason } : {})
          : mk("cancellation.requested", command.reason ? { reason: command.reason } : {}),
      ];
    case "submit_evidence": {
      if (!isValidAcceptanceEvidence(command.evidence))
        reject("submit_evidence requires evidence with a non-empty summary");
      return [
        mk("acceptance.evidence", {
          evidence: command.evidence,
        }),
      ];
    }
    case "acceptance_decision": {
      if (source !== "lead" && source !== "engine")
        reject("acceptance_decision is lead/engine-only");
      if (command.decision !== "accepted" && command.decision !== "rejected")
        reject(`invalid acceptance decision "${String(command.decision)}"`);
      if (!command.reason.trim())
        reject("acceptance_decision requires a non-empty reason");
      return [
        mk(command.decision === "accepted" ? "acceptance.accepted" : "acceptance.rejected", {
          reason: command.reason,
        }),
      ];
    }
  }
}

/**
 * Apply a sequence of commands from one wake, threading each command's effect
 * into the next (so a later command sees an earlier `set_field`). Returns all
 * produced events.
 */
export function reduceCommands(
  task: Task,
  wf: WorkflowDef,
  commands: readonly Command[],
  ctx: ReduceContext = {},
  onReject?: (command: Command, error: CommandRejectedError) => void,
): NewEvent[] {
  const out: NewEvent[] = [];
  let cur = task;
  for (const cmd of commands) {
    let events: NewEvent[];
    try {
      events = apply(cur, wf, cmd, ctx);
    } catch (err) {
      // With an onReject handler, a single illegal command is skipped (so one bad
      // tool-call can't crash a whole wake); without one, it throws as before.
      if (onReject && err instanceof CommandRejectedError) {
        onReject(cmd, err);
        continue;
      }
      throw err;
    }
    for (const ev of events) {
      out.push(ev);
      cur = foldEvent(cur, ev, wf);
    }
  }
  return out;
}

// ---- project: events → task (the read model) ------------------------------

/** Fold a full timeline into the current task projection. */
export function project(events: readonly TaskEvent[], wf: WorkflowDef): Task {
  let task: Task | null = null;
  for (const ev of events) task = foldEvent(task, ev, wf);
  if (!task) throw new Error("project: empty timeline (expected a task.created event)");
  return task;
}

/**
 * Fold already-stamped events onto an existing projection (no store round-trip).
 * Requires `TaskEvent[]` (stamped) so the resulting `cursor`/`updatedAt` stay
 * authoritative — do NOT pass raw `NewEvent`s the store hasn't sequenced yet.
 */
export function applyEventsToTask(
  task: Task,
  events: readonly TaskEvent[],
  wf: WorkflowDef,
): Task {
  let cur = task;
  for (const ev of events) cur = foldEvent(cur, ev, wf);
  return cur;
}

function foldEvent(task: Task | null, ev: EventLike, wf: WorkflowDef): Task {
  const seq = "seq" in ev ? ev.seq : undefined;
  const ts = "ts" in ev ? ev.ts : undefined;

  if (ev.type === "task.created") {
    const p = ev.payload;
    const workflowId = asString(p.workflowId);
    const workflowVersion = asString(p.workflowVersion);
    if (workflowId !== wf.id || workflowVersion !== wf.version)
      throw new Error(
        `project: workflow mismatch — timeline is ${workflowId}@${workflowVersion}, given def is ${wf.id}@${wf.version}`,
      );
    const stageId = asString(p.stageId);
    const base: Task = {
      id: asString(p.taskId),
      projectId: asString(p.projectId),
      workflowId,
      workflowVersion,
      stageId,
      fields: isRecord(p.fields) ? { ...p.fields } : {},
      status: statusForStage(wf, stageId),
      childIds: [],
      depth: typeof p.depth === "number" ? p.depth : 0,
      cursor: seq ?? 0,
      createdAt: ts ?? 0,
      updatedAt: ts ?? 0,
    };
    if (typeof p.parentId === "string") base.parentId = p.parentId;
    if (typeof p.workerId === "string") base.workerId = p.workerId;
    if (typeof p.effort === "string") base.effort = p.effort;
    if (p.isolate === true) base.isolate = true;
    if (Array.isArray(p.dependsOn) && p.dependsOn.length) base.dependsOn = p.dependsOn.map(String);
    if (Array.isArray(p.acceptance) && p.acceptance.length) base.acceptance = p.acceptance as readonly AcceptanceCheck[];
    return base;
  }

  if (!task) throw new Error(`project: first event must be task.created, got "${ev.type}"`);

  // done + cancelled are absorbing: a terminal task ignores all further mutations,
  // so a replayed/queued event can never un-finish or re-open it.
  const frozen = isTerminal(task.status);
  let next = task;
  switch (ev.type) {
    case "field.set":
      if (!frozen)
        next = { ...task, fields: { ...task.fields, [asString(ev.payload.field)]: ev.payload.value } };
      break;
    case "stage.entered":
      if (!frozen) {
        const stageId = asString(ev.payload.stageId);
        next = {
          ...task,
          stageId,
          status: task.status === "blocked" ? "blocked" : statusForStage(wf, stageId),
        };
      }
      break;
    case "subtask.created": {
      const childId = asString(ev.payload.childId);
      if (!frozen && !task.childIds.includes(childId))
        next = { ...task, childIds: [...task.childIds, childId] };
      break;
    }
    case "task.blocked":
      if (!frozen) next = { ...task, status: "blocked" };
      break;
    case "task.unblocked":
      if (task.status === "blocked")
        next = { ...task, status: statusForStage(wf, task.stageId) };
      break;
    case "task.cancelled":
      if (!frozen) next = { ...task, status: "cancelled" };
      break;
    case "transition.requested":
    case "note.appended":
    case "cancellation.requested":
    case "acceptance.evidence":
    case "acceptance.accepted":
    case "acceptance.rejected":
      break; // signal / audit only — no projection change
  }

  if (next === task && seq === undefined) return task;
  return { ...next, cursor: seq ?? next.cursor, updatedAt: ts ?? next.updatedAt };
}

// ---- tryAdvance: guard-driven stage progression ---------------------------

/**
 * Advance the task through as many stages as their entry guards allow, given
 * the full timeline so far. Returns the `stage.entered` events to append (empty
 * if no transition is admissible). Guards see only the CURRENT stage's events —
 * so a `hasEvent` guard means "since entering this stage". The agent never
 * transitions directly; it flips fields / requests, and this decides.
 *
 * `childrenDone` guards read `ctx.children` (child statuses the engine must
 * resolve and thread in); they are NOT yet reproducible from the parent log
 * alone — recording child-status events on the parent timeline is an M4 concern.
 */
export function tryAdvance(
  task: Task,
  wf: WorkflowDef,
  allEvents: readonly EventLike[],
  ctx: ReduceContext = {},
): NewEvent[] {
  assertPinned(task, wf);
  const source: EventSource = ctx.source ?? "engine";
  const out: NewEvent[] = [];
  let cur = task;

  for (let hops = wf.stages.length; hops > 0; hops--) {
    if (isTerminal(cur.status) || cur.status === "blocked") break;
    const idx = wf.stages.findIndex((s) => s.id === cur.stageId);
    if (idx < 0) break;
    const next = wf.stages[idx + 1];
    if (!next) break; // already at the last stage

    const curStage = stageById(wf, cur.stageId);
    const env: GuardEnv = {
      fields: cur.fields,
      eventTypes: eventTypesInCurrentStage([...allEvents, ...out]),
      children: ctx.children ?? [],
      acceptanceStatus: deriveAcceptanceStatus(curStage, [...allEvents, ...out]),
    };
    if (!evalGuard(next.entry, env)) break;

    const ev: NewEvent = {
      taskId: cur.id,
      source,
      type: "stage.entered",
      payload: { stageId: next.id },
      ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}),
    };
    out.push(ev);
    cur = foldEvent(cur, ev, wf);
  }
  return out;
}

/** Event types that occurred since the task entered its current stage. */
function eventTypesInCurrentStage(events: readonly EventLike[]): ReadonlySet<string> {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.type;
    if (t === "stage.entered" || t === "task.created" || t === "task.unblocked") {
      start = i + 1;
      break;
    }
  }
  const set = new Set<string>();
  for (let i = start; i < events.length; i++) {
    const t = events[i]?.type;
    if (t) set.add(t);
  }
  return set;
}

/**
 * Derive the lead acceptance-review status for the current stage by scanning
 * events. Evidence makes the status pending; a lead accepted/rejected event is
 * the only decision. Only looks within the current stage boundary, so a prior
 * stage's review never admits the next stage.
 */
export function deriveAcceptanceStatus(
  _stage: StageDef | undefined,
  events: readonly EventLike[],
): AcceptanceStatus {
  // Scan backwards so the latest lead decision wins. Stop at stage boundaries.
  let sawEvidence = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === "acceptance.accepted") return "accepted";
    if (ev?.type === "acceptance.rejected") return "rejected";
    if (ev?.type === "acceptance.evidence") sawEvidence = true;
    if (ev?.type === "stage.entered" || ev?.type === "task.created") break;
  }
  return sawEvidence ? "pending" : "none";
}

// ---- create + small helpers -----------------------------------------------

/** The `task.created` event that opens a task on its workflow's initial stage. */
export function initTask(params: {
  taskId: string;
  projectId: string;
  workflow: WorkflowDef;
  parentId?: string;
  workerId?: string;
  isolate?: boolean;
  /** Reasoning-effort override for this task (set by parent's create_subtask). */
  effort?: string;
  /** Lead-authored per-task acceptance checks (ADR 0027). */
  acceptance?: readonly AcceptanceCheck[];
  dependsOn?: readonly string[];
  fields?: Record<string, unknown>;
  source?: EventSource;
  /** Depth in the team tree — set by the engine from parent.depth + 1. */
  depth?: number;
}): NewEvent[] {
  const wf = params.workflow;
  const s0 = wf.stages[0];
  if (!s0) throw new Error(`workflow "${wf.id}" has no stages`);
  const payload: Record<string, unknown> = {
    taskId: params.taskId,
    projectId: params.projectId,
    workflowId: wf.id,
    workflowVersion: wf.version,
    stageId: s0.id,
    fields: params.fields ?? {},
    depth: params.depth ?? 0,
  };
  if (params.parentId) payload.parentId = params.parentId;
  if (params.workerId) payload.workerId = params.workerId;
  if (params.effort) payload.effort = params.effort;
  if (params.isolate) payload.isolate = true;
  if (params.dependsOn && params.dependsOn.length) payload.dependsOn = [...params.dependsOn];
  if (params.acceptance?.length) payload.acceptance = [...params.acceptance];
  return [{ taskId: params.taskId, source: params.source ?? "lead", type: "task.created", payload }];
}

export function stageById(wf: WorkflowDef, stageId: string): StageDef | undefined {
  return wf.stages.find((s) => s.id === stageId);
}

function stageCategory(wf: WorkflowDef, stageId: string): StageCategory {
  const stage = stageById(wf, stageId);
  if (!stage)
    throw new Error(`stage "${stageId}" not found in workflow ${wf.id}@${wf.version}`);
  return stage.category;
}

/** Status a task takes from a stage's category (with no blocked/cancelled overlay). */
function statusForStage(wf: WorkflowDef, stageId: string): TaskStatus {
  return stageCategory(wf, stageId);
}

/**
 * Keep only the entries that are declared by the workflow AND type-valid — used
 * to sanitize fields an agent (intake) extracted before creating a task.
 */
export function filterValidFields(
  wf: WorkflowDef,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const def = wf.fields[key];
    if (def && isValidFieldValue(def, value)) out[key] = value;
  }
  return out;
}

function isValidFieldValue(def: FieldDef, value: unknown): boolean {
  switch (def.type) {
    case "string":
    case "ref":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && !!def.enum?.includes(value);
    case "json":
      return true;
  }
}

function isValidAcceptanceEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.summary === "string" && value.summary.trim().length > 0;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
