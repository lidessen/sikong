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

## Development

```bash
bun run dev:cli
bun run dev:daemon
bun --filter agent-loop test
```

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
