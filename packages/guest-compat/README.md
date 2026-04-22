# codepod C Compatibility

Phase 1 provides a narrow, supported build path for standalone C executables
compiled with `wasi-sdk`.

Included in this package:

- a minimal public compatibility header for the phase-1 build path
- a narrow libc-compat scheduler-affinity layer for single-CPU guests
- narrow libc-compat header overrides for selected POSIX APIs
- a private runtime header for host import declarations
- plain-WASI canaries for stdio/file I/O and sleep behavior
- a shared host-side toolchain (`cpcc`/`cpar`/`cpranlib`/`cpcheck`/`cpconf`)
  under `toolchain/cpcc/`, built as workspace release binaries
- a Make-driven entrypoint that can build the archive, the canaries, and
  copy canary fixtures into the orchestrator test directory

Later recipe tasks consume the same toolchain for larger C ports such as
BusyBox (see `packages/c-ports/busybox/`). This package only validates the
toolchain against the phase-1 canaries.

Not included yet:

- full POSIX compatibility
- sockets as libc APIs
- shared libraries

## Build canaries

Build the archive and all canaries:

```bash
make -C packages/guest-compat all
```

Copy the resulting artifacts into the orchestrator fixture directory:

```bash
make -C packages/guest-compat copy-fixtures
```

Or run the full conformance flow end-to-end (toolchain build, archive,
canaries, signature checks, orchestrator behavioral suite):

```bash
./target/release/cpconf
```

Phase 1 C builds are host-side cross-compiles driven by `cpcc`, which
wraps `wasi-sdk`'s clang with the right `--target=wasm32-wasip1` /
`--sysroot=` / `--whole-archive` framing. Ports such as BusyBox invoke
`cpcc` / `cpar` / `cpranlib` as `CC` / `AR` / `RANLIB` directly; see
`packages/c-ports/busybox/Makefile`.

## Phase 1 delivered

- `stdio-canary`
- `sleep-canary`
- `system-canary`
- `popen-canary`
- `affinity-canary`
- `dup2-canary`
- host-side `clang` / `wasi-sdk` driver wrapper via `cpcc` (+ companions
  `cpar` / `cpranlib` / `cpcheck` / `cpconf`)
- BusyBox pilot recipe scaffolding for `grep`, `head`, and `seq`

## Compatibility headers

The shared compatibility layer currently ships these public headers in
[`include/`](include):

- [`codepod_compat.h`](include/codepod_compat.h): codepod-specific extension APIs such as `codepod_system()` and `codepod_popen()`
- [`sched.h`](include/sched.h): single-visible-CPU affinity compatibility (`sched_getaffinity`, `sched_setaffinity`, `sched_getcpu`, `CPU_*`)
- [`unistd.h`](include/unistd.h): narrow POSIX fd and identity compatibility currently providing `dup2()` and `getgroups()`
- [`signal.h`](include/signal.h): narrow signal compatibility for `signal`, `sigaction`, `raise`, `alarm`, and basic signal-set helpers

These headers are intentionally narrow. They describe the compatibility layer
that codepod actually implements today, not a full libc replacement.

## Single-CPU affinity contract

The phase-1 compat layer exposes a Linux-like single visible CPU:

- `sched_getaffinity()` reports only CPU `0`
- `sched_setaffinity()` accepts only masks selecting CPU `0`
- masks that exclude CPU `0` or include any other CPU fail with `EINVAL`

## File descriptor compatibility

The phase-1 compat layer currently provides a narrow `dup2()` contract:

- `dup2(oldfd, newfd)` is supported for guest-visible fd renumbering
- `dup2(1, 2)` and similar stdio redirections operate on the guest's actual
  WASI I/O targets
- invalid descriptors fail with `EBADF`

## Identity compatibility

The phase-1 compat layer currently provides a narrow `getgroups()` contract:

- `getgroups(0, NULL)` reports a single visible group
- `getgroups(1, list)` stores the single visible guest group id `0` in `list[0]`
- larger buffers are accepted, but only one group is currently reported
- this is a portability shim for software that expects basic group membership
  inspection, not a full Unix credential model

## Signal compatibility

The phase-1 compat layer currently provides a narrow signal contract:

- `signal()` and `sigaction()` install process-local handlers
- `raise()` synchronously dispatches to installed handlers
- default handling terminates the process for `SIGINT`, `SIGTERM`, and `SIGALRM`
- `alarm()` currently supports cancellation/state tracking but does not yet
  promise wall-clock asynchronous delivery
- signal-set helpers (`sigemptyset`, `sigfillset`, `sigaddset`, `sigdelset`,
  `sigismember`, `sigprocmask`, `sigsuspend`) exist for source compatibility,
  with partial semantics suitable for current ports such as BusyBox

This contract is intended to become the shared platform rule for both the C
compatibility layer and the Rust-side libc surface. It is not a promise of full
POSIX signal semantics.

## Deferred

- socket libc shims
- `fork()` / `exec()` semantics
- portable `pthread` guarantees
- in-sandbox C compilation
- broad BusyBox or POSIX compatibility claims
