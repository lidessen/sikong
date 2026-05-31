import type { ValidationIssue } from "./validate";

/** A command was rejected by the reducer (aggregate invariant violated). */
export class CommandRejectedError extends Error {
  constructor(
    message: string,
    readonly taskId: string,
    readonly commandKind: string,
  ) {
    super(message);
    this.name = "CommandRejectedError";
  }
}

/** A workflow definition failed structural validation and was not registered. */
export class WorkflowValidationError extends Error {
  constructor(
    readonly workflowId: string,
    readonly issues: readonly ValidationIssue[],
  ) {
    super(
      `workflow "${workflowId}" is invalid:\n` +
        issues.map((i) => `  - [${i.code}] ${i.message}`).join("\n"),
    );
    this.name = "WorkflowValidationError";
  }
}
