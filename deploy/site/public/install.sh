#!/usr/bin/env sh
set -eu

REPO="${SIKONG_RELEASE_REPO:-lidessen/sikong}"
VERSION="${SIKONG_VERSION:-v0.2.0-beta.2}"
ASSET="sikong-darwin-arm64.tar.gz"

os="$(uname -s)"
arch="$(uname -m)"
if [ "$os" != "Darwin" ] || [ "$arch" != "arm64" ]; then
  echo "Sikong beta currently supports macOS arm64 only. Detected: $os $arch" >&2
  exit 1
fi

if [ "${SIKONG_RELEASE_BASE_URL:-}" ]; then
  base_url="${SIKONG_RELEASE_BASE_URL%/}"
elif [ "$VERSION" = "latest" ]; then
  base_url="https://github.com/$REPO/releases/latest/download"
else
  base_url="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp="${TMPDIR:-/tmp}/sikong-install.$$"
mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading Sikong $VERSION for macOS arm64..."
curl -fsSL "$base_url/$ASSET" -o "$tmp/$ASSET"
curl -fsSL "$base_url/$ASSET.sha256" -o "$tmp/$ASSET.sha256"

(
  cd "$tmp"
  shasum -a 256 -c "$ASSET.sha256"
  tar -xzf "$ASSET"
)

if [ "${SIKONG_INSTALL_DIR:-}" ]; then
  install_dir="$SIKONG_INSTALL_DIR"
  mkdir -p "$install_dir"
elif [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
  install_dir="/usr/local/bin"
else
  install_dir="$HOME/.sikong/bin"
  mkdir -p "$install_dir"
fi

cp "$tmp/sikong" "$install_dir/sikong"
chmod 755 "$install_dir/sikong"

echo "Installed Sikong to $install_dir/sikong"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    echo "Add this to your shell profile:"
    echo "  export PATH=\"$install_dir:\$PATH\""
    ;;
esac
echo "Start Sikong with:"
echo "  sikong start"
