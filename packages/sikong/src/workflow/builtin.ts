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
      effort: "medium",
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

/**
 * The design workflow (ADR 0017): design UI components/pages as real semajsx
 * code through a structured divergent-convergent cycle. Stages: brief →
 * diverge → preview → critique → converge → refine → deliver. The preview
 * stage emits runnable semajsx bundles (SSR/dev server or SSG build) that the
 * owner interacts with — no mockup gap. Two owner approval gates: converge
 * (approved design) and deliver (landing the work).
 */
export const DESIGN_WORKFLOW: WorkflowDef = {
  id: "design",
  version: "1",
  name: "Design",
  description:
    "Design UI components or pages as real semajsx code: brief, diverge, preview, critique, converge, refine, deliver.",
  workerRole: "coding",
  fields: {
    request: { type: "string", description: "The original design request." },
    brief: { type: "string", description: "Captured design brief with constraints, targets (web and/or TUI), and style tokens." },
    candidates: { type: "json", description: "Array of candidate designs, each as a runnable semajsx bundle with name, description, and code." },
    critiques: { type: "json", description: "Array of adversarial critiques per candidate covering hierarchy, a11y, consistency, token usage." },
    design: { type: "string", description: "The converged/chosen design description." },
    changedFiles: { type: "json", description: "Array of project file paths written during delivery." },
    summary: { type: "string", description: "One-line final outcome." },
  },
  stages: [
    {
      id: "brief",
      category: "in_progress",
      entry: { op: "always" },
      effort: "medium",
      outputFields: ["brief"],
      instructions:
        "Capture what to design — page, component, or screen — and the constraints: target platforms (web and/or TUI), style tokens/branding, and any existing patterns to follow. Set `brief` with the refined brief, then request transition. Block if the request is too unclear.",
    },
    {
      id: "diverge",
      category: "in_progress",
      effort: "max",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "brief", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["candidates"],
      instructions:
        "Generate N genuinely different candidate designs as real semajsx code (the diverge step — judge-panel pattern, each a different approach). Each candidate is a runnable bundle. Set `candidates` to a JSON array of the candidate designs (each with name, description, and code), then request transition.",
    },
    {
      id: "preview",
      category: "in_progress",
      effort: "medium",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "candidates", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      instructions:
        "Emit each candidate as a live preview — serve the runnable semajsx bundles for the owner to interact with (web: SSR/dev server or static SSG build; TUI: terminal render). When the previews are live, request transition. Do not write workflow fields in this stage — just serve previews.",
    },
    {
      id: "critique",
      category: "in_progress",
      effort: "high",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "candidates", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["critiques"],
      instructions:
        "Adversarially critique the candidates across multiple lenses — information hierarchy, accessibility, visual consistency, token/token-usage discipline. Each candidate should be judged by distinct lenses. Record the critiques in `critiques` as a JSON array (each entry with candidate name, lens, and assessment), then request transition.",
    },
    {
      id: "converge",
      category: "in_progress",
      effort: "high",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "critiques", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["design"],
      instructions:
        "Synthesize the best design from the candidates, grafting good ideas from runners-up. Set `design` with the converged design description, then request transition for owner review. The owner approves before the next stage — present the decision and rationale clearly.",
    },
    {
      id: "refine",
      category: "in_progress",
      effort: "medium",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "design", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["design"],
      instructions:
        "Iterate on owner feedback — update the design and re-preview it. Keep updating `design` based on feedback. When the design is approved for delivery, request transition to the deliver stage.",
    },
    {
      id: "deliver",
      category: "in_progress",
      effort: "medium",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "design", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["changedFiles", "summary"],
      instructions:
        "Write the approved design as real semajsx/ui-based components or pages into the target project. Set `changedFiles` to a JSON array of written file paths and set `summary` as a one-line outcome, then request transition. Block if the writing fails.",
    },
    {
      id: "done",
      category: "done",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "changedFiles", cmp: "exists" },
          { op: "field", field: "summary", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
    },
  ],
};

