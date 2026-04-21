# BusyBox pilot recipe

This package defines the phase-1 BusyBox pilot as a recipe on top of
`scripts/build-c-port.sh`, not as a separate proof of the host C builder.

Enabled applets:

- `grep`
- `head`
- `seq`

Build path:

- `make copy-fixtures` fetches BusyBox source and uses
  `scripts/build-c-port.sh env` to export the shared `CC`, `AR`, and `RANLIB`
  toolchain contract for the upstream `make` build.
- The recipe runs `allnoconfig`, merges the curated
  [`busybox.config`](busybox.config) back into `.config`, then regenerates
  `include/autoconf.h` via `silentoldconfig` so the selected applets survive
  BusyBox's non-interactive Kconfig flow.
- The build step passes `CC`, `AR`, and `RANLIB` on the BusyBox `make`
  command line so upstream defaults do not fall back to host `gcc` / `ar`.
- The build step also adds the minimal WASI emulation flags and libraries
  required to get past BusyBox's unconditional libc headers:
  `-mllvm -wasm-enable-sjlj`,
  `-D_WASI_EMULATED_SIGNAL`,
  `-D_WASI_EMULATED_MMAN`,
  `-D_WASI_EMULATED_PROCESS_CLOCKS`,
  plus the matching `libwasi-emulated-*` link flags.
- A recipe-local `AR` wrapper emits an empty archive for kbuild directories
  with no selected objects, avoiding BusyBox's `ar: no archive members
  specified` failure without widening the curated applet set.
- The recipe injects the pinned BusyBox config plus the narrow compatibility
  headers in [`compat/include`](compat/include), currently
  [`paths.h`](compat/include/paths.h) and
  [`netdb.h`](compat/include/netdb.h) and
  [`mntent.h`](compat/include/mntent.h) and
  [`sys/statfs.h`](compat/include/sys/statfs.h) and
  [`sys/sysmacros.h`](compat/include/sys/sysmacros.h) and
  [`sys/wait.h`](compat/include/sys/wait.h) and
  [`termios.h`](compat/include/termios.h) and
  [`pwd.h`](compat/include/pwd.h) and
  [`grp.h`](compat/include/grp.h).
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
