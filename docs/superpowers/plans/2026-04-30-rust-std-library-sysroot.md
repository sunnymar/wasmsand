# Rust Std Library Sysroot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and consume a Codepod-patched Rust standard library for `wasm32-wasip1`, versioned for Rust 1.93-1.95, without shipping rustc or building per host platform.

**Architecture:** Codepod distributes target libraries only. The user keeps using the installed `rustc`/`cargo` selected by `rust-toolchain.toml` or explicit `+<version>`. The builder copies `rust-src`, applies versioned patches, uses `RUSTC_BOOTSTRAP=1` only inside the builder to unlock Cargo `-Z build-std` for the matching stable toolchain, packages the complete target libdir, and `cargo-codepod` composes the resulting sysroot into `CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS`.

**Tech Stack:** Rust 1.93-1.95, `rust-src`, Cargo `-Z build-std` under `RUSTC_BOOTSTRAP=1` in the builder only, `cpcc-toolchain`, `libcodepod.a`, `wasm32-wasip1`, shell scripts, Deno tests.

---

## Corrected Design Notes

- The repository currently pins Rust 1.93.0 in `rust-toolchain.toml`. The matrix also targets 1.95 when installed.
- Stable Cargo rejects `-Z build-std`; the build script must run the standard-library build with `RUSTC_BOOTSTRAP=1`. Consumers do not need `RUSTC_BOOTSTRAP`.
- Patch directories may contain zero patches. The script must tolerate that. Do not create fake empty patch files.
- Shared Codepod Rust std implementation lives in `patches/rust/codepod/codepod.rs`. Version-specific patches should wire that file with `#[path = "codepod.rs"] mod codepod;` and delegate to it, not carry inline Codepod implementations.
- A usable sysroot must include every target lib artifact produced by the std build, including dependencies such as `compiler_builtins`, not only `std/core/alloc`. It must also include the `self-contained/` directory with startup objects and wasi-libc (`crt1-command.o`, `crt1-reactor.o`, `libc.a`).
- The sysroot is target-only, so `cargo-codepod` must add `--sysroot=...` to `CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS`, not global `RUSTFLAGS`.
- The first canary proves a real std hook: stock Rust 1.93 `std::env::temp_dir()` on `wasm32-wasip1` panics with `no filesystem on wasm`; Codepod std patches it to return `/tmp`.

## File Map

- Create: `patches/rust/1.93.0/README.md` — patch contract and version scope.
- Create: `patches/rust/1.93.0/0001-wasip1-temp-dir.patch` — patches `std::env::temp_dir()` to return `/tmp`.
- Create: `patches/rust/1.95.0/README.md` — same patch contract for the next supported Rust line.
- Create: `patches/rust/1.95.0/0001-wasip1-temp-dir.patch` — same temp-dir patch for Rust 1.95.
- Create: `patches/rust/codepod/codepod.rs` — shared version-agnostic Codepod std implementation copied into patched `rust-src`.
- Create: `scripts/build-rust-std.sh` — copies `rust-src`, applies patches, builds and packages target libraries.
- Create: `scripts/check-rust-std-matrix.sh` — builds installed/supported Rust versions.
- Create: `scripts/check-rust-std-source-layout.sh` — verifies patches delegate to shared Codepod std source.
- Create: `packages/guest-compat/toolchain/cpcc/src/rust_std.rs` — sysroot discovery helpers.
- Modify: `packages/guest-compat/toolchain/cpcc/src/lib.rs` — exports `rust_std`.
- Modify: `packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs` — target-scoped sysroot injection.
- Test: `packages/guest-compat/toolchain/cpcc/tests/rust_std.rs`.
- Test: `packages/guest-compat/toolchain/cpcc/tests/cargo_codepod_dry_run.rs`.
- Create: `packages/guest-compat/conformance/rust/std-tempdir-canary/Cargo.toml`.
- Create: `packages/guest-compat/conformance/rust/std-tempdir-canary/src/main.rs`.

---

## Task 1: Patch Directory Contract

**Files:**
- Create: `patches/rust/1.93.0/README.md`
- Create: `patches/rust/1.93.0/0001-wasip1-temp-dir.patch`
- Create: `patches/rust/1.95.0/README.md`
- Create: `patches/rust/1.95.0/0001-wasip1-temp-dir.patch`
- Create: `patches/rust/codepod/codepod.rs`

