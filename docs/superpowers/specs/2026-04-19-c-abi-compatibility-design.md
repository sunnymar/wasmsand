# C ABI Compatibility For codepod

> **Superseded for architectural direction by
> [`2026-04-19-guest-compat-runtime-design.md`](2026-04-19-guest-compat-runtime-design.md).**
> That document generalizes this C-only contract into a shared guest
> compatibility runtime that hosts both C and Rust frontends on a single
> compiled archive, with paired driver wrappers (`codepod-cc` /
> `cargo-codepod`) and a conformance tree. This spec stays as the
> authoritative behavioral description of the C-facing Tier 1 semantics —
> individual symbol contracts (dup2, getgroups, sched\_\*, signal, alarm,
> etc.) are not duplicated there and should be read from here. Everything
> else — repository layout, link-order policy, toolchain integration,
> verification strategy, and migration path — lives in the runtime design
> doc.

## Status

Proposed normative platform specification (behavioral contract subset;
architectural direction is now in the guest compatibility runtime design).

This document defines the behavioral contract for porting C programs to
codepod. It is intentionally stricter than "whatever happens to work with
`wasi-sdk` today." If a behavior is not described here, package authors
must not rely on it.

## Goals

- Support portable C programs that build into standalone WASM executables.
- Preserve standard `wasm32-wasip1` / `wasi-libc` behavior wherever possible.
- Add a narrow compatibility layer only for capabilities codepod actually implements.
- Make package-porting decisions explicit: support, patch, or skip.

## Non-Goals

- Full POSIX compatibility.
- Full glibc or musl compatibility.
- Shared objects, `dlopen()`, or a general `.so` runtime.
- Unix process tree semantics (`fork()`, `execve()`, full signals, job control).
- A promise that arbitrary upstream Unix software will compile unchanged.

## Conformance Terms

- **Supported**: package authors may rely on this behavior.
- **Partial**: behavior exists with documented limits; callers must tolerate those limits.
- **Extension**: behavior is available through codepod-specific APIs, not standard WASI/POSIX alone.
- **Unsupported**: package authors must not rely on it.
- **Toolchain-defined**: behavior may be exposed by `wasi-libc` or the compiler toolchain, but codepod does not separately guarantee it beyond the underlying runtime capability described here.

## Execution Model

codepod runs standalone WebAssembly executables. Each program executes as its own WASM process with isolated linear memory, standard I/O, and a virtual filesystem. Installed `pkg` applications are distributable WASM tools and may be launched in fresh sandboxes.

The platform contract is therefore:

- Deployment unit: standalone `.wasm` executable.
- Optional link inputs: static libraries.
- Runtime boundary: one program instance per WASM process.
- Packaging model: built-in tools or `pkg install <tool>`.

Shared libraries are out of scope for this platform version.

## ABI Model

codepod has two ABI layers:

### 1. Base ABI: WASI Preview 1

Programs target `wasm32-wasip1` and link against `wasi-libc`. File I/O, argv, environment, clocks, and other baseline facilities are provided through the `wasi_snapshot_preview1` import namespace.

### 2. Extension ABI: `codepod`

codepod also exposes a non-standard import namespace named `codepod`. It currently provides process-management, networking, extension, and native-module hooks. These imports are available to all WASM guests, but they are not standard POSIX or WASI.

Any future C compatibility layer must be built on top of these existing imports rather than replacing `wasi-libc`.

## Normative Portability Rules

Package authors targeting codepod may assume:

- A single-process WASM execution model.
- `wasi-libc`-style file and stdio behavior backed by an in-memory VFS.
- Standard argv and environment delivery.
- Clock and polling behavior only to the extent documented here.
- Optional network access only through policy-gated codepod facilities.

Package authors must not assume:

- A Unix kernel.
- A host process table.
- `fork()`, `execve()`, `waitpid()` as operating-system syscalls.
- shared-library loading.
- a full POSIX `pthread` contract.
- full Unix signals.
- WASI socket syscalls.

Package authors may rely on higher-level library support that does not preserve the traditional Unix implementation strategy. For example, a future `system()` or `popen()` implementation may be supported as a library function routed through codepod command execution, even though `fork()` and `execve()` remain unsupported.

## Capability Contract

### Process Lifecycle

Status: **Supported** for standalone program startup and exit. **Unsupported** for Unix process creation semantics.

The platform supports:

- Program startup with argv and environment.
- Normal return from `main()`.
- Process termination via `proc_exit`.
- Isolated child WASM processes when invoked through codepod runtime mechanisms.

The platform does not support:

- `fork()`
- `vfork()`
- `execve()`
- `posix_spawn()` as a guaranteed POSIX interface
- Unix re-parenting, process groups, sessions, or job control

