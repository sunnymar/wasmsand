# Phase B — Codepod Rust Sysroot Distribution

> **Status:** Planned follow-up. Not yet scheduled.
>
> **Scope:** Ship a codepod-patched `library/std` as a prebuilt sysroot that
> consumers download via `cargo-codepod codepod download-toolchain` and use
> with stable rustc via `--sysroot`. Replaces the Phase A post-link rewriter
> (`packages/guest-compat/rust/codepod-wasi-shims` +
> `packages/guest-compat/toolchain/codepod-wasi-postlink`) as the sanctioned
> way to make unmodified upstream Rust crates work on codepod's wasi runtime.
>
> **Why Phase B exists:** Phase A (post-link rewriting) can't survive LTO,
> inlining, or compiler specialization of panicking stdlib functions. See
> the Phase A primitive's README for the full argument. Phase B fixes
> stdlib at compile time so LLVM never gets a chance to specialize.

---

## Goal

Unmodified upstream Rust crates (grex, coreutils tests, third-party CLIs)
compile and run on codepod's wasi runtime without losing stdlib functionality
that would otherwise panic or be specialized out under LTO. Phase B
specifically covers the stdlib surface codepod intends to support:
`env::temp_dir`, `env::home_dir`, `env::current_exe`, process spawn
(minus `fork`), and threads (`std::thread::spawn` + sync primitives).

**Non-goals:** new target triple (we keep `wasm32-wasip1`), compiler fork
(we ship a sysroot only, not rustc), full POSIX parity. `fork()` stays
explicitly out of scope per the guest-compat spec's §Non-Goals.

## Architecture

Mirrors wasix's proven shipping model, scoped down from full-toolchain
(~350 MB) to stdlib-only (~50–100 MB estimated):

```
codepod infra (our CI, nightly rustc):
  1. Clone rust-lang/rust at a pinned stable tag (e.g. 1.83.0)
  2. Apply patches/*.patch — surgical edits to library/std/src/sys/pal/wasi/
  3. cargo +nightly build -Zbuild-std=std,panic_abort --target wasm32-wasip1
  4. Package the rlibs into a sysroot layout:
       codepod-wasi-sysroot-1.83.0/
         lib/rustlib/wasm32-wasip1/lib/libstd-*.rlib
                                    /libcore-*.rlib
                                    /libpanic_abort-*.rlib
                                    /libcompiler_builtins-*.rlib
                                    /self-contained/
  5. Tar + release to https://github.com/<codepod-org>/releases/...

consumer (stable rustc, unmodified user crate):
  1. `cargo-codepod codepod download-toolchain` detects the rustc version
     and fetches the matching tarball, extracts to
     ~/.codepod/sysroots/wasm32-wasip1-<rustc-version>/
  2. `cargo-codepod codepod build` adds `--sysroot=<path>` to RUSTFLAGS
     and invokes real cargo
  3. rustc uses our stdlib → LTO sees non-panicking bodies → every upstream
     crate works as if wasi were a normal platform
```

## Patch surface

All patches live under `library/std/src/sys/pal/wasi/` in the fork.
Each is surgical — usually 5–30 lines — and chosen to not conflict with
upstream unless upstream itself rewrites the function.

### Filesystem / environment (small fixes)

