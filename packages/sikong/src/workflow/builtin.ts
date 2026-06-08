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
 * Visual design workflow (ADR 0028): design UI components/pages through a
 * philosophy-first pipeline — frame, language, derive, assemble, review. The
 * design philosophy (a language from the catalog) drives parameter derivation,
 * not pixel selection. The dialectic (ADR 0012) lives at philosophy altitude.
 *
 * Target-aware: `target` (web-semajsx | swiftui) captured at frame drives
 * branching at assemble (materialization) and review (preview/verify).
 * Reuses `design_preview`/`design_deliver` tools and approval gates from ADR 0017.
 *
 * This is the VISUAL / UI design workflow. For architectural/technical design
 * decisions (tradeoffs, DESIGN.md content, ADRs), use `DESIGN_WORKFLOW` instead.
 */
export const VISUAL_DESIGN_WORKFLOW: WorkflowDef = {
  id: "visual-design",
  version: "3",
  name: "Visual Design",
  description:
    "Design UI components or pages through a target-aware philosophy-driven pipeline (ADR 0028): frame, language, derive, assemble, review. Supports web-semajsx (default) and swiftui targets.",
  workerRole: "coding",
  fields: {
    request: { type: "string", description: "The original design request." },
    target: { type: "string", description: "Target platform for materialization: web-semajsx (default, producing real semajsx code) | swiftui (producing a SwiftUI design system + views). Captured at frame; drives assemble/review branching." },
    frame: { type: "string", description: "Captured design frame: content type (blog/article/product/docs/admin/…), goals, audience, key actions, information architecture, density (read vs scan vs operate). Everything downstream bends to this." },
    language: { type: "string", description: "The chosen design language/philosophy — which language from the catalog was selected, why it suits this frame, the feeling/values it elevates, and what it deliberately omits. Guarded: must be set alongside `alternatives`." },
    alternatives: { type: "json", description: "Array of rejected design languages + why each was rejected — the dialectic record at philosophy altitude. Each entry: { name, philosophy, why_rejected }. Must contain at least the 2-3 candidates that were steelmanned." },
    designSpec: { type: "json", description: "Derived concrete design specification 因地制宜 (according to circumstances): type scale, spacing rhythm, color roles, shape (radius/border), elevation/shadow, motion, per-component treatments (button/input/card/nav). Each parameter must cite its philosophical justification." },
    changedFiles: { type: "json", description: "Array of project file paths written during assembly." },
    summary: { type: "string", description: "One-line final outcome." },
  },
  stages: [
    {
      id: "frame",
      category: "in_progress",
      entry: { op: "always" },
      effort: "medium",
      outputFields: ["frame", "target"],
      instructions:
        "Classify what is being expressed: capture the content type (blog/article/product/docs/admin/…), goals, audience, key actions, information architecture, density (read vs scan vs operate), and the target platform for materialization — `web-semajsx` (default, producing real semajsx code) or `swiftui` (producing a SwiftUI design system + views). Set `frame` with the refined design frame and `target` to the target platform, then request transition. Block if the request is too unclear to frame.",
    },
    {
      id: "language",
      category: "in_progress",
      effort: "max",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "frame", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["language", "alternatives"],
      instructions:
        "DIVERGE: Select 2-3 candidate design languages from the catalog (`design/design-language-catalog.md`) suited to the `frame`. Steelman each: what it deliberately omits, what it elevates, the feeling/values it creates, and *why* it suits this frame. CONVERGE: choose one language whose philosophy best fits the frame's content, audience, and key actions. Record the chosen language in `language` (philosophy + reasoning + omit/elevate commitments) and the rejected candidates in `alternatives` as a JSON array of { name, philosophy, why_rejected }. The dialectic lives HERE at philosophy altitude — not at pixels. Cannot proceed to params without both fields. Then request transition.",
    },
    {
      id: "derive",
      category: "in_progress",
      effort: "high",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "language", cmp: "exists" },
          { op: "field", field: "alternatives", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["designSpec"],
      instructions:
        "因地制宜 (derive from context): from the chosen `language` philosophy + the `frame`'s constraints, DERIVE the concrete design system parameters — type scale, spacing rhythm, color roles, shape (radius/border), elevation/shadow, motion, and per-component treatments (button/input/card/nav). Each parameter MUST cite its philosophical justification (e.g. 'hairline borders ← minimalism omits ornament'). This is DERIVATION, not selection — every token must trace to the philosophy. Use the chosen language's derivation rules from the catalog. Set `designSpec` to a JSON object with the full specification, then request transition. Block if the language has no derivation rules available.",
    },
    {
      id: "assemble",
      category: "in_progress",
      effort: "medium",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "designSpec", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["changedFiles"],
      instructions:
        "Build the design from the derived `designSpec` into the target platform (from `target`). web-semajsx: write real semajsx code using `design_deliver`; prefer language-parameterized `semajsx/ui` components where available. swiftui: write a SwiftUI design system derived from the tokens — a Swift file of `Color`/`Font`/spacing (`CGFloat`)/`cornerRadius`/`shadow`/`animation` constants + `ViewModifier` helpers — then the views, delivered via `design_deliver`. Set `changedFiles` to a JSON array of written file paths, then request transition. Block if writing fails.",
    },
    {
      id: "review",
      category: "in_progress",
      effort: "high",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "designSpec", cmp: "exists" },
          { op: "field", field: "changedFiles", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      acceptance: [{ kind: "projectGate", description: "Submit typecheck/test evidence for lead review" }],
      outputFields: ["summary"],
      instructions:
        "Preview and evaluate the assembled design against the chosen `language` philosophy and the `frame`'s goals. web-semajsx: use `design_preview` to emit preview bundles for the owner. swiftui: run `swift build` to verify it compiles; then present for owner visual review. Judge coherence-with-the-stated-philosophy, not raw aesthetics — every parameter should trace to the philosophy. Submit structured evidence with `submit_evidence` (commands, outputs, previews/artifacts, changed files), set `summary`, and request transition. The lead must review the evidence and accept/reject; do not claim acceptance yourself. Block if the design fails to cohere with its stated philosophy or if verification cannot run.",
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
          { op: "acceptancePassed" },
        ],
      },
    },
  ],
};

