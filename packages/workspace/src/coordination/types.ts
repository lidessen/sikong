export interface RuntimeInput {
  cwd?: string;
  repoPath?: string;
}

export interface PlanDef {
  id: string;
  version: number;
  summary?: string;
  stages: PlanStageDef[];
}

export interface PlanStageDef {
  id: string;
  title: string;
  objective: string;
  acceptance: string[];
}

export interface TaskEventBase {
  id: string;
  taskId: string;
  workspaceId: string;
  createdAt: string;
}

export type TaskEvent =
  | TaskCreatedEvent
  | PlanRequestedEvent
  | PlanSubmittedEvent
  | PlanAcceptedEvent
  | PlanRejectedEvent
  | StageStartedEvent
  | WorkerRunStartedEvent
  | WorkerRunCompletedEvent
  | WorkerRunFailedEvent
  | WorkerRunBudgetExceededEvent
  | StageReviewStartedEvent
  | StageReviewAcceptedEvent
  | StageReviewRejectedEvent
  | StageAdvancedEvent
  | FinalReviewStartedEvent
  | FinalReviewRecommendedEvent
  | TaskAcceptedEvent
  | TaskRejectedEvent
  | TaskCompletedEvent;

export interface TaskCreatedEvent extends TaskEventBase {
  type: "task.created";
  request: string;
  runtime?: RuntimeInput;
}

export interface PlanRequestedEvent extends TaskEventBase {
  type: "plan.requested";
  brief?: string;
  constraints?: string;
  expectedStages?: string;
}

export interface PlanSubmittedEvent extends TaskEventBase {
  type: "plan.submitted";
  plan: PlanDef;
}

export interface PlanAcceptedEvent extends TaskEventBase {
  type: "plan.accepted";
  planId: string;
  version: number;
  report: string;
}

export interface PlanRejectedEvent extends TaskEventBase {
  type: "plan.rejected";
  planId: string;
  version: number;
  report: string;
  requestedChanges?: string;
}

export interface StageStartedEvent extends TaskEventBase {
  type: "stage.started";
  stageId: string;
}

export interface WorkerRunStartedEvent extends TaskEventBase {
  type: "worker_run.started";
  runId: string;
  stageId: string;
  workerId?: string;
  objective?: string;
}

export interface WorkerRunCompletedEvent extends TaskEventBase {
  type: "worker_run.completed";
  runId: string;
  stageId: string;
  result: TaskRunResult;
}

export interface WorkerRunFailedEvent extends TaskEventBase {
  type: "worker_run.failed";
  runId: string;
  stageId: string;
  result: TaskRunResult;
}

export interface WorkerRunBudgetExceededEvent extends TaskEventBase {
  type: "worker_run.budget_exceeded";
  runId: string;
  stageId: string;
  result: TaskRunResult;
}

export interface TaskRunResult {
  summary: string;
  report?: string;
  note?: string;
}

export interface StageReviewStartedEvent extends TaskEventBase {
  type: "stage.review.started";
  reviewId: string;
  stageId: string;
}

export interface StageReviewAcceptedEvent extends TaskEventBase {
  type: "stage.review.accepted";
  reviewId: string;
  stageId: string;
  report: string;
}

export interface StageReviewRejectedEvent extends TaskEventBase {
  type: "stage.review.rejected";
  reviewId: string;
  stageId: string;
  report: string;
  requestedChanges?: string;
}

export interface StageAdvancedEvent extends TaskEventBase {
  type: "stage.advanced";
  fromStageId: string;
  toStageId?: string;
}

export interface FinalReviewStartedEvent extends TaskEventBase {
  type: "final.review.started";
  reviewId: string;
}

export interface FinalReviewRecommendedEvent extends TaskEventBase {
  type: "final.review.recommended";
  reviewId: string;
  recommendation: "accept" | "reject";
  report: string;
}

export interface TaskAcceptedEvent extends TaskEventBase {
  type: "task.accepted";
  report: string;
}

export interface TaskRejectedEvent extends TaskEventBase {
  type: "task.rejected";
  report: string;
}

export interface TaskCompletedEvent extends TaskEventBase {
  type: "task.completed";
  outcome: "accepted" | "rejected";
  report?: string;
}

export type TaskStatus =
  | "created"
  | "planning"
  | "plan_submitted"
  | "running"
  | "reviewing"
  | "accepted"
  | "rejected"
  | "completed";

export type WorkerRunStatus = "running" | "completed" | "failed" | "budget_exceeded";

export interface WorkerRunProjection {
  runId: string;
  stageId: string;
  workerId?: string;
  status: WorkerRunStatus;
  objective?: string;
  result?: TaskRunResult;
  startedAt?: string;
  finishedAt?: string;
}

export type StageReviewStatus = "started" | "accepted" | "rejected";

export interface StageReviewProjection {
  reviewId: string;
  stageId: string;
  status: StageReviewStatus;
  report?: string;
  requestedChanges?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface FinalReviewProjection {
  reviewId: string;
  status: "started" | "recommended";
  recommendation?: "accept" | "reject";
  report?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface PlanDecisionProjection {
  status: "requested" | "submitted" | "accepted" | "rejected";
  planId?: string;
  version?: number;
  report?: string;
  requestedChanges?: string;
  updatedAt: string;
}

export interface TaskProjection {
  taskId: string;
  workspaceId: string;
  request?: string;
  runtime?: RuntimeInput;
  status: TaskStatus;
  createdAt?: string;
  updatedAt?: string;
  plan?: PlanDef;
  planDecision?: PlanDecisionProjection;
  currentStageId?: string;
  acceptedStageIds: string[];
  workerRuns: Record<string, WorkerRunProjection>;
  stageReviews: Record<string, StageReviewProjection>;
  finalReview?: FinalReviewProjection;
  terminal?: {
    outcome: "accepted" | "rejected";
    report?: string;
    at: string;
  };
  eventCount: number;
}