| stdlib fn | current wasi pal behavior | codepod patch |
|-----------|---------------------------|----------------|
| `env::temp_dir` | `panic!("no filesystem on wasm")` | return `PathBuf::from("/tmp")` |
| `env::home_dir` | returns `None` | return `PathBuf::from("/home/user")` (matches codepod's default VFS layout) |
| `env::current_exe` | `unsupported()` | return a stable sentinel like `/proc/self/exe` so callers that log or `strip_prefix` it don't crash |

Each is one-function edit. PR-worthy to upstream Rust in parallel.

### Process spawn (medium)

| stdlib fn | codepod patch |
|-----------|---------------|
| `std::process::Command::spawn` | route through codepod's `host_spawn_async` + `host_waitpid` ABI (same primitives coreutils / BusyBox already use via `packages/codepod-process`) |
| `std::process::Command::status` / `output` | thin wrappers over the patched `spawn` |
| `fork` family | stay unsupported — consistent with spec §Non-Goals |

The patch has to learn codepod's host-ABI for process operations. Existing
reference: `packages/codepod-process/`.

### Threads (the biggest chunk)

Rust stdlib already has a `wasi-threads` integration gated on a target
feature. It expects certain wasi host imports (`thread_spawn`,
`thread_join`, futex primitives) per the wasi-threads proposal.

| stdlib fn | codepod patch |
|-----------|---------------|
| `std::thread::spawn` | route through codepod's thread host ABI |
| `std::sync::Mutex` / `RwLock` / `Condvar` | map to codepod's futex-equivalent imports |
| `std::thread::sleep` | map to `host_yield` / appropriate syscall |

Two-way work: stdlib patches + codepod host ABI must be consistent. Reference
implementation: wasix's fork handles this in
`library/std/src/sys/pal/wasi/thread.rs`.

### Target-family cfg refinements (tiny, spec-level)

Not strictly stdlib, but codepod-toolchain can ship a patched target JSON
that sets the right cfg so upstream crates stop treating wasi as "browser
wasm." Observed precedent: grex's
`#[cfg(target_family = "wasm")] mod wasm;` pulling in wasm-bindgen is
pure `target_family` breakage. Whether we ship this as a stdlib patch or
documentation is an open question for the spec phase of this plan.

## Sysroot-build pipeline

Artifacts, per supported platform × rustc version:
- `rust-sysroot-wasm32-wasip1-<rustc>-x86_64-linux.tar.gz`
- `rust-sysroot-wasm32-wasip1-<rustc>-aarch64-darwin.tar.gz`
- etc.

Hosted on GitHub Releases of a codepod-org-owned repo. `cargo-codepod
download-toolchain` defaults to that URL; overridable via env var for
private mirrors.

CI:
- Nightly workflow builds sysroots for the pinned rustc + platforms
- When a new stable rustc ships (roughly every 6 weeks), refresh the
  pin, re-apply patches (with conflict resolution where upstream moved
  things), rebuild, release

## `cargo-codepod` integration

Current (Phase A):
- `cargo codepod download-toolchain` runs `rustup target add wasm32-wasip1`

Phase B:
- `cargo codepod download-toolchain` detects the host platform + rustc
  version, fetches the matching codepod-sysroot tarball, extracts to
  `~/.codepod/sysroots/<version>/`, sets an on-disk pointer (lockfile-ish)
- `cargo codepod build|test|run` prepends `--sysroot=<path>` to RUSTFLAGS,
  or (cleaner) writes/uses a custom target JSON at
  `~/.codepod/targets/wasm32-wasip1-codepod.json` that points at the sysroot
- Existing `CPCC_ARCHIVE` + `CPCC_NO_CLANG_LINKER` env-var surface stays
  compatible; nothing else in cargo-codepod's plan_invocation changes

## Deprecation of Phase A

When Phase B ships:
- `packages/guest-compat/rust/codepod-wasi-shims` → delete (or keep as a
  thin no-op crate for back-compat during the transition)
- `packages/guest-compat/toolchain/codepod-wasi-postlink` → delete
- `packages/rust-ports/grex-wasi-tests/.cargo/config.toml` drops the
  `run-wasi-test.sh` runner, uses plain `wasmtime` again
- LTO constraint removed from `CARGO_PROFILE_RELEASE_LTO=off`
- `guest-compat.yml` drops the postlink-build step

## Open questions (to resolve in the plan's implementation phase)

1. Exact rustc version to pin first. Candidates: latest stable at plan-exec
   time, or current-stable-minus-1 for maturity.
2. Patch storage: submodule of rust-lang/rust + diffs, or flat patch files?
   wasix uses a full fork on a branch; that's more than we need.
3. Consumer cache invalidation: when rustc is rustup-upgraded, how does
   `download-toolchain` notice and re-fetch? Probably store the matching
   rustc-version in the sysroot dir and check on every invocation.
4. Windows build story. wasix ships Windows tarballs; do we need to? Most
   codepod dev is macOS/Linux, but CI on Windows consumers would matter.
5. Nightly-for-build-only: how do we pin the nightly version? wasix tracks
   "nightly matching stable 1.90"; we copy their pattern.

## Effort estimate

| Phase | Work | Duration |
|-------|------|----------|
| Spec | Flesh this plan into an actual executable plan (like Step 3's) with concrete tasks, file paths, test commands | 2–3 days |
| Minimum viable | Fork + patch env::temp_dir only, local sysroot, verify LTO works on grex-wasi-tests | 4–6 hours (proof of concept; no shipping pipeline) |
| Filesystem patches + ship pipeline | Full filesystem/env patches, GitHub Releases CI, cargo-codepod integration, docs | 2 weeks |
| + Process spawn | Routing through codepod host ABI, tests | 1 week |
| + Threads | stdlib thread.rs patches + host ABI alignment + mutex/condvar/thread::spawn tests | 2 weeks |
| Maintenance | Per rustc release (every ~6 weeks): refresh patches, rebuild, release | ~1 day |

Total first-release: 5–6 weeks. First rayon-passing release: same plus
the thread work.

## Trigger

Start Phase B execution when one of:
- The post-link primitive breaks on a new upstream crate we want to support
  (any LTO-on consumer, any inlined stdlib call, etc.)
- A consumer crate needs `std::thread::spawn` to actually work (the
  current shim can't help; Phase A's rewriter doesn't extend to threads)
- A supported rustc version drift makes the mangled-name matching in
  codepod-wasi-postlink fragile

## References

- wasix's Rust fork: <https://github.com/wasix-org/rust> (full toolchain
  fork, for reference on the shipping pipeline and thread support)
- wasix's cargo wrapper: <https://github.com/wasix-org/cargo-wasix>
- Rust's `-Zbuild-std`:
  <https://doc.rust-lang.org/cargo/reference/unstable.html#build-std>
- Phase A primitive:
  `packages/guest-compat/rust/codepod-wasi-shims/` +
  `packages/guest-compat/toolchain/codepod-wasi-postlink/`
