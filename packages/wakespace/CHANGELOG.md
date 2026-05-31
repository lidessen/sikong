# Changelog

All notable changes to `wakespace` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

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
