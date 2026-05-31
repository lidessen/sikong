# wakespace

Durable workspace layer over [`agent-loop`](../agent-loop) for agent-driven
project development.

`wakespace` is published as a CLI-only package. The npm artifact contains the
compiled `wakespace` executable, with the `agent-loop` execution layer bundled
into that binary.

The initial dogfood package is built for macOS arm64 (`darwin/arm64`).

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

The default workspace directory is `.wakespace`. Override it with
`WAKESPACE_DIR` or the CLI `--dir` flag.

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

From the repository root:

```sh
bun run release:check
cd packages/wakespace
npm publish
```

`release:check` runs typecheck, tests, build, whitespace checks, and
`npm publish --dry-run`.

## License

MIT
