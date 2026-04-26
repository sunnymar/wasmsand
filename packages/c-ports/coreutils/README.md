# GNU coreutils port

C port of [coreutils/coreutils](https://github.com/coreutils/coreutils)
v9.11 for `wasm32-wasip1` via the codepod `cpcc` toolchain.  Six
tools that BusyBox doesn't ship and we previously had as Rust
standalones: **csplit, fmt, join, numfmt, sha224sum, sha384sum**.

## Status

**Working.**  All six tools build, link, and pass conformance tests
in the sandbox.  Conformance: `packages/orchestrator/src/__tests__/coreutils-conformance.test.ts`.

### Compat-layer fixes already landed for this port

This port has driven a substantial expansion of the compat layer.
Each fix below is broadly useful — future ports inherit it.

- **`-std=gnu23`** as cpcc default (was `-std=c11`).  Gives us the
  C23 `nullptr` keyword and `unreachable()` from `<stddef.h>`, both
  required by gnulib's modern code paths.
- **`NSIG=32`** in `signal.h` (was 65; gnulib's `verify_NSIG_constraint`
  enforces ≤32 and we don't model RT signals).
- **`GNULIB_defined_struct_sigaction=1`** so gnulib accepts our
  struct layout instead of redefining its own.
- **`<sys/wait.h>`** — POSIX wait surface (W*EXITSTATUS macros,
  WNOHANG, etc., plus wait/waitpid prototypes).
- **`<sys/stat.h>` shim** declaring `umask` (wasi-libc gates it on
  `__wasilibc_unmodified_upstream`).
- **`<dirent.h>` shim** that hides wasi-libc's 2-arg `opendirat`
  (clashes with gnulib's 4-arg version).
- **`<fcntl.h>` shim** that defines `F_DUPFD=0` (Linux convention)
  before gnulib falls back to `F_DUPFD=1`, which would collide
  with wasi-libc's `F_GETFD=1` in fcntl-op switch statements.
- **`wait`/`waitpid`** real impls routed through `host_waitpid`
  (async, wrapped via JSPI/asyncify by the orchestrator) — blocking
  waits work end-to-end regardless of scheduler backend.
- **`codepod_fs.c`** — real symbols for `chown`/`lchown`/`fchown`/
  `fchdir`/`chroot`/`getpriority`/`setpriority`/`getrusage`/
  `flockfile`/`funlockfile`/`ftrylockfile`/`qsort_r`/`setresuid`/
  `setresgid`.  All previously static-inline (which collided with
  gnulib's REPLACE_* replacements at compile time).  Now real
  exported symbols, so gnulib's autoconf detects them at link
  probe time and skips compiling its own copies.
- **Process group / session family** in `codepod_process.c` —
  `umask`, `getpgrp`/`getpgid`/`setpgid`/`setpgrp`/`getsid`/
  `setsid`/`tcgetpgrp`/`tcsetpgrp` as real symbols.  All gated by
  `__wasilibc_unmodified_upstream` in wasi-libc.
- **`codepod_mktemp.c`** — moved `mktemp`/`mkstemp`/`mkostemp`/
  `mkdtemp` from header-inline to real symbols.  Same root cause
  as the fs symbols above.
- **`CPCC_INCLUDE`/`CPCC_ARCHIVE`** are now passed during the
  configure step too, not only the build.  Without that, autoconf
  link probes don't see our compat library and incorrectly conclude
  every POSIX symbol is missing — defaulting to gnulib's replacement
  for everything.

### Final fixes that landed the build

- **Patches for gnulib platform-port aborts** — `patches/0001-add-wasi-locale-and-mountlist.patch` adds `__wasi__` arms to `lib/getlocalename_l-unsafe.c` and `lib/mountlist.c`, both of which had `#error "Please port to your platform"` falling through every `#ifdef`.  Locale returns "C.UTF-8"; mount list returns empty.
- **`PARSE_DATETIME_BISON` override** — configure sets it to `:` (no-op) during cross-compile because there's no `wasm32-wasi-bison`.  Override at `make` time using brew's bison 3.x (macOS' system bison is 2.3 for licensing reasons; coreutils' parser uses bison 3+ syntax).
- **`-lwasi-emulated-signal` dropped from LDFLAGS** — codepod ships its own `signal`/`raise`/`sigaction`/etc. in `libcodepod_guest_compat.a` which conflict with wasi-emulated-signal's stubs.  `-lwasi-emulated-mman` and `-lwasi-emulated-process-clocks` stay (the latter provides `getrusage`).
- **`getrusage` removed from codepod_fs.c** — wasi-emulated-process-clocks already provides it; defining ours duplicated the symbol.
- **`PACKAGE_VERSION` override in Makefile + post-configure sed on config.h** — AC_INIT bakes "UNKNOWN" because our rsync strips `.git`; we patch the version into both `config.h` and the per-tool make-time variable.

## Layout

- `upstream/` — coreutils submodule pinned to v9.11.
  - `upstream/gnulib/` — coreutils' own gnulib submodule (nested).
- `patches/` — empty; we'd populate with gnulib-specific patches if
  we end up needing them.
- `build/work/` — out-of-tree build dir (rsync of upstream + bootstrap
  + configure).
- `Makefile` — submodule-init + bootstrap + configure + per-tool
  build targets.

## Build (when unblocked)

```bash
make copy-fixtures   # builds and deploys all six wasm artifacts
```

Currently `make build/work/lib/libcoreutils.a` runs partway and exits
with the gaps above.  Per-tool `make build/<name>.wasm` will fail at
the same point until the gnulib gaps are resolved.

## Why not patch upstream?

The codepod c-port policy is "improve the compat layer first, patch
upstream only as last resort."  Each gnulib gap above is a real piece
of POSIX/C23 surface we're missing; fixing it benefits every future
port too.  The gaps are tracked in tasks; this README will go away
once the build goes green.

## Cross-compile cache vars

The Makefile pre-seeds these because configure can't probe them at
cross-compile time:

```
gl_cv_func_mmap_anon=no
gl_cv_func_mmap_dev_zero=no
gl_cv_func_mmap_file=no
ac_cv_func_mmap_fixed_mapped=no
ac_cv_func_fork=no
ac_cv_func_vfork=no
gl_cv_func_setlocale_null_all_mtsafe=yes
gl_cv_func_setlocale_null_mtsafe=yes
gl_cv_pthread_rwlock_rdlock_prefer_writer=yes
```
