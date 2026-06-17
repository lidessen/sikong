#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${SIKONG_RUNTIME_DIR:-$HOME/.sikong/runtime/dev-local}"
TARGET="$RUNTIME_DIR/client-dist"

cd "$ROOT"
bun --filter @sikong/client build
mkdir -p "$TARGET"
rsync -a --delete packages/client/dist/ "$TARGET/"

echo "sync-client: updated $TARGET"
