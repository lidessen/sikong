# agent-workspace

Monorepo for the agent-workspace stack. Bun workspaces; libraries ship `.ts`
source. The `agent-workspace` CLI can also be compiled to a standalone Bun
executable.

## Packages

| Package | Description |
| ------- | ----------- |
| [`packages/agent-loop`](packages/agent-loop) | The unified agent loop — **runtime ⊥ provider**. One call = one full loop over Claude Agent SDK / Codex / Cursor / Vercel AI SDK, plus the outer **task** (ralph) supervisor over many runs. |
| [`packages/agent-workspace`](packages/agent-workspace) | The workspace layer over `agent-loop` (multi-agent coordination). **Scope TBD — placeholder.** |

## Development

```sh
bun install
bun run build       # compiles packages/agent-workspace/dist/agent-workspace
bun run typecheck   # tsc --noEmit in every package
bun run test        # vitest in every package
```

Per-package (run inside a package dir, or with `--filter`):

```sh
bun run --filter agent-loop test
bun run --filter agent-loop typecheck
bun run --filter agent-workspace build:cli
```

## Design

The design entrypoint is [`design/README.md`](design/README.md). Durable design
decisions live in [`docs/decisions`](docs/decisions). Use a decision record for
core behavior, public contracts, data model semantics, persistence, runtime
boundaries, and long-term operational shape.

## License

MIT
