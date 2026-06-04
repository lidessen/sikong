/**
 * The workflow kernel (M0): the agent-facing data model + the pure functions
 * that drive it. No persistence, no LLM, no engine — those are M0.5/M1.
 */
export type {
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

export { evalGuard, type GuardEnv } from "./guard";
export {
  apply,
  applyEventsToTask,
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
export { DESIGN_WORKFLOW, DEVELOPMENT_LEAD_WORKFLOW, DEVELOPMENT_WORKFLOW, GENERAL_WORKFLOW, RELEASE_WORKFLOW } from "./builtin";
