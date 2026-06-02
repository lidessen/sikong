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
  // Staff coding work to a coding-capable worker (a real coding agent) when one is
  // available; falls back to any worker otherwise. See ADR 0008.
  workerRole: "coding",
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
      outputFields: ["implementation", "changedFiles"],
      entry: {
        op: "and",
        all: [
          { op: "field", field: "design", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      instructions:
        "Implement the designed change. Record `implementation` (what you changed) and set `changedFiles` to a JSON array of the changed project file paths, then request transition. Block with a concrete reason if the change cannot be made.",
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
        "Verify the implementation with appropriate checks. Record `verification` (what you checked and the results) and `summary`, then request transition. Block if verification fails or cannot run.",
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

/**
 * The lead workflow (ADR 0009): a 负责人 plans an effort, breaks it into a team of
 * child tasks (each auto-staffed by capability), is re-woken as they finish,
 * reviews the Team section, and synthesizes the outcome. `create_subtask` is
 * enabled ONLY on the delegate stage, so ordinary tasks can't fan out. Coordination
 * reuses `childrenDone` + parent re-wake — no new engine mechanism.
 */
export const DEVELOPMENT_LEAD_WORKFLOW: WorkflowDef = {
  id: "development-lead",
  version: "1",
  name: "Development Lead",
  description: "Lead a development effort: plan it, delegate the pieces to a team, review their results, and report.",
  workerRole: "coding",
  fields: {
    request: { type: "string", description: "The original development requirement." },
    design: { type: "string", description: "Key design decisions resolved during review (also written back to the project's design doc)." },
    alternatives: { type: "json", description: "Adversarial record of the design: the candidate approaches considered and why each was rejected — a JSON array of { option, pros, why_rejected }." },
    plan: { type: "string", description: "How the work is broken into ordered layers to delegate." },
    summary: { type: "string", description: "Final outcome synthesized from the team's results." },
  },
  stages: [
    {
      id: "design",
      category: "in_progress",
      entry: { op: "always" },
      outputFields: ["design", "alternatives"],
      instructions:
        "Review and refine the design BEFORE any planning or building — and think adversarially, not just convergently. Read the project's design doc (e.g. DESIGN.md in the project root). DIVERGE first: for the consequential decisions (architecture, language/stack, interfaces, transports, lifecycle, testing approach) identify 2-3 GENUINELY different candidate approaches, and steelman each one. Then attack your preferred choice with a pre-mortem (assume it failed — why?). Only after that CONVERGE: resolve the open decisions and inconsistencies, and UPDATE the design doc in place — add a concise 'Decisions' section capturing what you settled. Record the settled decisions in `design`, and record the seriously-considered-but-rejected approaches in `alternatives` as a JSON array of { option, pros, why_rejected } (do not pad it with strawmen — only options you actually weighed). Then request transition. Block if the requirement is too unclear to design.",
    },
    {
      id: "plan",
      category: "in_progress",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "design", cmp: "exists" },
          { op: "field", field: "alternatives", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["plan"],
      instructions:
        "Turn the refined design into ordered LAYERS to build. Record `plan` describing the layers and their order, then request transition. Block if the request needs lead clarification.",
    },
    {
      id: "delegate",
      category: "in_progress",
      tools: ["create_subtask", "append_note", "request_transition", "block", "cancel"],
      entry: {
        op: "and",
        all: [
          { op: "field", field: "plan", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      instructions:
        "Break the work into layers and create one subtask per layer with `create_subtask` (use the `development` workflow for code changes, or `general` otherwise); each is auto-staffed. ORDER them with dependencies: give each subtask a short `key` and list its prerequisite keys in `dependsOn`, so a later layer (e.g. the CLI) starts only after the layers it builds on (e.g. the control API) finish. Do NOT fan independent-looking layers out in parallel from an empty base — they will collide. Use `isolate: true` only for subtasks that genuinely edit the same files concurrently. Delegate the layers, then request transition to wait for the team.",
    },
    {
      id: "review",
      category: "in_progress",
      tools: ["create_subtask", "set_field", "request_transition", "append_note", "block", "cancel"],
      outputFields: ["summary"],
      entry: {
        op: "and",
        all: [
          { op: "childrenDone" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      instructions:
        "Read the Team section and review what each subtask returned. Any subtask shown as [isolated → branch sikong/<id>] committed its work to that branch — before finishing, merge each isolated branch into the current branch with git (you have a shell), resolving conflicts. If the effort needs another round, create follow-up subtasks with `create_subtask` and request transition WITHOUT setting `summary` — you will be re-woken once they finish, then review again. When the effort is complete, set a one-line `summary` of the overall outcome and request transition. Block if it failed.",
    },
    {
      id: "done",
      category: "done",
      // Re-gated on childrenDone so follow-up subtasks spawned during review must
      // also finish before the lead can close out (ADR 0009 multi-round review).
      entry: {
        op: "and",
        all: [
          { op: "childrenDone" },
          { op: "field", field: "summary", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
    },
  ],
};
