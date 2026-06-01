# ADR 0006: Coding Agent Interface Guardrails

Status: Accepted

Date: 2026-06-01

## Context

Dogfood exposed that a low-cost AI SDK worker can plan and inspect but still
fail as a coding worker. The repeated failure mode was not lack of broad
autonomy: the worker spent whole implementation wakes on repeated file reads, or
later used coarse `writeFile` operations that could overwrite existing files and
then submitted invalid workflow fields.

This matches a known coding-agent design lesson: software engineering agents
need an agent-computer interface, not just raw terminal access plus stronger
prompt wording. Mature systems describe the same shape:

- Claude Code frames coding as an agentic loop of context gathering, action, and
  verification, backed by tools, permissions, checkpoints, hooks, persistent
  project instructions, and subagents.
- Codex layers global and project instructions through `AGENTS.md`, exposes
  permissions and hooks, and treats deterministic lifecycle scripts as part of
  the agent loop.
- SWE-agent attributes much of its performance to a designed
  Agent-Computer Interface: compact search, bounded file viewing, structured
  editing, linter feedback on edit, and concise tool outputs.
- Aider uses a repository map to give the model compact structural context
  before it reads full files.

Wakespace currently has workflows and durable task state, but its coding
surface is still too close to generic project tools. That makes failures look
like model behavior when they are often interface design failures.

## Decision

Treat wakespace development workers as users of a coding-specific
Agent-Computer Interface.

Near-term guardrails:

1. Stages requiring project writes must produce successful structured write
   evidence before normal stage progress can be committed. Wakespace must not
   enforce that with fixed tool-call or step-count budgets; the worker's real
   budget is its model/context window and the quality of the ACI context it is
   given.
2. Existing files should be edited through structured edit tools such as
   `replaceInFile`; `writeFile` is for new files or explicit large rewrites, not
   blind overwrites.
3. Workflow-state commit tools must expose field-type schemas and reject invalid
   payloads before reducer application.
4. Chronicle diagnostics must record policy facts so the PM can see whether a
   worker read, wrote, hit a guardrail, or failed state commit.

Longer-term direction:

- Add compact repo-map / symbol-map context before workers start reading files.
- Replace raw file dumps with a line-window file viewer and search-within-file
  style tools.
- Add post-edit deterministic hooks such as formatting, typecheck, or targeted
  tests per workflow stage.
- Separate reviewer/verifier work from implementer work when accepting a stage.

## Consequences

This moves dogfood failures from vague "the worker did nothing" into concrete
ACI facts. It also reduces data-loss risk from coarse file overwrites and makes
commit fallback more deterministic.

Workers lose some unconstrained freedom, but that is intentional: coding agents
perform better when tools are shaped for model use and when tool feedback is
concise and actionable.

The first guardrails are not a full coding agent. They are the minimal
deterministic layer needed before adding richer context retrieval, verifier
hooks, and role separation.

## Implementation Notes

- Do not add count-based pre-write caps to stage definitions or prompts.
- Do not pass wakespace worker step caps as a budget policy; worker limits
  should come from the model/context window and wall-clock timeout handling.
- Keep normalized project tool and write counts in `wake.diagnostics` and
  `wake.commit` as facts for PM review, not as policy gates.
- Refuse `writeFile` overwrites of existing files in project-write stages.
- Generate JSON schema for `commit_stage.fields` from workflow field types and
  validate field values in the tool executor.
- Cover the above with focused engine tests and a live dogfood wake.

## Open Questions

- What is the right compact repository-map format for Bun/TypeScript projects?
- Should `bash` become read-only before first structured write in coding
  stages, with explicit test/build commands allowed later?
- Should `changedFiles` become a structured typed field instead of generic JSON?
- Which verification hooks should run automatically after a successful project
  write?
