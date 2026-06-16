import type { TaskCard } from "./types";

export type ConsoleBadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "destructive"
  | "ok"
  | "warn"
  | "err"
  | "info"
  | "neutral"
  | "accent";

export function statusBadgeVariant(task: TaskCard): ConsoleBadgeVariant {
  if (task.terminal?.outcome === "accepted") return "ok";
  if (task.terminal?.outcome === "rejected") return "err";
  if (task.terminal) return "neutral";
  if (task.runtimeProcesses.running > 0) return "info";
  if (task.waitingForLead) return "warn";
  if (task.status === "planning" || task.nextAction.type.includes("plan")) return "warn";
  if (task.status === "running") return "info";
  return "neutral";
}

export function nextActionBadgeVariant(task: TaskCard): ConsoleBadgeVariant {
  if (task.nextAction.type.includes("worker")) return "info";
  if (task.nextAction.type.includes("review")) return "accent";
  if (task.nextAction.type.includes("lead")) return "warn";
  if (task.nextAction.type === "terminal") return statusBadgeVariant(task);
  return "outline";
}

export function taskPhaseLabel(task: TaskCard): string {
  if (task.terminal) return task.terminal.outcome;
  if (task.activeRound) return "round active";
  if (task.currentStage) return "stage active";
  if (task.plan?.status) return `plan ${task.plan.status}`;
  return task.status;
}

export function currentOperatorLabel(task: TaskCard): string {
  const actionType = task.nextAction.type;
  if (actionType.includes("lead")) return "Lead";
  if (actionType.includes("planning")) return "Planner";
  if (actionType.includes("worker")) return "Worker";
  if (actionType.includes("review")) return "Reviewer";
  if (task.terminal) return "Closed";
  return "Engine";
}

export function nextActionLabel(task: TaskCard): string {
  return actionTypeLabel(task.nextAction.type);
}

export function actionTypeLabel(actionType: string): string {
  switch (actionType) {
    case "start_lead_requirement_spec":
      return "Lead spec";
    case "start_planning_worker":
      return "Planner";
    case "start_lead_plan_decision":
      return "Lead plan decision";
    case "start_lead_round_planning":
      return "Lead round planning";
    case "start_stage_worker":
      return "Worker unit";
    case "start_stage_workers":
      return "Worker units";
    case "await_worker_results":
      return "Waiting for workers";
    case "complete_stage_round":
      return "Complete round";
    case "start_stage_review":
      return "Start stage review";
    case "start_stage_verification_worker":
      return "Stage reviewer";
    case "start_final_verification_worker":
      return "Final reviewer";
    case "start_lead_final_decision":
      return "Lead final decision";
    case "terminal":
      return "Closed";
    default:
      return actionType.replace(/^start_/, "").replaceAll("_", " ");
  }
}
