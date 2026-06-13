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
```

## Setup

```bash
bun install
```

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
```

This project was initialized with `go mod init sikong` and `bun init -y`, then configured as a Bun workspaces monorepo.
