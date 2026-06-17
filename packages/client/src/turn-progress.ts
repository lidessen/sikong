import type {
  ClientTurnActivity,
  ClientTurnProgress,
  ClientTurnProgressPhase,
  ClientTurnProgressPhaseId,
  ClientTurnProgressStatus,
} from "./types";

interface TurnProgressInput {
  startedAt: string;
  workspaceName?: string;
  taskId?: string;
  activePhaseId?: ClientTurnProgressPhaseId;
  detail?: string;
  activities?: ClientTurnActivity[];
  nowMs?: number;
}

interface TurnProgressPhaseTemplate {
  id: ClientTurnProgressPhaseId;
  title: string;
  detail: string;
  startsAtMs: number;
  substeps: string[];
}

const PHASES: TurnProgressPhaseTemplate[] = [
  {
    id: "prepare",
    title: "Understand request",
    detail: "Read your instruction and decide what kind of response or action is needed.",
    startsAtMs: 0,
    substeps: ["Record request", "Identify intent", "Prepare work context"],
  },
  {
    id: "context",
    title: "Check work state",
    detail: "Review current work, decisions, and recent task state before answering.",
    startsAtMs: 1200,
    substeps: ["Read saved notes", "Check active work", "Review recent results"],
  },
  {
    id: "agent",
    title: "Prepare answer",
    detail: "Ask the Client Agent to produce the next useful answer or action.",
    startsAtMs: 3500,
    substeps: ["Reason over request", "Draft response", "Collect result"],
  },
  {
    id: "workspace",
    title: "Update work state",
    detail: "Persist any requested changes and start or update work items when needed.",
    startsAtMs: 12000,
    substeps: ["Persist changes", "Queue work if needed", "Summarize result"],
  },
  {
    id: "refresh",
    title: "Refresh dashboard",
    detail: "Reload the visible work state before showing the final reply.",
    startsAtMs: 24000,
    substeps: ["Refresh work items", "Refresh notes", "Show final reply"],
  },
];

export function buildClientTurnProgress(input: TurnProgressInput): ClientTurnProgress {
  const startedMs = Date.parse(input.startedAt);
  const nowMs = input.nowMs ?? Date.now();
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0;
  const activeIndex = input.activePhaseId
    ? phaseIndex(input.activePhaseId)
    : findActivePhaseIndex(elapsedMs);

  return {
    title: "Processing turn",
    detail: input.detail ?? progressDetail(input),
    startedAt: input.startedAt,
    elapsedMs,
    activities: input.activities ?? fallbackActivities(input, elapsedMs),
    phases: PHASES.map((phase, index) => phaseFromTemplate(phase, index, activeIndex, elapsedMs)),
  };
}

function progressDetail(input: TurnProgressInput): string {
  return input.taskId
    ? "Sikong is checking the selected work item and preparing the next useful answer."
    : "Sikong is checking the overall work state and preparing the next useful answer.";
}

function fallbackActivities(input: TurnProgressInput, elapsedMs: number): ClientTurnActivity[] {
  const phaseId = input.activePhaseId ?? PHASES[findActivePhaseIndex(elapsedMs)]?.id ?? "prepare";
  const titleByPhase: Record<ClientTurnProgressPhaseId, string> = {
    prepare: "Preparing request",
    context: "Checking work state",
    agent: "Preparing answer",
    workspace: "Updating work state",
    refresh: "Refreshing dashboard",
  };
  return [
    {
      id: `fallback-${phaseId}`,
      at: input.startedAt,
      phase: phaseId === "agent" ? "work" : "settlement",
      kind: "status",
      status: phaseId === "refresh" ? "done" : "running",
      title: titleByPhase[phaseId],
      detail: input.detail,
    },
  ];
}

function findActivePhaseIndex(elapsedMs: number): number {
  const index = PHASES.findLastIndex((phase) => elapsedMs >= phase.startsAtMs);
  return Math.max(0, index);
}

function phaseIndex(phaseId: ClientTurnProgressPhaseId): number {
  return Math.max(
    0,
    PHASES.findIndex((phase) => phase.id === phaseId),
  );
}

function phaseFromTemplate(
  phase: TurnProgressPhaseTemplate,
  index: number,
  activeIndex: number,
  elapsedMs: number,
): ClientTurnProgressPhase {
  const status = phaseStatus(index, activeIndex);
  return {
    id: phase.id,
    title: phase.title,
    detail: phase.detail,
    status,
    substeps: phase.substeps.map((label, substepIndex) => ({
      label,
      status: substepStatus(status, phase, substepIndex, elapsedMs),
    })),
  };
}

function phaseStatus(index: number, activeIndex: number): ClientTurnProgressStatus {
  if (index < activeIndex) return "done";
  if (index === activeIndex) return "running";
  return "pending";
}

function substepStatus(
  phaseStatusValue: ClientTurnProgressStatus,
  phase: TurnProgressPhaseTemplate,
  substepIndex: number,
  elapsedMs: number,
): ClientTurnProgressStatus {
  if (phaseStatusValue !== "running") return phaseStatusValue;
  const phaseElapsedMs = Math.max(0, elapsedMs - phase.startsAtMs);
  const intervalMs = 1100;
  const runningIndex = Math.min(phase.substeps.length - 1, Math.floor(phaseElapsedMs / intervalMs));
  if (substepIndex < runningIndex) return "done";
  if (substepIndex === runningIndex) return "running";
  return "pending";
}
