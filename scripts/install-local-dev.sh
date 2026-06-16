#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-dev-local}"
TARGET="${SIKONG_LOCAL_BIN:-$HOME/.sikong/bin/sikong}"
RELEASE_BIN="$ROOT/dist/release/sikong"

sanitize_version() {
  local value="$1"
  value="${value//\//-}"
  value="${value//\\/-}"
  value="${value//:/-}"
  value="${value// /-}"
  printf '%s' "$value"
}

mkdir -p "$(dirname "$TARGET")"

bash "$ROOT/scripts/build-release-darwin-arm64.sh" "$VERSION"

if [[ ! -x "$RELEASE_BIN" ]]; then
  echo "local install: missing built binary: $RELEASE_BIN" >&2
  exit 1
fi

if [[ -e "$TARGET" ]]; then
  BACKUP="$TARGET.backup.$(date +%Y%m%d%H%M%S)"
  cp "$TARGET" "$BACKUP"
  echo "local install: backed up existing binary to $BACKUP"
fi

install -m 755 "$RELEASE_BIN" "$TARGET"

RUNTIME_DIR="$HOME/.sikong/runtime/$(sanitize_version "$VERSION")"
rm -rf "$RUNTIME_DIR"

echo "local install: installed $("$TARGET" --version) to $TARGET"
echo "local install: cleared runtime cache $RUNTIME_DIR"
echo "local install: restart running sikong services to use this build"
