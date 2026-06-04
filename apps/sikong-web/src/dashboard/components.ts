/**
 * src/dashboard/components.ts — Dashboard UI components for the local monitor
 *
 * Uses plain VNode factory functions (h / fragment) from semajsx/core,
 * scoped styles via css() from semajsx/style.
 *
 * @module
 */

import { jsx as h, Fragment as fragment } from "semajsx/core"
import { css } from "semajsx/style"
import type { JSXNode } from "semajsx/html"
import type { StyleRef } from "semajsx/style"

// ── Types for data passed into components ───────────────────────────────────

export interface TaskSummary {
  id: string
  projectId: string
  workflowId: string
  stageId: string
  status: Status
  parentId?: string
  childCount: number
  updatedAt: number
}

type Status = "todo" | "in_progress" | "done" | "blocked" | "cancelled"

export interface ProjectOverview {
  id: string
  name: string
  root: string
  defaultWorkflowId?: string
  defaultWorker?: string
  permissionMode?: string
  taskCount: number
  counts: Record<Status, number>
  recentTasks: TaskSummary[]
}

export interface WorkerOverview {
  id: string
  name: string
  runtime: string
  provider: string
  model: string
  description: string
  permissionMode?: string
  isDefault: boolean
}

export interface OverviewData {
  projects: ProjectOverview[]
  workers: WorkerOverview[]
  defaultWorkerId?: string
  totalTasks: number
  counts: Record<Status, number>
  recentTasks: TaskSummary[]
  recentActivity: ChronicleEntry[]
  recentErrors: ChronicleEntry[]
}

interface ChronicleEntry {
  seq: number
  ts: number
  type: string
  taskId?: string
  projectId?: string
  data?: Record<string, unknown>
}

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  total: number
  costUsd: number
  unpricedTokens: number
  wakes: number
}

export interface UsageTaskRow extends UsageTotals {
  taskId: string
  projectId?: string
  model?: string
  billingMode: "token" | "subscription"
}

export interface UsageWindow extends UsageTotals {
  label: string
  sinceMs: number
}

export interface UsageData {
  tasks: UsageTaskRow[]
  byProject: Array<UsageTotals & { projectId: string }>
  workspace: UsageTotals
  windows: UsageWindow[]
}

// ── Utility formatters ──────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : `${n}`
}

function fmtCost(t: UsageTotals): string {
  if (t.unpricedTokens > 0 && t.costUsd === 0) return "n/a"
  return `$${t.costUsd.toFixed(4)}${t.unpricedTokens > 0 ? " (+unpriced)" : ""}`
}

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + fmtTime(ms)
}

// ── Status colors ───────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  in_progress: "#22c55e",
  done: "#3b82f6",
  failed: "#ef4444",
  todo: "#a3a3a3",
  blocked: "#f97316",
  cancelled: "#6b7280",
}

function statusColor(s: string): string {
  return STATUS_COLORS[s as keyof typeof STATUS_COLORS] ?? "#a3a3a3"
}

// ── Global / reset styles (not scoped — raw <style> injected by server) ────

export const GLOBAL_CSS = `
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC",
    Helvetica, Arial, sans-serif;
  background: #0f172a;
  color: #e2e8f0;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
a { color: #60a5fa; text-decoration: none; }
a:hover { color: #93c5fd; }
::selection { background: rgba(59, 130, 246, 0.3); }
code {
  font-family: "SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", monospace;
  font-size: 0.875em;
}
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #1e293b; }
th { color: #94a3b8; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
tr:hover td { background: #1e293b; }

/* Error state styles */
.sk-dashboard-error {
  text-align: center;
  padding: 80px 24px;
  max-width: 600px;
  margin: 0 auto;
}
.sk-dashboard-error h1 { font-size: 1.5rem; margin-bottom: 12px; }
.sk-dashboard-error p { color: #94a3b8; margin-bottom: 8px; line-height: 1.6; }
.sk-dashboard-error code {
  display: inline-block;
  background: #1e293b;
  padding: 2px 8px;
  border-radius: 4px;
  color: #60a5fa;
}
`

// ── Layout ──────────────────────────────────────────────────────────────────

const layoutRoot = css`
  display: flex;
  min-height: 100vh;
`

