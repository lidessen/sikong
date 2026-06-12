import type { Task, TaskEvent, TaskStatus } from "../workflow/types";
import { deriveAcceptanceStatus, eventTypesInCurrentStage } from "../workflow/reducer";
import { deriveLeadTeamStatus, type LeadTeamStatus, type TeamMember } from "../engine/team-status";
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
  pendingLeadActions: PendingLeadAction[];
  recentActivity: ChronicleEntry[];
  recentErrors: ChronicleEntry[];
}

export interface TaskDetailView {
  /** Null when the event log has the task but its projection isn't materialized yet. */
  task: Task | null;
  leadStatus?: LeadTeamStatus;
  team: TeamMember[];
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
  pendingLeadActions: PendingLeadAction[];
  recentActivity: ChronicleEntry[];
  recentErrors: ChronicleEntry[];
}

export interface PendingLeadAction {
  taskId: string;
  projectId: string;
  workflowId: string;
  stageId: string;
  classification: LeadTeamStatus["classification"] | "worker_log_review_required";
  next: string;
  suggestedCommand: string;
  childCount: number;
  activeChildren: number;
  updatedAt: number;
  wakeId?: string;
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
  opts: { projectId?: string; activityLimit?: number; events?: EventStore } = {},
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
    pendingLeadActions: await pendingLeadActions(tasks, projections, chronicle, opts.events),
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
  const team = task ? await teamMembers(task, projections) : [];
  const leadStatus = task
    ? deriveLeadTeamStatus(task, undefined, team, {
        eventTypes: eventTypesInCurrentStage(all),
        acceptanceStatus: deriveAcceptanceStatus(undefined, all),
      })
    : undefined;
  return {
    task,
    ...(leadStatus ? { leadStatus } : {}),
    team,
    timeline: all.slice(-(opts.timelineLimit ?? 20)),
    activity: await chronicle.recent({ taskId, limit: 20 }),
  };
}

async function teamMembers(task: Task, projections: ProjectionStore): Promise<TeamMember[]> {
  if (task.childIds.length === 0) return [];
  const children = await Promise.all(task.childIds.map((id) => projections.get(id)));
  return children.flatMap((child) =>
    child
      ? [
          {
            id: child.id,
            workflowId: child.workflowId,
            stageId: child.stageId,
            status: child.status,
            ...(child.isolate ? { isolate: true } : {}),
            ...(typeof child.fields.summary === "string" && child.fields.summary ? { summary: child.fields.summary } : {}),
            ...(typeof child.fields.request === "string" && child.fields.request ? { request: child.fields.request } : {}),
          },
        ]
      : [],
  );
}

export async function workspaceOverview(
  stores: {
    projects: ProjectStore;
    workers: WorkerStore;
    projections: ProjectionStore;
    chronicle: ChronicleStore;
    events?: EventStore;
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
    pendingLeadActions: await pendingLeadActions(allTasks, stores.projections, stores.chronicle, stores.events),
    recentActivity: await stores.chronicle.recent({ limit: opts.activityLimit ?? 10 }),
    recentErrors: await stores.chronicle.recent({ limit: 10, type: ["wake.error", "command.rejected"] }),
  };
}

