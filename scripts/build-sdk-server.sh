#!/usr/bin/env bash
set -euo pipefail
# Build the codepod-server (wasmtime backend) binary.
# Usage: ./scripts/build-sdk-server.sh [--debug] [--engine wasmtime|deno]
#
# Output: dist/codepod-server  (wasmtime default)
#      or dist/codepod-server-deno  (deno engine)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

OUT_DIR="${OUT_DIR:-dist}"
PROFILE="release"
ENGINE="wasmtime"

for arg in "$@"; do
  case "$arg" in
    --engine=*) ENGINE="${arg#--engine=}" ;;
    --engine)   shift; ENGINE="$1" ;;
    --debug)    PROFILE="debug" ;;
  esac
done

mkdir -p "$OUT_DIR"

if [ "$ENGINE" = "wasmtime" ]; then
  echo "==> Building codepod-server (wasmtime)..."
  if [ "$PROFILE" = "release" ]; then
    cargo build -p sdk-server-wasmtime --release
    cp target/release/codepod-server "$OUT_DIR/codepod-server"
  else
    cargo build -p sdk-server-wasmtime
    cp target/debug/codepod-server "$OUT_DIR/codepod-server"
  fi
  SIZE=$(du -h "$OUT_DIR/codepod-server" | cut -f1)
  echo "==> Built: $OUT_DIR/codepod-server ($SIZE)"
elif [ "$ENGINE" = "deno" ]; then
  echo "==> Building codepod-server (deno)..."
  if [ -n "${DENO:-}" ]; then :
  elif command -v deno &>/dev/null; then DENO="deno"
  elif [ -x "$HOME/.deno/bin/deno" ]; then DENO="$HOME/.deno/bin/deno"
  else echo "Error: deno not found"; exit 1
  fi

  BUNDLE="$OUT_DIR/.codepod-sdk-bundle.mjs"
  (cd packages/kernel && "$DENO" task build 2>&1)
  npx esbuild packages/sdk-server/src/server.ts \
    --bundle --platform=node --format=esm --outfile="$BUNDLE" --log-level=warning
  "$DENO" compile -A --no-check -o "$OUT_DIR/codepod-server-deno" "$BUNDLE"
  rm -f "$BUNDLE"
  SIZE=$(du -h "$OUT_DIR/codepod-server-deno" | cut -f1)
  echo "==> Built: $OUT_DIR/codepod-server-deno ($SIZE)"
else
  echo "Error: unknown engine '$ENGINE'. Use wasmtime or deno." >&2
  exit 1
fi
