#!/usr/bin/env bash
# Sync the root VERSION file into all generated version constants.
# Run this after editing VERSION, then commit the result.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(cat VERSION)"
echo "Syncing version: $VERSION"

# packages/orchestrator/src/version.ts
cat > packages/orchestrator/src/version.ts <<EOF
/** Codepod version. Updated by scripts/sync-version.sh from the root VERSION file. */
export const CODEPOD_VERSION = '$VERSION';
EOF
echo "  updated packages/orchestrator/src/version.ts"
