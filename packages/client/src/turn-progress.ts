import type {
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
    title: "Prepare turn",
    detail: "Capture the request and current UI focus.",
    startsAtMs: 0,
    substeps: ["Record user message", "Attach focused workspace", "Queue client turn"],
  },
  {
    id: "context",
    title: "Load context",
    detail: "Read the workspace, saved notes, and runtime settings.",
    startsAtMs: 1200,
    substeps: ["Read saved notes", "Read workspace summaries", "Apply runtime settings"],
  },
  {
    id: "agent",
    title: "Run client agent",
    detail: "Send the focused context packet through the model/tool loop.",
    startsAtMs: 3500,
    substeps: ["Send context packet", "Run model/tool loop", "Collect assistant result"],
  },
  {
    id: "workspace",
    title: "Update workspace",
    detail: "Persist durable changes and start newly created work when needed.",
    startsAtMs: 12000,
    substeps: ["Persist workspace changes", "Start new work items", "Summarize results"],
  },
  {
    id: "refresh",
    title: "Refresh UI",
    detail: "Reload the visible workspace projection before showing the final reply.",
    startsAtMs: 24000,
    substeps: ["Refresh work items", "Refresh saved notes", "Replace progress card"],
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
    phases: PHASES.map((phase, index) => phaseFromTemplate(phase, index, activeIndex, elapsedMs)),
  };
}

function progressDetail(input: TurnProgressInput): string {
  const focus = input.workspaceName ? `Workspace: ${input.workspaceName}` : "No workspace selected";
  const task = input.taskId ? ` · Work item: ${input.taskId}` : "";
  return `${focus}${task}. Coarse turn progress; detailed execution events stay in workspace context.`;
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
