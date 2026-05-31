# Changelog

All notable changes to `wakespace` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-06-01

Initial dogfood release. Published as a CLI-only package: the npm artifact ships
the compiled `wakespace` executable with the `agent-loop` execution layer bundled
into the binary. Built for macOS arm64 (`darwin/arm64`).

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
