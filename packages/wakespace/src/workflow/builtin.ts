import type { WorkflowDef } from "./types";

/**
 * The builtin fallback workflow — the intake router's DEFAULT ROUTE, not a
 * dumping ground. Its one job: do the work and, when finished, signal done
 * (which admits the terminal stage). Specific workflows are registered on top;
 * anything that doesn't match one flows through here.
 */
export const GENERAL_WORKFLOW: WorkflowDef = {
  id: "general",
  version: "1",
  name: "General",
  description: "Fallback workflow for any task without a specific one.",
  fields: {
    request: { type: "string", description: "The original requirement / what was asked." },
    summary: { type: "string", description: "One-line outcome, written when finishing." },
  },
  stages: [
    {
      id: "open",
      category: "in_progress",
      entry: { op: "always" },
      requiresProjectWrite: true,
      outputFields: ["summary"],
      instructions:
        "Do whatever the task needs. Record a one-line `summary` of the outcome, then request a transition to close it.",
    },
    {
      id: "done",
      category: "done",
      // Admitted once the agent explicitly signals it is finished.
      entry: { op: "hasEvent", eventType: "transition.requested" },
    },
  ],
};

export const DEVELOPMENT_WORKFLOW: WorkflowDef = {
  id: "development",
  version: "1",
  name: "Development",
  description: "Plan, design, implement, and verify a project code or documentation change.",
  fields: {
    request: { type: "string", description: "The original development request." },
    plan: { type: "string", description: "Bounded implementation plan and acceptance criteria." },
    design: { type: "string", description: "Design notes, tradeoffs, and selected approach." },
    implementation: { type: "string", description: "What was changed during implementation." },
    changedFiles: { type: "json", description: "Array of project file paths changed by the implementation." },
    verification: { type: "string", description: "Verification commands, results, and any residual risk." },
    summary: { type: "string", description: "One-line final outcome." },
  },
  stages: [
    {
      id: "plan",
      category: "in_progress",
      entry: { op: "always" },
      outputFields: ["plan"],
      instructions:
        "Inspect the request and relevant project context. Set `plan` with the bounded approach and acceptance criteria, then request transition. Block if the request needs lead clarification.",
    },
    {
      id: "design",
      category: "in_progress",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "plan", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["design"],
      instructions:
        "Turn the plan into a concrete design. Set `design` with the chosen approach and important tradeoffs, then request transition.",
    },
    {
      id: "implement",
      category: "in_progress",
      requiresProjectWrite: true,
      outputFields: ["implementation", "changedFiles"],
      entry: {
        op: "and",
        all: [
          { op: "field", field: "design", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      instructions:
        "Implement the designed change with project tools. Prefer replaceInFile for localized source edits (safer than writeFile); fall back to writeFile only for new files or large rewrites. Do not use writeFile to overwrite existing source files; use replaceInFile instead. Do not spend the wake only on inspection once the edit target is clear. Set `implementation`, set `changedFiles` to a JSON array of changed project paths, then request transition. Block instead of requesting transition if no edit should be made.",
    },
    {
      id: "verify",
      category: "in_progress",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "implementation", cmp: "exists" },
          { op: "field", field: "changedFiles", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["verification", "summary"],
      instructions:
        "Verify the implementation with focused checks. Set `verification` with commands and results, set `summary`, then request transition. Block if verification fails or cannot run.",
    },
    {
      id: "done",
      category: "done",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "verification", cmp: "exists" },
          { op: "field", field: "summary", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
    },
  ],
};
