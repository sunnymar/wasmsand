#!/usr/bin/env bash
# cargo's `runner` for wasm32-wasip1 test binaries. Cargo invokes this as:
#   run-wasi-test.sh <wasm> [args...]
# where <wasm> is the freshly-built test binary.
#
# We post-link rewrite the wasm to replace panicky Rust stdlib functions
# with codepod-wasi-shims replacements, then invoke wasmtime. The
# rewritten wasm is placed next to the original with a .post.wasm suffix
# so inspecting the raw rustc output stays easy.
#
# NOTE on LTO: this package's release profile must NOT have LTO enabled
# (LTO specializes `fn() -> T` where the body always panics into noreturn
# `fn()` stubs, which have different wasm type signatures from our
# real-returning shims). The fix here is wrapper-invocation level: the
# user is expected to pass `CARGO_PROFILE_RELEASE_LTO=off` when running
# `cargo test --release` for this crate. See CI config for the same.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: run-wasi-test.sh <wasm> [args...]" >&2
  exit 2
fi

WASM="$1"
shift

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
POSTLINK="$REPO_ROOT/target/release/codepod-wasi-postlink"

if [[ ! -x "$POSTLINK" ]]; then
  echo "run-wasi-test.sh: codepod-wasi-postlink missing at $POSTLINK — \
run: cargo build --release -p codepod-wasi-postlink" >&2
  exit 2
fi

OUT="${WASM%.wasm}.post.wasm"
"$POSTLINK" --input "$WASM" --output "$OUT" --allow-missing

exec wasmtime run --dir=. --dir=/tmp "$OUT" -- "$@"
