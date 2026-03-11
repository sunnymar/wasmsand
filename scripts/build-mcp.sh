#!/usr/bin/env bash
set -euo pipefail

# Build a standalone codepod-mcp binary via esbuild + deno compile.
#
# Usage:
#   ./scripts/build-mcp.sh              # build for current platform
#   ./scripts/build-mcp.sh --target x86_64-unknown-linux-gnu   # cross-compile
#   ./scripts/build-mcp.sh --rebuild-python   # force rebuild python3.wasm
#
# Output: dist/codepod-mcp (or dist/codepod-mcp.exe on Windows targets)
#
# The script automatically builds python3.wasm with numpy support if it
# doesn't exist in the fixtures directory.

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
REBUILD_PYTHON=false
PYTHON_FEATURES="${PYTHON_FEATURES:-numpy,pil}"

for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET_FLAG="--target ${arg#--target=}" ;;
    --target)   shift; TARGET_FLAG="--target $1" ;;
    --rebuild-python) REBUILD_PYTHON=true ;;
  esac
done

# Build python3.wasm with native packages if needed
WASM_FIXTURES="packages/orchestrator/src/platform/__tests__/fixtures"
if [ "$REBUILD_PYTHON" = true ] || [ ! -f "$WASM_FIXTURES/python3.wasm" ]; then
  echo "==> Building python3.wasm (features: $PYTHON_FEATURES)..."
  bash packages/python/build.sh "$PYTHON_FEATURES"
else
  echo "==> python3.wasm exists ($(du -h "$WASM_FIXTURES/python3.wasm" | cut -f1)), skipping (use --rebuild-python to force)"
fi

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

echo "==> Embedding python-shims..."
# The bundled code resolves python-shims relative to import.meta.url (= dist/).
# Copy them next to the bundle so deno compile --include picks them up at the
# right relative path.
cp -R packages/orchestrator/src/network/python-shims "$OUT_DIR/python-shims"

echo "==> Embedding package python files..."
# The PackageRegistry resolves pythonDir relative to PACKAGES_ROOT, which is
# 3 levels up from packages/orchestrator/src/packages/ in the source tree.
# In the bundle (dist/.codepod-mcp-bundle.mjs), import.meta.dirname is dist/,
# so PACKAGES_ROOT = dist/../../../ which won't exist. We mirror the expected
# relative structure so the embedded FS works: packages/{name}/python/
INCLUDE_FLAGS="--include $OUT_DIR/python-shims"
for pkg_dir in numpy-rust pillow-rust matplotlib-py; do
  src="packages/$pkg_dir/python"
  if [ -d "$src" ]; then
    # Registry resolves: PACKAGES_ROOT + "numpy-rust/python" etc.
    # PACKAGES_ROOT = resolve(import.meta.dirname, '..', '..', '..')
    # With import.meta.dirname = embedded root, we need the files at
    # ../../../{pkg_dir}/python relative to where the code thinks it is.
    # Simpler: copy into dist/ and patch PACKAGES_ROOT after bundling.
    dest="$OUT_DIR/packages/$pkg_dir/python"
    mkdir -p "$dest"
    cp -R "$src"/* "$dest/"
    INCLUDE_FLAGS="$INCLUDE_FLAGS --include $OUT_DIR/packages/$pkg_dir"
  fi
done

# Patch PACKAGES_ROOT in the bundle to resolve relative to the dist/ directory
# instead of 3 levels up from the source packages/ path.
echo "==> Patching PACKAGES_ROOT for compiled binary..."
# In the esbuild bundle, import.meta.dirname resolves to the dist/ directory.
# We need PACKAGES_ROOT to point to dist/packages/ (where we copied the files).
# The original code: resolve(import.meta.dirname, '..', '..', '..')
# Replace with: resolve(import.meta.dirname, 'packages')
sed -i.bak 's|import\.meta\.dirname, "\.\.", "\.\.", "\.\."|import.meta.dirname, "packages"|g' "$BUNDLE"
rm -f "$BUNDLE.bak"

echo "==> Compiling with deno..."
# shellcheck disable=SC2086
"$DENO" compile -A --no-check \
  $TARGET_FLAG \
  $INCLUDE_FLAGS \
  -o "$OUT_DIR/codepod-mcp" \
  "$BUNDLE"

rm -rf "$OUT_DIR/python-shims" "$OUT_DIR/packages"

rm -f "$BUNDLE"

SIZE=$(du -h "$OUT_DIR/codepod-mcp" | cut -f1)
echo "==> Built: $OUT_DIR/codepod-mcp ($SIZE)"

# Generate .mcp.json in this project directory (where Claude Code reads it)
CODEPOD_ROOT="$(pwd)"
WASM_DIR="$CODEPOD_ROOT/packages/orchestrator/src/platform/__tests__/fixtures"
MCP_JSON="$CODEPOD_ROOT/.mcp.json"

cat > "$MCP_JSON" <<MCPEOF
{
  "mcpServers": {
    "sandbox": {
      "command": "$CODEPOD_ROOT/$OUT_DIR/codepod-mcp",
      "args": [
        "--wasm-dir", "$WASM_DIR",
        "--shell-wasm", "$WASM_DIR/codepod-shell-exec.wasm",
        "--packages", "$PYTHON_FEATURES",
        "--mount", "$CODEPOD_ROOT:/mnt/src:ro",
        "--network-allow", "*"
      ]
    }
  }
}
MCPEOF

echo "==> Generated: $MCP_JSON"
