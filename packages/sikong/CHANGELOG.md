# Changelog

All notable changes to `sikong` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed

- **The compiled `sikong` binary can now drive claude-code workers.** A
  `bun --compile` single-file build cannot embed the Claude Agent SDK's native
  CLI, so claude-code wakes failed with "Native CLI binary for <platform> not
  found". The claude adapter now resolves the Claude Code executable (env
  `CLAUDE_CODE_EXECUTABLE` → `claude` on PATH / common install dirs → the SDK's
  bundled binary) and passes it as `pathToClaudeCodeExecutable`, so the published
  binary uses the operator's installed `claude`. Running from source is unchanged.

### Added

- **`sikong watch` — live terminal dashboard.** Redraws the workspace overview
  (projects, task counts, recent activity) plus the token-usage + cost panel
  every `--interval` seconds (default 3); `--project` scopes it, `--once` renders
  a single frame. Read-only (polls the workspace home), ctrl-c to exit.
- **Usage & cost accounting** (ADR 0013): a new `sikong usage [--project]
  [--text]` command reports token usage (uncached input / output / cache-read /
  cache-write) and estimated $ cost per task / project / workspace, plus
  ccusage-style 5h / 7d / 30d windows. The engine records each wake's usage and
  hired model on its chronicle entry; cost is priced from a vendored LiteLLM
  price snapshot (`agent-loop`, refresh with `scripts/refresh-prices.ts`) — no
  hand-maintained prices. Honest by mode: pay-per-token workers get $; subscription
  workers and unknown models report tokens only ($ n/a). Required agent-loop
  changes: cache-token fields on `usage`/`TokenUsage` with per-adapter mapping,
  usage preserved on run cancellation (sikong stops a run on the terminal tool
  call, which previously dropped usage), provider `pricing()` + exported
  `modelPricing()`. Subscription rate-limit % (5h/weekly) is deferred — the Claude
  SDK doesn't surface the unified rate-limit headers yet.
- **Adversarial-dialectic design stage for the lead** (ADR 0012): the
  `development-lead` `design` stage now requires an `alternatives` field (JSON
  `[{ option, pros, why_rejected }]`) and gates `plan` entry on it, and its
  instructions demand divergent-then-convergent reasoning (steelman 2-3
  candidates, pre-mortem the chosen one). The rejected options are recorded in
  durable state so the lead's consequential calls are auditable. Field+guard
  enforce presence/shape/audit; the instructions induce the thinking. Scoped to
  the lead only — the child `development` design stay lightweight.
- **Sibling task dependencies** (ADR 0011): `create_subtask` accepts `key` and
  `dependsOn` (sibling keys); the engine runs a dependent only after all its
  prerequisites are terminal (resolving keys→ids within the delegate pass, and
  across re-wakes). A lead can delegate a layered effort as an **ordered DAG**
  (proxy → capture → API → CLI → rules) instead of a colliding parallel fan-out.
  `create_subtask` is now **idempotent per (parent, key)** — re-running the
  `delegate` stage (the lead is re-woken on each child completion) no longer
  re-spawns the team.

- **Optional per-subtask isolation** (ADR 0010). `create_subtask` accepts a generic
  `isolate: true`; for git projects the worker boundary runs that child in its own
  git worktree (branch `sikong/<id>`, under the sikong home dir, not the
  project checkout), so parallel children editing the same code don't clobber each
  other. On terminal the worktree is committed to its branch and removed; a `run`
  GC sweep reclaims leftover worktrees and `sikong/*` branches, keyed on task
  lifecycle (not git-merge detection — a lead may integrate by re-applying rather
  than `git merge`), and **retains a child's branch until its parent effort
  terminates** so the lead's integration window isn't destroyed; neither worktrees
  nor branches pile up. Non-git projects: a no-op. The lead merges the isolated
  branches during review. The engine stays git-agnostic — it only forwards the
  opaque `isolate` flag to worker-boundary hooks. (Isolation is for parallel-edit
  safety, NOT a system sandbox — `bypassPermissions` bash is not jailed by a
  worktree; OS-level sandboxing is deferred.)
- **Staleness circuit-breaker**: a child task whose wake keeps failing (timeout /
  run error) is retried `maxWakeRetries` times (default 1) then terminally failed by
  the engine, so a stuck child can't wedge its parent's `childrenDone` — the parent
  unblocks and re-decides. Root tasks keep the plain behaviour. New `run
  --wake-timeout <seconds>` raises the per-wake budget for heavy real builds.
- The `development-lead` workflow gained an explicit **`design` stage** before
  planning: the lead must review and refine the project's design doc (update it in
  place) and record the key decisions before `plan` is admitted — so design review
  is a first-class, gated step, not bundled into planning.
