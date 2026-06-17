import type { ConsoleBadgeVariant } from "./task-labels";
import type { TaskCard, TaskDetailView, WorkerRunObservation, WorkerRunView } from "./types";

export function stageBadgeVariant(
  detail: TaskDetailView | null,
  stageId: string,
): ConsoleBadgeVariant {
  if (!detail) return "outline";
  if (detail.projection.currentStageId === stageId) return "info";
  if (detail.projection.acceptedStageIds.includes(stageId)) return "ok";
  return "outline";
}

export function taskStageSummary(task: TaskCard, detail: TaskDetailView | null): string {
  if (task.currentStage) return `${task.currentStage.title} · ${task.currentStage.id}`;
  const stages = detail?.projection.plan?.stages.length ?? task.plan?.stageCount ?? 0;
  const accepted = detail?.projection.acceptedStageIds.length ?? 0;
  if (stages > 0 && accepted >= stages) return "all stages accepted";
  if (task.terminal) return `closed · ${task.terminal.outcome}`;
  return "not started";
}

export function stageLabel(detail: TaskDetailView | null, stageId: string, index: number): string {
  if (!detail) return `Stage ${index + 1}`;
  if (detail.projection.currentStageId === stageId) return "current";
  if (detail.projection.acceptedStageIds.includes(stageId)) return "done";
  return `stage ${index + 1}`;
}

export function workerStatusVariant(status: WorkerRunView["status"]): ConsoleBadgeVariant {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "budget_exceeded") return "err";
  return "info";
}

export function runtimeStatusVariant(status: string): ConsoleBadgeVariant {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "timed_out" || status === "cancelled") return "err";
  if (status === "running") return "info";
  if (status === "queued") return "neutral";
  return "outline";
}

export function observationVariant(observation: WorkerRunObservation): ConsoleBadgeVariant {
  if (observation.kind === "tool_call") {
    if (observation.status === "failed") return "err";
    if (observation.status === "completed") return "ok";
    return "info";
  }
  if (observation.kind === "thinking") return "accent";
  if (observation.kind === "error") return "err";
  if (observation.kind === "usage") return "neutral";
  return "outline";
}

export function observationLabel(observation: WorkerRunObservation): string {
  if (observation.kind === "tool_call") return "tool";
  if (observation.kind === "thinking") return "think";
  if (observation.kind === "text") return "text";
  if (observation.kind === "usage") return "tokens";
  if (observation.kind === "round_start") return "round start";
  if (observation.kind === "round_end") return "round end";
  return observation.kind.replaceAll("_", " ");
}

export function compactArgs(args: string[] | undefined): string {
  if (!args?.length) return "";
  const text = args.join(" ");
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export function formatTimeout(timeoutMs: number | undefined): string {
  if (!timeoutMs) return "none";
  return formatDuration(timeoutMs);
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRest = minutes % 60;
  return minuteRest ? `${hours}h ${minuteRest}m` : `${hours}h`;
}

export function elapsedBetween(startedAt: string, finishedAt: string): string {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return "unknown";
  return formatDuration(Math.max(0, finished - started));
}

export function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