const sidebar = css`
  width: 240px;
  flex-shrink: 0;
  background: #0a0f1e;
  border-right: 1px solid #1e293b;
  padding: 24px 0;
  display: flex;
  flex-direction: column;
`

const sidebarBrand = css`
  padding: 0 20px 24px;
  border-bottom: 1px solid #1e293b;
  margin-bottom: 16px;
`

const sidebarTitle = css`
  font-size: 1.125rem;
  font-weight: 700;
  color: #f1f5f9;
  letter-spacing: -0.02em;
`

const sidebarSub = css`
  font-size: 0.75rem;
  color: #64748b;
  margin-top: 2px;
`

const navSection = css`
  padding: 0 12px;
  margin-bottom: 8px;
`

const navSectionTitle = css`
  font-size: 0.65rem;
  font-weight: 600;
  color: #475569;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 8px 8px 4px;
`

const navItem = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  color: #94a3b8;
  font-size: 0.875rem;
  transition: background 0.15s, color 0.15s;
  cursor: default;
`

const navItemActive = css`
  background: #1e293b;
  color: #60a5fa;
  font-weight: 500;
`

const navItemDot = css`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
`

const mainArea = css`
  flex: 1;
  overflow-y: auto;
`

const header = css`
  padding: 20px 28px;
  border-bottom: 1px solid #1e293b;
  display: flex;
  align-items: center;
  justify-content: space-between;
`

const headerTitle = css`
  font-size: 1.25rem;
  font-weight: 700;
  color: #f1f5f9;
`

const headerBadge = css`
  font-size: 0.75rem;
  color: #64748b;
  padding: 4px 10px;
  background: #1e293b;
  border-radius: 6px;
`

const content = css`
  padding: 24px 28px;
`

// ── Card ────────────────────────────────────────────────────────────────────

const card = css`
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 10px;
  padding: 20px;
  margin-bottom: 20px;
`

const cardTitle = css`
  font-size: 1rem;
  font-weight: 600;
  color: #f1f5f9;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
`

const grid2 = css`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
`

const grid3 = css`
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 16px;
`

// ── Stat block ──────────────────────────────────────────────────────────────

const statBlock = css`
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 16px;
  text-align: center;
`

const statValue = css`
  font-size: 1.75rem;
  font-weight: 700;
  color: #f1f5f9;
  line-height: 1.2;
`

const statLabel = css`
  font-size: 0.75rem;
  color: #64748b;
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
`

// ── Status badge ────────────────────────────────────────────────────────────

function badgeStyle(color: string): StyleRef {
  return css({
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "0.7rem",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    background: `${color}20`,
    color,
  })
}

function statusBadge(s: string): JSXNode {
  const color = statusColor(s)
  const dotClass = css({
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: color,
    flexShrink: 0,
  })
  return h("span", { class: badgeStyle(color), title: s },
    h("span", { class: dotClass }),
    s.replace("_", " "),
  )
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

/** Sidebar navigation panel. */
function Sidebar(data: OverviewData | null): JSXNode {
  const items = [
    { label: "Dashboard", id: "#dashboard", active: true },
    { label: "Projects", id: "#projects" },
    { label: "Usage", id: "#usage" },
  ]

  return h("nav", { class: sidebar },
    h("div", { class: sidebarBrand },
      h("div", { class: sidebarTitle }, "Sikong"),
      h("div", { class: sidebarSub }, "Monitor Dashboard"),
    ),
    h("div", { class: navSection },
      h("div", { class: navSectionTitle }, "Navigation"),
      ...items.map((item) =>
        h("div", { class: [navItem, item.active ? navItemActive : null] },
          item.active
            ? h("span", { class: [navItemDot, css({ background: "#60a5fa" })] })
            : h("span", { class: [navItemDot, css({ background: "#334155" })] }),
          item.label,
        )
      ),
    ),
    data
      ? h("div", { class: navSection },
        h("div", { class: navSectionTitle }, "Workers"),
        ...data.workers.map((w) =>
          h("div", { class: navItem },
            h("span", {
              class: [navItemDot, css({ background: STATUS_COLORS.in_progress! })],
            }),
            w.name || w.id,
          )
        ),
      )
      : null,
  )
}

// ── Header ──────────────────────────────────────────────────────────────────

const refreshTime = css`
  font-size: 0.75rem;
  color: #64748b;
