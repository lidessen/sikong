# Design Decisions

This directory records durable project decisions that should survive beyond chat
threads, issue comments, and inline code notes.

The design entrypoint is [`../README.md`](../README.md).

Use a decision record when a change affects core behavior, public contracts,
data model semantics, persistence, runtime boundaries, or long-term operational
shape. Keep records short and mechanism-focused.

## Naming

Files use a monotonic four-digit prefix:

```text
0001-short-kebab-title.md
```

`0000-template.md` is the copy source for new records.

## Status

- `Proposed`: the direction is captured, but implementation or review is still open.
- `Accepted`: the project has chosen this direction.
- `Superseded`: a later decision replaces it.
- `Rejected`: the project explicitly decided against it.

## Index

| ID | Status | Title |
| --- | --- | --- |
| [0001](0001-stage-scoped-subtasks-block-advancement.md) | Proposed | Stage-scoped subtasks block stage advancement |
| [0002](0002-project-markdown-memory.md) | Proposed | Project markdown memory |
| [0003](0003-global-sikong-home.md) | Accepted | Global sikong home |
| [0004](0004-worker-cancel-requires-lead-approval.md) | Accepted | Worker cancel requires lead approval |
| [0005](0005-builtin-development-workflow.md) | Accepted | Builtin development workflow |
| [0006](0006-coding-agent-interface-guardrails.md) | Superseded | Coding agent interface guardrails |
| [0007](0007-coding-belongs-to-the-agent.md) | Accepted | Coding belongs to the agent; sikong stays task-agnostic coordination |
| [0008](0008-sikong-owns-staffing.md) | Accepted | Sikong owns staffing; the client only states, accepts, supervises |
| [0009](0009-lead-creates-team.md) | Accepted | A lead task creates and coordinates a team (via subtasks) |
| [0010](0010-optional-subtask-isolation.md) | Accepted | Optional per-subtask isolation (git worktree) at the worker boundary |
| [0011](0011-task-dependencies.md) | Accepted | Sibling task dependencies (dependsOn) |
| [0012](0012-adversarial-dialectic-design-stage.md) | Accepted | Adversarial-dialectic design stage for the lead (alternatives field + guard) |
| [0013](0013-usage-and-cost-accounting.md) | Accepted | Usage & cost accounting (tokens, cache, $; subscription windows; LiteLLM prices) |
| [0014](0014-wake-cost-optimization.md) | Accepted | Wake cost optimization (flash@max, prefix-stable wakes, pro-on-escalation) |
| [0015](0015-verify-stage-demands-edge-case-tests.md) | Accepted | Verify stage demands adversarial/edge-case tests + a real-user-path smoke |
| [0016](0016-sikong-self-iteration-loop.md) | Accepted | sikong self-iteration loop (sikong improves sikong; promotion needs explicit lead approval) |
| [0017](0017-design-workflow.md) | Superseded | Design workflow (sikong-orchestrated UI design → real semajsx, live preview) — superseded by 0022 |
| [0018](0018-sikong-web-package.md) | Accepted | sikong-web — new package for sikong.dev website + local monitor dashboard |
| [0019](0019-release-workflow.md) | Accepted | Release/deploy workflow (select stable → gate → tag → approve → publish → confirm; tag+npm+vercel) |
| [0020](0020-unify-development-workflow.md) | Accepted | Unify development + development-lead into one adaptive workflow (delegation optional; engine maxTeamDepth cap) |
| [0021](0021-configurable-effort-level.md) | Accepted | Configurable, lead-decided effort level (generic RunInput.effort + per-stage/per-subtask resolution; default medium) |
| [0022](0022-philosophy-driven-design-workflow.md) | Accepted | Philosophy-driven design workflow (frame → language → derive → assemble → review; design-language catalog) — supersedes 0017 |
| [0023](0023-conductor-goal-loop.md) | Accepted | The Conductor — first-class goal/project-driven autonomous loop (read-only orchestrator + cron; spawns worker tasks, gates outward actions) |
| [0024](0024-grounded-acceptance-gates.md) | Accepted | Grounded acceptance gates — worker submits evidence; lead reviews and records accepted/rejected; engine enforces the decision |
| [0025](0025-phase-gated-development-lead-acceptance.md) | Accepted | Phase-gated development with per-phase lead acceptance (验收) — lead woken at each phase boundary to advance/adjust + configure the next phase |
| [0026](0026-worker-sandbox-escalation.md) | Accepted | Worker sandbox + auto-mode privilege escalation (Claude Code model: sandbox-default + escalate-on-failure) so the worker can run the real toolchain and self-verify |
| [0027](0027-lead-authored-task-acceptance.md) | Accepted | Lead-authored per-task acceptance criteria (Task.acceptance + create_subtask/CLI) — worker evidence must address criteria the worker cannot redefine |
| [0028](0028-target-aware-design-workflow.md) | Accepted | Target-aware design workflow — native/SwiftUI support (target field; assemble/review branch web-semajsx vs swiftui; tokens stay universal) |
| [0029](0029-interactive-monitor-dashboard.md) | Accepted | Interactive monitor dashboard — semajsx hydration + live SSE (filter/sort/drill-down, in-place updates) replacing the SSR meta-refresh snapshot |
| [0030](0030-adaptive-wake-timeout.md) | Accepted | Adaptive wake timeout from deterministic work units |
| [0031](0031-technical-design-blueprint-workflow.md) | Accepted | Technical design blueprint workflow — world → anchors → skeleton → parts → blueprint → review |
| [0032](0032-wake-preemption-and-repair-fields.md) | Accepted | Wake preemption (lead cancel/block interrupts in-flight wake) + acceptance rejection reason in per-wake prompt |
| [0033](0033-worker-work-log-review.md) | Accepted | Worker work-log review replaces automatic commit fallback |
| [0034](0034-operator-messages-require-lead-review.md) | Accepted | Operator messages require lead review before task topology changes |
| [0035](0035-worker-tool-trace-and-abandoned-run-cleanup.md) | Accepted | Worker tool trace and abandoned-run cleanup facts |
| [0036](0036-cooperative-runtime-cleanup-contract.md) | Accepted | Cooperative runtime cleanup contract |
