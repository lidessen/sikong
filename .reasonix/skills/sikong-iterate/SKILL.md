---
name: sikong-iterate
description: Use siko send to develop Sikong through the Rust assistant task board. Trigger when improving the Sikong project with Sikong itself: create bounded self-development tasks, inspect full historical and live task events, integrate accepted artifacts, run checks, and record feedback.
runAs: subagent
model: reasonix-default
effort: high
allowed-tools: bash, read_file, grep, ls, glob, write_file, edit_file, move_file, delete_range, memory, web_fetch
---

You guide Sikong development by using Sikong's own assistant task board.
`siko send` is the intake surface. `siko task inspect` is the review surface.
Manual edits happen only after the task artifact is inspected and accepted.

## Context

Workspace: `/Users/lidessen/workspaces/sikong`.
Primary implementation: Rust mainline under `src/`, `crates/siko-macros/`,
`packages/agent-host/`, and `packages/agent-loop/`.
Legacy Go/Bun paths are reference-only unless the user explicitly asks for
legacy work.

Before broad self-development work, read the governing docs that own the
boundary:

- `design/philosophy/development-philosophy.md`
- `design/philosophy/prompt-guidance.md`
- `design/philosophy/dogfood.md`
- `AGENTS.md`

## Workflow

1. Name the dogfood attention contract.
2. Create one bounded task with `siko send`.
3. Inspect full historical events and live progress with `siko task inspect`.
4. Accept, reject, or narrow the returned artifact.
5. Apply accepted changes in the main workspace when needed.
6. Run deterministic checks and record feedback in `development-log/YYYY-MM.md`.

### Task Shape

Every non-trivial `siko send` prompt should include:

- Mainline: the top-level intent that must not drift.
- Owning layer: `goal`, `design`, `fact`, `reframe`, or `harness`.
- Parent acceptance evidence: what lets the parent accept or reject the result.
- Child autonomy boundary: what the task may decide locally.
- Upward artifact: report, design patch, patch proposal, blocker, or verification evidence.

Keep the task bounded. Use a design/review task first when the implementation
boundary is unclear. Use a patch task only when the target behavior and
acceptance checks are already stable.

### Invocation Template

```bash
siko send --wait-ms 0 "Sikong self-development task:
Mainline: <stable top-level intent>.
Owning layer: <goal|design|fact|reframe|harness>.
Parent acceptance evidence: <evidence required to accept>.
Child autonomy boundary: <what this task may decide locally>.
Upward artifact: <report|design patch|patch proposal|blocker|verification>.

Request:
<bounded task text>"
```

Use `--wait-ms 0` when creating a background task. Use the default wait when
you want the initial assistant response inline.

### Inspection

Use task commands instead of guessing from terminal output:

```bash
siko task list
siko task inspect <task-id>
siko task show <task-id>
siko task events <task-id>
```

`task inspect` replays existing events first and then follows live updates until
terminal task status, so it can be opened at any time. Prefer copying the full
short id shown by `task list`; legacy long ids may be referenced by a unique
prefix.

### Acceptance

Do not treat an agent-written report as accepted truth. Accept only artifacts
with reviewable evidence:

- file or module evidence for code claims;
- deterministic command output for build/test/lint claims;
- transcript or task-event evidence for runtime behavior;
- design-doc references for architecture claims;
- explicit blocker text when the child task cannot preserve the parent boundary.

If the artifact is weak, create a narrower follow-up task with the missing
evidence surface. Do not silently broaden the original task.

### Manual Integration

Manual implementation is appropriate when:

- the task board cannot proceed because of missing infrastructure;
- the task exposes a mechanical CLI/runtime bug;
- the user explicitly asks for direct edits after seeing the artifact;
- the accepted artifact is a patch proposal that still needs normal workspace edits.

Keep manual edits small, scoped to the accepted boundary, and verified. For
Rust mainline changes, run at least the focused tests plus:

```bash
cargo test
cargo clippy --all-targets -- -D warnings
```

Run `bun run build:agent-host` when the change affects `packages/agent-host`,
`packages/agent-loop`, or Rust launch/config behavior for the external host.

### Feedback

Record reusable learning in `development-log/YYYY-MM.md`:

- target and boundary;
- task id and inspected artifact;
- accepted changes or rejected findings;
- verification commands;
- what should be easier for the next `siko send` run.

## Skill Boundaries

- Use `harness-prompt-design` for prompt/harness wording and attention-layer
  work.
- Use `sikong-mentor` for higher-level scenario direction and philosophy checks.
- Use this skill for the day-to-day project development loop based on
  `siko send`.
