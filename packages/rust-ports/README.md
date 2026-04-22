# Rust ports (§Repository Shape)

This directory holds **unmodified** third-party Rust CLI crates that validate
the codepod guest compatibility runtime end-to-end, per the spec at
[`docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`](../../docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md)
§Package Validation Requirements.

## Pattern

Each port is:

- a git submodule pointing at a specific upstream tag/SHA (see `.gitmodules`)
- **never** a workspace member of the root `Cargo.toml` (upstream `Cargo.toml`
  is not edited or patched). Add the port path to the root `Cargo.toml`
  `exclude = [...]` list.
- built by invoking `cargo-codepod codepod build --release` inside the
  submodule's directory, with `CPCC_ARCHIVE` and `CPCC_PRESERVE_PRE_OPT`
  pointing at the guest-compat archive and a dedicated pre-opt dir
- validated by `cpcheck` against the preserved pre-opt `.wasm` per
  §Verifying Precedence

Some ports additionally need `CPCC_NO_CLANG_LINKER=1` so the wasi-sdk
clang linker is bypassed (rust-lld handles link; --whole-archive is
preserved via RUSTFLAGS). See `grex.build.sh` for the cdylib+wasm-bindgen
case.

## Current ports

| Port  | Upstream                     | Tag      | Pinned SHA                                |
|-------|------------------------------|----------|-------------------------------------------|
| grex  | github.com/pemistahl/grex    | v1.4.6   | db9275ace11ad455700656c6186e0d69f6107870  |

## Prior attempts

- `tokei@v12.1.2` was the initial candidate but its transitive dep
  `memmap v0.7.0` has no `wasm32-wasip1` implementation. Swapped to
  grex in the Task 7 consolidation commit.

## Adding a new port

1. `git submodule add <upstream-url> packages/rust-ports/<name>`
2. `cd packages/rust-ports/<name> && git checkout <pinned-sha>`
3. Add `packages/rust-ports/<name>` to the root `Cargo.toml` `exclude = [...]` list.
4. Add a build recipe. Current pattern: a sibling script at
   `packages/rust-ports/<name>.build.sh` (the script is outside the
   submodule so it is not wiped by a submodule update).
5. Add the signature-check invocation to `.github/workflows/guest-compat.yml`.
6. Do not edit the submodule's sources. If a port does not build against
   `cargo-codepod`, the fix lives in `packages/guest-compat/`, not here.
   Check its dep tree for `memmap`, `mmap2`, tokio/async-std, native
   threads, or dlopen before accepting.
