#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE="${CPCC_ARCHIVE:-$REPO_ROOT/packages/guest-compat/build/libcodepod.a}"
BASH_WASM="${1:-$REPO_ROOT/packages/orchestrator/src/platform/__tests__/fixtures/bash.wasm}"
CPCHECK="$REPO_ROOT/target/release/cpcheck"

if [[ ! -f "$ARCHIVE" ]]; then
  echo "check-bash-libcodepod-link: archive missing at $ARCHIVE" >&2
  echo "  run: make -C packages/guest-compat lib" >&2
  exit 2
fi

if [[ ! -f "$BASH_WASM" ]]; then
  echo "check-bash-libcodepod-link: bash wasm missing at $BASH_WASM" >&2
  echo "  run: ./scripts/build-coreutils.sh --copy-fixtures" >&2
  exit 2
fi

if [[ ! -x "$CPCHECK" ]]; then
  cargo build --release -q -p cpcc-toolchain
fi

"$CPCHECK" --archive "$ARCHIVE" --pre-opt-wasm "$BASH_WASM"
