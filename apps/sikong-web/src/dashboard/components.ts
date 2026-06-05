/**
 * src/dashboard/components.ts — Dashboard UI components for the local monitor
 *
 * Design language: Precision Product Craft (Linear · Vercel · Stripe lineage).
 * Philosophy: earn trust through craft and restraint — "the monitor as a
 * precision instrument." Monochrome dark canvas + one hard-working blue accent.
 * Omits: stock illustration, rounded softness, multi-color palettes, decorative
 * glow, box shadows, slow motion. Elevates: sharp typography, generous
 * whitespace, real data density, flat depth via border distinction.
 *
 * Built with semajsx: h (jsx), css (scoped styles), fragment.
 *
 * @module
 */

import { jsx as h, Fragment as fragment } from "semajsx/core"
import { css } from "semajsx/style"
import type { JSXNode } from "semajsx/html"
import type { StyleRef } from "semajsx/style"

// ── Design tokens ────────────────────────────────────────────────────────────
// Precision Product Craft: monochrome dark canvas + single blue accent.
// 4px base grid; Inter/Geist sans + JetBrains Mono; 6px precise radii.

const T = {
  // Canvas — deep rich black. Not #000 (too harsh), not navy (too terminal).
  bg: "#09090b",
  bgAlt: "#0f0f11",
  surface: "#18181b",
  surfaceHover: "#1f1f23",

  // Borders — hairline, low contrast. Precision over decoration.
  border: "#27272a",
  borderHover: "#3a3a3f",

  // Type
  text: "#fafafa",
  textDim: "#a1a1aa",
  textMuted: "#71717a",

  // Accent — the ONE hard-working color. Primary actions, active state, key signals.
  accent: "#3b82f6",
  accentHover: "#2563eb",
  accentBg: "rgba(59, 130, 246, 0.06)",
  accentBorder: "rgba(59, 130, 246, 0.15)",

  // Semantic — minimal, functional
  success: "#22c55e",
  warning: "#f59e0b",
  error: "#ef4444",
  neutral: "#71717a",

  // Typography — Inter/Geist lineage (geometric, slightly cold, high contrast)
  fontSans:
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif",
  fontMono: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",

  // Shape — small, precise radii; not rounded/friendly
  radius: "6px",
  radiusSm: "4px",

  // Spacing — 4px base grid
  space1: "4px",
  space2: "8px",
  space3: "12px",
  space4: "16px",
  space6: "24px",

  // Motion — fast, functional. No decorative animations.
  duration: "150ms",
} as const

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

// ── Status colors ───────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  in_progress: T.success,
  done: T.accent,
  failed: T.error,
  todo: T.neutral,
  blocked: T.warning,
  cancelled: T.textMuted,
}