- [ ] **Step 1: Write the README**

Create `patches/rust/1.93.0/README.md`:

```markdown
# Rust 1.93.0 Codepod std patches

These patches apply to the `rust-src` component for Rust 1.93.0.

The builder copies the installed source tree to a temporary directory,
applies patches in lexical order, and builds only `wasm32-wasip1` target
libraries. It does not build or distribute rustc.

Patch rules:

- Keep patches minimal and target-specific.
- Prefer changes under `library/std/src/sys/pal/wasip1/`.
- Do not add Codepod-specific public Rust APIs.
- Route behavior through existing POSIX/libc names where possible.
- If a later Rust version needs a different patch, create a new directory
  such as `patches/rust/1.95.0/`.
```

- [ ] **Step 2: Write the first real patch**

Create `patches/rust/codepod/codepod.rs`:

```rust
use crate::path::PathBuf;

pub fn temp_dir() -> PathBuf {
    PathBuf::from("/tmp")
}
```

Create `patches/rust/1.93.0/0001-wasip1-temp-dir.patch`:

```diff
diff --git a/library/std/src/sys/pal/wasip1/os.rs b/library/std/src/sys/pal/wasip1/os.rs
--- a/library/std/src/sys/pal/wasip1/os.rs
+++ b/library/std/src/sys/pal/wasip1/os.rs
@@ -8,6 +8,8 @@ use crate::sys::common::small_c_string::run_path_with_cstr;
 use crate::sys::unsupported;
 use crate::{fmt, io, str};

+#[path = "codepod.rs"]
+mod codepod;
 // Add a few symbols not in upstream `libc` just yet.
 pub mod libc {
     pub use libc::*;
@@ -115,7 +117,7 @@ pub fn page_size() -> usize {
 }

 pub fn temp_dir() -> PathBuf {
-    panic!("no filesystem on wasm")
+    codepod::temp_dir()
 }
```

- [ ] **Step 3: Verify the patch applies to installed Rust 1.93.0 source**

Run:

```bash
tmp="$(mktemp -d /tmp/codepod-rust-src-verify.XXXXXX)"
repo="$PWD"
src="$(rustc +1.93.0 --print sysroot)/lib/rustlib/src/rust"
cp -R "$src" "$tmp/rust"
(cd "$tmp/rust" && patch -p1 < "$repo/patches/rust/1.93.0/0001-wasip1-temp-dir.patch")
cp "$repo/patches/rust/codepod/codepod.rs" "$tmp/rust/library/std/src/sys/pal/wasip1/codepod.rs"
rg -n 'codepod::temp_dir|PathBuf::from\("/tmp"\)' "$tmp/rust/library/std/src/sys/pal/wasip1"
```

Expected: `patching file library/std/src/sys/pal/wasip1/os.rs`, then one `codepod::temp_dir()` line in `os.rs` and one `PathBuf::from("/tmp")` line in `codepod.rs`.

- [ ] **Step 4: Commit**

```bash
git add patches/rust/1.93.0
git commit -m "feat(rust-std): add rust 1.93 std patch set"
```

---

## Task 2: Build Script

**Files:**
- Create: `scripts/build-rust-std.sh`

- [ ] **Step 1: Write failing smoke command**

Run before creating the script:

```bash
source scripts/dev-init.sh
./scripts/build-rust-std.sh --rust 1.93.0 --dry-run
```

Expected: fails with `No such file or directory`.

- [ ] **Step 2: Create the builder**

