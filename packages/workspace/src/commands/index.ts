export type { CommandContext, CommandError, CommandErrorCode, CommandResult } from "./types";
export { fail, ok } from "./types";

export {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  type CreateWorkspaceInput,
  type WorkspaceIdInput,
} from "./workspace";

export {
  addWorkspacePreference,
  listWorkspacePreferences,
  removeWorkspacePreference,
  type AddWorkspacePreferenceInput,
  type RemoveWorkspacePreferenceInput,
} from "./preference";

export {
  acceptPlan,
  acceptStageReview,
  acceptTask,
  completeWorkerRun,
  createTask,
  exceedWorkerRunBudget,
  failWorkerRun,
  getTask,
  inspectTaskCompact,
  inspectTaskEvents,
  inspectTaskProjection,
  inspectTaskSummary,
  inspectTaskTrace,
  recommendFinalReview,
  rejectPlan,
  rejectStageReview,
  rejectTask,
  startStageReview,
  startWorkerRun,
  submitPlan,
  type FinishStageReviewInput,
  type FinishTaskInput,
  type FinishWorkerRunInput,
  type PlanDecisionInput,
  type RecommendFinalReviewInput,
  type RejectPlanInput,
  type StageReviewInput,
  type StartWorkerRunInput,
  type CreateTaskInput,
  type InspectTaskTraceInput,
  type SubmitPlanInput,
  type TaskCompactNextAction,
  type TaskCompactView,
  type TaskIdInput,
  type TaskSummary,
  type TaskTraceEntry,
} from "./task";
