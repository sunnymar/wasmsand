# Rust ports (§Repository Shape)

This directory holds **unmodified** third-party Rust CLI crates that validate
the codepod guest compatibility runtime end-to-end, per the spec at
[`docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`](../../docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md)
§Package Validation Requirements.

## Pattern

Each port is:

- a git submodule pointing at a specific upstream tag/SHA (see `.gitmodules`)
- **never** a workspace member of the root `Cargo.toml` (upstream `Cargo.toml`
  is not edited or patched)
- built by invoking `cargo-codepod codepod build --release` inside the
  submodule's directory, with `CPCC_ARCHIVE` and `CPCC_PRESERVE_PRE_OPT`
  pointing at the guest-compat archive and a dedicated pre-opt dir
- validated by `cpcheck` against the preserved pre-opt `.wasm` per
  §Verifying Precedence

## Current ports

| Port   | Upstream                         | Tag      | Pinned SHA                                |
|--------|----------------------------------|----------|-------------------------------------------|
| tokei  | github.com/XAMPPRocky/tokei      | v12.1.2  | 5ae68d43023f746633cb705dd866be5cef4dbdc3  |

## Adding a new port

1. `git submodule add <upstream-url> packages/rust-ports/<name>`
2. `cd packages/rust-ports/<name> && git checkout <pinned-sha>`
3. Add a build recipe. Current pattern: a sibling script at
   `packages/rust-ports/<name>.build.sh` (the script is outside the
   submodule so it is not wiped by a submodule update).
4. Add the signature-check invocation to `.github/workflows/guest-compat.yml`.
5. Do not edit the submodule's sources. If a port does not build against
   `cargo-codepod`, the fix lives in `packages/guest-compat/`, not here.
