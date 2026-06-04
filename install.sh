#!/bin/sh
# sikong installer — curl -fsSL https://sikong.dev/install.sh | sh
#
# Detects your OS/arch/libc, downloads the matching prebuilt `sikong` binary from
# GitHub Releases, and installs it to a bin directory on your PATH. No build step,
# no Node/npm required — the binary is a self-contained Bun executable.
#
# Env overrides:
#   SIKONG_VERSION=v0.1.7   pin a release tag (default: latest)
#   SIKONG_INSTALL_DIR=...  install location (default: ~/.local/bin, then /usr/local/bin)
#   SIKONG_REPO=owner/name  source repo (default: lidessen/sikong)
set -eu

REPO="${SIKONG_REPO:-lidessen/sikong}"
VERSION="${SIKONG_VERSION:-latest}"

err() { printf 'sikong-install: %s\n' "$1" >&2; exit 1; }
info() { printf '%s\n' "$1" >&2; }

# --- detect platform key (mirrors packages/sikong/scripts/build-platforms.ts) ---
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os_key="darwin" ;;
  Linux)  os_key="linux" ;;
  *) err "unsupported OS: $os (Windows: download the .zip from https://github.com/$REPO/releases)" ;;
esac

case "$arch" in
  arm64|aarch64) arch_key="arm64" ;;
  x86_64|amd64)  arch_key="x64" ;;
  *) err "unsupported architecture: $arch" ;;
esac

libc_suffix=""
if [ "$os_key" = "linux" ]; then
  # musl (Alpine) vs glibc: ldd's banner names the implementation.
  if ldd --version 2>&1 | grep -qi musl; then
    libc_suffix="-musl"
  fi
fi

key="${os_key}-${arch_key}${libc_suffix}"
asset="sikong-${key}.tar.gz"

# --- resolve download URL (GitHub Releases, or a SIKONG_BASE_URL mirror) ---
if [ -n "${SIKONG_BASE_URL:-}" ]; then
  url="${SIKONG_BASE_URL%/}/${asset}"
elif [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

# --- fetch + extract ---
command -v tar >/dev/null 2>&1 || err "tar is required"
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  err "need curl or wget to download"
fi

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t sikong)"
trap 'rm -rf "$tmp"' EXIT INT TERM

info "Downloading sikong (${key}, ${VERSION}) ..."
fetch "$url" "$tmp/$asset" || err "download failed: $url
(no release asset yet? see https://github.com/$REPO/releases)"
tar -xzf "$tmp/$asset" -C "$tmp" || err "extract failed"
[ -f "$tmp/sikong" ] || err "archive did not contain a 'sikong' binary"
chmod +x "$tmp/sikong"

# --- choose an install dir on PATH (no sudo unless the dir needs it) ---
if [ -n "${SIKONG_INSTALL_DIR:-}" ]; then
  install_dir="$SIKONG_INSTALL_DIR"
elif [ -w "/usr/local/bin" ] && printf '%s' "$PATH" | grep -q "/usr/local/bin"; then
  install_dir="/usr/local/bin"
else
  install_dir="$HOME/.local/bin"
fi
mkdir -p "$install_dir" 2>/dev/null || err "cannot create $install_dir"

dest="$install_dir/sikong"
if mv "$tmp/sikong" "$dest" 2>/dev/null; then
  :
elif command -v sudo >/dev/null 2>&1; then
  info "Elevating to write $dest ..."
  sudo mv "$tmp/sikong" "$dest" || err "install failed"
else
  err "cannot write $dest (set SIKONG_INSTALL_DIR to a writable dir)"
fi

info ""
info "sikong installed to $dest"
case ":$PATH:" in
  *":$install_dir:"*) info "Run: sikong help" ;;
  *)
    info "Add it to your PATH, e.g.:"
    info "  echo 'export PATH=\"$install_dir:\$PATH\"' >> ~/.zshrc && exec \$SHELL"
    info "Then run: sikong help"
    ;;
esac
