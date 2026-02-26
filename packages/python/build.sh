#!/bin/bash
set -euo pipefail

FEATURES="${1:-}"

rustup target add wasm32-wasip1 2>/dev/null || true

if [ -n "$FEATURES" ]; then
  cargo build --release --target wasm32-wasip1 -p codepod-python --features "$FEATURES"
else
  cargo build --release --target wasm32-wasip1 -p codepod-python
fi

cp target/wasm32-wasip1/release/python3.wasm \
   packages/orchestrator/src/platform/__tests__/fixtures/python3.wasm

echo "Built python3.wasm ($(du -h packages/orchestrator/src/platform/__tests__/fixtures/python3.wasm | cut -f1))"
