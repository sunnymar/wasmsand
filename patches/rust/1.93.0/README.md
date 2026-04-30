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
