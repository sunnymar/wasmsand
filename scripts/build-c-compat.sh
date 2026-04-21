#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/packages/guest-compat"

if [ "$#" -eq 0 ]; then
  set -- all
fi

make "$@"
