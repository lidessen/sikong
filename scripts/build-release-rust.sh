#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-${GITHUB_REF_NAME:-dev}}"
ASSET_NAME="siko-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m).tar.gz"
RELEASE_DIR="$ROOT/dist/release"

echo "Building siko v$VERSION for $(uname -s) $(uname -m)..."

cd "$ROOT"

mkdir -p "$RELEASE_DIR"

# Build Rust CLI
echo "  -> building siko (Rust CLI)..."
# Build with version tag if provided
VERSION_FLAG=""
if [ -n "$GITHUB_REF_NAME" ]; then
  VERSION_FLAG="$GITHUB_REF_NAME"
elif [ -n "$1" ]; then
  VERSION_FLAG="$1"
fi
if [ -n "$VERSION_FLAG" ]; then
  SIKO_VERSION="$VERSION_FLAG" cargo build --release --bin siko 2>&1 | tail -1
else
  cargo build --release --bin siko 2>&1 | tail -1
fi
RUST_BIN="$ROOT/target/release/siko"

# Build agent-host (Bun)
echo "  -> building siko-agent-host..."
bun run build:agent-host 2>&1 | tail -1
HOST_BIN="$ROOT/dist/siko-agent-host"

# Verify both exist
if [[ ! -x "$RUST_BIN" ]]; then echo "ERROR: siko binary not found at $RUST_BIN" >&2; exit 1; fi
if [[ ! -x "$HOST_BIN" ]]; then echo "ERROR: siko-agent-host not found at $HOST_BIN" >&2; exit 1; fi

# Package into release dir
cp "$RUST_BIN" "$RELEASE_DIR/siko"
cp "$HOST_BIN" "$RELEASE_DIR/siko-agent-host"
chmod +x "$RELEASE_DIR/siko" "$RELEASE_DIR/siko-agent-host"

# Create tarball
cd "$RELEASE_DIR"
tar -czf "$ASSET_NAME" siko siko-agent-host
shasum -a 256 "$ASSET_NAME" > "$ASSET_NAME.sha256"

echo ""
echo "Release ready:"
echo "  $RELEASE_DIR/siko          ($(du -h siko | cut -f1))"
echo "  $RELEASE_DIR/siko-agent-host ($(du -h siko-agent-host | cut -f1))"
echo "  $RELEASE_DIR/$ASSET_NAME"
echo "  $RELEASE_DIR/$ASSET_NAME.sha256"
