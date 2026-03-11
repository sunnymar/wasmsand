#!/bin/bash
set -euo pipefail

# Build sips image tool to wasm32-wasip1
# Usage: ./scripts/build-sips.sh [--copy-fixtures]

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIPS_DIR="$REPO_ROOT/packages/sips"
TARGET_DIR="$SIPS_DIR/target/wasm32-wasip1/release"
FIXTURES_DIR="$REPO_ROOT/packages/orchestrator/src/platform/__tests__/fixtures"

echo "Building sips to wasm32-wasip1..."
cargo build \
  --manifest-path "$SIPS_DIR/Cargo.toml" \
  --target wasm32-wasip1 \
  --release

echo ""
ls -lh "$TARGET_DIR/sips.wasm"

if [[ "${1:-}" == "--copy-fixtures" ]]; then
  echo ""
  echo "Copying sips.wasm to test fixtures..."
  cp "$TARGET_DIR/sips.wasm" "$FIXTURES_DIR/sips.wasm"
  echo "Done."
fi
