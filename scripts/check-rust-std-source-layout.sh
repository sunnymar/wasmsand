#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARED="$ROOT/patches/rust/codepod/codepod.rs"
SHARED_FS="$ROOT/patches/rust/codepod/fs.rs"

if [[ ! -f "$SHARED" ]]; then
  echo "missing shared Codepod std source: $SHARED" >&2
  exit 1
fi
if [[ ! -f "$SHARED_FS" ]]; then
  echo "missing shared Codepod fs source: $SHARED_FS" >&2
  exit 1
fi

for patch_dir in "$ROOT"/patches/rust/[0-9]*; do
  [[ -d "$patch_dir" ]] || continue
  if ! grep -R '#\[path = "codepod.rs"\]' "$patch_dir"/*.patch >/dev/null; then
    echo "patch set $(basename "$patch_dir") does not wire sibling codepod.rs" >&2
    exit 1
  fi
  if grep -R 'PathBuf::from("/tmp")' "$patch_dir"/*.patch >/dev/null; then
    echo "patch set $(basename "$patch_dir") contains inline Codepod implementation" >&2
    exit 1
  fi
  if grep -R '#\[path = "codepod_fs.rs"\]' "$patch_dir"/*.patch >/dev/null; then
    continue
  fi
done
