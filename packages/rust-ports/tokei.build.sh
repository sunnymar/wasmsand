#!/usr/bin/env bash
# Build tokei (unmodified upstream, packages/rust-ports/tokei submodule at
# v12.1.2) via cargo-codepod and verify the produced wasm passes §Verifying
# Precedence for all 16 Tier 1 symbols.
#
# Per §Package Validation Requirements the load-bearing claim is that
# upstream Cargo.toml was NOT edited. This script does not mutate the
# submodule's tree.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT_DIR="$REPO_ROOT/packages/rust-ports/tokei"
ARCHIVE="$REPO_ROOT/packages/guest-compat/build/libcodepod_guest_compat.a"
PRE_OPT_DIR="$REPO_ROOT/target/wasm32-wasip1/release/tokei-pre-opt"
CARGO_CODEPOD="$REPO_ROOT/target/release/cargo-codepod"
CPCHECK="$REPO_ROOT/target/release/cpcheck"

if [[ ! -f "$PORT_DIR/Cargo.toml" ]]; then
  echo "tokei.build: submodule not initialized; run \`git submodule update --init packages/rust-ports/tokei\`" >&2
  exit 2
fi
if [[ ! -x "$CARGO_CODEPOD" ]]; then
  echo "tokei.build: cargo-codepod missing; run \`cargo build --release -p cpcc-toolchain\`" >&2
  exit 2
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "tokei.build: archive missing; run \`make -C packages/guest-compat lib\`" >&2
  exit 2
fi

mkdir -p "$PRE_OPT_DIR"

# CARGO_TARGET_DIR intentionally NOT set to the repo root target/. Per
# §Repository Shape tokei is outside the workspace; using a dedicated target
# dir keeps its wasm outputs separate from codepod-owned ones and matches
# the spec's "without workspace wrapping."
TARGET_DIR="$REPO_ROOT/target/rust-ports/tokei"
mkdir -p "$TARGET_DIR"

echo "tokei.build: cargo-codepod codepod build --release (tokei v12.1.2)"
(
  cd "$PORT_DIR"
  env \
    CPCC_ARCHIVE="$ARCHIVE" \
    CPCC_PRESERVE_PRE_OPT="$PRE_OPT_DIR" \
    CARGO_TARGET_DIR="$TARGET_DIR" \
    "$CARGO_CODEPOD" codepod build --release
)

WASM="$TARGET_DIR/wasm32-wasip1/release/tokei.wasm"
PRE_OPT="$PRE_OPT_DIR/tokei.pre-opt.wasm"

if [[ ! -f "$WASM" ]]; then
  echo "tokei.build: expected $WASM not produced. Cargo's own output should show the actual path." >&2
  exit 1
fi
if [[ ! -f "$PRE_OPT" ]]; then
  echo "tokei.build: expected $PRE_OPT not preserved. Check CPCC_PRESERVE_PRE_OPT handling in cargo-codepod (src/bin/cargo-codepod.rs:91-104)." >&2
  exit 1
fi

echo "tokei.build: produced $WASM"
ls -lh "$WASM" "$PRE_OPT"

echo ""
echo "tokei.build: §Verifying Precedence — cpcheck on $PRE_OPT"
"$CPCHECK" --archive "$ARCHIVE" --pre-opt-wasm "$PRE_OPT"
echo "tokei.build: OK"
