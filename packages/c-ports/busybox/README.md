# BusyBox pilot recipe

This package builds BusyBox 1.37.0 for wasm32-wasip1 using the `cpcc`/`cpar`/`cpranlib`
toolchain wrappers from `packages/guest-compat/toolchain/`.

Enabled applets:

- `grep`
- `head`
- `seq`

Build path:

- `make copy-fixtures` fetches BusyBox source (if not already present), configures,
  builds, and copies `busybox.wasm` to the test fixtures directory.
- The recipe runs `allnoconfig`, merges the curated
  [`busybox.config`](busybox.config) back into `.config`, then regenerates
  `include/autoconf.h` via `silentoldconfig` so the selected applets survive
  BusyBox's non-interactive Kconfig flow.
- `cpcc`/`cpar`/`cpranlib` are used as `CC`/`AR`/`RANLIB` so the guest-compat
  library (`libcodepod_guest_compat.a`) is automatically injected at link time
  via `CPCC_ARCHIVE`.
- The build step adds minimal WASI emulation flags and libraries:
  `-mllvm -wasm-enable-sjlj`,
  `-D_WASI_EMULATED_SIGNAL`,
  `-D_WASI_EMULATED_MMAN`,
  `-D_WASI_EMULATED_PROCESS_CLOCKS`,
  plus the matching `libwasi-emulated-*` link flags and `-Wl,-u,__main_argc_argv`
  to prevent `--gc-sections` from eliminating BusyBox's main entry point.
- The recipe injects the pinned BusyBox config plus narrow compatibility
  headers in [`compat/include`](compat/include) covering POSIX functions
  absent in `wasm32-wasip1` (uid/gid, socket, signal, fork stubs, etc.).
- If BusyBox still needs more libc or POSIX surface than the builder path
  provides, that is treated as a concrete blocker for this recipe, not as a
  reason to broaden the phase-1 platform contract.

Sandbox mapping:

- The sandbox registers `busybox.wasm` as the `busybox` command.
- The sandbox exposes `grep`, `head`, and `seq` as aliases to the same binary
  while preserving `argv[0]` so BusyBox dispatches the selected applet.

Scope notes:

- This is a curated pilot only. It does not claim general BusyBox or POSIX
  support.
- The config stays intentionally narrow so the selected applets can be
  validated without over-promising broader command coverage.
