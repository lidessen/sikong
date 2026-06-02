# ADR 0002: Project markdown memory

Status: Proposed

Date: 2026-06-01

## Context

`sikong` projects currently persist only structured project configuration in
`projects/<id>.yaml`. Dogfood use needs a lightweight place to keep project
operating notes, conventions, and local decisions that should be visible to
workers without becoming task timeline state.

## Decision

Each project may have a markdown memory file at `projects/<id>.md`.

The YAML file remains the structured project definition. The markdown file is
free-form context. When a project is loaded, the store attaches bounded markdown
content to the in-memory `Project` object so the wake prompt can include it as
project context.

## Consequences

- Project memory is easy to edit by hand and review as text.
- Task timelines remain the source of truth for task state; memory is advisory
  project context, not workflow state.
- The wake prompt must bound memory content before injection so a large markdown
  file cannot dominate the run context.

