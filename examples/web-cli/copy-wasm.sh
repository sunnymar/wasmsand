#!/bin/bash
set -euo pipefail

FIXTURES="../../packages/orchestrator/src/platform/__tests__/fixtures"
OUT="public/wasm"

mkdir -p "$OUT"

# Shell executor (Rust WASM)
cp "$FIXTURES/codepod-shell-exec.wasm" "$OUT/"

# All coreutils + python
cp "$FIXTURES"/*.wasm "$OUT/"

echo "Copied $(ls "$OUT"/*.wasm | wc -l | tr -d ' ') wasm binaries to $OUT/"
du -sh "$OUT"
