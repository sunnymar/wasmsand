# file/libmagic port

C port of [file/file](https://github.com/file/file) (the standard
Unix `file(1)` utility plus libmagic) for `wasm32-wasip1`, built via
the codepod `cpcc` toolchain.

## Layout

- `upstream/` — git submodule pinned to a release tag (currently
  `FILE5_47`). Read-only; we treat upstream as canonical.
- `patches/*.patch` — patches applied on top of the submodule before
  configure. Empty today; populate only when upstream needs codepod-
  specific changes that aren't expressible as configure flags or
  build-time defines.
- `build/host/` — host-side build of the same upstream tree, used
  only to produce `magic.mgc` (the compiled magic database, ~10 MB).
  We can't generate this from inside the wasm build because the
  cross-compile recipe would need a wasm-runnable `file -C` pass,
  which isn't bootstrapped yet.
- `build/work/` — out-of-tree wasm build directory (rsync'd from
  `upstream/` so the submodule stays pristine).
- `build/file.wasm`, `build/magic.mgc` — final artifacts.
- `Makefile` — fetch, autoreconf, configure (host + wasm), build.

## Build

```bash
make copy-fixtures
```

This will:

1. Initialize the submodule if needed.
2. Build the `cpcc` toolchain and `libcodepod_guest_compat.a`.
3. Rsync `upstream/` → `build/work/`, apply `patches/*.patch`.
4. Run `autoreconf -fi` (the submodule has `configure.ac` only — the
   release tarball ships a pre-built `configure` script, but git
   checkouts don't).
5. Run `./configure` for wasm with `cpcc` as `CC`
   (`--disable-shared --enable-static --disable-libseccomp`,
   all `--disable-*lib` to skip compression dependencies).
6. Generate `magic.h` (a small sed substitution) and `make file` —
   we skip the `magic/` subdir because building `magic.mgc` would
   require running our wasm `file -C` on the host.
7. Run a separate **host** build (`build/host/`) to produce
   `magic.mgc` using the system compiler, and copy it out.
8. Copy `build/file.wasm` and `build/magic.mgc` to
   `packages/orchestrator/src/platform/__tests__/fixtures/`.

The sandbox auto-loads `magic.mgc` into the VFS at
`/usr/share/misc/magic.mgc` on startup (see
`Sandbox.registerTools` and `PlatformAdapter.readDataFile`), which is
where libmagic looks by default with our `--prefix=/usr` configure.

## Compat-layer dependencies driven by this port

| What | Where | Why |
|------|-------|-----|
| `pipe()`, `pipe2()` | `guest-compat/src/codepod_pipe.c` | wasi-libc has no pipe surface; we already had `host_pipe`, just hadn't wired the POSIX names. file/libmagic uses `pipe2(O_CLOEXEC)` for decompressor pipelines (gated, dead with `--disable-*lib`, but other ports will want pipe). |
| `tzset()`, `tzname[]`, `timezone`, `daylight` | `guest-compat/src/codepod_time.c` + `include/time.h` | wasi-libc gates these behind `__wasilibc_unmodified_upstream`. Codepod is UTC-only, so `tzset` is a no-op and the globals carry "GMT" defaults. file's `print.c:325` calls `tzset()` before `localtime_r`. |
| Drop `static inline int vfork()` from `guest-compat/include/unistd.h` | colliding with autoconf's `#define vfork fork` fallback when neither symbol is found in libc | After preprocessing, the static inline became a duplicate definition of `fork()`. |

## Compat-layer items deferred

- `posix_spawn` family — file's `compress.c:1188` uses it, but only
  for decompressor pipelines (gated by `HAVE_BZLIB` / `HAVE_ZLIB`
  etc., all disabled in our build). We have `host_spawn` available
  if a future port needs it.
- POSIX regex — wasi-libc actually does ship `regcomp` /
  `regexec` / `regfree` / `regerror` in `libc.a` (the agent's
  initial intel was wrong). No port needed.
- `der.c:451` file-backed `mmap()` of the input file — falls back
  to `read()` automatically via `_WASI_EMULATED_MMAN`.

## Scope notes

- Single-binary port: produces `file.wasm`, registered as the
  `file` command in the sandbox.
- All compression decompressors disabled
  (`--disable-{bz,z,xz,zstd,lz}lib`). file can't peek inside
  `.gz`/`.bz2`/etc. for type detection — it'll classify as
  "gzip compressed data" / "bzip2 compressed data" via the magic
  rule but won't chain into the contents.
- libseccomp disabled (Linux-only).
- `magic.mgc` is currently the full 10 MB upstream database.
  Trimming `Magdir/` to a curated subset (drop database, gnumeric,
  office, images, …) would shrink it 5–10x; tracked separately.
- Tests live in `packages/orchestrator/src/__tests__/file-conformance.test.ts`.