`

function DashboardHeader(lastUpdated: Date): JSXNode {
  return h("header", { class: header },
    h("h1", { class: headerTitle }, "Dashboard"),
    h("div", { style: { display: "flex", alignItems: "center", gap: "12px" } },
      h("span", { class: headerBadge }, "Auto-refresh every 10s"),
      h("span", { class: refreshTime }, `Updated ${fmtTime(lastUpdated.getTime())}`),
    ),
  )
}

// ── Overview Panel ──────────────────────────────────────────────────────────

function OverviewPanel(data: OverviewData): JSXNode {
  const wCount = data.workers.length
  const pCount = data.projects.length
  const activeCount = data.counts.in_progress ?? 0
  const doneCount = data.counts.done ?? 0
  const totalCount = data.totalTasks

  return h("div", { class: card },
    h("h2", { class: cardTitle }, "Overview"),
    h("div", { class: grid3 },
      // Projects
      h("div", { class: statBlock },
        h("div", { class: statValue }, String(pCount)),
        h("div", { class: statLabel }, "Projects"),
      ),
      // Total tasks
      h("div", { class: statBlock },
        h("div", { class: statValue }, String(totalCount)),
        h("div", { class: statLabel }, "Total Tasks"),
      ),
      // Workers
      h("div", { class: statBlock },
        h("div", { class: statValue }, String(wCount)),
        h("div", { class: statLabel }, "Workers"),
      ),
    ),
    h("div", { class: grid3, style: { marginTop: "12px" } },
      // Active
      h("div", { class: statBlock },
        h("div", { class: [statValue, css({ color: STATUS_COLORS.in_progress! })] }, String(activeCount)),
        h("div", { class: statLabel }, "Active"),
      ),
      // Done
      h("div", { class: statBlock },
        h("div", { class: [statValue, css({ color: STATUS_COLORS.done! })] }, String(doneCount)),
        h("div", { class: statLabel }, "Completed"),
      ),
      // Blocked + errors
      h("div", { class: statBlock },
        h("div", { class: [statValue, css({ color: STATUS_COLORS.blocked! })] },
          String((data.counts.blocked ?? 0) + (data.counts.cancelled ?? 0)),
        ),
        h("div", { class: statLabel }, "Blocked / Cancelled"),
      ),
    ),
  )
}

// ── Usage Panel ─────────────────────────────────────────────────────────────

function UsagePanel(usage: UsageData): JSXNode {
  const w = usage.workspace

  return h("div", { class: card, id: "usage" },
    h("h2", { class: cardTitle }, "Token Usage & Cost"),

    // Workspace totals stat blocks
    h("div", { class: grid3, style: { marginBottom: "16px" } },
      h("div", { class: statBlock },
        h("div", { class: statValue }, fmtTokens(w.total)),
        h("div", { class: statLabel }, "Total Tokens"),
      ),
      h("div", { class: statBlock },
        h("div", { class: statValue }, fmtCost(w)),
        h("div", { class: statLabel }, "Total Cost"),
      ),
      h("div", { class: statBlock },
        h("div", { class: statValue }, String(w.wakes)),
        h("div", { class: statLabel }, "Wakes"),
      ),
    ),

    // Token breakdown
    h("div", { class: cardTitle }, "Token Breakdown"),
    h("table", {},
      h("thead", {},
        h("tr", {},
          h("th", {}, "Category"),
          h("th", {}, "Tokens"),
        ),
      ),
      h("tbody", {},
        h("tr", {},
          h("td", {}, "Input"),
          h("td", {}, fmtTokens(w.input)),
        ),
        h("tr", {},
          h("td", {}, "Output"),
          h("td", {}, fmtTokens(w.output)),
        ),
        h("tr", {},
          h("td", {}, "Cache Read"),
          h("td", {}, fmtTokens(w.cacheRead)),
        ),
        h("tr", {},
          h("td", {}, "Cache Creation"),
          h("td", {}, fmtTokens(w.cacheCreation)),
        ),
      ),
    ),

    // Windows section
    h("h2", { class: [cardTitle, css({ marginTop: "20px" })] }, "Time Windows"),
    h("table", {},
      h("thead", {},
        h("tr", {},
          h("th", {}, "Window"),
          h("th", {}, "Tokens"),
          h("th", {}, "Cost"),
          h("th", {}, "Wakes"),
        ),
      ),
      h("tbody", {},
        ...usage.windows.map((win) =>
          h("tr", {},
            h("td", {}, win.label),
            h("td", {}, fmtTokens(win.total)),
            h("td", {}, fmtCost(win)),
            h("td", {}, String(win.wakes)),
          )
        ),
      ),
    ),

    // By project
    usage.byProject.length > 0
      ? h("h2", { class: [cardTitle, css({ marginTop: "20px" })] }, "By Project")
      : null,
    usage.byProject.length > 0
      ? h("table", {},
        h("thead", {},
          h("tr", {},
            h("th", {}, "Project"),
            h("th", {}, "Tokens"),
            h("th", {}, "Cost"),
            h("th", {}, "Wakes"),
          ),
        ),
        h("tbody", {},
          ...usage.byProject.map((p) =>
            h("tr", {},
              h("td", {}, p.projectId),
              h("td", {}, fmtTokens(p.total)),
              h("td", {}, fmtCost(p)),
              h("td", {}, String(p.wakes)),
            )
          ),
        ),
      )
      : null,

    // Top tasks
    usage.tasks.length > 0
      ? h("h2", { class: [cardTitle, css({ marginTop: "20px" })] }, "Top Tasks by Usage")
      : null,
    usage.tasks.length > 0
      ? h("table", {},
        h("thead", {},
          h("tr", {},
            h("th", {}, "Task ID"),
            h("th", {}, "Model"),
            h("th", {}, "Tokens"),
            h("th", {}, "Cost"),
            h("th", {}, "Wakes"),
          ),
        ),
        h("tbody", {},
          ...usage.tasks.slice(0, 10).map((t) =>
            h("tr", {},
              h("td", { style: { maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis" } }, t.taskId),
              h("td", {}, t.model ?? "?"),
              h("td", {}, fmtTokens(t.total)),
              h("td", {}, fmtCost(t)),
              h("td", {}, String(t.wakes)),
            )
          ),
        ),
      )
      : null,
  )
}

// ── Task List ───────────────────────────────────────────────────────────────

const taskRowId = css`
  font-family: "SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", monospace;
  font-size: 0.8rem;
  color: #e2e8f0;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