Rationale: codepod can start new WASM programs, but it does not expose a Unix kernel process model. Subprocess-style behavior is therefore a runtime capability, not a POSIX process guarantee.

### Standard I/O And File Descriptors

Status: **Supported**, with some operations **Partial**.

The platform supports:

- `stdin`, `stdout`, `stderr`
- pipe-based composition
- file-descriptor reads and writes
- redirection semantics used by the shell
- descriptor renumbering through WASI `fd_renumber`

The platform partially supports:

- descriptor flag and sync operations that are treated as no-ops
- readiness polling for supported fd types

The platform does not support:

- signal-driven I/O
- tty-specific behavior
- full `ioctl()` semantics

### Files And Directories

Status: **Supported**.

The platform supports:

- regular files and directories in the in-memory VFS
- preopened directories
- symlinks
- file metadata queries
- directory iteration
- rename, unlink, create, truncate, seek

The platform partially supports:

- operations that are accepted as safe no-ops for compatibility

The platform does not support:

- hard links
- host filesystem access except through explicit mounts

### Time And Polling

Status: **Partial**.

The platform supports:

- realtime and monotonic clocks
- `poll_oneoff` for clock subscriptions
- `poll_oneoff` fd readiness for supported in-memory and pipe-backed fds
- clock resolution queries for realtime and monotonic clocks

The platform does not support:

- full Unix `select()` / `poll()` / `epoll()` semantics
- CPU-time clocks as a guaranteed interface

### Networking

Status: **Extension**.

The platform supports:

- HTTP fetch through `codepod.host_network_fetch`
- TCP/TLS sockets through `codepod.host_socket_*` in full network mode
- host allowlist / policy enforcement

The platform does not support:

- WASI socket syscalls
- unrestricted ambient networking

Any C socket or resolver API added later must be specified as a codepod compatibility extension, not as standard POSIX socket support.

### Subprocesses And Shell Command Execution

Status: **Extension**, not currently standardized for C.

The runtime already supports shell-command execution through `codepod.host_run_command`. Python uses this today for `subprocess` and `os.popen` shims. This proves the platform can support library-level subprocess behavior without supporting `fork()`.

Normative rule:

- codepod may standardize C library functions such as `system()` or `popen()` in a future compatibility layer.
- Such support must be documented as command-execution extensions, not as POSIX process semantics.
- No C subprocess function is guaranteed by this spec yet.

### Dynamic Loading And Shared Libraries

Status: **Unsupported**.

The platform does not support:

- `.so`
- `dlopen()`
- `dlsym()`
- ELF-style relocation and runtime linking

### Threads, Signals, And Async Process Control

Status: **Partial** for thread-adjacent compatibility behavior. **Unsupported** for a full guest thread runtime.

The platform supports:

- blocking and timeout behavior that lowers to WASI polling and clocks, including paths used by `sleep`-style APIs
- host-side worker-thread execution for sandbox management and hard-kill on supported runtimes
- cooperative concurrency across multiple WASM processes managed by the runtime

The platform does not support:

- a guaranteed POSIX `pthread` API contract
- guest-created native threads with shared linear memory as a portable platform guarantee
- `std::thread::spawn()`-style parallel execution as a guaranteed ABI contract for C/C++/Rust guests
- full asynchronous Unix signal delivery
- `kill()` with full POSIX semantics
- `alarm()`
- process-group control

Normative rule:

- Package authors may rely on thread-adjacent compatibility behavior only where codepod documents it explicitly.
- Package authors must not assume that software requiring real POSIX threads, thread-local scheduling semantics, or parallel shared-memory execution will work unchanged.

### Engine-Specific Thread And Concurrency Profile

Thread and concurrency behavior is engine-dependent. Package authors must treat the following matrix as normative:

| Engine / runtime path | Status | What may be relied on |
|---|---|---|
| `wasmtime` backend | Partial, strongest profile | runtime-managed concurrency; native host threading in the engine/backend; future wasi-threads support is plausible here, but guest `pthread` APIs are still not part of the base codepod contract unless explicitly standardized |
| Deno / Node.js with JSPI-capable execution | Partial | cooperative concurrency across multiple WASM instances; async host calls; polling/sleep behavior; worker-thread hard-kill on supported runtimes |
| Browser with JSPI | Partial | cooperative concurrency across multiple WASM instances; async host calls; polling/sleep behavior |
| Browser asyncify fallback | Partial, reduced | compatibility behavior for async host operations and polling remains available, but performance and scheduling characteristics are weaker than native JSPI |
| Bun | Unsupported as a general codepod execution engine today | do not rely on codepod's async-host / concurrency model here |

Normative consequences:

