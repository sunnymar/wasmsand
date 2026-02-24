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
cp "$SHELL_FIXTURES/wasmsand-shell.wasm" "$TARGET/"

# Python
cp "$FIXTURES/python3.wasm" "$TARGET/"

# Coreutils
for tool in cat echo head tail wc sort uniq grep ls mkdir rm cp mv touch tee tr cut \
    basename dirname env printf find sed awk jq uname whoami id printenv yes rmdir \
    sleep seq ln readlink realpath mktemp tac xargs expr diff du; do
  cp "$FIXTURES/${tool}.wasm" "$TARGET/"
done

# true/false have special filenames
cp "$FIXTURES/true-cmd.wasm" "$TARGET/"
cp "$FIXTURES/false-cmd.wasm" "$TARGET/"

echo "Copied $(ls "$TARGET"/*.wasm | wc -l | tr -d ' ') WASM binaries to $TARGET/"
