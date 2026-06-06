/**
 * The workflow kernel (M0): the agent-facing data model + the pure functions
 * that drive it. No persistence, no LLM, no engine — those are M0.5/M1.
 */
export type {
  AcceptanceCheck,
  AcceptanceDecision,
  AcceptanceEvidence,
  AcceptanceEvidenceItem,
  Command,
  EventSource,
  FieldCmp,
  FieldDef,
  FieldsSchema,
  FieldType,
  Guard,
  NewEvent,
  ReduceContext,
  StageCategory,
  StageDef,
  Task,
  TaskEvent,
  TaskEventType,
  TaskStatus,
  WorkflowDef,
} from "./types";

export { evalGuard, type AcceptanceStatus, type GuardEnv } from "./guard";
export {
  apply,
  applyEventsToTask,
  deriveAcceptanceStatus,
  filterValidFields,
  initTask,
  project,
  reduceCommands,
  stageById,
  tryAdvance,
} from "./reducer";
export {
  assertValidWorkflow,
  validateWorkflow,
  type ValidateOptions,
  type ValidationIssue,
} from "./validate";
export { CommandRejectedError, WorkflowValidationError } from "./errors";
export { _DESIGN_WORKFLOW_V1, _DESIGN_WORKFLOW_V2, DESIGN_WORKFLOW, DEVELOPMENT_LEAD_WORKFLOW, DEVELOPMENT_WORKFLOW, GENERAL_WORKFLOW, RELEASE_WORKFLOW } from "./builtin";