async function pendingLeadActions(
  tasks: readonly Task[],
  projections: ProjectionStore,
  chronicle: ChronicleStore,
  events?: EventStore,
): Promise<PendingLeadAction[]> {
  const actionable = new Set<LeadTeamStatus["classification"]>([
    "ready_for_parent_review",
    "waiting_for_lead_acceptance",
    "needs_repair_or_decision",
    "ready_to_close",
  ]);
  const rows: PendingLeadAction[] = [];
  const byTask = new Map(tasks.map((task) => [task.id, task]));
  const latestReviewRequired = new Map<string, ChronicleEntry>();
  for (const entry of await chronicle.recent({ type: "wake.review_required", limit: 1_000 })) {
    if (!entry.taskId || latestReviewRequired.has(entry.taskId)) continue;
    latestReviewRequired.set(entry.taskId, entry);
  }
  for (const [taskId, entry] of latestReviewRequired) {
    const task = byTask.get(taskId);
    if (!task || task.status === "done" || task.status === "cancelled" || task.status === "blocked") continue;
    const team = await teamMembers(task, projections);
    rows.push({
      taskId: task.id,
      projectId: task.projectId,
      workflowId: task.workflowId,
      stageId: task.stageId,
      classification: "worker_log_review_required",
      next: "Review the worker work log and decide whether to steer, repair, continue, block, or accept.",
      suggestedCommand: `sikong trace ${task.id} --text`,
      childCount: team.length,
      activeChildren: team.filter((child) => child.status !== "done" && child.status !== "cancelled").length,
      updatedAt: entry.ts,
      ...(entry.wakeId ? { wakeId: entry.wakeId } : {}),
    });
  }
  for (const task of tasks) {
    if (task.status === "done" || task.status === "cancelled" || task.status === "blocked") continue;
    const team = await teamMembers(task, projections);
    const timeline = events ? await events.load(task.id) : [];
    const status = deriveLeadTeamStatus(task, undefined, team, {
      eventTypes: eventTypesInCurrentStage(timeline),
      acceptanceStatus: deriveAcceptanceStatus(undefined, timeline),
    });
    if (!actionable.has(status.classification)) continue;
    rows.push({
      taskId: task.id,
      projectId: task.projectId,
      workflowId: task.workflowId,
      stageId: task.stageId,
      classification: status.classification,
      next: status.next,
      suggestedCommand: suggestedLeadCommand(task.id, status.classification),
      childCount: status.total,
      activeChildren: status.active,
      updatedAt: task.updatedAt,
    });
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

function suggestedLeadCommand(taskId: string, classification: PendingLeadAction["classification"]): string {
  switch (classification) {
    case "worker_log_review_required":
      return `sikong trace ${taskId} --text`;
    case "ready_to_close":
      return `sikong run --task ${taskId}`;
    case "waiting_for_lead_acceptance":
      return `sikong task ${taskId} --text`;
    case "ready_for_parent_review":
      return `sikong task ${taskId} --text`;
    case "needs_repair_or_decision":
      return `sikong task ${taskId} --text`;
    case "waiting_for_children":
    case "no_team":
      return `sikong task ${taskId} --text`;
  }
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
  renderPendingLeadActions(lines, v.pendingLeadActions);
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

export function renderLeadActions(actions: readonly PendingLeadAction[]): string {
  const lines = ["Pending lead actions:"];
  if (actions.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }
  for (const action of actions)
    lines.push(
      `  ${action.taskId} [${action.classification}] project=${action.projectId} ${action.workflowId}@${action.stageId}` +
        ` children=${action.childCount} active=${action.activeChildren}${action.wakeId ? ` wake=${action.wakeId}` : ""}`,
      `    next: ${action.next}`,
      `    command: ${action.suggestedCommand}`,
    );
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

  renderPendingLeadActions(lines, v.pendingLeadActions);

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

function renderPendingLeadActions(lines: string[], actions: readonly PendingLeadAction[]): void {
  lines.push("", ...renderLeadActions(actions.slice(0, 20)).split("\n"));
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
    if (v.leadStatus && v.team.length) {
      const s = v.leadStatus;
      lines.push(
        "  lead/team:",
        `    classification: ${s.classification}`,
        `    children: total=${s.total} done=${s.done} cancelled=${s.cancelled} active=${s.active}`,
        `    transition requested: ${s.transitionRequested ? "yes" : "no"}; acceptance: ${s.acceptanceStatus}`,
        `    next: ${s.next}`,
      );
      for (const m of v.team) {
        const parts = [`    - ${m.id} (${m.workflowId}${m.stageId ? `@${m.stageId}` : ""}) [${m.status}]`];
        if (m.isolate) parts.push(`[isolated -> branch sikong/${m.id}]`);
        if (m.summary) parts.push(`summary: ${truncate(m.summary, 120)}`);
        else if (m.request) parts.push(`request: ${truncate(m.request, 120)}`);
        lines.push(parts.join("  "));
      }
    }
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
