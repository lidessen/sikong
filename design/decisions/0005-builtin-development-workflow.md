# ADR 0005: Builtin Development Workflow

Status: Accepted

Date: 2026-06-01

## Context

The builtin `general` workflow is intentionally loose: a worker can complete it
by setting a summary and requesting transition. That is useful for small admin
tasks, but too weak for development work. During dogfood, workers sometimes read
project files, then failed to edit or verify while still trying to close or
cancel the task.

Development tasks need explicit stage evidence: a plan before design, design
before implementation, changed-file evidence before verification, and
verification before done.

## Decision

Add a builtin `development` workflow with four active stages:

1. `plan`
2. `design`
3. `implement`
4. `verify`

The workflow uses durable fields for `plan`, `design`, `implementation`,
`changedFiles`, `verification`, and `summary`. Each stage requires the relevant
field plus a current-stage `transition.requested` event before advancing.

Keep `general` as the fallback workflow. `development` is opt-in through
`--workflow development`, project defaults, intake routing, or future PM
delegation logic.

## Consequences

Development work has a better state contract without making simple tasks
ceremonial. Workers must record intermediate artifacts, and PM review can inspect
stage-specific fields and changed-file evidence.

The workflow does not fully prove the diff is correct. It records evidence; PM
or future verifier hooks still need to compare requested behavior against actual
diffs and test results.

## Implementation Notes

- Export `DEVELOPMENT_WORKFLOW` from `workflow/builtin.ts`.
- Register it as a builtin alongside `GENERAL_WORKFLOW` in workspace startup.
- Add tests for workflow validity, registration, and stage progression.
- Keep CLI semantics unchanged: users can select it with `--workflow
  development` or project defaults.

## Open Questions

- Should development workflow completion require a future verifier role before
  entering `done`?
- Should `changedFiles` become a first-class typed field shape instead of
  generic JSON?
