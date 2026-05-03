#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
busybox_dir="$repo_root/packages/c-ports/busybox"
src_dir="$busybox_dir/src-shell"

if [[ ! -d "$src_dir/shell" ]]; then
  echo "BusyBox shell source not found at $src_dir/shell" >&2
  echo "Run: make -C packages/c-ports/busybox fetch-shell" >&2
  exit 1
fi

echo "# BusyBox ash process-path trace"
echo
echo "Source: packages/c-ports/busybox/src-shell"
echo

rg -n \
  '\b(fork|vfork|exec[lvpe]*|waitpid|wait4|spawn|run_applet|spawn_and_wait|wait_for_child)\b' \
  "$src_dir/shell" "$src_dir/libbb" \
  | sed "s|$repo_root/||"