function statusColor(s: string): string {
  return STATUS_COLORS[s as keyof typeof STATUS_COLORS] ?? T.neutral
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

// ── Global / reset styles ───────────────────────────────────────────────────

export const GLOBAL_CSS = `
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; }
body {
  font-family: ${T.fontSans};
  background: ${T.bg};
  color: ${T.textDim};
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
a { color: ${T.accent}; text-decoration: none; transition: color ${T.duration} ease; }
a:hover { color: ${T.accentHover}; }
::selection { background: rgba(59, 130, 246, 0.25); }
code {
  font-family: ${T.fontMono};
  font-size: 0.75rem;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}
th, td {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid ${T.border};
}
th {
  color: ${T.textMuted};
  font-weight: 600;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding-bottom: 10px;
}
tr:last-child td { border-bottom: none; }
tr:hover td { background: ${T.surfaceHover}; }

/* Scrollbar — subtle, functional */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: ${T.borderHover}; }

/* Error state styles */
.sk-dashboard-error {
  text-align: center;
  padding: 80px 24px;
  max-width: 560px;
  margin: 0 auto;
}
.sk-dashboard-error h1 {
  font-size: 1.25rem;
  font-weight: 600;
  margin-bottom: 12px;
  color: ${T.text};
}
.sk-dashboard-error p {
  color: ${T.textDim};
  margin-bottom: 8px;
  line-height: 1.6;
}
.sk-dashboard-error code {
  display: inline-block;
  background: ${T.surface};
  padding: 2px 8px;
  border-radius: ${T.radiusSm};
  color: ${T.accent};
}
`

// ── Layout ──────────────────────────────────────────────────────────────────

const layoutRoot = css`
  display: flex;
  min-height: 100vh;
`

const sidebar = css`
  width: 220px;
  flex-shrink: 0;
  background: ${T.bg};
  border-right: 1px solid ${T.border};
  padding: ${T.space6} 0;
  display: flex;
  flex-direction: column;
`

const sidebarBrand = css`
  padding: 0 16px ${T.space6};
  border-bottom: 1px solid ${T.border};
  margin-bottom: ${T.space4};
`

const sidebarTitle = css`
  font-size: 1.0625rem;
  font-weight: 700;
  color: ${T.text};
  letter-spacing: -0.02em;
  line-height: 1.3;
`

const sidebarSub = css`
  font-size: 0.6875rem;
  color: ${T.textMuted};
  margin-top: 2px;
  letter-spacing: 0.02em;
`

const navSection = css`
  padding: 0 ${T.space3};
  margin-bottom: ${T.space2};
`

const navSectionTitle = css`
  font-size: 0.625rem;
  font-weight: 600;
  color: ${T.textMuted};
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: ${T.space2} ${T.space2} ${T.space1};
`

const navItem = css`
  display: flex;
  align-items: center;
  gap: ${T.space2};
  padding: 7px ${T.space3};
  border-radius: ${T.radius};
  color: ${T.textDim};
  font-size: 13px;
  transition: background ${T.duration} ease, color ${T.duration} ease;
  cursor: default;
`

const navItemActive = css`
  background: ${T.surface};
  color: ${T.accent};
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
  min-width: 0;
`

const header = css`
  padding: ${T.space4} 24px;
  border-bottom: 1px solid ${T.border};
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 56px;
`

const headerTitle = css`
  font-size: 1rem;
  font-weight: 600;
  color: ${T.text};
  line-height: 1.4;
`

const headerBadge = css`
  font-size: 0.6875rem;
  color: ${T.textMuted};
  padding: 4px 10px;
  background: ${T.surface};
  border: 1px solid ${T.border};
  border-radius: ${T.radiusSm};
  letter-spacing: 0.02em;
`

const refreshTime = css`
  font-size: 0.6875rem;
  color: ${T.textMuted};
`

const content = css`
  padding: ${T.space6};
  max-width: 1200px;
`

// ── Card ────────────────────────────────────────────────────────────────────
// Depth via border + subtle background distinction. No box shadows.

const card = css`
  background: ${T.surface};
  border: 1px solid ${T.border};
  border-radius: ${T.radius};
  padding: ${T.space4};
  margin-bottom: ${T.space4};
`

const cardTitle = css`
  font-size: 1rem;
  font-weight: 600;
  color: ${T.text};
  line-height: 1.4;
  margin-bottom: ${T.space4};
  display: flex;
  align-items: center;
  justify-content: space-between;
`

// ── Stat grid ───────────────────────────────────────────────────────────────
// 3-across for first-row glance. Single-column stack for remaining panels.

const grid3 = css`
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: ${T.space3};
`

// ── Stat block ──────────────────────────────────────────────────────────────

const statBlock = css`
  background: ${T.bg};
  border: 1px solid ${T.border};
  border-radius: ${T.radius};
  padding: ${T.space4};
  text-align: center;
`

const statValue = css`
  font-size: 1.75rem;
  font-weight: 700;
  color: ${T.text};
  line-height: 1.2;
  letter-spacing: -0.02em;
`

const statLabel = css`
  font-size: 0.6875rem;
  color: ${T.textMuted};
  margin-top: ${T.space1};
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
`

// ── Status badge ────────────────────────────────────────────────────────────

function badgeStyle(color: string): StyleRef {
  return css({
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    padding: "2px 8px",
    borderRadius: T.radiusSm,
    fontSize: "0.625rem",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    background: `${color}18`,
    color,
  })
}

function statusBadge(s: string): JSXNode {
  const color = statusColor(s)
  const dotClass = css({
    width: "5px",
    height: "5px",
    borderRadius: "50%",
    background: color,
    flexShrink: 0,
  })
  return h("span", { class: badgeStyle(color), title: s },
    h("span", { class: dotClass }),
    s.replace("_", " "),
  )
}

// ── Section divider ─────────────────────────────────────────────────────────

const sectionDivider = css`
  border: none;
  border-top: 1px solid ${T.border};
  margin: ${T.space4} 0;
`

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
      h("div", { class: sidebarSub }, "Monitor"),
    ),
    h("div", { class: navSection },
      h("div", { class: navSectionTitle }, "Navigation"),
      ...items.map((item) =>
        h("div", { class: [navItem, item.active ? navItemActive : null] },
          item.active
            ? h("span", { class: [navItemDot, css({ background: T.accent })] })
            : h("span", { class: [navItemDot, css({ background: T.border })] }),
          item.label,
        )
      ),
    ),
    data && data.workers.length > 0
      ? h("div", { class: navSection, style: { marginTop: T.space2 } },
        h("div", { class: navSectionTitle }, "Workers"),
        ...data.workers.map((w) =>
          h("div", { class: navItem },
            h("span", {
              class: [navItemDot, css({ background: T.success })],
            }),
            h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              w.name || w.id,
            ),
          )
        ),
      )
      : null,
  )
}

