#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${CARGO_HOME:-$HOME/.cargo}/bin"
CODEPOD_HOME="${CODEPOD_HOME:-$HOME/.codepod}"
BUILD_PROFILE="release"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin-dir)
      BIN_DIR="${2:?missing bin dir}"
      shift 2
      ;;
    --codepod-home)
      CODEPOD_HOME="${2:?missing codepod home}"
      shift 2
      ;;
    --debug)
      BUILD_PROFILE="debug"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "usage: $0 [--bin-dir <dir>] [--codepod-home <dir>] [--debug] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

if [[ "$DRY_RUN" == "1" ]]; then
  echo "bin_dir=$BIN_DIR"
  echo "codepod_home=$CODEPOD_HOME"
  echo "build_profile=$BUILD_PROFILE"
  exit 0
fi

if [[ "$BUILD_PROFILE" == "release" ]]; then
  cargo build -p cpcc-toolchain --release
  TARGET_DIR="$ROOT/target/release"
else
  cargo build -p cpcc-toolchain
  TARGET_DIR="$ROOT/target/debug"
fi

mkdir -p "$BIN_DIR" "$CODEPOD_HOME/rust-std"

for bin in cargo-codepod maturin-codepod cpcc cpar cpranlib cpcheck cpconf; do
  install -m 0755 "$TARGET_DIR/$bin" "$BIN_DIR/$bin"
done

if [[ -d "$ROOT/packages/guest-compat/build/rust-std" ]]; then
  for version_dir in "$ROOT"/packages/guest-compat/build/rust-std/*; do
    [[ -d "$version_dir" ]] || continue
    version="$(basename "$version_dir")"
    rm -rf "$CODEPOD_HOME/rust-std/$version"
    mkdir -p "$CODEPOD_HOME/rust-std"
    cp -R "$version_dir" "$CODEPOD_HOME/rust-std/$version"
  done
fi

cat <<EOF
Installed Codepod toolchain:
  binaries: $BIN_DIR
  CODEPOD_HOME: $CODEPOD_HOME

Use:
  cargo codepod build
  maturin-codepod build
EOF
