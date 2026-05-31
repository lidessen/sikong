import type { Task, TaskEvent, TaskStatus } from "../workflow/types";
import type {
  ChronicleEntry,
  ChronicleStore,
  EventStore,
  ProjectionStore,
  ProjectStore,
  WorkerStore,
} from "../store/types";
import type { Project } from "../project";
import type { Worker } from "../worker";

/**
 * Observability: read-only views over the durable stores, plus terse renderers
 * for ad-hoc human inspection. Agents should prefer the same views as JSON.
 * Works against any store impl; the CLI points them at the file-backed stores so
 * it can inspect a running engine's workspace dir out-of-process.
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

export interface ProjectOverview {
  id: string;
  name: string;
  root: string;
  defaultWorkflowId?: string;
  defaultWorker?: string;
  permissionMode?: string;
  taskCount: number;
  counts: Record<TaskStatus, number>;
  recentTasks: TaskSummary[];
}

export interface WorkerOverview {
  id: string;
  name: string;
  runtime: Worker["runtime"];
  provider: Worker["provider"];
  model: string;
  description: string;
  permissionMode?: string;
  isDefault: boolean;
}

export interface WorkspaceOverviewView {
  projects: ProjectOverview[];
  workers: WorkerOverview[];
  defaultWorkerId?: string;
  totalTasks: number;
  counts: Record<TaskStatus, number>;
  recentTasks: TaskSummary[];
  recentActivity: ChronicleEntry[];
  recentErrors: ChronicleEntry[];
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

export async function workspaceOverview(
  stores: {
    projects: ProjectStore;
    workers: WorkerStore;
    projections: ProjectionStore;
    chronicle: ChronicleStore;
  },
  opts: { projectId?: string; defaultWorkerId?: string; taskLimit?: number; activityLimit?: number } = {},
): Promise<WorkspaceOverviewView> {
  const allProjects = await stores.projects.list();
  const projects = opts.projectId ? allProjects.filter((p) => p.id === opts.projectId) : allProjects;
  const workers = await stores.workers.list();
  const allTasks = await stores.projections.query(opts.projectId ? { projectId: opts.projectId } : {});
  const taskSummaries = allTasks
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

  const counts = ZERO_COUNTS();
  for (const t of allTasks) counts[t.status]++;

  return {
    projects: projects.map((p) => projectOverview(p, allTasks.filter((t) => t.projectId === p.id))),
    workers: workers.map((w) => ({
      id: w.id,
      name: w.name,
      runtime: w.runtime,
      provider: w.provider,
      model: w.model,
      description: w.description,
      ...(w.permissionMode ? { permissionMode: w.permissionMode } : {}),
      isDefault: w.id === opts.defaultWorkerId,
    })),
    ...(opts.defaultWorkerId ? { defaultWorkerId: opts.defaultWorkerId } : {}),
    totalTasks: allTasks.length,
    counts,
    recentTasks: taskSummaries.slice(0, opts.taskLimit ?? 20),
    recentActivity: await stores.chronicle.recent({ limit: opts.activityLimit ?? 10 }),
    recentErrors: await stores.chronicle.recent({ limit: 10, type: ["wake.error", "command.rejected"] }),
  };
}

function projectOverview(project: Project, tasks: readonly Task[]): ProjectOverview {
  const counts = ZERO_COUNTS();
  for (const t of tasks) counts[t.status]++;
  return {
    id: project.id,
    name: project.name,
    root: project.root,
    ...(project.defaultWorkflowId ? { defaultWorkflowId: project.defaultWorkflowId } : {}),
    ...(project.defaultWorker ? { defaultWorker: project.defaultWorker } : {}),
    ...(project.permissionMode ? { permissionMode: project.permissionMode } : {}),
    taskCount: tasks.length,
    counts,
    recentTasks: tasks
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
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5),
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

export function renderOverview(v: WorkspaceOverviewView, opts: { dir?: string } = {}): string {
  const title = opts.dir ? `Workspace ${opts.dir}` : "Workspace";
  const lines: string[] = [
    `${title}: ${v.totalTasks} task(s) - ${fmtCounts(v.counts)}`,
    "",
    "Projects:",
  ];
  if (v.projects.length === 0) lines.push("  (none)");
  for (const p of v.projects) {
    const meta = [
      `root=${p.root}`,
      p.defaultWorkflowId ? `workflow=${p.defaultWorkflowId}` : undefined,
      p.defaultWorker ? `worker=${p.defaultWorker}` : undefined,
      p.permissionMode ? `permission=${p.permissionMode}` : undefined,
    ].filter(Boolean);
    lines.push(`  ${p.id}  ${p.name}  (${p.taskCount} task(s): ${fmtCounts(p.counts)})`);
    lines.push(`    ${meta.join("  ") || "no defaults"}`);
    for (const t of p.recentTasks)
      lines.push(`    - ${t.id} [${t.status}] ${t.workflowId}@${t.stageId} updated ${fmtTs(t.updatedAt)}`);
  }

  lines.push("", "Workers:");
  if (v.workers.length === 0) lines.push("  (none - run `worker discover`)");
  for (const w of v.workers) {
    const mark = w.isDefault ? " *" : "";
    const permission = w.permissionMode ? ` permission=${w.permissionMode}` : "";
    lines.push(`  ${w.id}${mark}  ${w.runtime}/${w.provider}/${w.model}${permission}`);
    if (w.description) lines.push(`    ${truncate(w.description, 100)}`);
  }

  lines.push("", "Recent tasks:");
  if (v.recentTasks.length === 0) lines.push("  (none)");
  for (const t of v.recentTasks)
    lines.push(`  ${t.id} [${t.status}] project=${t.projectId} ${t.workflowId}@${t.stageId}`);

  lines.push("", "Recent activity:");
  if (v.recentActivity.length === 0) lines.push("  (none)");
  for (const e of v.recentActivity)
    lines.push(`  ${fmtTs(e.ts)} ${e.type}${e.taskId ? ` ${e.taskId}` : ""} - ${e.summary}`);

  if (v.recentErrors.length > 0) {
    lines.push("", "Recent errors:");
    for (const e of v.recentErrors)
      lines.push(`  ${fmtTs(e.ts)} ${e.type}${e.taskId ? ` ${e.taskId}` : ""} - ${e.summary}`);
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
