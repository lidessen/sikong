import type { AcceptanceStatus } from "../workflow/guard";
import type { StageDef, Task, TaskStatus } from "../workflow/types";

/** A compact, read-only snapshot of a child task shown to its lead. */
export interface TeamMember {
  id: string;
  workflowId: string;
  stageId?: string;
  status: TaskStatus;
  /** Ran in an isolated workspace (its work is on branch `sikong/<id>` for git projects). */
  isolate?: boolean;
  acceptanceStatus?: AcceptanceStatus;
  acceptanceReason?: string;
  evidenceSummary?: string;
  summary?: string;
  request?: string;
}

export type LeadTeamClassification =
  | "no_team"
  | "waiting_for_children"
  | "ready_for_parent_review"
  | "needs_repair_or_decision"
  | "waiting_for_lead_acceptance"
  | "ready_to_close";

export interface LeadStatusContext {
  eventTypes?: ReadonlySet<string>;
  acceptanceStatus?: AcceptanceStatus;
}

export interface LeadTeamStatus {
  classification: LeadTeamClassification;
  total: number;
  done: number;
  cancelled: number;
  active: number;
  transitionRequested: boolean;
  acceptanceStatus: AcceptanceStatus;
  next: string;
}

export function deriveLeadTeamStatus(
  task: Task,
  stage: StageDef | undefined,
  team: readonly TeamMember[],
  status: LeadStatusContext,
): LeadTeamStatus {
  const total = team.length;
  const done = team.filter((m) => m.status === "done").length;
  const cancelled = team.filter((m) => m.status === "cancelled").length;
  const active = team.filter((m) => m.status !== "done" && m.status !== "cancelled").length;
  const transitionRequested = Boolean(status.eventTypes?.has("transition.requested"));
  const acceptanceStatus = status.acceptanceStatus ?? "none";
  const hasAcceptanceGate = Boolean(stage?.acceptance?.length || task.acceptance?.length);

  let classification: LeadTeamClassification = "no_team";
  let next = "Do this stage's work and record durable progress.";
  if (active > 0) {
    classification = "waiting_for_children";
    next = "Wait for active children, or intervene only if their evidence shows a real block.";
  } else if (cancelled > 0 || acceptanceStatus === "rejected") {
    classification = "needs_repair_or_decision";
    next = "Review failed or rejected work, then create a repair subtask, adjust scope, block, or cancel.";
  } else if (acceptanceStatus === "pending" && transitionRequested) {
    classification = "waiting_for_lead_acceptance";
    next = "A lead decision is required: accept or reject the submitted evidence.";
  } else if (acceptanceStatus === "accepted" && transitionRequested) {
    classification = "ready_to_close";
    next = "The acceptance gate is satisfied; if the workflow does not advance, inspect the remaining guard fields.";
  } else if (total > 0 && active === 0) {
    classification = "ready_for_parent_review";
    next = hasAcceptanceGate
      ? "All children are terminal. Review their outputs, set parent verification/summary, submit evidence, then request transition."
      : "All children are terminal. Review their outputs, set the required parent fields, then request transition.";
  } else if (hasAcceptanceGate && acceptanceStatus === "pending") {
    classification = "waiting_for_lead_acceptance";
    next = "A lead decision is required: accept or reject the submitted evidence.";
  }

  return { classification, total, done, cancelled, active, transitionRequested, acceptanceStatus, next };
}
