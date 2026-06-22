#!/usr/bin/env bash
# Sikong — curl-friendly install script
# Usage: curl -fsSL https://sikong.dev/install.sh | sh
set -euo pipefail

REPO="${SIKONG_REPO:-sikong/sikong}"
VERSION="${SIKONG_VERSION:-latest}"
INSTALL_DIR="${SIKONG_INSTALL_DIR:-$HOME/.sikong/bin}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

# Map arch names
case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

# Fetch release info
if [ "$VERSION" = "latest" ]; then
  echo "  -> fetching latest release info..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
fi

ASSET_NAME="siko-$OS-$ARCH.tar.gz"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET_NAME"

echo "Installing Sikong $VERSION ($OS/$ARCH)..."
echo "  -> downloading $ASSET_NAME..."

mkdir -p "$INSTALL_DIR"
TMP_DIR=$(mktemp -d)
TAR_PATH="$TMP_DIR/$ASSET_NAME"

curl -fsSL "$DOWNLOAD_URL" -o "$TAR_PATH"
tar -xzf "$TAR_PATH" -C "$TMP_DIR"

# Install binaries
install -m 755 "$TMP_DIR/siko" "$INSTALL_DIR/siko"
install -m 755 "$TMP_DIR/siko-agent-host" "$INSTALL_DIR/siko-agent-host"

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
echo "Sikong $VERSION installed to $INSTALL_DIR/siko"
echo ""
echo "Quick start:"
echo "  siko assistant --acp     # Start ACP server (for external tool integration)"
echo "  siko assistant prompt --help"
echo "  siko dogfood run          # Run self-iteration loop"
echo ""
echo "Set your API key:"
echo "  export DEEPSEEK_API_KEY=sk-..."
echo "  export SIKONG_AGENT_HOST_WORKER=agent-loop  # Enable real agents"
