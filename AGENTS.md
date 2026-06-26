# Sikong — Rust-based Recursive Agent Engine

## Project Structure & Module Organization

This repository contains a single Rust-based mainline implementation.

### Rust Mainline

- `src/` contains the Rust `siko` engine, assistant, task manager, single-task
  run harnesses/tools, workspace providers, and agent run scheduler.
  - `src/main.rs` — binary entrypoint (parses CLI args, delegates to CLI interface)
  - `src/lib.rs` — public API surface re-exporting all modules
- `src/task_run/` contains recursive engine execution: operation harnesses,
  problem tree, node plan/execute/combine/verify, resource bookkeeping,
  governance gates, and agent-run tools.
- `src/task_board/` contains assistant-facing task board types, stores,
  queueing, cancellation, task-level dispatch, and task inspection views.
- `src/agent_run/` contains agent run request/response, scheduler, cancellation
  tokens, and tool schema support.
- `src/workspace/` contains workspace providers and workspace facts:
  FileSystem, GitFileSystem, Memory, WorkspaceSurface, scope checks, and
  provider cleanup.
- `src/interface/` contains external/operator surfaces:
  - `src/interface/cli/` — CLI subcommand dispatch (`run`, `send`, `task`,
    `tui`, `acp`, `daemon`, `eval`, etc.)
  - `src/interface/assistant/` — ACP server, session, assistant tools, context
  - `src/interface/daemon.rs` — daemon socket lifecycle and request handling
- `src/common/` contains shared primitives:
  - `src/common/config.rs` — SikoConfig, per-provider config
  - `src/common/metrics.rs` — MetricsCollection and recording
  - `src/common/types.rs` — common type aliases (NodeId, ArtifactId)
- `crates/siko-macros/` contains Rust proc macros used by the new tool
  definition layer.
- `packages/agent-host/` contains the current external agent process used by
  `ProcessAgentRunScheduler`. For now, the real agent loop is still mocked in
  this package.
- `packages/agent-loop/` is the Bun loop/tool abstraction used by the
  `agent-host` mock and intended future real loop integration.

Do not add compatibility layers from the Rust mainline back to legacy
paths unless the user explicitly asks for it.

## Dogfood Operating Mode

The preferred development loop is Sikong-to-Sikong self-iteration. Treat user
messages as steer input: inspect or create assistant task-board items, let the
Rust task-run engine produce reviewable artifacts, then use those artifacts to
decide the next bounded slice.

For day-to-day Sikong self-development, use the project skill
`.reasonix/skills/sikong-iterate/SKILL.md`. It is the current `siko send`-based
operating guide for creating bounded development tasks, inspecting full
historical and live task events, accepting or rejecting artifacts, and recording
feedback. The older scenario/eval dogfood surfaces are reference and evaluation
tools; they are not the default intake path for normal Sikong project work.

When starting a non-trivial self-development task, create one bounded assistant
task through `siko send` and include the dogfood attention contract: mainline,
owning layer (`goal`, `design`, `fact`, `reframe`, or `harness`), parent
acceptance evidence, child autonomy boundary, and upward artifact. Use
`siko task list` and `siko task inspect <task-id>` to review the task. `inspect`
must be treated as the place to replay prior events and follow new events from
whatever point the operator joins the task.

Do not directly edit implementation code as the first response to self-improvement
requests. Intervene manually only when the dogfood loop cannot make progress
because of missing infrastructure, a runtime failure, an invalid protocol
boundary, or a clearly mechanical reliability bug. Keep those interventions
small, tested, and recorded in `development-log/`.

## Build, Test, and Development Commands

- `bun install` installs Bun workspace dependencies and updates `bun.lock`.
- `cargo test` runs the Rust mainline unit and integration tests.
- `cargo clippy --all-targets -- -D warnings` runs Rust lint checks.
- `cargo build` builds the siko binary in debug mode; `cargo build --release` produces a release binary.
- `cargo run -- run "<prompt>"` directly runs a task through the siko engine.
- `cargo run -- assistant` starts the interactive assistant loop.
- `cargo fmt` formats Rust code; `cargo fmt --check` checks formatting without changes.
- `bun run build:rust` runs the Rust release build pipeline (produces `dist/release/siko`).
- `bun run check` runs TypeScript checks, Oxlint, Oxfmt, and agent-loop/agent-host package tests.
- `bun run build:agent-host` builds the Bun agent host executable into `dist/siko-agent-host`.
- `bun --filter agent-loop test` runs the agent-loop package tests directly.
- `bun --filter @sikong/agent-host test` runs the agent-host protocol and mock-loop tests.
- `bun run typecheck` runs TypeScript Native Preview through `tsgo`.
- `bun run lint` runs Oxlint; `bun run lint:fix` applies safe fixes.
- `bun run fmt:check` checks formatting with Oxfmt; `bun run fmt` writes changes.

Prefer package scripts over ad hoc command combinations so contributors use the
same checks locally and in automation. For Rust mainline changes, run the Rust
checks explicitly because `bun run check` does not replace `cargo test` and
`cargo clippy`.

## Coding Style & Naming Conventions

Format Rust files with `cargo fmt`. Keep Rust modules small and aligned with
`agent_run`, `assistant`, `task_board`, `task_run`, and `workspace` boundaries. New
Rust API shapes should follow the current `src/` patterns instead of preserving
old Go/Bun assumptions.

## Agent Protocol & Evaluation Patterns

