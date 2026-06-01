# wakespace

Durable workspace layer over [`agent-loop`](../agent-loop) for agent-driven
project development.

`wakespace` is published as a CLI-only package. The `agent-loop` execution layer
is compiled into a single self-contained binary per platform. The published
`wakespace` package is a tiny cross-platform launcher; the actual binary ships in
a per-platform package (`wakespace-<platform>`) installed automatically as an
optional dependency gated by `os`/`cpu`/`libc`, so `npm install` pulls only the
one that matches your machine.

Supported platforms: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`,
`linux-x64-musl`, `linux-arm64-musl`, `windows-x64`.

The CLI provides a headless workflow engine with:

- workflow definitions with staged state machines and schema-validated fields
- append-only JSONL event storage plus projections and chronicle inspection
- project/worktree isolation and worker permission modes
- wake execution over `agent-loop` workers, including AI SDK project tools
- a Bun CLI for creating tasks, waking workers, and inspecting state

## CLI

```sh
bun run --filter wakespace build:cli
packages/wakespace/dist/wakespace help
```

After install:

```sh
wakespace help
```

The default workspace home is `~/.wakespace`. Override it with `WAKESPACE_HOME`.
The legacy `WAKESPACE_DIR` environment variable and CLI `--dir` flag still act
as explicit store overrides for tests, isolated smokes, and migration.

The normal home layout keeps user coordination state out of source checkouts:

```text
~/.wakespace/
  workers/<id>.yaml
  projects/<projectId>/project.yaml
  projects/<projectId>/memory.md
  projects/<projectId>/state/events/<taskId>.jsonl
  projects/<projectId>/state/projections/<taskId>.json
```

Agent-facing commands default to JSON. Use `--text` for ad-hoc human text on
commands such as `status`, `task`, `project list`, and `worker list`.

For a human-readable snapshot of projects, workers, tasks, and recent activity:

```sh
wakespace overview
```

## Live Smoke

```sh
cd packages/wakespace
DEEPSEEK_API_KEY=... bun run smoke:deepseek-tools
```

The smoke asks a real DeepSeek-backed AI SDK worker to use project tools
(`rg`, `readFile`, and `writeFile`) and then asserts both normalized tool events
and the filesystem side effect.

## Release

Releasing builds every platform binary, publishes each `wakespace-<platform>`
package, then publishes the `wakespace` launcher last (so its optional
dependencies already resolve). From `packages/wakespace`:

```sh
bun run release:dry   # build all platforms + npm publish --dry-run everywhere
bun run release       # build all platforms + publish for real (needs npm auth)
```

The platform matrix lives in `scripts/build-platforms.ts`; it stamps each
platform package with the launcher's version and fails if
`optionalDependencies` drift out of sync. Bump the version in both
`package.json` (version + each `optionalDependencies` entry) when cutting a
release. Run `bun run release:dry` before publishing.

## License

MIT
