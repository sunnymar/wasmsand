#!/bin/bash
set -euo pipefail

FIXTURES="../orchestrator/src/platform/__tests__/fixtures"
SHELL_FIXTURES="../orchestrator/src/shell/__tests__/fixtures"
OUT="public/wasm"

mkdir -p "$OUT"

# Shell parser
cp "$SHELL_FIXTURES/wasmsand-shell.wasm" "$OUT/"

# Python
cp "$FIXTURES/python3.wasm" "$OUT/"

# Coreutils
for tool in cat echo head tail wc sort uniq grep ls mkdir rm cp mv touch tee tr cut basename dirname env printf find sed awk jq uname whoami id printenv yes rmdir sleep seq ln readlink realpath mktemp tac xargs expr diff; do
  cp "$FIXTURES/${tool}.wasm" "$OUT/"
done

# true/false have special filenames
cp "$FIXTURES/true-cmd.wasm" "$OUT/"
cp "$FIXTURES/false-cmd.wasm" "$OUT/"

echo "Copied $(ls "$OUT"/*.wasm | wc -l | tr -d ' ') wasm binaries to $OUT/"
du -sh "$OUT"