Keep agent-facing protocols qualitative, evidence-backed, and terminal-tool
driven.

- For design-sensitive changes, read `design/philosophy/development-philosophy.md` before
  changing engine, assistant, task-run, workspace, agent-run, agent-host,
  agent-loop, or dogfood behavior. New mechanisms must compile into the current
  core loops instead of adding independent planner, scheduler, learner, quality,
  memory, or repair subsystems.
- Before a state-changing design or implementation slice, name the current
  attention boundary and the layer that owns the uncertainty: `goal`, `design`,
  `fact`, `reframe`, or `harness`. If that cannot be named, recover the route
  before editing.
- Prompt and harness changes should follow `design/philosophy/prompt-guidance.md`: preserve
  the attention boundary, project only the current layer's context into each
  run, and let lower-layer agent loops own local execution detail.
- When live eval exposes bad model behavior, do not first add long
  forbidden-example lists to the prompt. First ask whether the prompt is
  over-projecting context, making the task more specific than the raw intent,
  or missing a schema/state-machine/tool constraint. Prefer a smaller prompt
  plus a tighter terminal tool contract over prose bans such as "do not invent
  env vars, paths, protocols, error codes, ...".
- Do not ask agents to produce subjective numeric estimates such as scores,
  confidence percentages, probability ratings, difficulty numbers, or
  0-to-1/1-to-10 judgements. Use structured qualitative fields instead:
  `passed` plus findings/evidence for evals, or enum-like choices plus `reason`
  for routing decisions.
- Numeric fields are fine for deterministic system telemetry and configuration,
  such as token counts, durations, attempt counters, limits, offsets, prices,
  line numbers, and protocol versions. They should not represent the model's
  subjective self-assessment.
- Immutable per-run context should be provided as prompt/input context sections,
  not as a generic `read_*_context` tool. Avoid context-reader tools whose only
  purpose is to return the current request packet; they invite repeated calls
  and duplicate token cost.
- Tools should represent actions, terminal submissions, or bounded queries over
  larger state. Examples: `submit_specification`, `submit_work`,
  `finish_eval`, `query_messages`, or task-board commands. Terminal semantics
  belong to the run's `terminalToolSet`, not to separate business-specific
  tool-handling branches in `agent-host`.
- Do not implement semantic quality, routing, task-understanding, or acceptance
  checks through regexes, keyword lists, `includes(...)`, or fixed phrase
  matching. Use schemas, typed decoding, explicit fields, verifier judgement,
  workspace/resource facts, and settlement/verification evidence.
- Claude Code runs must not load Claude settings sources. Do not support
  user/project/local `settingSources` for Sikong agent-loop runs; all context,
  tools, memory, plugins, and instructions must be mounted explicitly through
  `AgentRunRequest`.
- Runtime profiles are deliberately coarse: `general` for Sikong control,
  assistant, and general work; `code` for work that should use Claude Code's
  coding prompt/tool behavior. Do not add fine-grained runtime profiles without
  repeated live-eval evidence. Disable orchestration escape tools such as
  sub-agent launchers and Claude plan mode, but do not blanket-disable current
  Claude task-tracking tools such as `TaskCreate`, `TaskUpdate`, `TaskGet`, and
  `TaskList`.
- For live evals, make the judge finish through a terminal judgement tool, but
  put the transcript/eval context in the prompt section. Prefer
  `passed/findings/evidence` over score-like outputs.
- Use `siko send` plus `siko task inspect` as Sikong's daily dogfood loop: run
  realistic current-repo tasks, classify task-event and artifact evidence before
  trusting the agent-written report, make one bounded improvement, re-run
  focused checks, and record reusable feedback in `development-log/YYYY-MM.md`.
- Dogfood runs must follow the attention contract in `design/philosophy/dogfood.md`:
  name the mainline, owning layer, parent acceptance evidence, child autonomy
  boundary, and upward artifact before broad self-development work. Use child
  runs to own local evidence surfaces; the parent should integrate or reject
  compressed artifacts, not watch every local detail.
- Use `eval task-run-split --scenario-file ... --artifact-dir ...` only for
  internal regression or diagnostic runs, not normal task intake. In those eval
  runs, the JSON transcript is intentionally compact; artifact sidecars are the
  review surface for reports, proposed docs, and patch proposals.
- If dogfood work changes `packages/agent-host`, `packages/agent-loop`, or Rust
  launch/config behavior for the external host, rebuild the runtime host with
  `bun run build:agent-host` and rerun a focused live eval using the updated
  runtime before calling the loop closed.

## Testing Guidelines

Rust tests use `cargo test`; integration tests live under `tests/`. Prefer
host-backed tests for new Rust/Bun boundaries so only the actual agent loop
remains mocked in `packages/agent-host`.

Bun tests use `bun:test`. Name test files `*.test.ts` and keep them close to the code they cover.

Run `cargo test`, `cargo clippy --all-targets -- -D warnings`, and
`bun run check` before handing off non-trivial changes.

## Commit & Pull Request Guidelines

This repository has no commit history yet, so no existing convention can be inferred. Use short imperative commit messages, preferably Conventional Commit style, for example `feat: add daemon config loader` or `test: cover tooling entrypoint`.

Pull requests should include a concise description, the commands run for verification, linked issues when applicable, and screenshots only for UI-facing changes.

## Security & Configuration Tips

Do not commit secrets, local environment files, or generated binaries. Keep `.env*`, `dist/`, and dependency directories ignored.
