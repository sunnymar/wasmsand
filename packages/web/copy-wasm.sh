#!/bin/bash
set -euo pipefail

FIXTURES="../orchestrator/src/platform/__tests__/fixtures"
SHELL_FIXTURES="../orchestrator/src/shell/__tests__/fixtures"
OUT="public/wasm"

mkdir -p "$OUT"

# Shell parser
cp "$SHELL_FIXTURES/codepod-shell.wasm" "$OUT/"

# All coreutils + python
cp "$FIXTURES"/*.wasm "$OUT/"

echo "Copied $(ls "$OUT"/*.wasm | wc -l | tr -d ' ') wasm binaries to $OUT/"
du -sh "$OUT"
