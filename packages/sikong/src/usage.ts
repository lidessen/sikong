import { modelPricing } from "agent-loop";
import type { ChronicleEntry } from "./store/types";

/**
 * Usage & cost accounting (ADR 0013). The engine records each wake's token usage
 * (uncached input / output / cache-read / cache-creation, plus the hired model)
 * on its `wake.end`/`wake.error` chronicle entry. This module aggregates those
 * entries per task / project / workspace and, for pay-per-token workers, prices
 * them from the vendored LiteLLM snapshot via `modelPricing`.
 *
 * Honesty: token counts are reported for every wake. A dollar cost is shown ONLY
 * for `billingMode: "token"` workers with a known model price — subscription
 * workers (quota/window-based) and unknown models report cost as n/a (never
 * guessed). Time-windowed views (5h / 7d / 30d) follow ccusage's approach:
 * absolute usage grouped by the entry timestamp. Rate-limit % (the subscription
 * denominator) needs provider headers the SDKs don't yet expose — deferred.
 */

interface WakeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  model?: string;
  provider?: string;
  billingMode?: "token" | "subscription";
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  /** Summed $ cost over the priced wakes (token-billed, known model). */
  costUsd: number;
  /** Tokens whose wakes could not be priced ($ n/a) — kept honest. */
  unpricedTokens: number;
  wakes: number;
}

export interface UsageTaskRow extends UsageTotals {
  taskId: string;
  projectId?: string;
  model?: string;
  billingMode: "token" | "subscription";
}

export interface UsageWindow extends UsageTotals {
  label: string;
  sinceMs: number;
}

export interface UsageReport {
  tasks: UsageTaskRow[];
  byProject: Array<UsageTotals & { projectId: string }>;
  workspace: UsageTotals;
  windows: UsageWindow[];
}

const emptyTotals = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
  costUsd: 0,
  unpricedTokens: 0,
  wakes: 0,
});

/** Cost of one wake in USD, or undefined when it cannot be priced. */
export function wakeCostUsd(u: WakeUsage): number | undefined {
  if (u.billingMode === "subscription") return undefined;
  if (!u.model) return undefined;
  const price = modelPricing(u.model);
  if (!price) return undefined;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheCreation = u.cacheCreationTokens ?? 0;
  return (
    (u.inputTokens / 1e6) * price.inputPer1M +
    (u.outputTokens / 1e6) * price.outputPer1M +
    (cacheRead / 1e6) * (price.cacheReadPer1M ?? price.inputPer1M) +
    (cacheCreation / 1e6) * (price.cacheWritePer1M ?? price.inputPer1M)
  );
}

function parseWakeUsage(entry: ChronicleEntry): WakeUsage | undefined {
  const u = entry.data?.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return undefined;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    totalTokens: num(u.totalTokens),
    ...(typeof u.cacheReadTokens === "number" ? { cacheReadTokens: u.cacheReadTokens } : {}),
    ...(typeof u.cacheCreationTokens === "number" ? { cacheCreationTokens: u.cacheCreationTokens } : {}),
    ...(typeof u.model === "string" ? { model: u.model } : {}),
    ...(typeof u.provider === "string" ? { provider: u.provider } : {}),
    ...(u.billingMode === "subscription" || u.billingMode === "token" ? { billingMode: u.billingMode } : {}),
  };
}

function fold(into: UsageTotals, u: WakeUsage): void {
  into.input += u.inputTokens;
  into.output += u.outputTokens;
  into.cacheRead += u.cacheReadTokens ?? 0;
  into.cacheCreation += u.cacheCreationTokens ?? 0;
  into.total += u.totalTokens;
  into.wakes += 1;
  const cost = wakeCostUsd(u);
  if (cost === undefined) into.unpricedTokens += u.totalTokens;
  else into.costUsd += cost;
}

