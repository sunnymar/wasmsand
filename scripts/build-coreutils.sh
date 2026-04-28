#!/bin/bash
set -euo pipefail

# Build all coreutils + shell to wasm32-wasip1.
# Usage:
#   ./scripts/build-coreutils.sh [--engine=cargo|cargo-codepod] [--copy-fixtures]
#
# Engines (§Toolchain Integration > Rust Toolchain):
#   cargo         — plain cargo, wasm32-wasip1, no compat archive. Historical
#                   default; preserved for bisect and emergency fallback.
#   cargo-codepod — the Phase A wrapper. Injects --whole-archive of
#                   libcodepod_guest_compat.a via RUSTFLAGS, exports Tier 1
#                   markers, preserves pre-opt wasms for cpcheck, runs wasm-opt.
#                   Applied to codepod-coreutils, true-cmd-wasm, false-cmd-wasm.
#
# codepod-shell-exec is NEVER routed through cargo-codepod: it's the host-side
# shell runtime (exports __run_command / __alloc / __dealloc), not a consumer
# of libcodepod_guest_compat.a. Routing it through cargo-codepod would inject
# --whole-archive of the 16 Tier 1 symbols and drop __run_command — breaking
# every sandbox test. Shell-exec always builds with plain cargo.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="$REPO_ROOT/target/wasm32-wasip1/release"
FIXTURES_DIR="$REPO_ROOT/packages/orchestrator/src/platform/__tests__/fixtures"
SHELL_FIXTURES_DIR="$REPO_ROOT/packages/orchestrator/src/shell/__tests__/fixtures"
ARCHIVE="$REPO_ROOT/packages/guest-compat/build/libcodepod_guest_compat.a"
PRE_OPT_DIR="$REPO_ROOT/target/wasm32-wasip1/release/coreutils-pre-opt"

ENGINE="cargo-codepod"
COPY_FIXTURES=0
for arg in "$@"; do
  case "$arg" in
    --engine=*) ENGINE="${arg#--engine=}" ;;
    --copy-fixtures) COPY_FIXTURES=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

case "$ENGINE" in
  cargo|cargo-codepod) ;;
  *) echo "--engine must be cargo or cargo-codepod (got: $ENGINE)" >&2; exit 2 ;;
esac

echo "Building coreutils + test fixtures to wasm32-wasip1 (engine=$ENGINE)..."

if [[ "$ENGINE" == "cargo-codepod" ]]; then
  # Ensure the wrapper and archive exist.
  cargo build --release -p cpcc-toolchain
  make -C "$REPO_ROOT/packages/guest-compat" lib
  mkdir -p "$PRE_OPT_DIR"
  # §Override And Link Precedence > Link Order Rust frontend: cargo-codepod
  # reads CPCC_ARCHIVE and CPCC_PRESERVE_PRE_OPT. Setting the preserve dir
  # is load-bearing for Task 5's signature check.
  env \
    CPCC_ARCHIVE="$ARCHIVE" \
    CPCC_PRESERVE_PRE_OPT="$PRE_OPT_DIR" \
    CPCC_WASM_OPT_FLAGS="-O2 --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int --enable-mutable-globals" \
    CARGO_TARGET_DIR="$REPO_ROOT/target" \
    "$REPO_ROOT/target/release/cargo-codepod" codepod build --release \
      -p codepod-coreutils \
      -p true-cmd-wasm \
      -p false-cmd-wasm
else
  cargo build \
    -p codepod-coreutils \
    -p true-cmd-wasm \
    -p false-cmd-wasm \
    --target wasm32-wasip1 \
    --release
fi

# codepod-shell-exec always builds via plain cargo — it is the host runtime,
# not a consumer of the guest-compat library. See header comment.
echo "Building codepod-shell-exec to wasm32-wasip1 (plain cargo, always)..."
cargo build \
  -p codepod-shell-exec \
  --target wasm32-wasip1 \
  --release

echo ""
echo "Built binaries:"
ls -lh "$TARGET_DIR"/*.wasm 2>/dev/null | while read line; do
  size=$(echo "$line" | awk '{print $5}')
  name=$(echo "$line" | awk '{print $NF}' | xargs basename)
  printf "  %-30s %s\n" "$name" "$size"
done

if [[ "$COPY_FIXTURES" -eq 1 ]]; then
  echo ""
  echo "Copying to test fixtures..."

  # Tools removed from this list because they're now provided by
  # upstream c-ports (packages/c-ports/) instead of Rust standalones:
  #   - jq, file → packages/c-ports/{jq,file}/
  #   - csplit, fmt, join, numfmt, sha224sum, sha384sum →
  #     packages/c-ports/coreutils/
  # Their fixtures are deployed by the corresponding c-port's
  # `make copy-fixtures` and tracked in git directly.
  TOOLS=(cat echo head tail wc sort uniq grep ls mkdir rm cp mv touch tee tr cut basename dirname env printf find sed awk du df gzip tar bc dc hostname base64 sha256sum sha1sum sha512sum md5sum stat xxd rev nproc fold nl expand unexpand paste comm split strings od cksum truncate tree patch column cmp timeout zip unzip arch factor shuf sum link unlink base32 dd tsort nice nohup hostid uptime chown chgrp sudo groups logname users who)
  for tool in "${TOOLS[@]}"; do
    cp "$TARGET_DIR/$tool.wasm" "$FIXTURES_DIR/$tool.wasm"
  done

  cp "$TARGET_DIR/true-cmd-wasm.wasm" "$FIXTURES_DIR/true-cmd.wasm"
  cp "$TARGET_DIR/false-cmd-wasm.wasm" "$FIXTURES_DIR/false-cmd.wasm"
  cp "$TARGET_DIR/codepod-shell-exec.wasm" "$SHELL_FIXTURES_DIR/codepod-shell-exec.wasm"
  cp "$TARGET_DIR/codepod-shell-exec.wasm" "$FIXTURES_DIR/codepod-shell-exec.wasm"

  if command -v wasm-opt &>/dev/null; then
    echo ""
    echo "Building codepod-shell-exec-asyncify.wasm via wasm-opt --asyncify..."
    wasm-opt "$TARGET_DIR/codepod-shell-exec.wasm" \
      --asyncify \
      --enable-bulk-memory \
      --enable-nontrapping-float-to-int \
      --enable-sign-ext \
      --enable-mutable-globals \
      --pass-arg=asyncify-imports@codepod.host_waitpid,codepod.host_yield,codepod.host_network_fetch,codepod.host_register_tool,codepod.host_run_command,wasi_snapshot_preview1.fd_read,wasi_snapshot_preview1.fd_write,wasi_snapshot_preview1.poll_oneoff \
      -O1 \
      -o "$FIXTURES_DIR/codepod-shell-exec-asyncify.wasm"
    cp "$FIXTURES_DIR/codepod-shell-exec-asyncify.wasm" "$SHELL_FIXTURES_DIR/codepod-shell-exec-asyncify.wasm"
    echo "  codepod-shell-exec-asyncify.wasm built."
  else
    echo "WARNING: wasm-opt not found — skipping asyncify build."
  fi

  echo "Done."
fi