// ── Header ──────────────────────────────────────────────────────────────────

function DashboardHeader(lastUpdated: Date): JSXNode {
  return h("header", { class: header },
    h("h1", { class: headerTitle }, "Dashboard"),
    h("div", { style: { display: "flex", alignItems: "center", gap: T.space3 } },
      h("span", { class: headerBadge }, "Auto 10s"),
      h("span", { class: refreshTime }, `Updated ${fmtTime(lastUpdated.getTime())}`),
    ),
  )
}

// ── Overview Panel ──────────────────────────────────────────────────────────
// First glance: 3 stats across. Second row: 3 status counts. Single card.

function OverviewPanel(data: OverviewData): JSXNode {
  const wCount = data.workers.length
  const pCount = data.projects.length
  const activeCount = data.counts.in_progress ?? 0
  const doneCount = data.counts.done ?? 0
  const totalCount = data.totalTasks
  const blockedCount = (data.counts.blocked ?? 0) + (data.counts.cancelled ?? 0)

  return h("div", { class: card },
    h("h2", { class: cardTitle }, "Overview"),

    // Row 1: resource counts
    h("div", { class: grid3 },
      h("div", { class: statBlock },
        h("div", { class: statValue }, String(pCount)),
        h("div", { class: statLabel }, "Projects"),
      ),
      h("div", { class: statBlock },
        h("div", { class: statValue }, String(totalCount)),
        h("div", { class: statLabel }, "Total Tasks"),
      ),
      h("div", { class: statBlock },
        h("div", { class: statValue }, String(wCount)),
        h("div", { class: statLabel }, "Workers"),
      ),
    ),

    // Row 2: status breakdown
    h("div", { class: grid3, style: { marginTop: T.space3 } },
      h("div", { class: statBlock },
        h("div", { class: [statValue, css({ color: T.success })] }, String(activeCount)),
        h("div", { class: statLabel }, "Active"),
      ),
      h("div", { class: statBlock },
        h("div", { class: [statValue, css({ color: T.accent })] }, String(doneCount)),
        h("div", { class: statLabel }, "Completed"),
      ),
      h("div", { class: statBlock },
        h("div", { class: [statValue, css({ color: T.warning })] }, String(blockedCount)),
        h("div", { class: statLabel }, "Blocked"),
      ),
    ),
  )
}

// ── Task List ───────────────────────────────────────────────────────────────

const taskRowId = css`
  font-family: ${T.fontMono};
  font-size: 0.75rem;
  color: ${T.text};
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const taskRowProject = css`
  font-size: 13px;
  color: ${T.textDim};
`

const taskRowTime = css`
  font-size: 0.75rem;
  color: ${T.textMuted};
  font-variant-numeric: tabular-nums;