Create `scripts/build-rust-std.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUST_VERSION=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rust)
      RUST_VERSION="${2:?missing rust version}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "usage: $0 --rust <version> [--dry-run]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$RUST_VERSION" ]]; then
  echo "build-rust-std: --rust is required" >&2
  exit 2
fi

PATCH_DIR="$ROOT/patches/rust/$RUST_VERSION"
CODEPOD_STD_SRC="$ROOT/patches/rust/codepod/codepod.rs"
OUT_DIR="$ROOT/packages/guest-compat/build/rust-std/$RUST_VERSION"
WORK_DIR="${TMPDIR:-/tmp}/codepod-rust-src-$RUST_VERSION"
FAKE_SYSROOT="${TMPDIR:-/tmp}/codepod-rust-sysroot-$RUST_VERSION"
BUILD_CRATE="${TMPDIR:-/tmp}/codepod-rust-std-probe-$RUST_VERSION"

if [[ ! -d "$PATCH_DIR" ]]; then
  echo "build-rust-std: missing patch directory $PATCH_DIR" >&2
  exit 1
fi
if [[ ! -f "$CODEPOD_STD_SRC" ]]; then
  echo "build-rust-std: missing shared Codepod std source $CODEPOD_STD_SRC" >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "rust=$RUST_VERSION"
  echo "patch_dir=$PATCH_DIR"
  echo "codepod_std_src=$CODEPOD_STD_SRC"
  echo "work_dir=$WORK_DIR"
  echo "fake_sysroot=$FAKE_SYSROOT"
  echo "build_crate=$BUILD_CRATE"
  echo "out_dir=$OUT_DIR"
  exit 0
fi

SYSROOT="$(rustc "+$RUST_VERSION" --print sysroot 2>/dev/null || true)"
if [[ -z "$SYSROOT" ]]; then
  echo "build-rust-std: rust toolchain $RUST_VERSION is not installed" >&2
  exit 1
fi

SRC_ROOT="$SYSROOT/lib/rustlib/src/rust"
if [[ ! -d "$SRC_ROOT/library" ]]; then
  echo "build-rust-std: rust-src missing for $RUST_VERSION; run: rustup +$RUST_VERSION component add rust-src" >&2
  exit 1
fi

rm -rf "$WORK_DIR"
mkdir -p "$(dirname "$WORK_DIR")"
cp -R "$SRC_ROOT" "$WORK_DIR"

shopt -s nullglob
for patch_file in "$PATCH_DIR"/*.patch; do
  echo "applying $(basename "$patch_file")"
  (cd "$WORK_DIR" && patch -p1 < "$patch_file")
done

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

rm -rf "$FAKE_SYSROOT" "$BUILD_CRATE"
mkdir -p "$FAKE_SYSROOT/lib/rustlib" "$FAKE_SYSROOT/lib" "$BUILD_CRATE/src" "$OUT_DIR/bin"

find "$SYSROOT/lib" -mindepth 1 -maxdepth 1 ! -name rustlib -exec ln -s {} "$FAKE_SYSROOT/lib/" \;
find "$SYSROOT/lib/rustlib" -mindepth 1 -maxdepth 1 ! -name src -exec ln -s {} "$FAKE_SYSROOT/lib/rustlib/" \;
mkdir -p "$FAKE_SYSROOT/lib/rustlib/src"
mv "$WORK_DIR" "$FAKE_SYSROOT/lib/rustlib/src/rust"

CODEPOD_STD_DEST=""
for platform_dir in \
  "$FAKE_SYSROOT/lib/rustlib/src/rust/library/std/src/sys/pal/wasip1" \
  "$FAKE_SYSROOT/lib/rustlib/src/rust/library/std/src/sys/pal/wasi"; do
  if [[ -d "$platform_dir" ]]; then
    CODEPOD_STD_DEST="$platform_dir/codepod.rs"
    break
  fi
done
if [[ -z "$CODEPOD_STD_DEST" ]]; then
  echo "build-rust-std: cannot find WASI platform directory in rust-src for $RUST_VERSION" >&2
  exit 1
fi
cp "$CODEPOD_STD_SRC" "$CODEPOD_STD_DEST"

cat > "$BUILD_CRATE/Cargo.toml" <<'EOF'
[package]
name = "codepod-rust-std-probe"
version = "0.0.0"
edition = "2021"

[workspace]
EOF

cat > "$BUILD_CRATE/src/main.rs" <<'EOF'
fn main() {
    println!("{}", std::env::temp_dir().display());
}
EOF

RUSTC_WRAPPER="$OUT_DIR/bin/rustc-codepod-std-$RUST_VERSION"
cat > "$RUSTC_WRAPPER" <<EOF
#!/usr/bin/env bash
exec rustc "+$RUST_VERSION" --sysroot "$FAKE_SYSROOT" "\$@"
EOF
chmod +x "$RUSTC_WRAPPER"

CARGO_TARGET_DIR="$OUT_DIR/target" \
RUSTC="$RUSTC_WRAPPER" \
RUSTC_BOOTSTRAP=1 \
cargo "+$RUST_VERSION" build \
  -Z build-std=core,alloc,std,panic_abort,proc_macro \
  --target wasm32-wasip1 \
  --manifest-path "$BUILD_CRATE/Cargo.toml" \
  --release

TARGET_DEPS="$OUT_DIR/target/wasm32-wasip1/release/deps"
LIB_DIR="$OUT_DIR/lib/rustlib/wasm32-wasip1/lib"
mkdir -p "$LIB_DIR"
find "$TARGET_DEPS" -maxdepth 1 -type f \( -name '*.rlib' -o -name '*.rmeta' \) -exec cp {} "$LIB_DIR/" \;

SOURCE_LIB_DIR="$SYSROOT/lib/rustlib/wasm32-wasip1/lib"
if [[ -d "$SOURCE_LIB_DIR/self-contained" ]]; then
  cp -R "$SOURCE_LIB_DIR/self-contained" "$LIB_DIR/self-contained"
fi

if ! find "$LIB_DIR" -maxdepth 1 -name 'libcompiler_builtins-*.rlib' | grep -q .; then
  echo "build-rust-std: packaged sysroot is missing compiler_builtins" >&2
  exit 1
fi
if ! find "$LIB_DIR" -maxdepth 1 -name 'libstd-*.rlib' | grep -q .; then
  echo "build-rust-std: packaged sysroot is missing std" >&2
  exit 1
fi
if [[ ! -f "$LIB_DIR/self-contained/crt1-command.o" ]]; then
  echo "build-rust-std: packaged sysroot is missing self-contained/crt1-command.o" >&2
  exit 1
fi
if [[ ! -f "$LIB_DIR/self-contained/libc.a" ]]; then
  echo "build-rust-std: packaged sysroot is missing self-contained/libc.a" >&2
  exit 1
fi

rustc "+$RUST_VERSION" --version > "$OUT_DIR/rustc-version.txt"
echo "wasm32-wasip1" > "$OUT_DIR/target.txt"
echo "built $OUT_DIR"
```

