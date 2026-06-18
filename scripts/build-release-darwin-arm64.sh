#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-${GITHUB_REF_NAME:-dev}}"
ASSET_NAME="sikong-darwin-arm64.tar.gz"
ASSETS_DIR="$ROOT/internal/runtimebundle/assets"
RELEASE_DIR="$ROOT/dist/release"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "release:darwin-arm64 must run on macOS arm64" >&2
  exit 1
fi

cleanup() {
  rm -rf "$ASSETS_DIR/bin" "$ASSETS_DIR/client-dist"
  bun scripts/patch-cursor-sdk-standalone.ts restore >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
mkdir -p "$ASSETS_DIR/bin" "$RELEASE_DIR"

cd "$ROOT"

bun --filter @sikong/client build
bun scripts/patch-cursor-sdk-standalone.ts apply

bun build --compile packages/workspace/src/cli/index.ts \
  --outfile "$ASSETS_DIR/bin/sikong-workspace-cli"
bun build --compile packages/client/server/index.ts \
  --outfile "$ASSETS_DIR/bin/sikong-client-api"
bun build --compile packages/workspace/src/orchestration/runner.ts \
  --outfile "$ASSETS_DIR/bin/sikong-orchestration-runner"
bun build --compile packages/workspace/src/process/runner.ts \
  --outfile "$ASSETS_DIR/bin/sikong-process-runner"
bun build --compile packages/agent-host/src/runtime-host.ts \
  --outfile "$ASSETS_DIR/bin/siko-agent-host"

go build -o "$ASSETS_DIR/bin/sikongd" ./cmd/sikongd
cp -R packages/client/dist "$ASSETS_DIR/client-dist"

go build \
  -ldflags "-X sikong/internal/buildinfo.version=$VERSION" \
  -o "$RELEASE_DIR/sikong" \
  ./cmd/sikong

chmod +x "$RELEASE_DIR/sikong"
tar -C "$RELEASE_DIR" -czf "$RELEASE_DIR/$ASSET_NAME" sikong
(
  cd "$RELEASE_DIR"
  shasum -a 256 "$ASSET_NAME" > "$ASSET_NAME.sha256"
)

echo "$RELEASE_DIR/$ASSET_NAME"
echo "$RELEASE_DIR/$ASSET_NAME.sha256"
