# Changelog

All notable changes to `wakespace` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

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
- Documented the global ~/.wakespace home layout for projects, worktrees, memory, workers, and state.

### Changed

- Worker discovery now reports codex and cursor as visible but non-createable runtimes when they lack wakespace tool capability.
- AI SDK wakes now require tool calls so workers cannot silently complete in plain text.

### Fixed

- Added a commit pass for workers that perform project-tool work but forget wakespace state tools, and block fallback completion when no write evidence exists.
- Prevented stale transition.requested events from completing a task after block and unblock.

## 0.1.0 — 2026-06-01

Initial dogfood release. Published as a CLI-only package: a tiny cross-platform
launcher (`wakespace`) plus per-platform binary packages (`wakespace-<platform>`)
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
- `WAKESPACE_DIR` / `--dir` override for the workspace directory (default
  `.wakespace`).