/**
 * Generic design workflow: research, decision, document, and review
 * architectural/technical design choices — tradeoffs, DESIGN.md content,
 * ADRs, interfaces, architecture, and any software design that is NOT
 * UI/visual design. For UI/visual design (target-aware, philosophy-driven),
 * use `VISUAL_DESIGN_WORKFLOW` instead.
 *
 * Stages: design → document → review → done.
 */
export const DESIGN_WORKFLOW: WorkflowDef = {
  id: "design",
  version: "4",
  name: "Design",
  description:
    "Architectural/technical design: research tradeoffs, make design decisions, document them, and get lead review. For UI/visual design, use visual-design instead.",
  fields: {
    request: { type: "string", description: "The original design requirement." },
    design: { type: "string", description: "Design decisions, tradeoffs, and selected approach." },
    alternatives: { type: "json", description: "Adversarial record of the design: the candidate approaches considered and why each was rejected — a JSON array of { option, pros, why_rejected }." },
    summary: { type: "string", description: "One-line final outcome." },
  },
  stages: [
    {
      id: "design",
      category: "in_progress",
      entry: { op: "always" },
      effort: "high",
      outputFields: ["design", "alternatives"],
      instructions:
        "Research the problem and explore design space. Read existing design documents, code structure, and any relevant context. DIVERGE first: identify 2-3 genuinely different candidate approaches and steelman each one. Attack your preferred choice with a pre-mortem. CONVERGE: resolve the design decisions. Record the settled decisions in `design`, and the seriously-considered-but-rejected approaches in `alternatives` as a JSON array of { option, pros, why_rejected }. Then request transition. Block if the requirement is too unclear to design.",
    },
    {
      id: "document",
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
      outputFields: [],
      instructions:
        "Write a design document capturing the design decisions, tradeoffs, and selected approach. Update existing design docs (e.g. DESIGN.md, ADR files) with the settled decisions. Submit evidence with `submit_evidence` (files written, summaries), then request transition.",
    },
    {
      id: "review",
      category: "in_progress",
      effort: "low",
      entry: {
        op: "and",
        all: [
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      acceptance: [{ kind: "projectGate", description: "Submit evidence for lead review" }],
      outputFields: ["summary"],
      instructions:
        "Present the design for lead review. Submit structured evidence with `submit_evidence` (design docs, alternatives record), set `summary`, then request transition. The lead must review the evidence and accept/reject; do not claim acceptance yourself.",
    },
    {
      id: "done",
      category: "done",
      entry: {
        op: "and",
        all: [
          { op: "field", field: "design", cmp: "exists" },
          { op: "field", field: "summary", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
          { op: "acceptancePassed" },
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
      tools: ["create_subtask", "set_field", "request_transition", "append_note", "submit_evidence", "block", "cancel"],
      entry: {
        op: "and",
        all: [
          { op: "field", field: "plan", cmp: "exists" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      outputFields: ["implementation", "changedFiles"],
      instructions:
        "The adaptive stage — implement the change directly OR delegate via `create_subtask`. For solo work: write the code, record `implementation` (what you changed) and set `changedFiles` to a JSON array of the changed project file paths, then request transition. For delegation (planned team effort): create one subtask per layer with `create_subtask`, respecting dependsOn ordering and the collision rule for shared-file edits (two subtasks touching the same files must either chain with dependsOn or isolate:true). Lead-authored `acceptance` checks are evidence requirements for later review, not automatic engine tests. After delegating, request transition to wait for the team. Block with a concrete reason if the change cannot be made.",
    },
    {
      id: "verify",
      category: "in_progress",
      effort: "medium",
      tools: ["create_subtask", "set_field", "request_transition", "append_note", "submit_evidence", "block", "cancel"],
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
      acceptance: [{ kind: "projectGate", description: "Submit typecheck/test evidence for lead review" }],
      outputFields: ["verification", "summary"],
      instructions:
        "Verify the implementation adversarially (ADR 0015) AND/OR review+merge the team's results. Run the project's full checks (build, vet/lint, tests) covering EDGE CASES and real-user-path smokes — not only happy-path values. If the team used isolated worktrees, merge each branch with git now. You MAY create follow-up subtasks with `create_subtask` for multi-round efforts (set no summary to be re-woken). Record `verification`, submit structured evidence with `submit_evidence` (commands, exit codes, outputs/artifacts, changed files), set `summary`, then request transition. The lead must review the evidence and accept/reject; do not claim acceptance yourself. Block if verification fails or cannot run.",
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
          { op: "acceptancePassed" },
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
      tools: ["create_subtask", "set_field", "request_transition", "append_note", "submit_evidence", "block", "cancel"],
      acceptance: [{ kind: "projectGate", description: "Submit typecheck/test evidence across the merged project for lead review" }],
      outputFields: ["summary"],
      entry: {
        op: "and",
        all: [
          { op: "childrenDone" },
          { op: "hasEvent", eventType: "transition.requested" },
        ],
      },
      instructions:
        "Read the Team section and review what each subtask returned. Any subtask shown as [isolated → branch sikong/<id>] committed its work to that branch — before finishing, merge each isolated branch into the current branch with git (you have a shell), resolving conflicts. If the effort needs another round, create follow-up subtasks with `create_subtask` and request transition WITHOUT setting `summary` — you will be re-woken once they finish, then review again. When the effort is complete, submit structured evidence with `submit_evidence`, set a one-line `summary`, and request transition. The lead must review the evidence and accept/reject. Block if it failed.",
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
          { op: "acceptancePassed" },
        ],
      },
    },
  ],
};
