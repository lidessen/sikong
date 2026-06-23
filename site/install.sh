#!/usr/bin/env bash
# Sikong — curl-friendly install script
# Usage: curl -fsSL https://sikong.dev/install.sh | sh
set -euo pipefail

REPO="${SIKONG_REPO:-lidessen/sikong}"
VERSION="${SIKONG_VERSION:-latest}"
INSTALL_DIR="${SIKONG_INSTALL_DIR:-$HOME/.sikong/bin}"
BASE_URL="${SIKONG_BASE_URL:-https://github.com/$REPO/releases/latest}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

# Map arch names
case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

ASSET_NAME="siko-$OS-$ARCH.tar.gz"

echo "Installing Sikong ($OS/$ARCH)..."

mkdir -p "$INSTALL_DIR"
TMP_DIR=$(mktemp -d)
TAR_PATH="$TMP_DIR/$ASSET_NAME"

# Try GitHub releases first
if [ "$VERSION" = "latest" ]; then
  DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/$ASSET_NAME"
else
  DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET_NAME"
fi
echo "  -> downloading $ASSET_NAME..."
if ! curl -fsSL "$DOWNLOAD_URL" -o "$TAR_PATH" 2>/dev/null; then
  # Fall back to sikong.dev
  DOWNLOAD_URL="https://sikong.dev/releases/$ASSET_NAME"
  echo "  -> fallback: $DOWNLOAD_URL"
  curl -fsSL "$DOWNLOAD_URL" -o "$TAR_PATH"
fi

mkdir -p "$TMP_DIR/siko-install"
tar -xzf "$TAR_PATH" -C "$TMP_DIR/siko-install"

# Install binaries
install -m 755 "$TMP_DIR/siko-install/siko" "$INSTALL_DIR/siko"
install -m 755 "$TMP_DIR/siko-install/siko-agent-host" 2>/dev/null || true
# Install agent-host source (fallback for environments where compiled binary fails)
if [ -d "$TMP_DIR/siko-install/agent-host" ]; then
  mkdir -p "$INSTALL_DIR/agent-host"
  cp -r "$TMP_DIR/siko-install/agent-host/"* "$INSTALL_DIR/agent-host/"
fi

rm -rf "$TMP_DIR"

# Add to PATH if not already
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  SHELL_CONFIG="$HOME/.bashrc"
  case "$SHELL" in
    *zsh) SHELL_CONFIG="$HOME/.zshrc" ;;
    *fish) SHELL_CONFIG="$HOME/.config/fish/config.fish" ;;
  esac
  echo ""
  echo "  -> adding $INSTALL_DIR to PATH in $SHELL_CONFIG"
  echo "export PATH=\"\$PATH:$INSTALL_DIR\"" >> "$SHELL_CONFIG"
  echo "  -> run: export PATH=\"\$PATH:$INSTALL_DIR\""
fi

echo ""
echo "Sikong installed to $INSTALL_DIR/siko"
echo ""
echo "Quick start:"
echo "  siko setup                # Interactive configuration"
echo "  siko run \"analyze this\"    # Run a task through the assistant"
echo "  siko assistant --acp      # ACP server for external tools"
echo "  siko dogfood run          # Self-iteration loop"
echo ""
echo "Set your API key:"
echo "  export DEEPSEEK_API_KEY=sk-..."
echo "  export SIKONG_AGENT_HOST_WORKER=agent-loop  # Enable real agents"
