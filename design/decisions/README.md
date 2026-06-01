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
| [0003](0003-global-wakespace-home.md) | Accepted | Global wakespace home |
| [0004](0004-worker-cancel-requires-lead-approval.md) | Accepted | Worker cancel requires lead approval |
| [0005](0005-builtin-development-workflow.md) | Accepted | Builtin development workflow |