- A package that only needs sleep, timeouts, and runtime-managed concurrent processes may be portable across supported engines.
- Many programs that use threads mainly for blocking workers, background activity, or I/O overlap may still work acceptably on a cooperative runtime profile.
- A package that requires true guest-managed POSIX threads is not portable across codepod engines today.
- Engine-specific support must be called out explicitly by any future `pthread`-adjacent compatibility API.
- codepod does not yet define a package-manifest or installation-time mechanism for declaring thread requirements; that policy is deferred until a concrete need exists.

### Environment, Arguments, And Working Directory

Status: **Supported**.

The platform supports:

- argv
- environment variables
- current working directory behavior through the VFS/runtime

## Current WASI Runtime Matrix

This section maps the runtime contract codepod provides today.

### WASI Syscalls

| Category | Interface | Status | Notes |
|---|---|---|---|
| Process startup | `args_get`, `args_sizes_get` | Supported | argv is delivered normally |
| Environment | `environ_get`, `environ_sizes_get` | Supported | environment is delivered normally |
| Exit | `proc_exit` | Supported | terminates the current WASM process |
| Scheduling | `sched_yield` | Supported | cooperative yield only |
| File I/O | `fd_read`, `fd_write`, `fd_close`, `fd_seek`, `fd_tell`, `path_open` | Supported | backed by VFS and pipe targets |
| Positional I/O | `fd_pread`, `fd_pwrite` | Supported | positional read/write without changing offset |
| Directory ops | `fd_readdir`, `path_create_directory`, `path_remove_directory`, `path_rename` | Supported | directory iteration and mutation |
| Metadata | `fd_filestat_get`, `path_filestat_get`, `path_filestat_set_times` | Partial | some metadata writes are compatibility no-ops |
| Symlinks | `path_symlink`, `path_readlink` | Supported | symlink behavior is available |
| Polling | `poll_oneoff` | Partial | clock subscriptions and supported fd readiness only |
| Clocks | `clock_time_get`, `clock_res_get` | Partial | realtime and monotonic supported; CPU clocks not guaranteed |
| FD renumbering | `fd_renumber` | Supported | WASI-level equivalent of `dup2` |
| Sync / advisory | `fd_advise`, `fd_allocate`, `fd_datasync`, `fd_sync`, `fd_fdstat_set_flags`, `fd_filestat_set_size` | Partial | currently safe no-ops or compatibility behavior |
| Hard links | `path_link` | Unsupported | returns `ENOTSUP` |
| Sockets | `sock_recv`, `sock_send`, `sock_accept`, `sock_shutdown` | Unsupported | returns `ENOSYS`; use `codepod` imports instead |
| Signals | `proc_raise` | Unsupported | returns `ENOSYS` |

### `codepod` Imports

| Interface | Status | Notes |
|---|---|---|
| `host_pipe` | Extension | create pipe fds for WASM processes |
| `host_spawn` | Extension | spawn child WASM process through runtime |
| `host_waitpid` | Extension | wait for child runtime process exit |
| `host_close_fd` | Extension | close runtime fd |
| `host_read_fd` / `host_write_fd` | Extension | read/write runtime pipe fds |
| `host_dup` / `host_dup2` | Extension | duplicate runtime fds |
| `host_yield` | Extension | cooperative scheduling |
| `host_network_fetch` | Extension | policy-gated HTTP |
| `host_socket_connect/send/recv/close` | Extension | policy-gated TCP/TLS in full mode |
| `host_extension_invoke` | Extension | invoke host extensions |
| `host_run_command` | Extension | run shell command and capture output |
| `host_native_invoke` | Extension | invoke registered native module WASM |

## Current C / libc Surface

This section describes the contract package authors may rely on when compiling C code. It deliberately separates runtime capability from libc symbol policy.

### Baseline C Library Surface

The following areas are **Supported** at the platform level because the underlying WASI behavior is implemented:

| libc / POSIX area | Status | Notes |
|---|---|---|
| `main(int argc, char** argv)` | Supported | standard process startup |
| `getenv`, `setenv`-style environment access | Toolchain-defined | underlying environment delivery is supported |
| `fopen`, `fclose`, `fread`, `fwrite`, `fflush`, `fseek`, `ftell` | Toolchain-defined | supported to the extent `wasi-libc` maps them onto WASI file I/O |
| `open`, `close`, `read`, `write`, `lseek` | Toolchain-defined | underlying fd operations are supported |
| `opendir`, `readdir`, `closedir` | Toolchain-defined | underlying directory operations are supported |
| `stat` / `fstat`-style metadata queries | Toolchain-defined | backed by WASI metadata syscalls |
| `rename`, `unlink`, `mkdir`, `rmdir` | Toolchain-defined | backed by VFS mutation |
| `symlink`, `readlink` | Toolchain-defined | supported through WASI path operations |
| `sleep` / timeout paths that lower to `poll_oneoff` | Toolchain-defined | supported within the documented polling limits |

