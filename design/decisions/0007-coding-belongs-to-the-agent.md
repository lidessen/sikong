# ADR 0007: Coding Belongs to the Agent; Sikong Stays Task-Agnostic Coordination

Status: Accepted

Date: 2026-06-02

Supersedes: [0006](0006-coding-agent-interface-guardrails.md)

## Context

ADR 0006 reacted to a real dogfood failure — a low-cost AI SDK worker could plan
and inspect but did not turn that into edits, and produced plausible-but-false
verification. Its remedy was to treat sikong development workers "as users of a
coding-specific Agent-Computer Interface" and to build that interface *into the
coordination layer*: a host-side check runner (`runHostCheck`, with this repo's own
build/test commands hardcoded into the library engine), project-write-evidence
gates, verify-stage shell-failure gates, raw-`bash` suppression, a
`writeFile`-overwrite refusal, and editor-tool prompt steering.

That is the wrong layer. The design entrypoint already defines the boundary:
`agent-loop` is the execution library (it owns runtimes, tools, skills,
capabilities); `sikong` is the coordination layer whose entire core is
`WorkflowDef -> Task timeline -> Wake -> Commands -> Events -> Projection` plus
guard-driven advancement. README states the containment test plainly: anything that
cannot say which event it records, which command it validates, which guard it
affects, or which projection it rebuilds does not belong in the core. A line-window
file viewer, a structured-edit policy, or a `bun run test` runner is none of those.
ADR 0006's guardrails fail that test.

This project is an engineering system, and the cybernetics view (Qian Xuesen,
*Engineering Cybernetics*) is the right lens: a machine-plus-human engineering
system and an all-machine one are not essentially different. Sikong is the
**controller** (a company coordinating a team); each agent is a **plant** — a black
box with a transfer function. A controller acts on the plant's inputs and observed
outputs and corrects through feedback; it does not reach inside the plant to rewire
its hands. "The cheap worker cannot code" is a poor plant transfer function. The
correct control response is to **select a better plant** — hire a coding-capable
worker (a real coding agent such as claude-code or codex, which already carry their
own coding interface and do not exhibit this failure) — not to rebuild a coding
agent inside the controller.

## Decision

Coding capability lives **inside the agent**, never in the sikong coordination
layer.

1. Sikong is a task-agnostic coordination/control layer. Its vocabulary is
   workflows, stages, fields, guards, commands, events, projections, and wakes —
   and nothing about files, edits, shells, tests, or "verify" semantics.

2. A worker is a black box. Sikong assigns a task, supplies the field-state
   context and a fixed menu of state-recording tools, observes the commands and
   events the worker emits, and advances by guards. It does not police *how* the
   work is done.

3. The worker brings its own capabilities. A coding-agent runtime (claude-code /
   codex) supplies its own coding interface. A bare ai-sdk worker gets generic,
   task-agnostic tools from `agent-loop` (the agent's interior) injected at the
   **worker boundary**, not assembled or policed by the engine.

4. For coding work, hire a coding-capable worker. Worker quality is a worker
   selection decision, not something the coordination layer compensates for with
   coding scaffolding.

5. Keep only the genuine, task-agnostic control kernel that any team-of-agents
   needs regardless of task type:
   - stop a run once it records terminal intent (`request_transition` / `block` /
     `cancel`) — lifecycle, not a budget;
   - a wall-clock wake timeout and a runaway wake backstop;
  - a no-state-command commit fallback that re-drives a worker which recorded no
    durable outcome (with generic typed-field validation on the commit tool);
    superseded by [0033](0033-worker-work-log-review.md), which records a
    review-required worker work log instead;
   - generic, sanitized diagnostics/observability of what a run did.

## Consequences

- Sikong returns to the small core the design docs already describe; a
  non-coding task is coordinated identically to a coding one.
- Dogfood reliability for coding shifts to choosing a real coding-agent worker,
  which is where the cybernetics analysis says it belongs.
- Generic file/shell tools (`viewFile`, `replaceInFile`, `insertInFile`, pipefail
  bash) stay in `agent-loop` as reusable agent capability — that is coding *inside
  the agent*, and is explicitly retained.
- ADR 0006 and its guardrails (host-check runner, write/verify gates, overwrite
  refusal, bash suppression, coding prompt steering, the `requiresProjectWrite`
  stage flag) are removed from sikong.

## Implementation Notes

- Remove from `packages/sikong/src/engine/engine.ts`: the `runHostCheck` /
  `HOST_CHECKS` machinery, `failedProjectCommand`, the project-write evidence gate
  and verify-failure gate (command rejection), `PROJECT_WRITE_TOOL_NAMES`, the
  `writeFile`-overwrite refusal, and the per-tool counting wrapper.
- The engine no longer constructs project tools. A new optional
  `workerTools(ctx, loop)` engine resolver (mirroring `intakeLoop`) lets the worker
  layer supply the worker's tools; the engine merges them with command tools
  without knowing what they are.
- `packages/sikong/src/workspace.ts` owns the coding decision: it builds
  `agent-loop` project tools for an ai-sdk worker and passes them via `workerTools`.
- Drop `StageDef.requiresProjectWrite`; built-in workflow instructions describe the
  *deliverable* (which fields to set), not which edit tool to use.
- Superseded by [0033](0033-worker-work-log-review.md): the engine records
  `wake.review_required` for lead/reviewer inspection instead of running an
  automatic commit fallback.
- Keep `closesCurrentRun` / run-stop-on-terminal-intent and the sanitized
  diagnostics as task-agnostic mechanisms.

## Open Questions

- Should per-run runtime tuning (e.g. ai-sdk `toolChoice: "required"`) also move
  from the engine to the worker boundary? It is runtime tuning, not coding content;
  deferred.
- Should a stage be able to declare a generic "evidence event required before
  transition" guard (the task-agnostic generalization of the removed write gate),
  expressed purely as a `Guard`? Only if a real need appears — not added now.