`

function TaskList(tasks: TaskSummary[]): JSXNode {
  if (tasks.length === 0) {
    return h("div", { class: card },
      h("h2", { class: cardTitle }, "Recent Tasks"),
      h("p", { style: { color: T.textMuted, fontSize: "13px" } }, "No tasks yet."),
    )
  }

  return h("div", { class: card },
    h("h2", { class: cardTitle },
      "Recent Tasks",
      h("span", { style: { fontSize: "0.6875rem", color: T.textMuted, fontWeight: 400, textTransform: "none", letterSpacing: 0 } },
        `${tasks.length} total`,
      ),
    ),
    h("table", {},
      h("thead", {},
        h("tr", {},
          h("th", {}, "ID"),
          h("th", {}, "Project"),
          h("th", {}, "Status"),
          h("th", { style: { textAlign: "right" } }, "Updated"),
        ),
      ),
      h("tbody", {},
        ...tasks.slice(0, 15).map((t) =>
          h("tr", {},
            h("td", { class: taskRowId }, t.id),
            h("td", { class: taskRowProject }, t.projectId),
            h("td", {}, statusBadge(t.status)),
            h("td", { class: taskRowTime, style: { textAlign: "right" } }, fmtDate(t.updatedAt)),
          )
        ),
      ),
    ),
  )
}

// ── Project List ────────────────────────────────────────────────────────────

function ProjectList(projects: ProjectOverview[]): JSXNode {
  if (projects.length === 0) return null

  return h("div", { class: card, id: "projects" },
    h("h2", { class: cardTitle },
      "Projects",
      h("span", { style: { fontSize: "0.6875rem", color: T.textMuted, fontWeight: 400, textTransform: "none", letterSpacing: 0 } },
        `${projects.length} active`,
      ),
    ),
    h("table", {},
      h("thead", {},
        h("tr", {},
          h("th", {}, "Name"),
          h("th", {}, "Root"),
          h("th", {}, "Tasks"),
          h("th", {}, "Active"),
          h("th", {}, "Done"),
          h("th", {}, "Blocked"),
        ),
      ),
      h("tbody", {},
        ...projects.map((p) =>
          h("tr", {},
            h("td", { style: { color: T.text, fontWeight: 500 } }, p.name),
            h("td", { style: { fontFamily: T.fontMono, fontSize: "0.75rem", color: T.textDim, maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.root),
            h("td", { style: { color: T.text } }, String(p.taskCount)),
            h("td", {},
              (p.counts.in_progress ?? 0) > 0
                ? h("span", { style: { color: T.success, fontWeight: 600 } }, String(p.counts.in_progress))
                : h("span", { style: { color: T.textMuted } }, "0"),
            ),
            h("td", { style: { color: T.text } }, String(p.counts.done ?? 0)),
            h("td", {},
              (p.counts.blocked ?? 0) > 0
                ? h("span", { style: { color: T.warning, fontWeight: 600 } }, String(p.counts.blocked))
                : h("span", { style: { color: T.textMuted } }, "0"),
            ),
          )
        ),
      ),
    ),
  )
}

// ── Recent Activity ─────────────────────────────────────────────────────────

const activityDot = (color: string): StyleRef => css({
  width: "7px",
  height: "7px",
  borderRadius: "50%",
  background: color,
  flexShrink: 0,
  marginTop: "4px",
})

function activityColor(type: string): string {
  if (type.startsWith("wake.end")) return T.accent
  if (type.startsWith("wake.error") || type.startsWith("command.rejected")) return T.error
  if (type.startsWith("wake.")) return T.success
  return T.textMuted
}

const activityList = css`
  display: flex;
  flex-direction: column;
  gap: 6px;
`

const activityRow = css`
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 5px 0;
`

const activityType = css`
  font-size: 13px;
  color: ${T.text};
  font-weight: 500;
  line-height: 1.4;
`

const activityTime = css`
  font-size: 0.6875rem;
  color: ${T.textMuted};
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
`

const activityTaskId = css`
  font-size: 0.6875rem;
  color: ${T.textDim};
  font-family: ${T.fontMono};
  margin-top: 1px;
