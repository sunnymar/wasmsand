#!/usr/bin/env bash
# Build grex (unmodified upstream, packages/rust-ports/grex submodule) via
# cargo-codepod and verify the produced wasm passes §Verifying Precedence
# for all 16 Tier 1 symbols.
#
# grex has a cdylib lib target with wasm-bindgen for wasm family targets;
# the wasi-sdk clang linker can't produce the cdylib (missing _initialize).
# CPCC_NO_CLANG_LINKER=1 tells cargo-codepod to let rust-lld handle the
# link. RUSTFLAGS (--whole-archive + Tier 1 --export) still apply, so
# §Override And Link Precedence holds.
#
# Per §Package Validation Requirements the load-bearing claim is that
# upstream Cargo.toml was NOT edited. This script does not mutate the
# submodule's tree.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT_DIR="$REPO_ROOT/packages/rust-ports/grex"
ARCHIVE="$REPO_ROOT/packages/guest-compat/build/libcodepod_guest_compat.a"
PRE_OPT_DIR="$REPO_ROOT/target/wasm32-wasip1/release/grex-pre-opt"
CARGO_CODEPOD="$REPO_ROOT/target/release/cargo-codepod"
CPCHECK="$REPO_ROOT/target/release/cpcheck"

if [[ ! -f "$PORT_DIR/Cargo.toml" ]]; then
  echo "grex.build: submodule not initialized; run \`git submodule update --init packages/rust-ports/grex\`" >&2
  exit 2
fi
if [[ ! -x "$CARGO_CODEPOD" ]]; then
  echo "grex.build: cargo-codepod missing; run \`cargo build --release -p cpcc-toolchain\`" >&2
  exit 2
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "grex.build: archive missing; run \`make -C packages/guest-compat lib\`" >&2
  exit 2
fi

mkdir -p "$PRE_OPT_DIR"
TARGET_DIR="$REPO_ROOT/target/rust-ports/grex"
mkdir -p "$TARGET_DIR"

echo "grex.build: cargo-codepod codepod build --release --bin grex"
(
  cd "$PORT_DIR"
  env \
    CPCC_ARCHIVE="$ARCHIVE" \
    CPCC_PRESERVE_PRE_OPT="$PRE_OPT_DIR" \
    CPCC_NO_CLANG_LINKER=1 \
    CARGO_TARGET_DIR="$TARGET_DIR" \
    "$CARGO_CODEPOD" codepod build --release --bin grex
)

WASM="$TARGET_DIR/wasm32-wasip1/release/grex.wasm"
PRE_OPT="$PRE_OPT_DIR/grex.pre-opt.wasm"

if [[ ! -f "$WASM" ]]; then
  echo "grex.build: expected $WASM not produced" >&2
  exit 1
fi
if [[ ! -f "$PRE_OPT" ]]; then
  echo "grex.build: expected $PRE_OPT not preserved. Check CPCC_PRESERVE_PRE_OPT handling in cargo-codepod." >&2
  exit 1
fi

echo "grex.build: produced $WASM"
ls -lh "$WASM" "$PRE_OPT"

echo ""
echo "grex.build: §Verifying Precedence — cpcheck on $PRE_OPT"
"$CPCHECK" --archive "$ARCHIVE" --pre-opt-wasm "$PRE_OPT"
echo "grex.build: OK"