These are **Partially Supported**:

| libc / POSIX area | Status | Notes |
|---|---|---|
| `dup2` and related fd-renumber behavior | Toolchain-defined / Partial | runtime semantics exist via WASI `fd_renumber`; exact libc exposure depends on toolchain |
| `fcntl`-style flag mutation | Partial | only the subset expressible by current runtime semantics should be promised |
| `poll` / `select`-style readiness APIs | Partial | must be constrained to supported fd types and clock semantics if exposed |
| `sleep`, `usleep`, `nanosleep`-style timeout behavior | Toolchain-defined / Partial | supported where the toolchain lowers these paths to the documented WASI clock / polling behavior |
| `sched_getaffinity`, `sched_setaffinity` | Partial | codepod presents a Linux-like single visible CPU; get reports CPU `0` only, and set accepts only masks selecting CPU `0` |
| limited thread-adjacent APIs | Partial | any support is engine-dependent and must be documented explicitly; cooperative execution may be sufficient for some programs, but no full `pthread` portability guarantee exists |

These are **Unsupported**:

| libc / POSIX area | Status | Notes |
|---|---|---|
| `fork`, `vfork`, `exec*` | Unsupported | no Unix process model |
| `waitpid` as an OS syscall contract | Unsupported | runtime child waiting exists only through codepod extensions |
| `socket`, `connect`, `bind`, `listen`, `accept` as POSIX guarantees | Unsupported today | raw networking exists only as codepod extensions, not libc contract |
| `dlopen`, `dlsym` | Unsupported | no shared-library runtime |
| `mmap`, `munmap`, `mprotect` as a platform guarantee | Unsupported | not part of the current contract |
| `kill`, `signal`, `sigaction` | Unsupported | no signal delivery |
| `pthread_create` and general parallel shared-memory `pthread` execution | Unsupported as a portable contract | engine-specific backend internals do not currently imply a guest-visible POSIX thread guarantee |
| `pthread_kill`, thread signals, thread scheduling controls | Unsupported | no signal/thread-control contract |

### Library Functions That May Exist Without Their Traditional Syscalls

Normative rule:

If codepod standardizes a library function through a compatibility layer, the function contract takes precedence over the traditional Unix implementation model.

Examples:

- `system()` may be supported in the future by routing through `host_run_command`.
- `popen()` may be supported in the future by routing through command execution plus captured pipes.
- Such support does not imply support for `fork()`, `execve()`, or anonymous child process state.

This rule is already reflected in the runtime architecture: Python subprocess support exists today without exposing Unix process syscalls to guest code.

## Proposed Direction For The C Compatibility Layer

The compatibility layer should:

- keep `wasi-libc` as the base C library
- add narrowly-scoped headers and helper objects for codepod extensions
- expose only capabilities backed by the existing runtime
- define explicit feature macros for codepod-specific behavior

It should not:

- replace libc wholesale
- claim general POSIX compatibility
- emulate unsupported Unix semantics for compatibility theater

## Phase 1 Builder And Recipe Contract

Phase 1 standardizes a host-side builder around `clang` from `wasi-sdk`. The
supported path is `scripts/build-c-port.sh`, either invoked directly for small
programs or through its `env` mode for upstream `make`-driven recipes.

Normative consequences:

- codepod does not promise in-sandbox C compilation.
- BusyBox is treated as the first recipe consumer of this builder, not as proof
  that the platform broadly supports Unix software unchanged.
- The BusyBox pilot scope is limited to selected applets (`grep`, `head`,
  `seq`) registered through multicall aliases.
- Additional libc or POSIX assumptions discovered while building BusyBox are
  blockers for that recipe until explicitly standardized or patched.

## Initial Porting Profile

The first target profile should be:

- standalone CLI-style programs
- programs that mainly need stdio, file I/O, directories, clocks, and possibly shell-command execution
- optional networking only where it can be cleanly mapped to `codepod` imports

Good candidates:

- text-processing tools
- archive and document utilities
- self-contained database utilities such as `sqlite`

Poor candidates:

- daemons
- software that requires shared libraries at runtime
- software that assumes `fork()`-heavy worker models
- software that depends on full pthread semantics, signals, or shared-library loading

## Appendix: What This Spec Means For Porters

When evaluating an upstream C package for codepod:

1. Check whether it fits the standalone executable model.
2. Check whether it only depends on the supported baseline C/WASI surface.
3. If it needs more, determine whether the need maps to an existing codepod extension.
4. If yes, add a narrow compatibility API or patch the package.
5. If no, skip the package rather than faking Unix semantics the runtime does not have.

This is the intended standard: codepod supports a deliberate, documented subset of Unix-like C software on top of WASI, not a hidden pseudo-Linux environment.
