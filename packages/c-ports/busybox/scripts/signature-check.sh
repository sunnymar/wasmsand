#!/usr/bin/env bash
# Guest-compat implementation-signature check for busybox.wasm.
# Invoked by CI (Task 8) and by developers after `make -C packages/c-ports/busybox all`.
# Exits non-zero if any Tier 1 symbol in busybox.wasm routes to a
# wasi-libc stub instead of the codepod compat body (§Verifying Precedence,
# §Link-Order Regressions).  TIER1 is the authoritative list — see
# packages/guest-compat/toolchain/cpcc/src/lib.rs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
ARCHIVE="$REPO_ROOT/packages/guest-compat/build/libcodepod_guest_compat.a"
WASM="$REPO_ROOT/packages/c-ports/busybox/build/busybox.wasm"
CPCHECK="$REPO_ROOT/target/release/cpcheck"

if [[ ! -f "$ARCHIVE" ]]; then
  echo "signature-check: archive missing at $ARCHIVE — run \`make -C packages/guest-compat lib\`" >&2
  exit 2
fi
if [[ ! -f "$WASM" ]]; then
  echo "signature-check: busybox.wasm missing at $WASM — run \`make -C packages/c-ports/busybox all\`" >&2
  exit 2
fi
if [[ ! -x "$CPCHECK" ]]; then
  echo "signature-check: cpcheck missing — run \`cargo build --release -p cpcc-toolchain\`" >&2
  exit 2
fi

# §Verifying Precedence: cpcheck with no --symbol flags defaults to the
# full TIER1 list (packages/guest-compat/toolchain/cpcc/src/bin/cpcheck.rs:22).
# BusyBox links the archive with --whole-archive, so every Tier 1 marker
# must be present regardless of which symbols BusyBox source calls directly.
"$CPCHECK" --archive "$ARCHIVE" --pre-opt-wasm "$WASM"