`

function RecentActivity(entries: ChronicleEntry[]): JSXNode {
  if (entries.length === 0) {
    return h("div", { class: card },
      h("h2", { class: cardTitle }, "Recent Activity"),
      h("p", { style: { color: T.textMuted, fontSize: "13px" } }, "No recent activity."),
    )
  }

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
    { class: [card, css({ borderLeft: `3px solid ${T.error}` })] },
    h("h2", { class: cardTitle },
      h("span", { style: { color: T.error } }, `Errors (${errors.length})`),
    ),
    h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
      ...errors.slice(0, 5).map((e) =>
        h("div", { style: { fontSize: "13px", color: "#fca5a5", lineHeight: 1.5 } },
          h("span", { style: { color: T.textMuted, marginRight: T.space2, fontVariantNumeric: "tabular-nums" } }, fmtTime(e.ts)),
          `${e.type}: ${e.taskId ?? "(no task)"}`,
        )
      ),
    ),
  )
}

// ── Usage Panel ─────────────────────────────────────────────────────────────
// Information-dense. Sections separated by dividers, not separate cards.

function UsagePanel(usage: UsageData): JSXNode {
  const w = usage.workspace

  const sectionLabel = css`
    font-size: 0.75rem;
    font-weight: 600;
    color: ${T.textDim};
    margin-bottom: ${T.space3};
    letter-spacing: 0.02em;
  `

  return h("div", { class: card, id: "usage" },
    h("h2", { class: cardTitle }, "Token Usage & Cost"),

    // Workspace totals
    h("div", { class: grid3, style: { marginBottom: T.space4 } },
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
    h("hr", { class: sectionDivider }),
    h("div", { class: sectionLabel }, "Token Breakdown"),
    h("table", {},
      h("thead", {},
        h("tr", {},
          h("th", {}, "Category"),
          h("th", { style: { textAlign: "right" } }, "Tokens"),
        ),
      ),
      h("tbody", {},
        h("tr", {},
          h("td", {}, "Input"),
          h("td", { style: { textAlign: "right", fontFamily: T.fontMono, fontSize: "0.75rem", color: T.text } }, fmtTokens(w.input)),
        ),
        h("tr", {},
          h("td", {}, "Output"),
          h("td", { style: { textAlign: "right", fontFamily: T.fontMono, fontSize: "0.75rem", color: T.text } }, fmtTokens(w.output)),
        ),
        h("tr", {},
          h("td", {}, "Cache Read"),
          h("td", { style: { textAlign: "right", fontFamily: T.fontMono, fontSize: "0.75rem", color: T.text } }, fmtTokens(w.cacheRead)),
        ),
        h("tr", {},
          h("td", {}, "Cache Creation"),
          h("td", { style: { textAlign: "right", fontFamily: T.fontMono, fontSize: "0.75rem", color: T.text } }, fmtTokens(w.cacheCreation)),
        ),
      ),
    ),

    // Time windows
    h("hr", { class: sectionDivider }),
    h("div", { class: sectionLabel }, "Time Windows"),
    h("table", {},
      h("thead", {},
        h("tr", {},
          h("th", {}, "Window"),
          h("th", { style: { textAlign: "right" } }, "Tokens"),
          h("th", { style: { textAlign: "right" } }, "Cost"),
          h("th", { style: { textAlign: "right" } }, "Wakes"),
        ),
      ),
      h("tbody", {},
        ...usage.windows.map((win) =>
          h("tr", {},
            h("td", { style: { color: T.text } }, win.label),
            h("td", { style: { textAlign: "right", fontFamily: T.fontMono, fontSize: "0.75rem", color: T.text } }, fmtTokens(win.total)),
            h("td", { style: { textAlign: "right", fontFamily: T.fontMono, fontSize: "0.75rem", color: T.text } }, fmtCost(win)),
            h("td", { style: { textAlign: "right", color: T.text } }, String(win.wakes)),
          )
        ),
      ),
    ),

    // By project
    usage.byProject.length > 0
      ? fragment({ children: [
        h("hr", { class: sectionDivider }),
        h("div", { class: sectionLabel }, "By Project"),
        h("table", {},
          h("thead", {},
            h("tr", {},
              h("th", {}, "Project"),
              h("th", { style: { textAlign: "right" } }, "Tokens"),
              h("th", { style: { textAlign: "right" } }, "Cost"),
              h("th", { style: { textAlign: "right" } }, "Wakes"),
            ),
          ),
          h("tbody", {},
            ...usage.byProject.map((p) =>
              h("tr", {},
                h("td", { style: { color: T.text, fontWeight: 500 } }, p.projectId),
                h("td", { style: { textAlign: "right", fontFamily: T.fontMono, fontSize: "0.75rem", color: T.text } }, fmtTokens(p.total)),
                h("td", { style: { textAlign: "right", fontFamily: T.fontMono, fontSize: "0.75rem", color: T.text } }, fmtCost(p)),
                h("td", { style: { textAlign: "right", color: T.text } }, String(p.wakes)),
              )
            ),
          ),
        ),
      ]})
      : null,

    // Top tasks
    usage.tasks.length > 0
      ? fragment({ children: [
        h("hr", { class: sectionDivider }),
        h("div", {
          class: sectionLabel,
          style: { marginBottom: T.space3 },
        }, `Top Tasks by Usage (${Math.min(usage.tasks.length, 10)} of ${usage.tasks.length})`),
        h("table", {},
          h("thead", {},
            h("tr", {},
              h("th", {}, "Task ID"),
              h("th", {}, "Model"),
              h("th", { style: { textAlign: "right" } }, "Tokens"),
              h("th", { style: { textAlign: "right" } }, "Cost"),
              h("th", { style: { textAlign: "right" } }, "Wakes"),
            ),
          ),
          h("tbody", {},
            ...usage.tasks.slice(0, 10).map((t) =>
              h("tr", {},
                h("td", {
                  class: taskRowId,
                  style: { maxWidth: "200px" },
                }, t.taskId),
                h("td", { style: { fontSize: "0.75rem", color: T.textDim } }, t.model ?? "?"),
                h("td", { style: { textAlign: "right", fontFamily: T.fontMono, fontSize: "0.75rem", color: T.text } }, fmtTokens(t.total)),
                h("td", { style: { textAlign: "right", fontFamily: T.fontMono, fontSize: "0.75rem", color: T.text } }, fmtCost(t)),
                h("td", { style: { textAlign: "right", color: T.text } }, String(t.wakes)),
              )
            ),
          ),
        ),
      ]})
      : null,
  )
}

// ── Worker List ─────────────────────────────────────────────────────────────

function WorkerList(workers: WorkerOverview[]): JSXNode {
  if (workers.length === 0) return null

  return h("div", { class: card },
    h("h2", { class: cardTitle },
      "Workers",
      h("span", { style: { fontSize: "0.6875rem", color: T.textMuted, fontWeight: 400, textTransform: "none", letterSpacing: 0 } },
        `${workers.length} configured`,
      ),
    ),
    h("table", {},
      h("thead", {},
        h("tr", {},
          h("th", {}, "Name"),
          h("th", {}, "Runtime"),
          h("th", {}, "Provider"),
          h("th", {}, "Model"),
          h("th", {}, "Mode"),
        ),
      ),
      h("tbody", {},
        ...workers.map((w) =>
          h("tr", {},
            h("td", { style: { color: T.text, fontWeight: 500 } },
              w.name || w.id,
              w.isDefault
                ? h("span", { style: { marginLeft: "6px", fontSize: "0.625rem", color: T.accent, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" } }, "default")
                : null,
            ),
            h("td", { style: { color: T.textDim, fontSize: "0.75rem" } }, w.runtime),
            h("td", { style: { color: T.textDim, fontSize: "0.75rem" } }, w.provider),
            h("td", { style: { fontFamily: T.fontMono, fontSize: "0.75rem", color: T.text } }, w.model),
            h("td", { style: { fontSize: "0.75rem", color: T.textMuted } }, w.permissionMode ?? "default"),
          )
        ),
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
  background: ${T.bg};
`