`

const taskRowProject = css`
  font-size: 0.8rem;
  color: #94a3b8;
`

const taskRowTime = css`
  font-size: 0.8rem;
  color: #64748b;
`

function TaskList(tasks: TaskSummary[]): JSXNode {
  if (tasks.length === 0) {
    return h("div", { class: card },
      h("h2", { class: cardTitle }, "Recent Tasks"),
      h("p", { style: { color: "#64748b", fontSize: "0.875rem" } }, "No tasks yet."),
    )
  }

  return h("div", { class: card },
    h("h2", { class: cardTitle }, "Recent Tasks"),
    h("table", {},
      h("thead", {},
        h("tr", {},
          h("th", {}, "ID"),
          h("th", {}, "Project"),
          h("th", {}, "Status"),
          h("th", {}, "Updated"),
        ),
      ),
      h("tbody", {},
        ...tasks.slice(0, 15).map((t) =>
          h("tr", {},
            h("td", { class: taskRowId }, t.id),
            h("td", { class: taskRowProject }, t.projectId),
            h("td", {}, statusBadge(t.status)),
            h("td", { class: taskRowTime }, fmtDate(t.updatedAt)),
          )
        ),
      ),
    ),
  )
}

// ── Recent Activity ─────────────────────────────────────────────────────────

const activityDot = (color: string): StyleRef => css({
  width: "8px",
  height: "8px",
  borderRadius: "50%",
  background: color,
  flexShrink: 0,
  marginTop: "4px",
})

function activityColor(type: string): string {
  if (type.startsWith("wake.end")) return STATUS_COLORS.done ?? "#3b82f6"
  if (type.startsWith("wake.error") || type.startsWith("command.rejected")) return STATUS_COLORS.failed ?? "#ef4444"
  if (type.startsWith("wake.")) return STATUS_COLORS.in_progress ?? "#22c55e"
  return "#64748b"
}

function RecentActivity(entries: ChronicleEntry[]): JSXNode {
  if (entries.length === 0) {
    return h("div", { class: card },
      h("h2", { class: cardTitle }, "Recent Activity"),
      h("p", { style: { color: "#64748b", fontSize: "0.875rem" } }, "No recent activity."),
    )
  }

  const activityList = css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `

  const activityRow = css`
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 6px 0;
  `

  const activityType = css`
    font-size: 0.8rem;
    color: #e2e8f0;
    font-weight: 500;
  `

  const activityTime = css`
    font-size: 0.75rem;
    color: #64748b;
    white-space: nowrap;
  `

  const activityTaskId = css`
    font-size: 0.75rem;
    color: #94a3b8;
    font-family: "SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", monospace;
  `

  return h("div", { class: card },
    h("h2", { class: cardTitle }, "Recent Activity"),
    h("div", { class: activityList },
      ...entries.slice(0, 12).map((e) =>
        h("div", { class: activityRow },
          h("span", { class: activityDot(activityColor(e.type)) }),
          h("div", { style: { flex: "1", minWidth: "0" } },
            h("div", { class: activityType }, e.type),
            e.taskId
              ? h("div", { class: activityTaskId }, e.taskId)
              : null,
          ),
          h("span", { class: activityTime }, fmtTime(e.ts)),
        )
      ),
    ),
  )
}

