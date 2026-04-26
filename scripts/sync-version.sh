#!/usr/bin/env bash
# Sync the root VERSION file into all generated version constants.
# Run this after editing VERSION, then commit the result.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(cat VERSION)"
echo "Syncing version: $VERSION"

# Parse semver into major.minor.patch — used by the C-side header.
IFS='.' read -r MAJOR MINOR PATCH <<<"$VERSION"
: "${MAJOR:?VERSION missing major component}"
: "${MINOR:?VERSION missing minor component}"
: "${PATCH:?VERSION missing patch component}"

# packages/orchestrator/src/version.ts
cat > packages/orchestrator/src/version.ts <<EOF
/** Codepod version. Updated by scripts/sync-version.sh from the root VERSION file. */
export const CODEPOD_VERSION = '$VERSION';
EOF
echo "  updated packages/orchestrator/src/version.ts"

# packages/guest-compat/include/codepod_compat.h — the four
# CODEPOD_VERSION_* macros (string + numeric major/minor/patch).  The
# CODEPOD_GUEST_COMPAT_VERSION_* macros are the ABI version and
# tracked separately, so we leave them alone.
COMPAT_HEADER=packages/guest-compat/include/codepod_compat.h
sed -i.bak \
  -e "s|^#define CODEPOD_VERSION_STR .*|#define CODEPOD_VERSION_STR    \"$VERSION\"|" \
  -e "s|^#define CODEPOD_VERSION_MAJOR .*|#define CODEPOD_VERSION_MAJOR  ${MAJOR}u|" \
  -e "s|^#define CODEPOD_VERSION_MINOR .*|#define CODEPOD_VERSION_MINOR  ${MINOR}u|" \
  -e "s|^#define CODEPOD_VERSION_PATCH .*|#define CODEPOD_VERSION_PATCH  ${PATCH}u|" \
  "$COMPAT_HEADER"
rm -f "$COMPAT_HEADER.bak"
echo "  updated $COMPAT_HEADER"
