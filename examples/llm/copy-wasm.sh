#!/bin/bash
set -euo pipefail

FIXTURES="../../packages/orchestrator/src/platform/__tests__/fixtures"
SHELL_FIXTURES="../../packages/orchestrator/src/shell/__tests__/fixtures"
OUT="public/wasm"

mkdir -p "$OUT"

cp "$SHELL_FIXTURES/codepod-shell-exec.wasm" "$OUT/"
cp "$FIXTURES"/*.wasm "$OUT/"

echo "Copied $(ls "$OUT"/*.wasm | wc -l | tr -d ' ') wasm binaries to $OUT/"
du -sh "$OUT"