const naCard = css`
  background: ${T.surface};
  border: 1px solid ${T.border};
  border-radius: ${T.radius};
  padding: 48px;
  max-width: 500px;
  text-align: center;
`

const naTitle = css`
  font-size: 1.125rem;
  font-weight: 600;
  color: ${T.text};
  margin-bottom: ${T.space3};
  line-height: 1.4;
`

const naText = css`
  font-size: 13px;
  color: ${T.textDim};
  line-height: 1.6;
  margin-bottom: ${T.space4};
`

const naCode = css`
  display: inline-block;
  background: ${T.bg};
  padding: 10px 16px;
  border-radius: ${T.radius};
  font-family: ${T.fontMono};
  font-size: 0.8125rem;
  color: ${T.accent};
  margin: ${T.space2} 0;
  border: 1px solid ${T.border};
`

export function NotAvailable(): JSXNode {
  return h("div", { class: naContainer },
    h("div", { class: naCard },
      h("div", { class: naTitle }, "Sikong CLI Not Available"),
      h("div", { class: naText },
        h("p", {}, "The sikong CLI could not be found or is not responding. Install it to monitor your workspace:"),
        h("div", { class: naCode }, "npm install -g sikong"),
        h("p", { style: { marginTop: T.space3, fontSize: "0.8125rem" } },
          "Or clone the repository and run from source."
        ),
      ),
    ),
  )
}

// ── Page (dashboard view) ───────────────────────────────────────────────────
// Single-column stack. Operator reads top-to-bottom; scan efficiency beats
// side-by-side comparison. Stats row first, then each panel full-width.

export function DashboardPage(data: OverviewData, usage: UsageData, lastUpdated: Date): JSXNode {
  return fragment({ children: [
    Sidebar(data),
    h("div", { class: mainArea },
      DashboardHeader(lastUpdated),
      h("div", { class: content },
        // First glance: overview stats (3-across grid)
        OverviewPanel(data),

        // Project table — the operator's work queue
        ProjectList(data.projects),

        // Recent task feed
        TaskList(data.recentTasks),

        // Usage: single consolidated card with dividers
        UsagePanel(usage),

        // Recent activity timeline
        RecentActivity(data.recentActivity),

        // Error panel (only shows when errors exist)
        ErrorPanel(data.recentErrors),

        // Worker configuration
        WorkerList(data.workers),
      ),
    ),
  ]})
}
