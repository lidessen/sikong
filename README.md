# sikong

Sikong is initialized as a Go CLI and daemon project with a Bun workspace monorepo.

## Layout

```text
.
├── cmd/
│   ├── sikong/   # CLI binary
│   └── sikongd/  # daemon binary
├── internal/     # private Go packages shared by commands
└── packages/     # Bun workspaces
    ├── agent-loop/
    └── workspace/
```

## Setup

```bash
bun install
```

## Beta Install

```bash
curl -fsSL https://sikong.dev/install.sh | sh
sikong start
```

The beta installer currently supports macOS arm64. `sikong start` launches the
local daemon and web UI by default; `sikong stop` stops them.

If the UI reports a network error, collect the local daemon/UI logs with:

```bash
sikong logs --lines 200
sikong logs --ui --follow
```

## Development

```bash
bun run dev:cli
bun run dev:daemon
bun --filter agent-loop test
```

Client UI shadcn components live under `packages/client/src/components/ui`.
Add shadcn components with the official CLI from the client workspace:

```bash
cd packages/client
bunx --bun shadcn@latest info --json
bunx --bun shadcn@latest add dialog
```

Use `--dry-run` or `--diff` before replacing an existing component.

## Checks

```bash
bun run check
bun run typecheck
bun run lint
bun run fmt:check
```

## Build

```bash
bun run build
bun run release:darwin-arm64
```

## Design

Start with [design/README.md](design/README.md). The current rewrite treats old
`sikong-old/packages/sikong` code as source material, not as a package to copy
back wholesale.

This project was initialized with `go mod init sikong` and `bun init -y`, then configured as a Bun workspaces monorepo.
