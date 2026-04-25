#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BUILD_DIR="$REPO_ROOT/packages/guest-compat/build"
if [ -z "${WASI_SDK_PATH:-}" ]; then
  if [ -x "$REPO_ROOT/target/release/cpcc" ]; then
    WASI_SDK_PATH="$("$REPO_ROOT/target/release/cpcc" --print-sdk-path)"
  else
    echo "set WASI_SDK_PATH or build cpcc first" >&2
    exit 1
  fi
fi
NM="$WASI_SDK_PATH/bin/llvm-nm"

# (symbol, object-file) pairs. Each symbol must have a marker defined in
# the same object file.
pairs=(
  "dup2 codepod_unistd.o"
  "getgroups codepod_unistd.o"
  "sched_getaffinity codepod_sched.o"
  "sched_setaffinity codepod_sched.o"
  "sched_getcpu codepod_sched.o"
  "signal codepod_signal.o"
  "sigaction codepod_signal.o"
  "raise codepod_signal.o"
  "alarm codepod_signal.o"
  "sigemptyset codepod_signal.o"
  "sigfillset codepod_signal.o"
  "sigaddset codepod_signal.o"
  "sigdelset codepod_signal.o"
  "sigismember codepod_signal.o"
  "sigprocmask codepod_signal.o"
  "sigsuspend codepod_signal.o"
)

fail=0
for pair in "${pairs[@]}"; do
  sym="${pair% *}"
  obj="${pair#* }"
  path="$BUILD_DIR/$obj"
  if [ ! -f "$path" ]; then
    echo "missing object $path — run make objects first" >&2
    exit 1
  fi
  defined_sym="$("$NM" --defined-only "$path" | awk -v s="$sym" '$3 == s {print $3; exit}')"
  defined_marker="$("$NM" --defined-only "$path" | awk -v s="__codepod_guest_compat_marker_$sym" '$3 == s {print $3; exit}')"
  if [ -z "$defined_sym" ]; then
    echo "FAIL: $sym not defined in $obj" >&2; fail=1
  fi
  if [ -z "$defined_marker" ]; then
    echo "FAIL: __codepod_guest_compat_marker_$sym not defined in $obj" >&2; fail=1
  fi
done

[ "$fail" -eq 0 ] || exit 1
echo "markers OK"
