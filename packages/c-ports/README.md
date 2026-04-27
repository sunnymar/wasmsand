# C ports

WASM ports of upstream C projects, built via the `cpcc` toolchain
against `libcodepod_guest_compat.a`. Each port lives in its own
subdirectory.

## Source policy

**Every port pins upstream as a git submodule.** No `curl | tar` at
build time — that loses provenance and breaks reproducibility. Two
forms are allowed:

1. **Upstream-pin** (default) — submodule the official upstream repo
   directly, pinned to a release tag. Patches we carry live in
   `patches/*.patch` and are applied to a worktree copy at configure
   time. Example: `jq/`, `rust-ports/grex/`.

2. **Fork-pin** (when patches accumulate) — fork upstream under
   `codepod-sandbox/<repo>`, submodule the fork, carry patches as
   branch commits. Example: `numpy-rust`, `pillow-rust`,
   `matplotlib-py`, `pandas-rust`.

Switch from (1) to (2) when patches stop being trivially reviewable
or when we need to track upstream releases independently of our
modifications.

## Layout convention

```
packages/c-ports/<name>/
├── upstream/        ← git submodule (pinned to a tag)
├── patches/         ← *.patch files applied at configure time (optional)
├── compat/include/  ← narrow per-port libc shims (optional)
├── build/           ← out-of-tree build dir (gitignored)
├── Makefile
├── README.md
└── .gitignore
```

The `Makefile` builds out-of-tree (rsync `upstream/` → `build/work/`,
apply patches, configure, make) so the submodule stays pristine and
`git submodule status` doesn't go dirty after every build.

## Current ports

| Name | Upstream | Form | Output |
|------|----------|------|--------|
| `busybox/` | busybox.net 1.37.0 | tarball-fetch (legacy — being migrated) | `busybox.wasm` (default userland) |
| `jq/` | [jqlang/jq](https://github.com/jqlang/jq) `jq-1.8.1` | submodule (upstream-pin) | `jq.wasm` (replaces former Rust standalone) |
| `file/` | [file/file](https://github.com/file/file) `FILE5_47` | submodule (upstream-pin) | `file.wasm` + `magic.mgc` (replaces former Rust stub) |
| `coreutils/` | [coreutils/coreutils](https://github.com/coreutils/coreutils) `v9.11` | submodule (upstream-pin) + 1 patch (gnulib `__wasi__` arms) | `csplit.wasm`, `fmt.wasm`, `join.wasm`, `numfmt.wasm`, `sha224sum.wasm`, `sha384sum.wasm` (replaces former Rust standalones) |
