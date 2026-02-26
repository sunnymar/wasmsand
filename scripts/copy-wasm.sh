#!/bin/bash
# Copy WASM binaries from fixture directories to a target directory.
# Usage: scripts/copy-wasm.sh <target-dir>
set -euo pipefail

TARGET="${1:?Usage: copy-wasm.sh <target-dir>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES="$ROOT/packages/orchestrator/src/platform/__tests__/fixtures"
SHELL_FIXTURES="$ROOT/packages/orchestrator/src/shell/__tests__/fixtures"

mkdir -p "$TARGET"

# Shell parser
cp "$SHELL_FIXTURES/codepod-shell.wasm" "$TARGET/"

# All coreutils + python
cp "$FIXTURES"/*.wasm "$TARGET/"

echo "Copied $(ls "$TARGET"/*.wasm | wc -l | tr -d ' ') WASM binaries to $TARGET/"