/**
 * The merged adaptive development workflow (ADR 0020): a single workflow for
 * both SOLO and TEAM scopes — the agent discovers the right scale at the build
 * stage rather than guessing at intake time.
 *
 * Stages: design → plan → build → verify → done.
 * - `create_subtask` is available on `build` and `verify` stages.
 * - `childrenDone` is vacuously true with no children, so the solo path flows
 *   through uniform guards.
 * - `maxTeamDepth` (default 2) caps how many tiers of delegation are allowed
 *   (root depth 0 → lead at depth 1 → workers at depth 2, who cannot fan out).
 */
export const DEVELOPMENT_WORKFLOW: WorkflowDef = {
  id: "development",
  version: "2",
  name: "Development",
  description: "Development (adapts to solo or team scope): design, plan, build, verify, and deliver.",
  workerRole: "coding",
  maxTeamDepth: 2,
  fields: {
    request: { type: "string", description: "The original development request." },
    design: { type: "string", description: "Design decisions, tradeoffs, and selected approach." },
    alternatives: { type: "json", description: "Adversarial record of the design: the candidate approaches considered and why each was rejected — a JSON array of { option, pros, why_rejected }." },
    plan: { type: "string", description: "Bounded implementation plan and acceptance criteria. Decide solo vs team." },
    implementation: { type: "string", description: "What was changed during implementation (set when working solo)." },
    changedFiles: { type: "json", description: "Array of project file paths changed by the implementation." },
    verification: { type: "string", description: "Verification commands, results, and any residual risk." },
    summary: { type: "string", description: "One-line final outcome." },
  },
  stages: [
    {
      id: "design",
      category: "in_progress",
      effort: "high",
      entry: { op: "always" },
      outputFields: ["design", "alternatives"],
      instructions:
        "Review and refine the design BEFORE any planning or building — and think adversarially, not just convergently. Read existing design documents in the project. DIVERGE first: for consequential decisions (architecture, stack, interfaces, transports, lifecycle, testing approach) identify 2-3 genuinely different candidate approaches and steelman each one. Then attack your preferred choice with a pre-mortem (assume it failed — why?). For trivial decisions a light treatment is fine. CONVERGE: resolve open decisions and update design docs. Record the settled decisions in `design`, and record seriously-considered-but-rejected approaches in `alternatives` as a JSON array of { option, pros, why_rejected } (do not pad it with strawmen — only options you actually weighed). Then request transition. Block if the requirement is too unclear to design.",
    },
    {
      id: "plan",
      category: "in_progress",
      effort: "medium",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "design", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["plan"],
      instructions:
        "Turn the refined design into a bounded plan with acceptance criteria. This is where you decide **solo vs team**: if the work is small enough for you alone, say so in the plan and proceed to build directly. If it needs a team, describe the layers to delegate. Set `plan` with the approach, then request transition. Block if the request needs lead clarification.",
    },
    {
      id: "build",
      category: "in_progress",
      effort: "medium",
      tools: ["create_subtask", "set_field", "request_transition", "append_note", "block", "cancel"],
      entry: {
        op: "and",
        all: [
          { op: "field", field: "plan", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["implementation", "changedFiles"],
      instructions:
        "The adaptive stage — implement the change directly OR delegate via `create_subtask`. For solo work: write the code, record `implementation` (what you changed) and set `changedFiles` to a JSON array of the changed project file paths, then request transition. For delegation (planned team effort): create one subtask per layer with `create_subtask`, respecting dependsOn ordering and the collision rule for shared-file edits (two subtasks touching the same files must either chain with dependsOn or isolate each via isolate:true). After delegating, request transition to wait for the team. Block with a concrete reason if the change cannot be made.",
    },
    {
      id: "verify",
      category: "in_progress",
      effort: "medium",
      tools: ["create_subtask", "set_field", "request_transition", "append_note", "block", "cancel"],
      entry: {
        op: "and",
        all: [
          {
            op: "or",
            any: [
              { op: "field", field: "implementation", cmp: "exists" },
              { op: "childrenDone" },
            ],
          },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["verification", "summary"],
      instructions:
        "Verify the implementation adversarially (ADR 0015) AND/OR review+merge the team's results. Run the project's full checks (build, vet/lint, tests) covering EDGE CASES and real-user-path smokes — not only happy-path values. If the team used isolated worktrees, merge each branch with git now. You MAY create follow-up subtasks with `create_subtask` for multi-round efforts (set no summary to be re-woken). Record `verification` (what you checked, exact commands, and results) and set `summary` as a one-line outcome, then request transition. Block if verification fails or cannot run.",
    },
    {
      id: "done",
      category: "done",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "summary", cmp: "exists" },
          { op: "childrenDone" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
    },
  ],
};

/**
 * The release workflow (ADR 0019): ship a project through a gated, auditable
 * pipeline. Stages: assess → gate → prepare → approve → publish → confirm.
 * Each stage is staffed independently per wake. The `approve` stage halts for
 * external lead approval (`approved` is never in any stage's outputFields so
 * the agent cannot set it — only `sikong submit set-field approved true` can).
 * The `publish` and `confirm` stages enable `create_subtask` for fan-out to
 * parallel artifacts (e.g. npm-publish + Vercel deploy + GitHub Release).
 */
export const RELEASE_WORKFLOW: WorkflowDef = {
  id: "release",
  version: "1",
  name: "Release",
  description: "Ship a project: assess, gate, prepare, approve, publish, confirm.",
  workerRole: "coding",
  fields: {
    request: { type: "string", description: "The original release requirement." },
    releaseRef: { type: "string", description: "Lead-specified ref/version override (optional)." },
    releasePlan: { type: "json", description: "Version, ref, targets, changelog, and intended publish commands." },
    gate: { type: "json", description: "Build/test/smoke commands and results proving the candidate is stable." },
    prepared: { type: "string", description: "Local release prep done: version bumped, changelog updated, tag created." },
    releaseSummary: { type: "string", description: "Evidence presented to the lead: version, changelog, gate results, publish plan." },
    approved: { type: "boolean", description: "Lead approval gate — can only be set externally, never by the agent." },
    published: { type: "json", description: "Publish commands that ran and resulting artifact URLs." },
    verification: { type: "json", description: "Landing checks and their results: assets exist, npm resolves, deploy is live." },
    summary: { type: "string", description: "One-line final outcome." },
  },
  stages: [
    {
      id: "assess",
      category: "in_progress",
      entry: { op: "always" },
      effort: "medium",
      outputFields: ["releasePlan"],
      instructions:
        "Decide what to ship: determine the target ref/version, inspect the project for release mechanisms (package.json scripts, .github/workflows, vercel.json, release scripts), build the changelog since the last release, and infer the publish targets. Set `releasePlan` with the version, ref, targets, changelog, and intended publish commands. Block if the project has no discernible release mechanism, then request transition.",
    },
    {
      id: "gate",
      category: "in_progress",
      effort: "medium",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "releasePlan", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["gate"],
      instructions:
        "Prove the candidate is stable before any outward-facing action. Run the project's full verification (build + test + any release:check script) on that exact ref, plus a real-user smoke where applicable (ADR 0015). Set `gate` with the exact commands and their results. Block if not green — you do not ship red, then request transition.",
    },
    {
      id: "prepare",
      category: "in_progress",
      effort: "medium",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "gate", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["prepared"],
      instructions:
        "Make the release locally — nothing outward yet. Bump the version, update CHANGELOG, create the tag (unpushed), and build artifacts. Set `prepared` describing what was done, then request transition.",
    },
    {
      id: "approve",
      category: "in_progress",
      effort: "low",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "prepared", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["releaseSummary"],
      instructions:
        "HALT for lead approval. Present the full release evidence — version, changelog, gate results, and precisely what will be published where — to the lead. Set `releaseSummary` with the decision context. Request transition. The task stops here until the lead sets `approved=true` externally (this field is never in outputFields so you cannot set it). Only `sikong submit <id> set-field approved true` advances to publish.",
    },
    {
      id: "publish",
      category: "in_progress",
      effort: "medium",
      tools: ["create_subtask", "set_field", "request_transition", "append_note", "block", "cancel"],
      entry: {
        op: "and",
        all: [
          { op: "field", field: "prepared", cmp: "exists" },
          { op: "field", field: "approved", cmp: "eq", value: true },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["published"],
      instructions:
        "Execute the release outward: push the tag (triggers release CI), npm publish, vercel deploy --prod, and/or other publish commands from the releasePlan. You MAY fan out parallel artifacts with `create_subtask`. Set `published` with the commands that ran and resulting artifact URLs. Block if a publish command fails, then request transition.",
    },
    {
      id: "confirm",
      category: "in_progress",
      effort: "medium",
      tools: ["create_subtask", "set_field", "request_transition", "append_note", "block", "cancel"],
      entry: {
        op: "and",
        all: [
          { op: "field", field: "published", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["verification", "summary"],
      instructions:
        "Verify the release actually landed: GitHub Release assets exist, npm version resolves, deploy URL is live, install one-liner works. Set `verification` with the landing checks and results. Set `summary` with a one-line outcome. Block if it didn't land, then request transition.",
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
 * Alias for the development workflow, kept for one transition release so that
 * existing tooling referencing `development-lead` continues to work. After one
 * release this constant is removed and only `DEVELOPMENT_WORKFLOW` remains.
 * (ADR 0020)
 */
export const DEVELOPMENT_LEAD_WORKFLOW: WorkflowDef = {
  ...DEVELOPMENT_WORKFLOW,
  id: "development-lead",
};

/**
 * The original `development-lead@v1` definition, retained so that tasks already
 * pinned to `development-lead@v1` can still load and replay their timeline.
 * Registration happens in `workspace.ts` alongside the v2 alias. Deleted after
 * one transition release. (ADR 0020)
 */
export const _DEVELOPMENT_LEAD_WORKFLOW_V1: WorkflowDef = {
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
      effort: "high",
      entry: { op: "always" },
      outputFields: ["design", "alternatives"],
      instructions:
        "Review and refine the design BEFORE any planning or building — and think adversarially, not just convergently. Read the project's design doc (e.g. DESIGN.md in the project root). DIVERGE first: for the consequential decisions (architecture, language/stack, interfaces, transports, lifecycle, testing approach) identify 2-3 GENUINELY different candidate approaches, and steelman each one. Then attack your preferred choice with a pre-mortem (assume it failed — why?). Only after that CONVERGE: resolve the open decisions and inconsistencies, and UPDATE the design doc in place — add a concise 'Decisions' section capturing what you settled. Record the settled decisions in `design`, and record the seriously-considered-but-rejected approaches in `alternatives` as a JSON array of { option, pros, why_rejected } (do not pad it with strawmen — only options you actually weighed). Then request transition. Block if the requirement is too unclear to design.",
    },
    {
      id: "plan",
      category: "in_progress",
      effort: "medium",
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
      effort: "medium",
      tools: ["create_subtask", "append_note", "request_transition", "block", "cancel"],
      entry: {
        op: "and",
        all: [
          { op: "field", field: "plan", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      instructions:
        "Break the work into layers and create one subtask per layer with `create_subtask` (use the `development` workflow for code changes, or `general` otherwise); each is auto-staffed. ORDER them with dependencies: give each subtask a short `key` and list its prerequisite keys in `dependsOn`, so a later layer (e.g. the CLI) starts only after the layers it builds on (e.g. the control API) finish. COLLISION RULE — two subtasks that may touch the SAME files must never run unordered: either chain them with `dependsOn` (preferred — it also gives a clean build order), or, when they are genuinely independent yet edit shared files, set `isolate: true` on EACH so it gets its own git worktree and you merge the branches at review. Only subtasks touching disjoint files may run unordered without isolation; never fan independent-looking layers out in parallel from an empty base — they will collide. Delegate the layers, then request transition to wait for the team.",
    },
    {
      id: "review",
      category: "in_progress",
      effort: "medium",
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