- [ ] **Step 3: Make script executable**

```bash
chmod +x scripts/build-rust-std.sh
```

- [ ] **Step 4: Verify dry-run**

Run:

```bash
source scripts/dev-init.sh
./scripts/build-rust-std.sh --rust 1.93.0 --dry-run
```

Expected output contains `rust=1.93.0`.

- [ ] **Step 5: Build Rust 1.93.0 std**

Run:

```bash
source scripts/dev-init.sh
./scripts/build-rust-std.sh --rust 1.93.0
```

Expected: creates `packages/guest-compat/build/rust-std/1.93.0/lib/rustlib/wasm32-wasip1/lib/libstd-*.rlib`, `libcompiler_builtins-*.rlib`, and `self-contained/libc.a`.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-rust-std.sh
git commit -m "feat(rust-std): build patched wasm target std libraries"
```

---

## Task 3: `cargo-codepod` Discovery Helpers

**Files:**
- Create: `packages/guest-compat/toolchain/cpcc/src/rust_std.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/lib.rs`
- Test: `packages/guest-compat/toolchain/cpcc/tests/rust_std.rs`

- [ ] **Step 1: Write tests**

Create `packages/guest-compat/toolchain/cpcc/tests/rust_std.rs`:

```rust
use cpcc_toolchain::rust_std::{discover_built_std, rustc_version_key};

#[test]
fn rustc_version_key_extracts_semver_prefix() {
    assert_eq!(
        rustc_version_key("rustc 1.93.0 (254b59607 2026-01-19)").unwrap(),
        "1.93.0"
    );
}

#[test]
fn discover_returns_none_when_root_missing() {
    let tmp = tempfile::tempdir().unwrap();
    let found = discover_built_std(tmp.path(), "1.93.0");
    assert!(found.is_none());
}

#[test]
fn discover_requires_target_libdir() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("packages/guest-compat/build/rust-std/1.93.0");
    std::fs::create_dir_all(root.join("lib/rustlib/wasm32-wasip1/lib")).unwrap();
    let found = discover_built_std(tmp.path(), "1.93.0").unwrap();
    assert_eq!(found, root);
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cargo test -q -p cpcc-toolchain --test rust_std
```

Expected: fails because `rust_std` module does not exist.

- [ ] **Step 3: Implement module**

Create `packages/guest-compat/toolchain/cpcc/src/rust_std.rs`:

```rust
use std::path::{Path, PathBuf};