- **A lead task can build and coordinate a team** (ADR 0009). New built-in
  `development-lead` workflow: a 负责人 plans an effort, delegates the pieces to a
  team of child tasks (each auto-staffed by capability), is re-woken as they finish,
  reviews their results, and synthesizes the outcome — reusing `create_subtask` +
  `childrenDone` + parent re-wake, no new engine mechanism. A lead's wake now shows
  a read-only `## Team` section (each subtask's status + summary) so it can review
  and re-plan; re-planning stays task-level (spawn/cancel), never mid-task injection.
  `create_subtask` remains opt-in per stage (enabled only on the lead's delegate
  stage). Select it with `create "<req>" --workflow development-lead [--worker <id>]`.
  The `review` stage also enables `create_subtask` and `done` is re-gated on
  `childrenDone`, so the lead can run another round (spawn follow-up subtasks,
  get re-woken when they finish, review again) before closing out.
- Auto-discovered `claude-code` workers default to `permissionMode:
  "bypassPermissions"` so a headless autonomous dev worker can both edit files and
  run project checks (typecheck/tests/build) during verify — it cannot answer
  permission prompts. File tools stay jailed to the project root (cwd +
  allowedPaths); run teams against a project you're willing to let an agent modify.
- **Create-time guardrail**: `create` warns when a write-class workflow (one that
  staffs a coding team — i.e. declares a `workerRole`) targets the current
  directory (the builtin `default` project root is `"."`), so a team isn't pointed
  at the wrong place by accident. Use `project create <id> --root <path>` to scope.
- **Sikong now staffs tasks itself** (ADR 0008). The operator only provisions the
  workforce once — set a provider key (e.g. `DEEPSEEK_API_KEY`/`ANTHROPIC_API_KEY`)
  and/or install `claude`; sikong auto-discovers the roster and hires per task.
  The everyday path needs no worker management: `create "<requirement>"` → `run`.
- Capability-matched assignment: a worker carries `roles` (e.g. `coding`,
  `general`; inferred from runtime when unset — `claude-code` is coding-capable), a
  workflow carries an optional `workerRole`, and sikong prefers a worker whose
  roles match. The `development` workflow declares `workerRole: "coding"`, so coding
  work is staffed to a coding-agent worker when one is available.
- `--worker`, `worker default`, and `worker create` remain as an optional supervisor
  override, no longer a prerequisite. `worker list` shows the effective roster
  (registered, or auto-discovered) so you can see who will be hired.

### Changed

- **Coding capability now lives inside the agent, not in the sikong
  coordination layer** (ADR 0007 supersedes ADR 0006). Sikong is again a
  task-agnostic coordinator: it assigns a task, supplies field state plus the
  workflow's state tools, observes the worker's commands, and advances by guards.
  It no longer knows about files, edits, shells, tests, or "verify" semantics.
- A worker's own tools now arrive at the worker boundary via a generic
  `workerTools` engine resolver and are merged with the command tools without the
  engine knowing what they are. A bare ai-sdk worker is given `agent-loop`'s
  generic project tools; a coding-agent runtime (claude-code) carries its own
  interface and needs none. For coding work, hire a coding-capable worker —
  worker quality is a selection decision, not something sikong patches over.
- The built-in `general` and `development` workflows no longer demand project
  writes; their stage instructions describe the deliverable (which fields to
  set), not which edit tool to use.

### Removed

- The coding-specific Agent-Computer Interface guardrails from ADR 0006: the
  host-side `runHostCheck` runner (with hardcoded repo build/test commands),
  project-write-evidence gates, verify-stage shell-failure gates, raw-`bash`
  suppression, the `writeFile`-overwrite refusal, the `StageDef.requiresProjectWrite`
  flag, the per-tool write counting, and the editor-tool/`runHostCheck`/
  "smallest-edit-or-block" prompt steering.

### Kept (task-agnostic coordination)

- Stop-the-run once a terminal command (`request_transition`/`block`/`cancel`) is
  recorded; the no-state-command commit fallback (now with no coding-evidence
  gating); `commit_stage` field-type validation; the wake timeout; and sanitized
  run diagnostics.
- `agent-loop`'s generic `viewFile`, `insertInFile`, and pipefail `bash` remain
  as reusable agent tools — coding *inside the agent*.

## 0.1.6 — 2026-06-01

### Changed

- Removed the fixed pre-write project tool-call cap from implementation stages.
  Project write evidence is still required before normal implementation progress
  can be committed, but worker exploration is governed by model/context limits
  and better ACI context rather than a hard tool-count budget.
- Removed the sikong worker step-cap option from workspace and engine wiring;
  worker runtime limits should come from the model/context window and timeout
  handling, not a sikong step budget.

## 0.1.5 — 2026-06-01

### Changed

- Implementation stages that require project writes now cap pre-write project
  exploration. After the budget is exhausted, project tools reject the rest of
  the worker pass, cancel the run, and route to commit fallback instead of
  allowing repeated read retries or late writes.
- Coding-stage project writes now refuse `writeFile` overwrites of existing
  files, steering workers toward structured `replaceInFile` edits for existing
  source.
- Forced commit tools now expose workflow-field JSON schema and reject invalid
  field payload types before reducer application.

## 0.1.4 — 2026-06-01

### Added

- Wake chronicles now record `wake.progress` events for worker and commit tool
  calls, so `inspect wait` can observe long wakes before they finish.
- Wake chronicles now record bounded worker diagnostics for each worker and
  forced commit pass, including state-command counts, project tool/write
  evidence, tool-call summaries, and first-pass text previews.
- Added `inspect wait`, a read-side command that waits for the next chronicle
  event (optionally scoped by task) or exits on timeout.
- AI SDK project workers now get `replaceInFile` for exact small source edits;
  sikong counts it as project write evidence alongside `writeFile`.
- CLI task creation now accepts `--parent`, and `submit` accepts `transition`
  so a lead can split broad work into child tasks and explicitly accept results.

### Fixed

- Forced commit fallback now coalesces duplicate block/cancel calls so a worker
  retry does not create misleading `command.rejected` chronicle noise.
- Wake diagnostics now label project write evidence generically as
  `projectWrites` because either `writeFile` or `replaceInFile` can satisfy it.
- Project write evidence now counts only successful edit tool results, and the
  forced commit fallback also runs when the worker only records non-advancing
  commands such as `append_note`.

### Changed

- `chronicle --text` now renders structured facts for diagnostics, forced
  commits, and progress rows instead of relying only on prose summaries.
- Default wake step budget increased from 6 to 12 so development workers have
  enough room to inspect, edit, and commit state in one small implementation
  wake.
- Development implement-stage instructions now prefer `replaceInFile` for
  localized edits and explicitly warn workers not to spend the wake only on
  inspection after the edit target is clear.

## 0.1.3 — 2026-06-01

### Changed

- Default CLI state now resolves to `~/.sikong` through `SIKONG_HOME`.
  Legacy `SIKONG_DIR` and `--dir` remain explicit store overrides.
- Project definitions and memory now write to `projects/<id>/project.yaml` and
  `projects/<id>/memory.md`.
- New task timelines and projections now write under
  `projects/<id>/state/`, while legacy flat state remains readable.
- No-state-command fallback passes now use stage policy: planning/design-style
  stages may commit workflow fields without project writes, while stages marked
  `requiresProjectWrite` still block without `writeFile` evidence.

## 0.1.2 — 2026-06-01

### Added

- Added the builtin `development` workflow with explicit plan, design,
  implement, and verify stages for general project work.

### Changed

- Worker discovery now reports provider, runtime, and compatibility facts
  without generating worker-creation suggestions.
- Worker-issued cancellation now records an approval request instead of
  immediately terminating the task.
- Workers that performed no project writes are prompted to block rather than
  claim completion during the commit fallback pass.

## 0.1.1 — 2026-06-01

### Added

- Added project markdown memory files that are loaded into worker prompts as bounded project context.
- Documented the global ~/.sikong home layout for projects, worktrees, memory, workers, and state.

### Changed

- Worker discovery now reports codex and cursor as visible but non-createable runtimes when they lack sikong tool capability.
- AI SDK wakes now require tool calls so workers cannot silently complete in plain text.

### Fixed

- Added a commit pass for workers that perform project-tool work but forget sikong state tools, and block fallback completion when no write evidence exists.
- Prevented stale transition.requested events from completing a task after block and unblock.

## 0.1.0 — 2026-06-01

Initial dogfood release. Published as a CLI-only package: a tiny cross-platform
launcher (`sikong`) plus per-platform binary packages (`sikong-<platform>`)
installed automatically as optional dependencies, with the `agent-loop` execution
layer compiled into each binary. Supported platforms: `darwin-arm64`,
`darwin-x64`, `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`,
`windows-x64`.

### Added

- Workflow definitions with staged state machines and schema-validated fields.
- Append-only JSONL event storage with projections and chronicle inspection.
- Project/worktree isolation and worker permission modes.
- Wake execution over `agent-loop` workers, including AI SDK project tools
  (`rg`, `readFile`, `writeFile`).
- Bun CLI for creating tasks, waking workers, and inspecting state
  (`help`, `overview`, `status`, `task`, `project`, `worker`, …).
- `SIKONG_DIR` / `--dir` override for the workspace directory (default
  `.sikong`).
