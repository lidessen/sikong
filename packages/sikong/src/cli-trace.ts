import type { ChronicleEntry } from "./store";
import { JsonWorkspaceChronicleStore, JsonWorkspaceProjectionStore } from "./store";

function csv(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(",") : "";
}

function toolStarts(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const parts = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}:${String(count)}`);
  return parts.join(",");
}

function chronicleDataSuffix(e: { type: string; data?: Record<string, unknown> }): string {
  const data = e.data;
  if (!data) return "";
  if (e.type === "wake.diagnostics") {
    const parts = [
      `phase=${String(data.phase ?? "")}`,
      `stateCommands=${String(data.stateCommands ?? 0)}`,
      `tools=${toolStarts(data.toolCallStarts) || "none"}`,
    ];
    return ` [${parts.join(" ")}]`;
  }
  if (e.type === "wake.commit") {
    const parts = [
      `reason=${String(data.reason ?? "")}`,
      `allowed=${csv(data.allowedTools) || "none"}`,
    ];
    const outputFields = csv(data.outputFields);
    if (outputFields) parts.push(`outputFields=${outputFields}`);
    return ` [${parts.join(" ")}]`;
  }
  if (e.type === "wake.review_required") {
    const parts = [`reason=${String(data.reason ?? "")}`];
    const outputFields = csv(data.outputFields);
    if (outputFields) parts.push(`outputFields=${outputFields}`);
    const commandKinds = csv(data.commandKinds);
    if (commandKinds) parts.push(`commands=${commandKinds}`);
    return ` [${parts.join(" ")}]`;
  }
  if (e.type === "wake.progress") {
    const parts = [
      `phase=${String(data.phase ?? "")}`,
      `event=${String(data.event ?? "")}`,
      `tool=${String(data.tool ?? "")}`,
    ];
    if (data.argsPreview) parts.push(`args=${String(data.argsPreview).slice(0, 160)}`);
    if (data.resultPreview) parts.push(`result=${String(data.resultPreview).slice(0, 160)}`);
    if (data.error) parts.push(`error=${String(data.error).slice(0, 120)}`);
    return ` [${parts.join(" ")}]`;
  }
  if (e.type === "wake.cleanup") {
    const parts = [
      `status=${String(data.status ?? "")}`,
      `reason=${String(data.reason ?? "")}`,
    ];
    if (data.elapsedMs !== undefined) parts.push(`elapsedMs=${String(data.elapsedMs)}`);
    if (data.resultStatus) parts.push(`result=${String(data.resultStatus)}`);
    if (data.error) parts.push(`error=${String(data.error).slice(0, 120)}`);
    return ` [${parts.join(" ")}]`;
  }
  return "";
}

export function chronicleLine(e: { ts: number; type: string; taskId?: string; summary: string; data?: Record<string, unknown> }): string {
  return `${new Date(e.ts).toISOString().slice(11, 19)} ${e.type}${e.taskId ? ` ${e.taskId}` : ""} — ${e.summary}${chronicleDataSuffix(e)}`;
}

function traceTs(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

function latestWakeId(entries: readonly ChronicleEntry[]): string | undefined {
  return entries.find((entry) => entry.wakeId)?.wakeId;
}

function byNewest(a: ChronicleEntry, b: ChronicleEntry): number {
  return b.ts - a.ts || b.seq - a.seq;
}

function byOldest(a: ChronicleEntry, b: ChronicleEntry): number {
  return a.ts - b.ts || a.seq - b.seq;
}

function latestWakeStatus(entries: readonly ChronicleEntry[]): "active" | "ended" | "error" | "unknown" {
  const terminal = entries
    .filter((entry) => entry.type === "wake.end" || entry.type === "wake.error")
    .sort(byNewest)[0];
  if (terminal?.type === "wake.end") return "ended";
  if (terminal?.type === "wake.error") return "error";
  if (
    entries.some(
      (entry) =>
        entry.type === "wake.start" ||
        entry.type === "wake.progress" ||
        entry.type === "wake.steer" ||
        entry.type === "wake.diagnostics" ||
        entry.type === "wake.review_required" ||
        entry.type === "wake.cleanup",
    )
  )
    return "active";
  return "unknown";
}

function toolTimelineFrom(entries: readonly ChronicleEntry[], limit = 12): ChronicleEntry[] {
  return entries
    .filter(
      (entry) =>
        entry.type === "wake.progress" &&
        (entry.data?.event === "tool_call_start" || entry.data?.event === "tool_call_end") &&
        typeof entry.data.tool === "string",
    )
    .sort(byOldest)
    .slice(-limit);
}

function renderToolTimeline(entry: ChronicleEntry): string {
  const data = entry.data ?? {};
  const kind = data.event === "tool_call_start" ? "start" : data.error ? "error" : "end";
  const parts = [
    `${traceTs(entry.ts)} ${String(data.phase ?? "")} ${kind} ${String(data.tool ?? "")}`,
  ];
  if (data.callId) parts.push(`call=${String(data.callId)}`);
  if (data.durationMs !== undefined) parts.push(`duration=${String(data.durationMs)}ms`);
  if (data.argsPreview) parts.push(`args=${String(data.argsPreview).slice(0, 180)}`);
  if (data.resultPreview) parts.push(`result=${String(data.resultPreview).slice(0, 180)}`);
  if (data.error) parts.push(`error=${String(data.error).slice(0, 140)}`);
  return parts.join(" ");
}

export function renderTrace(view: {
  task: Awaited<ReturnType<JsonWorkspaceProjectionStore["get"]>>;
  latestWake?: {
    wakeId: string;
    status: "active" | "ended" | "error" | "unknown";
    lastEventType: string;
    lastEventAgeMs: number;
    lastTool?: string;
    stateCommands?: unknown;
    tools?: string;
    lastProgress?: ChronicleEntry;
    diagnostics?: ChronicleEntry;
    reviewRequired?: ChronicleEntry;
    cleanup?: ChronicleEntry;
    error?: ChronicleEntry;
    toolTimeline: ChronicleEntry[];
  };
  recent: ChronicleEntry[];
}): string {
  const task = view.task;
  if (!task) return "Trace: task not found";
  const lines = [
    `Trace ${task.id} [${task.status}]`,
    `  project=${task.projectId} workflow=${task.workflowId}@${task.workflowVersion} stage=${task.stageId}`,
  ];
  if (task.workerId) lines.push(`  worker=${task.workerId}`);
  lines.push(`  updated=${new Date(task.updatedAt).toISOString()}`);
  if (!view.latestWake) {
    lines.push("\nLatest wake: none");
  } else {
    const wake = view.latestWake;
    lines.push(
      `\nLatest wake: ${wake.wakeId} status=${wake.status} last=${wake.lastEventType} age=${Math.round(wake.lastEventAgeMs / 1000)}s`,
    );
    lines.push(`  worker stateCommands=${String(wake.stateCommands ?? "unknown")} tools=${wake.tools || "none"}`);
    if (wake.lastTool) lines.push(`  last tool=${wake.lastTool}`);
    if (wake.toolTimeline.length) {
      lines.push("  tools:");
      for (const entry of wake.toolTimeline) lines.push(`    ${renderToolTimeline(entry)}`);
    }
    if (wake.lastProgress) lines.push(`  progress: ${chronicleLine(wake.lastProgress)}`);
    if (wake.diagnostics) lines.push(`  diagnostics: ${chronicleLine(wake.diagnostics)}`);
    if (wake.reviewRequired) lines.push(`  review required: ${chronicleLine(wake.reviewRequired)}`);
    if (wake.cleanup) lines.push(`  cleanup: ${chronicleLine(wake.cleanup)}`);
    if (wake.error) lines.push(`  error: ${chronicleLine(wake.error)}`);
  }
  lines.push("\nRecent:");
  if (view.recent.length === 0) lines.push("  (none)");
  else for (const entry of view.recent.slice(0, 12)) lines.push(`  ${chronicleLine(entry)}`);
  return lines.join("\n");
}

export async function taskTrace(
  taskId: string,
  stores: {
    projections: JsonWorkspaceProjectionStore;
    chronicle: JsonWorkspaceChronicleStore;
  },
) {
  const task = await stores.projections.get(taskId);
  const recent = await stores.chronicle.recent({ taskId, limit: 300 });
  const wakeId = latestWakeId(recent);
  const wakeEntries = wakeId ? recent.filter((entry) => entry.wakeId === wakeId) : [];
  const latest = wakeEntries[0];
  const diagnostics = wakeEntries.find((entry) => entry.type === "wake.diagnostics");
  const reviewRequired = wakeEntries.find((entry) => entry.type === "wake.review_required");
  const lastProgress = wakeEntries.find((entry) => entry.type === "wake.progress");
  const cleanup = wakeEntries.find((entry) => entry.type === "wake.cleanup");
  const error = wakeEntries.find((entry) => entry.type === "wake.error");
  const data = diagnostics?.data;
  const progressData = lastProgress?.data;
  return {
    task,
    ...(wakeId && latest
      ? {
          latestWake: {
            wakeId,
            status: latestWakeStatus(wakeEntries),
            lastEventType: latest.type,
            lastEventAgeMs: Date.now() - latest.ts,
            ...(typeof progressData?.tool === "string" ? { lastTool: progressData.tool } : {}),
            ...(data && "stateCommands" in data ? { stateCommands: data.stateCommands } : {}),
            tools: toolStarts(data?.toolCallStarts),
            ...(lastProgress ? { lastProgress } : {}),
            ...(diagnostics ? { diagnostics } : {}),
            ...(reviewRequired ? { reviewRequired } : {}),
            ...(cleanup ? { cleanup } : {}),
            ...(error ? { error } : {}),
            toolTimeline: toolTimelineFrom(wakeEntries),
          },
        }
      : {}),
    recent,
  };
}