pub fn rustc_version_key(version_output: &str) -> Option<String> {
    let version = version_output.split_whitespace().nth(1)?;
    let mut parts = version.split('.');
    Some(format!(
        "{}.{}.{}",
        parts.next()?,
        parts.next()?,
        parts.next()?.split('-').next().unwrap_or("")
    ))
}

pub fn discover_built_std(repo_root: &Path, rust_key: &str) -> Option<PathBuf> {
    let root = repo_root
        .join("packages/guest-compat/build/rust-std")
        .join(rust_key);
    let lib = root.join("lib/rustlib/wasm32-wasip1/lib");
    if lib.is_dir() {
        Some(root)
    } else {
        None
    }
}
```

Modify `packages/guest-compat/toolchain/cpcc/src/lib.rs` to include:

```rust
pub mod rust_std;
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
cargo test -q -p cpcc-toolchain --test rust_std
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/guest-compat/toolchain/cpcc/src/rust_std.rs packages/guest-compat/toolchain/cpcc/src/lib.rs packages/guest-compat/toolchain/cpcc/tests/rust_std.rs
git commit -m "feat(cargo-codepod): discover built rust std libraries"
```

---

## Task 4: Target-Scoped Sysroot Injection

**Files:**
- Modify: `packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs`
- Test: `packages/guest-compat/toolchain/cpcc/tests/cargo_codepod_dry_run.rs`

- [ ] **Step 1: Add dry-run test**

Append to `packages/guest-compat/toolchain/cpcc/tests/cargo_codepod_dry_run.rs`:

```rust
#[test]
fn built_std_env_is_composed_into_target_rustflags() {
    let prev = std::env::var_os("CODEPOD_RUST_STD");
    std::env::set_var("CODEPOD_RUST_STD", "/tmp/codepod-rust-std");

    let plan = plan_invocation(Subcommand::Build, &[]).unwrap();

    match prev {
        Some(v) => std::env::set_var("CODEPOD_RUST_STD", v),
        None => std::env::remove_var("CODEPOD_RUST_STD"),
    }

    let flags = plan
        .env
        .iter()
        .find(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    assert!(flags.contains("--sysroot=/tmp/codepod-rust-std"), "flags: {flags}");
}
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cargo test -q -p cpcc-toolchain --test cargo_codepod_dry_run built_std_env_is_composed_into_target_rustflags
```

Expected: fails because sysroot is not composed into target rustflags.

- [ ] **Step 3: Implement target-scoped composition**

In `packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs`, initialize the target rustflags once near the existing archive handling:

```rust
    let mut target_rustflags =
        std::env::var("CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS").unwrap_or_default();

    if let Some(std_root) = std::env::var_os("CODEPOD_RUST_STD") {
        if !target_rustflags.is_empty() {
            target_rustflags.push(' ');
        }
        target_rustflags.push_str(&format!("--sysroot={}", PathBuf::from(std_root).display()));
    }
```

Then reuse `target_rustflags` in the existing archive block instead of creating a second local `rustflags` string. Push exactly one env entry at the end when `target_rustflags` is non-empty:

```rust
    if !target_rustflags.is_empty() {
        plan.env.push((
            "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS".to_string(),
            target_rustflags.trim_end().to_string(),
        ));
    }
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
cargo test -q -p cpcc-toolchain --test cargo_codepod_dry_run built_std_env_is_composed_into_target_rustflags
cargo test -q -p cpcc-toolchain --test cargo_codepod_dry_run
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs packages/guest-compat/toolchain/cpcc/tests/cargo_codepod_dry_run.rs
git commit -m "feat(cargo-codepod): inject codepod rust std for wasm target"
```

---

## Task 5: Temp Dir Canary

**Files:**
- Create: `packages/guest-compat/conformance/rust/std-tempdir-canary/Cargo.toml`
- Create: `packages/guest-compat/conformance/rust/std-tempdir-canary/src/main.rs`

- [ ] **Step 1: Create canary crate**

Create `packages/guest-compat/conformance/rust/std-tempdir-canary/Cargo.toml`:

```toml
[package]
name = "std-tempdir-canary"
version = "0.1.0"
edition = "2021"

[dependencies]

[workspace]
```

Create `packages/guest-compat/conformance/rust/std-tempdir-canary/src/main.rs`:

```rust
fn main() {
    println!("{}", std::env::temp_dir().display());
}
```

- [ ] **Step 2: Verify stock behavior fails at runtime**

Run:

```bash
tmp="$(mktemp -d /tmp/codepod-stock-tempdir.XXXXXX)"
rustc +1.93.0 --target wasm32-wasip1 packages/guest-compat/conformance/rust/std-tempdir-canary/src/main.rs -O -o "$tmp/tempdir-stock.wasm"
wasmtime "$tmp/tempdir-stock.wasm"
```

Expected: exits non-zero and stderr contains `no filesystem on wasm`.

- [ ] **Step 3: Build canary with Codepod std**

Run:

```bash
source scripts/dev-init.sh
cargo build -p cpcc-toolchain
CODEPOD_RUST_STD="$PWD/packages/guest-compat/build/rust-std/1.93.0" \
./target/debug/cargo-codepod codepod build --manifest-path packages/guest-compat/conformance/rust/std-tempdir-canary/Cargo.toml --release
```

Expected: produces `packages/guest-compat/conformance/rust/std-tempdir-canary/target/wasm32-wasip1/release/std-tempdir-canary.wasm`.

This canary intentionally omits `CPCC_ARCHIVE`: it tests the patched Rust sysroot itself and should instantiate under plain `wasmtime`. Guest-compat-linked binaries that whole-archive `libcodepod.a` must run through the Codepod sandbox because they import `codepod::*`.

- [ ] **Step 4: Run canary**

Run:

```bash
wasmtime packages/guest-compat/conformance/rust/std-tempdir-canary/target/wasm32-wasip1/release/std-tempdir-canary.wasm
```

Expected stdout:

```text
/tmp
```

- [ ] **Step 5: Commit**

```bash
git add packages/guest-compat/conformance/rust/std-tempdir-canary
git commit -m "test(rust-std): add patched temp_dir canary"
```

---

## Task 6: Version Matrix

**Files:**
- Create: `scripts/check-rust-std-matrix.sh`

- [ ] **Step 1: Create matrix script**

Create `scripts/check-rust-std-matrix.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS=(1.93.0 1.95.0)

for version in "${VERSIONS[@]}"; do
  if ! rustc "+$version" --version >/dev/null 2>&1; then
    echo "SKIP rust $version: toolchain not installed"
    continue
  fi
  if [[ ! -d "$ROOT/patches/rust/$version" ]]; then
    echo "SKIP rust $version: patch directory missing"
    continue
  fi
  "$ROOT/scripts/build-rust-std.sh" --rust "$version"
done
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/check-rust-std-matrix.sh
```

- [ ] **Step 3: Run matrix**

```bash
source scripts/dev-init.sh
./scripts/check-rust-std-matrix.sh
```

Expected today: builds 1.93.0. It builds 1.95.0 only after `patches/rust/1.95.0/` exists.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-rust-std-matrix.sh
git commit -m "test(rust-std): add rust std version matrix"
```

---

## Verification Checklist

Run:

```bash
source scripts/dev-init.sh
cargo test -q -p cpcc-toolchain --test rust_std
cargo test -q -p cpcc-toolchain --test cargo_codepod_dry_run
./scripts/build-rust-std.sh --rust 1.93.0
./scripts/check-rust-std-matrix.sh
git diff --check
```

Expected:

- cpcc tests pass.
- Rust 1.93.0 std libraries exist under `packages/guest-compat/build/rust-std/1.93.0/lib/rustlib/wasm32-wasip1/lib`.
- The packaged libdir contains both `libstd-*.rlib` and `libcompiler_builtins-*.rlib`.
- The packaged libdir contains `self-contained/crt1-command.o` and `self-contained/libc.a`.
- 1.95.0 is skipped until `patches/rust/1.95.0/` exists.
- No whitespace errors.

## Deferred Follow-Ups

- Add `patches/rust/1.95.0/` after validating the `temp_dir` patch against Rust 1.95 source.
- Add a real networking canary once patched std grows `std::net` support through libc/libcodepod.
- Decide when `cargo-codepod` should auto-discover `packages/guest-compat/build/rust-std/<rustc-version>` by default instead of requiring `CODEPOD_RUST_STD`.
- Package built target libraries for release distribution.
