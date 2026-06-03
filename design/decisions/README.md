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
