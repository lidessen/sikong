import type { Task, TaskEvent, TaskStatus } from "../workflow/types";
import type { ChronicleEntry, ChronicleStore, EventStore, ProjectionStore } from "../store/types";

/**
 * Observability: read-only views over the durable stores, plus terse renderers
 * meant for an AGENT to read (the lead agent asking "what's going on") — not a
 * human GUI. Works against any store impl; the CLI points them at the JSONL/JSON
 * stores so it can inspect a running engine's workspace dir out-of-process.
 */

export interface TaskSummary {
  id: string;
  projectId: string;
  workflowId: string;
  stageId: string;
  status: TaskStatus;
  parentId?: string;
  childCount: number;
  updatedAt: number;
}

export interface WorkspaceStatusView {
  total: number;
  counts: Record<TaskStatus, number>;
  tasks: TaskSummary[];
  recentActivity: ChronicleEntry[];
  recentErrors: ChronicleEntry[];
}

export interface TaskDetailView {
  /** Null when the event log has the task but its projection isn't materialized yet. */
  task: Task | null;
  timeline: TaskEvent[];
  activity: ChronicleEntry[];
}

const ZERO_COUNTS: () => Record<TaskStatus, number> = () => ({
  todo: 0,
  in_progress: 0,
  done: 0,
  blocked: 0,
  cancelled: 0,
});

export async function workspaceStatus(
  projections: ProjectionStore,
  chronicle: ChronicleStore,
  opts: { projectId?: string; activityLimit?: number } = {},
): Promise<WorkspaceStatusView> {
  const tasks = await projections.query(opts.projectId ? { projectId: opts.projectId } : {});
  const counts = ZERO_COUNTS();
  for (const t of tasks) counts[t.status]++;
  const summaries = tasks
    .map(
      (t): TaskSummary => ({
        id: t.id,
        projectId: t.projectId,
        workflowId: t.workflowId,
        stageId: t.stageId,
        status: t.status,
        ...(t.parentId ? { parentId: t.parentId } : {}),
        childCount: t.childIds.length,
        updatedAt: t.updatedAt,
      }),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    total: tasks.length,
    counts,
    tasks: summaries,
    recentActivity: await chronicle.recent({ limit: opts.activityLimit ?? 15 }),
    recentErrors: await chronicle.recent({ limit: 10, type: ["wake.error", "command.rejected"] }),
  };
}

export async function taskDetail(
  taskId: string,
  events: EventStore,
  projections: ProjectionStore,
  chronicle: ChronicleStore,
  opts: { timelineLimit?: number } = {},
): Promise<TaskDetailView | null> {
  const task = await projections.get(taskId);
  const all = await events.load(taskId);
  if (!task && all.length === 0) return null; // genuinely absent
  return {
    task,
    timeline: all.slice(-(opts.timelineLimit ?? 20)),
    activity: await chronicle.recent({ taskId, limit: 20 }),
  };
}

// ---- renderers (terse, agent-readable plain text) -------------------------

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Field values are load-bearing (an agent reads the outcome) — render lossless up to a high cap. */
function renderFieldValue(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 600 ? `${s.slice(0, 600)}… (${s.length} chars total)` : s;
}

function fmtCounts(counts: Record<TaskStatus, number>): string {
  const parts = (Object.keys(counts) as TaskStatus[]).filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`);
  return parts.length ? parts.join(", ") : "no tasks";
}

export function renderStatus(v: WorkspaceStatusView): string {
  const lines: string[] = [`Workspace: ${v.total} task(s) — ${fmtCounts(v.counts)}`, "", "Tasks:"];
  if (v.tasks.length === 0) lines.push("  (none)");
  for (const t of v.tasks.slice(0, 40))
    lines.push(
      `  ${t.id}  [${t.status}]  ${t.workflowId} @ ${t.stageId}  (project ${t.projectId})` +
        `${t.parentId ? ` ↳ child of ${t.parentId}` : ""}${t.childCount ? ` [${t.childCount} child${t.childCount > 1 ? "ren" : ""}]` : ""}`,
    );
  lines.push("", "Recent activity:");
  if (v.recentActivity.length === 0) lines.push("  (none)");
  for (const e of v.recentActivity)
    lines.push(`  ${fmtTs(e.ts)} ${e.type}${e.taskId ? ` ${e.taskId}` : ""} — ${e.summary}`);
  if (v.recentErrors.length > 0) {
    lines.push("", "⚠ Recent errors:");
    for (const e of v.recentErrors)
      lines.push(`  ${fmtTs(e.ts)} ${e.type}${e.taskId ? ` ${e.taskId}` : ""} — ${e.summary}`);
  }
  return lines.join("\n");
}

export function renderTaskDetail(v: TaskDetailView): string {
  const t = v.task;
  const lines: string[] = [];
  if (t) {
    lines.push(
      `Task ${t.id}  [${t.status}]`,
      `  workflow: ${t.workflowId}@${t.workflowVersion}   stage: ${t.stageId}   project: ${t.projectId}`,
    );
    if (t.workerId) lines.push(`  worker: ${t.workerId}`);
    if (t.parentId) lines.push(`  parent: ${t.parentId}`);
    if (t.childIds.length) lines.push(`  children: ${t.childIds.join(", ")}`);
    lines.push("  fields:");
    const keys = Object.keys(t.fields);
    if (keys.length === 0) lines.push("    (none)");
    for (const k of keys) lines.push(`    ${k} = ${renderFieldValue(t.fields[k])}`);
  } else {
    lines.push("Task (projection not yet materialized — showing event log)");
  }
  lines.push("", "  timeline (recent):");
  if (v.timeline.length === 0) lines.push("    (none)");
  for (const e of v.timeline)
    lines.push(`    #${e.seq} ${fmtTs(e.ts)} ${e.source} ${e.type} ${truncate(JSON.stringify(e.payload), 80)}`);
  lines.push("", "  activity (recent):");
  if (v.activity.length === 0) lines.push("    (none)");
  for (const e of v.activity) lines.push(`    ${fmtTs(e.ts)} ${e.type} — ${e.summary}`);
  return lines.join("\n");
}
