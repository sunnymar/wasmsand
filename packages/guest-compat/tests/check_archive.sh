#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ARCHIVE="$REPO_ROOT/packages/guest-compat/build/libcodepod_guest_compat.a"
if [ -z "${WASI_SDK_PATH:-}" ]; then
  if [ -x "$REPO_ROOT/target/release/cpcc" ]; then
    WASI_SDK_PATH="$("$REPO_ROOT/target/release/cpcc" --print-sdk-path)"
  else
    echo "set WASI_SDK_PATH or build cpcc first" >&2
    exit 1
  fi
fi
AR="$WASI_SDK_PATH/bin/llvm-ar"
NM="$WASI_SDK_PATH/bin/llvm-nm"

[ -f "$ARCHIVE" ] || { echo "missing $ARCHIVE" >&2; exit 1; }

contents="$("$AR" t "$ARCHIVE")"
for want in codepod_command.o codepod_sched.o codepod_signal.o codepod_unistd.o codepod_version.o; do
  if ! echo "$contents" | grep -qx "$want"; then
    echo "archive missing $want (contains: $contents)" >&2
    exit 1
  fi
done

# Every Tier 1 symbol and its marker must be defined somewhere in the
# archive (llvm-nm on the whole archive).
tier1=(dup2 getgroups sched_getaffinity sched_setaffinity sched_getcpu \
       signal sigaction raise alarm \
       sigemptyset sigfillset sigaddset sigdelset sigismember \
       sigprocmask sigsuspend)
nm_out="$("$NM" --defined-only "$ARCHIVE")"

fail=0
for s in "${tier1[@]}"; do
  if ! echo "$nm_out" | awk '{print $NF}' | grep -qx "$s"; then
    echo "archive missing definition of $s" >&2
    fail=1
  fi
  if ! echo "$nm_out" | awk '{print $NF}' | grep -qx "__codepod_guest_compat_marker_$s"; then
    echo "archive missing marker __codepod_guest_compat_marker_$s" >&2
    fail=1
  fi
done

# Version sentinel.
if ! echo "$nm_out" | awk '{print $NF}' | grep -qx codepod_guest_compat_version; then
  echo "archive missing codepod_guest_compat_version" >&2
  fail=1
fi

[ $fail -eq 0 ] || exit 1
echo "archive OK"
