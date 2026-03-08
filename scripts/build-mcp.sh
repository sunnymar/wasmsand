#!/usr/bin/env bash
set -euo pipefail

# Build a standalone codepod-mcp binary via esbuild + deno compile.
#
# Usage:
#   ./scripts/build-mcp.sh              # build for current platform
#   ./scripts/build-mcp.sh --target x86_64-unknown-linux-gnu   # cross-compile
#
# Output: dist/codepod-mcp (or dist/codepod-mcp.exe on Windows targets)

cd "$(dirname "$0")/.."

# Auto-detect deno
if [ -n "${DENO:-}" ]; then
  : # user-supplied
elif command -v deno &>/dev/null; then
  DENO="deno"
elif [ -x "$HOME/.deno/bin/deno" ]; then
  DENO="$HOME/.deno/bin/deno"
else
  echo "Error: deno not found. Install it: curl -fsSL https://deno.land/install.sh | sh"
  exit 1
fi
OUT_DIR="${OUT_DIR:-dist}"
TARGET_FLAG=""

for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET_FLAG="--target ${arg#--target=}" ;;
    --target)   shift; TARGET_FLAG="--target $1" ;;
  esac
done

mkdir -p "$OUT_DIR"

BUNDLE="$OUT_DIR/.codepod-mcp-bundle.mjs"

echo "==> Bundling with esbuild..."
npx esbuild packages/mcp-server/src/index.ts \
  --bundle --platform=node --format=esm \
  --outfile="$BUNDLE" \
  --log-level=warning

# deno compile requires node: prefix on builtins; esbuild leaves them bare.
echo "==> Fixing bare node imports..."
sed -i.bak -E '
  s|from "fs/promises"|from "node:fs/promises"|g
  s|from "fs"|from "node:fs"|g
  s|from "path"|from "node:path"|g
  s|from "url"|from "node:url"|g
  s|from "os"|from "node:os"|g
  s|from "events"|from "node:events"|g
  s|from "stream"|from "node:stream"|g
  s|from "buffer"|from "node:buffer"|g
  s|from "util"|from "node:util"|g
  s|from "crypto"|from "node:crypto"|g
  s|from "http"|from "node:http"|g
  s|from "https"|from "node:https"|g
  s|from "net"|from "node:net"|g
  s|from "tls"|from "node:tls"|g
  s|from "child_process"|from "node:child_process"|g
  s|from "worker_threads"|from "node:worker_threads"|g
  s|from "process"|from "node:process"|g
' "$BUNDLE"
rm -f "$BUNDLE.bak"

echo "==> Compiling with deno..."
# shellcheck disable=SC2086
"$DENO" compile -A --no-check \
  $TARGET_FLAG \
  -o "$OUT_DIR/codepod-mcp" \
  "$BUNDLE"

rm -f "$BUNDLE"

SIZE=$(du -h "$OUT_DIR/codepod-mcp" | cut -f1)
echo "==> Built: $OUT_DIR/codepod-mcp ($SIZE)"

# Generate .mcp.json at project root (one level up from codepod/)
PROJECT_ROOT="$(cd .. && pwd)"
CODEPOD_ROOT="$(pwd)"
WASM_DIR="$CODEPOD_ROOT/packages/orchestrator/src/platform/__tests__/fixtures"
MCP_JSON="$PROJECT_ROOT/.mcp.json"

cat > "$MCP_JSON" <<MCPEOF
{
  "mcpServers": {
    "sandbox": {
      "command": "$CODEPOD_ROOT/$OUT_DIR/codepod-mcp",
      "args": [
        "--wasm-dir", "$WASM_DIR",
        "--shell-wasm", "$WASM_DIR/codepod-shell-exec.wasm",
        "--mount", "$CODEPOD_ROOT:/mnt/src:ro",
        "--network-allow", "*"
      ]
    }
  }
}
MCPEOF

echo "==> Generated: $MCP_JSON"