// ── Error Panel ─────────────────────────────────────────────────────────────

function ErrorPanel(errors: ChronicleEntry[]): JSXNode {
  if (errors.length === 0) return null

  return h("div",
    { class: [card, css({ borderLeft: `3px solid ${STATUS_COLORS.failed}` })] },
    h("h2", { class: cardTitle }, `Errors (${errors.length})`),
    h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
      ...errors.slice(0, 5).map((e) =>
        h("div", { style: { fontSize: "0.8rem", color: "#fca5a5" } },
          h("span", { style: { color: "#64748b", marginRight: "8px" } }, fmtTime(e.ts)),
          `${e.type}: ${e.taskId ?? "(no task)"}`,
        )
      ),
    ),
  )
}

// ── Not Available message ───────────────────────────────────────────────────

const naContainer = css`
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: #0f172a;
`

const naCard = css`
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 12px;
  padding: 48px;
  max-width: 500px;
  text-align: center;
`

const naTitle = css`
  font-size: 1.25rem;
  font-weight: 700;
  color: #f1f5f9;
  margin-bottom: 12px;
`

const naText = css`
  font-size: 0.9rem;
  color: #94a3b8;
  line-height: 1.6;
  margin-bottom: 20px;
`

const naCode = css`
  display: inline-block;
  background: #0f172a;
  padding: 10px 16px;
  border-radius: 6px;
  font-family: "SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", monospace;
  font-size: 0.85rem;
  color: #60a5fa;
  margin: 8px 0;
`

export function NotAvailable(): JSXNode {
  return h("div", { class: naContainer },
    h("div", { class: naCard },
      h("div", { class: naTitle }, "Sikong CLI Not Available"),
      h("div", { class: naText },
        h("p", {}, "The sikong CLI could not be found or is not responding. Install it to monitor your workspace:"),
        h("div", { class: naCode }, "npm install -g sikong"),
        h("p", { style: { marginTop: "12px", fontSize: "0.85rem" } },
          "Or clone the repository and run from source."
        ),
      ),
    ),
  )
}

// ── Main content area / panels grid ─────────────────────────────────────────

const panelsGrid = css`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
`

const fullWidth = css`
  grid-column: 1 / -1;
`

// ── Page (dashboard view) ───────────────────────────────────────────────────

export function DashboardPage(data: OverviewData, usage: UsageData, lastUpdated: Date): JSXNode {
  return fragment({ children: [
    Sidebar(data),
    h("div", { class: mainArea },
      DashboardHeader(lastUpdated),
      h("div", { class: content },
        h("div", { class: panelsGrid },
          h("div", { class: fullWidth },
            OverviewPanel(data),
          ),
          h("div", { class: fullWidth },
            TaskList(data.recentTasks),
          ),
          h("div", {},
            RecentActivity(data.recentActivity),
            ErrorPanel(data.recentErrors),
          ),
          h("div", {},
            UsagePanel(usage),
          ),
        ),
      ),
    ),
  ]})
}
