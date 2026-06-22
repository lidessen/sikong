#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Building release..."
bash scripts/build-release-rust.sh 2>&1 | tail -3

echo "Copying artifacts to site/releases/"
mkdir -p site/releases
cp dist/release/siko-darwin-arm64.tar.gz site/releases/
cp dist/release/siko-darwin-arm64.tar.gz.sha256 site/releases/
cp dist/release/siko site/releases/siko-darwin-arm64 2>/dev/null || true
cp dist/release/siko-agent-host site/releases/siko-agent-host-darwin-arm64 2>/dev/null || true
cp scripts/install.sh site/install.sh
chmod +x site/install.sh

echo ""
echo "Site ready at site/"
echo "  site/index.html"
echo "  site/install.sh"
echo "  site/releases/siko-darwin-arm64.tar.gz"
echo ""
echo "To deploy to sikong.dev:"
echo "  rsync -avz site/ user@sikong.dev:/var/www/sikong/"
echo "  # or deploy via your hosting provider"
