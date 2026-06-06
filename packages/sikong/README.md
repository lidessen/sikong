# sikong

Durable workspace layer over [`agent-loop`](../agent-loop) for agent-driven
project development.

`sikong` is published as a CLI-only package. The `agent-loop` execution layer
is compiled into a single self-contained binary per platform. The published
`sikong` package is a tiny cross-platform launcher; the actual binary ships in
a per-platform package (`sikong-<platform>`) installed automatically as an
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
bun run --filter sikong build:cli
packages/sikong/dist/sikong help
```

After install:

```sh
sikong help
```

The default workspace home is `~/.sikong`. Override it with `SIKONG_HOME`.
The legacy `SIKONG_DIR` environment variable and CLI `--dir` flag still act
as explicit store overrides for tests, isolated smokes, and migration.

The normal home layout keeps user coordination state out of source checkouts:

```text
~/.sikong/
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
sikong overview
```

To coordinate with a concurrently running wake without streaming `run`, wait
for the next chronicle event:

```sh
sikong inspect wait --task <taskId> --timeout 30000
```

When a task is too broad, split a narrower child task and let the lead merge
accepted fields back into the parent:

```sh
sikong create "small bounded change" --parent <parentTaskId> --workflow general
sikong submit <taskId> transition "accepted"
```

## Live Smoke

```sh
cd packages/sikong
DEEPSEEK_API_KEY=... bun run smoke:deepseek-tools
```

The smoke asks a real DeepSeek-backed AI SDK worker to use project tools
(`rg`, `readFile`, and `writeFile`) and then asserts both normalized tool events
and the filesystem side effect.

## Release

Before replacing a local stable dogfood binary or preparing a public release,
generate promotion evidence for the candidate:

```sh
bun run promotion:evidence
```

The script builds `dist/sikong-candidate`, runs the repository typecheck/tests,
runs `git diff --check`, self-smokes the candidate binary, and writes JSON +
Markdown evidence under `promotion-evidence/` at the repository root. It does
not replace the local stable binary and does not publish anything. Evidence is
recorded with repo-relative paths so it can be reviewed without leaking the
builder's local checkout path; the lead must review it and explicitly accept or
reject the candidate first.

After lead acceptance, install the candidate as local stable:

```sh
bun run promotion:install-local -- --evidence promotion-evidence/<file>.json --accepted-by <lead>
```

The install step machine-validates that evidence checks all passed, the evidence
was generated from a clean git status, the evidence sha matches the current HEAD,
the candidate binary hash matches, and recorded paths are repo-relative. It then copies the candidate to
`${SIKONG_HOME:-~/.sikong}/local-stable/versions/...`, atomically updates the
`current` symlink, and writes a receipt. It still does not publish anything.

Releasing builds every platform binary, publishes each `sikong-<platform>`
package, then publishes the `sikong` launcher last (so its optional
dependencies already resolve). From `packages/sikong`:

```sh
bun run release:dry   # build all platforms + npm publish --dry-run everywhere
NPM_TOKEN=... bun run release
```

The script performs `npm whoami` with the same auth config before any real
publish. If `NPM_TOKEN` is loaded only when your shell starts at the repository
root, run the release from the root with an explicit environment override:

```sh
NPM_TOKEN="$NPM_TOKEN" bun --cwd packages/sikong scripts/release.ts
```

The platform matrix lives in `scripts/build-platforms.ts`; it stamps each
platform package with the launcher's version and fails if
`optionalDependencies` drift out of sync. Bump the version in both
`package.json` (version + each `optionalDependencies` entry) when cutting a
release. Run `bun run release:dry` before publishing.

When publishing from this monorepo, do not rely on npm discovering a local
`.npmrc` from generated package directories. The release script maps `NPM_TOKEN`
to a temporary `NPM_CONFIG_USERCONFIG` file and passes that config explicitly to
each `npm publish` child process, then removes it. This avoids the recurring
case where `npm whoami` succeeds in one directory but platform-package publish
fails with auth/404 errors.

## License

MIT
