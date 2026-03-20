#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="$REPO_ROOT/target/wasm32-wasip1/release"
FIXTURES_DIR="$REPO_ROOT/packages/orchestrator/src/platform/__tests__/fixtures"

echo "Building document tools to wasm32-wasip1..."
cargo build \
  -p codepod-pdf-tools \
  -p codepod-xlsx-tools \
  --target wasm32-wasip1 \
  --release

echo ""
echo "Built document tool binaries:"
for tool in pdfinfo pdfunite pdfseparate xlsx2csv csv2xlsx; do
  if [[ -f "$TARGET_DIR/$tool.wasm" ]]; then
    size=$(du -h "$TARGET_DIR/$tool.wasm" | cut -f1)
    printf "  %-20s %s\n" "$tool.wasm" "$size"
  fi
done

if [[ "${1:-}" == "--copy-fixtures" ]]; then
  echo ""
  echo "Copying to test fixtures..."
  for tool in pdfinfo pdfunite pdfseparate xlsx2csv csv2xlsx; do
    cp "$TARGET_DIR/$tool.wasm" "$FIXTURES_DIR/$tool.wasm"
  done
  echo "Done."
fi
