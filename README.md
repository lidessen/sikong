# WakeSpace

Monorepo for the WakeSpace stack. Bun workspaces; `agent-loop` ships `.ts`
source, while `wakespace` is published as a compiled CLI executable.

## Packages

| Package | Description |
| ------- | ----------- |
| [`packages/agent-loop`](packages/agent-loop) | The unified agent loop — **runtime ⊥ provider**. One call = one full loop over Claude Agent SDK / Codex / Cursor / Vercel AI SDK, plus the outer **task** (ralph) supervisor over many runs. |
| [`packages/wakespace`](packages/wakespace) | The durable workspace layer over `agent-loop`: workflow tasks, wake engine, project isolation, workers, CLI, and smokes. |

## Development

```sh
bun install
bun run build       # compiles packages/wakespace/dist/wakespace
bun run typecheck   # tsc --noEmit in every package
bun run test        # vitest in every package
```

Per-package (run inside a package dir, or with `--filter`):

```sh
bun run --filter agent-loop test
bun run --filter agent-loop typecheck
bun run --filter wakespace build:cli
```

## Design

The design entrypoint is [`design/README.md`](design/README.md). Durable design
decisions live in [`design/decisions`](design/decisions). Use a decision record for
core behavior, public contracts, data model semantics, persistence, runtime
boundaries, and long-term operational shape.

## License

MIT
