# jq port

C port of [jqlang/jq](https://github.com/jqlang/jq) for `wasm32-wasip1`,
built via the codepod `cpcc` toolchain.

## Layout

- `upstream/` — git submodule pinned to a jq release tag (currently
  `jq-1.8.1`). Never edit in place; we treat upstream as read-only.
- `patches/*.patch` — patches applied on top of the submodule before
  configure. Empty today; populate only when upstream needs codepod-
  specific changes that aren't expressible as configure flags or
  build-time defines.
- `build/` — out-of-tree build directory. `build/work/` is a clean
  rsync of `upstream/` (with patches applied) so the submodule stays
  pristine across builds.
- `Makefile` — fetch, configure, build, deploy.

## Build

```bash
make copy-fixtures
```

This will:

1. Initialize the submodule if needed.
2. Build the `cpcc` toolchain (no-op if up to date).
3. Build `libcodepod_guest_compat.a` (no-op if up to date).
4. Rsync `upstream/` → `build/work/`, apply any `patches/*.patch`.
5. Run jq's `./configure` with `cpcc` as `CC` (`--without-oniguruma`,
   `--disable-decnum`, `--disable-docs`, `--enable-static`).
6. Run jq's `make` to produce `build/work/jq`.
7. Copy the artifact to
   `packages/orchestrator/src/platform/__tests__/fixtures/jq.wasm`.

## Why submodule + out-of-tree

Submodule pins the exact upstream commit (auditable, reproducible).
Out-of-tree (`rsync` to `build/work/`) keeps the submodule itself
pristine so `git submodule status` stays clean. Patches are reviewable
diffs in `patches/` rather than uncommitted changes to upstream.

If we ever accumulate substantial patches, switch the submodule URL
from upstream to a fork under `codepod-sandbox/jq` and carry the
patches as branch commits — same pattern as `numpy-rust` and
`pillow-rust`.

## Compat-layer dependencies

jq pulls in:

- `pthread.h` for `__thread` / once-init in `jv_alloc.c` and
  `jv_dtoa_tsd.c`. wasi-sdk supports `_Thread_local` in single-
  threaded builds, so this collapses to globals.
- `libgen.h` (`basename`/`dirname`) — present in wasi-sdk.
- `gettimeofday` (via `_WASI_EMULATED_PROCESS_CLOCKS`).
- `setjmp`/`longjmp` — **zero call sites** in jq itself (only
  comments); the existing Phase 1 stub in `host_setjmp` is
  sufficient.
- `oniguruma` — disabled here. Regex builtins (`test`, `match`,
  `splits`) become unavailable. Add a separate `c-ports/oniguruma/`
  later if regex support is wanted.

## Scope notes

- This is a single-binary port: produces `jq.wasm`, registered as the
  `jq` command in the sandbox.
- Decimal arithmetic (`--disable-decnum`) is off — JSON numbers
  round-trip as `double`, not arbitrary precision. Matches what most
  pure-Python and BusyBox JSON tools do; accept the precision loss
  to keep the binary lean.
- Tests live in `packages/orchestrator/src/__tests__/jq-conformance.test.ts`
  (TBD).