const WINDOWS: ReadonlyArray<readonly [label: string, ms: number]> = [
  ["last 5h", 5 * 60 * 60 * 1000],
  ["last 7d", 7 * 24 * 60 * 60 * 1000],
  ["last 30d", 30 * 24 * 60 * 60 * 1000],
];

/** Aggregate wake.end/wake.error chronicle entries into a usage+cost report. */
export function summarizeUsage(
  entries: ChronicleEntry[],
  taskProject: Map<string, string>,
  now: number,
): UsageReport {
  const perTask = new Map<string, UsageTaskRow>();
  const perProject = new Map<string, UsageTotals & { projectId: string }>();
  const workspace = emptyTotals();
  const windows: UsageWindow[] = WINDOWS.map(([label, ms]) => ({
    ...emptyTotals(),
    label,
    sinceMs: now - ms,
  }));

  for (const entry of entries) {
    const u = parseWakeUsage(entry);
    if (!u) continue;
    fold(workspace, u);

    const taskId = entry.taskId ?? "(unknown)";
    const projectId = entry.taskId ? taskProject.get(entry.taskId) : undefined;
    let row = perTask.get(taskId);
    if (!row) {
      row = {
        ...emptyTotals(),
        taskId,
        ...(projectId ? { projectId } : {}),
        ...(u.model ? { model: u.model } : {}),
        billingMode: u.billingMode ?? "token",
      };
      perTask.set(taskId, row);
    }
    fold(row, u);

    if (projectId) {
      let proj = perProject.get(projectId);
      if (!proj) {
        proj = { ...emptyTotals(), projectId };
        perProject.set(projectId, proj);
      }
      fold(proj, u);
    }

    for (const w of windows) if (entry.ts >= w.sinceMs) fold(w, u);
  }

  return {
    tasks: [...perTask.values()].sort((a, b) => b.total - a.total),
    byProject: [...perProject.values()].sort((a, b) => b.total - a.total),
    workspace,
    windows,
  };
}

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

const fmtCost = (t: UsageTotals): string =>
  t.unpricedTokens > 0 && t.costUsd === 0
    ? "n/a"
    : `$${t.costUsd.toFixed(4)}${t.unpricedTokens > 0 ? " (+unpriced)" : ""}`;

/** Human-readable usage report. */
export function renderUsage(report: UsageReport, opts: { scope?: string } = {}): string {
  const lines: string[] = [];
  const w = report.workspace;
  lines.push(`Usage${opts.scope ? ` — ${opts.scope}` : ""}: ${fmtTokens(w.total)} tokens over ${w.wakes} wakes — ${fmtCost(w)}`);
  lines.push(
    `  in ${fmtTokens(w.input)} · out ${fmtTokens(w.output)} · cache-read ${fmtTokens(w.cacheRead)} · cache-write ${fmtTokens(w.cacheCreation)}`,
  );
  if (report.byProject.length) {
    lines.push("", "By project:");
    for (const p of report.byProject) {
      lines.push(`  ${p.projectId}  ${fmtTokens(p.total)} tok  ${fmtCost(p)}  (${p.wakes} wakes)`);
    }
  }
  if (report.tasks.length) {
    lines.push("", "Top tasks:");
    for (const t of report.tasks.slice(0, 12)) {
      lines.push(
        `  ${t.taskId}  ${t.model ?? "?"}  ${fmtTokens(t.total)} tok  ${fmtCost(t)}${t.billingMode === "subscription" ? " [subscription]" : ""}`,
      );
    }
  }
  lines.push("", "Windows:");
  for (const win of report.windows) {
    lines.push(`  ${win.label}: ${fmtTokens(win.total)} tok  ${fmtCost(win)}  (${win.wakes} wakes)`);
  }
  if (report.workspace.unpricedTokens > 0) {
    lines.push(
      "",
      `Note: ${fmtTokens(report.workspace.unpricedTokens)} tokens are unpriced (subscription worker or unknown model price) — $ excludes them.`,
    );
  }
  return lines.join("\n");
}
