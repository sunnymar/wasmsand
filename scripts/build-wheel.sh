#!/bin/bash
# Build a platform-specific Python wheel with bundled Bun and WASM binaries.
# Usage: scripts/build-wheel.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG="$ROOT/packages/python-sdk"
BUNDLED="$PKG/src/codepod/_bundled"

# Detect platform for Bun download
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux)  BUN_OS="linux" ;;
  darwin) BUN_OS="darwin" ;;
  *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) BUN_ARCH="x64" ;;
  aarch64|arm64) BUN_ARCH="aarch64" ;;
  *)             echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

BUN_ZIP="bun-${BUN_OS}-${BUN_ARCH}.zip"
BUN_VERSION="1.3.9"
BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ZIP}"

echo "=== Building server.js bundle ==="
bun build "$ROOT/packages/sdk-server/src/server.ts" \
  --bundle \
  --target=bun \
  --outfile="$BUNDLED/server.js"

echo "=== Copying WASM binaries ==="
"$SCRIPT_DIR/copy-wasm.sh" "$BUNDLED/wasm"

echo "=== Downloading Bun ${BUN_VERSION} for ${BUN_OS}-${BUN_ARCH} ==="
TMP_DL_DIR="$(mktemp -d)"
curl -fsSL "$BUN_URL" -o "$TMP_DL_DIR/$BUN_ZIP"
unzip -q "$TMP_DL_DIR/$BUN_ZIP" -d "$TMP_DL_DIR"
cp "$TMP_DL_DIR/bun-${BUN_OS}-${BUN_ARCH}/bun" "$BUNDLED/bun"
chmod +x "$BUNDLED/bun"
rm -rf "$TMP_DL_DIR"

echo "=== Building wheel ==="
cd "$PKG"

# Use a build venv to ensure 'build' module is available
BUILD_VENV="$ROOT/.build-venv"
if [ ! -d "$BUILD_VENV" ]; then
  python3 -m venv "$BUILD_VENV"
  "$BUILD_VENV/bin/pip" install --quiet build
fi
"$BUILD_VENV/bin/python" -m build --wheel

echo "=== Done ==="
ls -lh "$PKG/dist/"*.whl
