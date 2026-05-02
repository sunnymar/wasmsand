# Asyncify Continuation Fork

## Status

Proposed design for POSIX-style `fork()` inside a Codepod sandbox.

This extends the existing Asyncify-backed `setjmp` / `longjmp` machinery.
Normal modules remain JSPI-capable and do not pay the Asyncify size or runtime
cost. Only modules that opt into continuation support can call `fork()`.

## Problem

Codepod currently has process identity, `posix_spawn`, specific-child
`waitpid`, pipes, sockets, and fd ownership, but `fork()` and `vfork()` return
`ENOSYS`.

Some real ports still need `fork()`:

- shells that fork for subshells, pipelines, and command execution
- BusyBox applets that expect Unix process duplication
- future ports that use fork before a more specific process API can replace it

WebAssembly does not expose an engine-level way to clone a live instance.
The JS API can instantiate a module and read linear memory, but it cannot clone
an instruction pointer, native Wasm stack, or arbitrary non-exported instance
state. JSPI can suspend an import, but it does not expose a clonable suspended
continuation.

Asyncify is the practical exception. It rewrites the guest so the active Wasm
stack can be unwound into linear memory and later rewound. `fork()` can use the
same shape as `setjmp` / `longjmp`: unwind at a controlled import boundary,
copy the process state, then rewind twice with different return values.

## Goals

1. Add opt-in `fork()` support for Codepod-built continuation modules.
2. Reuse the existing Asyncify continuation path instead of adding a second
   build mode.
3. Rename the user-facing toolchain opt-in from `CPCC_USE_SETJMP` to a broader
   continuation flag.
4. Preserve normal module behavior: default builds do not run Asyncify and
   continue to return `ENOSYS` for `fork()`.
5. Implement POSIX-like return behavior:
   - parent receives the child PID
   - child receives `0`
   - failure returns `-1` and sets `errno`
6. Create the child as a new process in the same sandbox PID namespace.
7. Copy guest linear memory while sharing immutable compiled module code.
8. Inherit fd tables with POSIX-style shared open file descriptions.
9. Share the sandbox VFS namespace between parent and child.
10. Fail closed for unsupported module/runtime states.

## Non-Goals

- `vfork()` semantics in the first fork slice.
- `execve()` / process image replacement.
- Unix job control, controlling terminals, process groups beyond current
  Codepod behavior, or full signal delivery.
- Forking multi-threaded Wasm guests or SharedArrayBuffer-backed memories.
- Engine-native snapshotting.
- Supporting arbitrary third-party Wasm modules that were not built through the
  Codepod continuation profile.
- Duplicating in-flight network requests, timers, or other external host work.
- Copy-on-write linear memory in the first implementation. Full memory copy is
  acceptable initially.

## Terminology

`Sandbox.fork()` and POSIX `fork()` are different operations.

- `Sandbox.fork()` clones a whole Codepod sandbox between commands.
- POSIX `fork()` duplicates one running process inside the same sandbox.

This spec is about POSIX `fork()`.

The term "continuation module" means a module built with the Codepod
continuation opt-in. A continuation module is Asyncify-instrumented and may use
`setjmp`, `longjmp`, and `fork`.

The term "open file description" uses the POSIX meaning: fd numbers are copied
on fork, but the underlying open file state is shared. In particular, regular
file offsets, pipe endpoints, and socket endpoints are shared/refcounted.

## Toolchain Contract

### User-Facing Flags

Rename the primary opt-in:

```text
CPCC_USE_CONTINUATIONS=1
```

This replaces:

```text
CPCC_USE_SETJMP=1
```

`CPCC_USE_SETJMP=1` remains a compatibility alias during the migration. If both
flags are present, either one enables continuation mode unless explicitly set to
`0`.

The archive override is renamed the same way:

```text
CPCC_CONTINUATIONS_ARCHIVE=/path/to/libcodepod_continuations.a
```

`CPCC_SETJMP_ARCHIVE` remains a compatibility alias. The default archive name
becomes:

```text
libcodepod_continuations.a
```

The guest compile define becomes:

```text
CODEPOD_USE_CONTINUATIONS=1
```

`CODEPOD_USE_SETJMP=1` may be emitted as a transition define for code that has
not been renamed yet, but new code should key off `CODEPOD_USE_CONTINUATIONS`.

### Continuation Mode Effects

When continuation mode is enabled, `cpcc` must:

1. Link the normal `libcodepod.a`.
2. Link `libcodepod_continuations.a`.
3. Run `wasm-opt --asyncify`.
4. Emit a `codepod.features` custom section declaring continuation support.
5. Preserve default non-continuation behavior when the flag is absent.

The stable feature payload is:

```json
{"async":"asyncify","features":["continuations"]}
```

During migration the runtime must also accept the legacy feature name:

```json
{"async":"asyncify","features":["setjmp"]}
```

The toolchain may emit both feature names for one transition slice, but the
long-term feature is `continuations`.

### Default Fork Stub

The current default `fork()` / `vfork()` stubs live in the always-linked
compatibility archive and return `ENOSYS`. Continuation mode needs a real
`fork()` implementation to win at link time without relying on accidental
multiple-definition behavior.

The implementation must make this explicit by using one of these shapes:

1. Make the default `fork()` / `vfork()` stubs weak symbols and provide a strong
   `fork()` in `libcodepod_continuations.a`.
2. Split default process stubs so continuation builds do not link the default
   `fork()` object.

The implementation plan can choose the lower-risk option, but tests must prove:

- a default build that calls `fork()` links and returns `ENOSYS`
- a continuation build that calls `fork()` imports `codepod.host_fork`
- the continuation `fork()` implementation wins over the default stub

## Guest ABI

Add one host import:

```c
__attribute__((import_module("codepod"), import_name("host_fork")))
int codepod_host_fork(void);
```

`libcodepod_continuations.a` provides:

```c
pid_t fork(void);
```

The shim calls `codepod_host_fork()`.

Return convention:

- `rc >= 0`: return `rc` to the caller
  - parent sees `rc == child_pid`
  - child sees `rc == 0`
- `rc < 0`: set `errno = -rc` and return `-1`

The host should use POSIX errno values:

- `-ENOSYS`: fork unavailable in this runtime/build
- `-EAGAIN`: process limit, unsupported temporary state, or scheduler refusal
- `-ENOMEM`: memory clone failed

`vfork()` remains `ENOSYS` in the first slice. Mapping `vfork()` to `fork()`
would be safer than true `vfork()`, but it can hide bugs in software that
depends on parent suspension and shared address space. Treat it as a follow-up.

## Loader Validation

The process loader must fail closed:

1. If a module imports `codepod.host_fork`, it must declare continuation support
   through `codepod.features`.
2. If a module declares continuation support, it must export the Asyncify
   control functions:
   - `asyncify_start_unwind`
   - `asyncify_stop_unwind`
   - `asyncify_start_rewind`
   - `asyncify_stop_rewind`
   - `asyncify_get_state`
3. Continuation modules must run under the Asyncify bridge even if JSPI is
   available.
4. Non-continuation modules must not be forced onto Asyncify because they import
   unrelated async host functions.

The loader should produce clear errors such as:

```text
module imports host_fork but lacks codepod.features continuations marker;
rebuild with CPCC_USE_CONTINUATIONS=1
```

and:

```text
module declares continuations but is not asyncify-instrumented
```

## Runtime Architecture

`fork()` is implemented as a cooperative continuation operation in
`AsyncifyAsyncBridge`.

At a high level:

1. Guest calls `fork()`.
2. The C shim calls `codepod.host_fork`.
3. `host_fork` records a pending fork and starts an Asyncify unwind.
4. The wrapped export returns to the host with Asyncify state `UNWINDING`.
5. The bridge stops the unwind and asks the process kernel to create a child.
6. The process kernel snapshots parent process state and copies parent memory.
7. The process kernel registers the child process record and returns its PID.
8. The parent rewinds the continuation and `host_fork` returns `child_pid`.
9. The child process is instantiated from the same `WebAssembly.Module`.
10. Child memory is initialized from the copied snapshot.
11. Child rewinds the same continuation and `host_fork` returns `0`.
12. Parent and child continue as separate processes.

This requires the process runner to know the active root export. For `_start`
processes, the child driver re-enters `_start` while Asyncify is in rewind
state. For resident exported calls, the runner re-enters the same wrapped
export with the same arguments.

## Asyncify Bridge Changes

Extend `AsyncifyAsyncBridge` with fork state:

```ts
type PendingFork = {
  parentPid: number;
};

type ForkReturn = {
  value: number;
};
```

The bridge needs a kernel callback rather than owning process creation itself:

```ts
interface ForkController {
  forkFromContinuation(snapshot: ForkSnapshot): number;
}
```

`forkFromContinuation` must synchronously allocate the child PID, clone memory,
clone fd/process state, and register the child process record. It may enqueue
the actual child Wasm instantiation as a later async task using the already
copied snapshot.

`hostFork` behavior:

- NORMAL state:
  - set `pendingFork`
  - call `asyncify_start_unwind(dataAddr)`
  - return `0`, ignored during unwind
- REWINDING state:
  - call `asyncify_stop_rewind()`
  - return the pending fork return value

`wrapExport` gains a fork branch in the unwind loop:

```ts
if (pendingFork) {
  stopUnwind();
  const childPid = controller.forkFromContinuation(snapshot);
  pendingForkReturn = { value: childPid };
  startRewind(dataAddr);
  result = fn(...args);
}
```

The child bridge starts from the cloned snapshot with:

```ts
pendingForkReturn = { value: 0 };
asyncify_start_rewind(dataAddr);
entryExport(...entryArgs);
```

The exact TypeScript shape can differ, but the bridge must keep the state
machine explicit. `fork()` must not be modeled as a normal async import that
only awaits a Promise, because it duplicates the continuation rather than only
suspending it.

## Fork Snapshot

The fork snapshot contains process state, not the whole sandbox:

```ts
interface ForkSnapshot {
  module: WebAssembly.Module;
  entryExportName: string;
  entryArgs: number[];
  memoryBytes: Uint8Array;
  memoryPages: number;
  asyncifyDataAddr: number;
  asyncifyDataSize: number;
  asyncifySavedHigh: number;
  asyncifySavedData: Uint8Array;
  bridgeContinuationState: BridgeContinuationState;
  process: ProcessForkState;
}
```

`BridgeContinuationState` includes saved `setjmp` buffers. A child forked after
one or more successful `setjmp` calls must inherit those saved jump targets.

`ProcessForkState` includes:

- parent PID
- argv
- environment
- cwd
- process mode
- deadline / resource limit references
- fd table snapshot
- signal/process metadata currently tracked by the kernel

The snapshot is created after `asyncify_stop_unwind()`, while the unwound stack
is represented in linear memory. The implementation must copy memory before
rewinding the parent.

## Memory Semantics

Each forked process gets its own `WebAssembly.Instance` and its own linear
memory.

The compiled `WebAssembly.Module` is shared through the module cache. Immutable
code is loaded once; mutable process state is copied.

Memory copy rules:

- Copy the full current linear memory byte range.
- Grow child memory to the same page count before copying.
- Reject SharedArrayBuffer-backed memories in the first slice.
- Reject or fail clearly if the child memory cannot grow to the parent size.

Initial support is for Codepod cpcc-produced continuation modules. Arbitrary
Wasm modules may keep mutable runtime state in non-exported Wasm globals or
tables that the JS API cannot snapshot. The implementation must not document
generic Wasm fork support until that class of state is either validated,
rejected, or made snapshot-safe.

## File Descriptor Semantics

`fork()` copies the fd table by fd number.

The copied entries reference the same underlying open file descriptions:

- regular-file offsets are shared
- pipe endpoints are shared and refcounted
- socket endpoints are shared and refcounted
- stdout/stderr buffer targets are shared unless redirected
- close in one process decrements the reference and does not invalidate the
  other process's fd number
- EOF on a pipe is delayed until all write-end references are closed

This may require a fd-layer refactor before `fork()` lands. The process kernel
must be able to distinguish an fd table entry from the underlying open object.

Close-on-exec flags can be tracked now if convenient, but `execve()` is out of
scope for this slice.

## VFS Semantics

Parent and child share the same sandbox VFS namespace.

`fork()` does not create a new layered VFS overlay and does not call
`Sandbox.fork()`. File changes made by either process are visible to the other
process, matching Unix process semantics.

The layered VFS work remains relevant for sandbox construction and persistence,
but POSIX `fork()` is a process operation inside one sandbox.

## Scheduling Semantics

The child is scheduled as an independent Codepod process after the fork snapshot
is created.

The parent and child run cooperatively on the JS event loop. Their relative
execution order is not guaranteed except where existing synchronization makes it
observable:

- `waitpid(child_pid, ...)`
- pipes
- sockets
- explicit yield/sleep primitives
- process exit

The fork snapshot operation itself must be atomic with respect to the parent
process. It must not `await` between cloning memory, cloning fd/process state,
and registering the child. In practice this means the kernel critical section
must be synchronous after Asyncify has unwound.

## Resource And Security Semantics

The child inherits the parent's sandbox policy:

- network policy
- filesystem mounts and VFS namespace
- extension policy
- memory and process limits
- deadline / cancellation scope, unless a future API defines per-process
  deadline inheritance differently

The process kernel must enforce a maximum process count. If the limit would be
exceeded, `fork()` returns `-1` with `errno = EAGAIN`.

Fork must never clone state across sandbox boundaries.

## Interaction With Existing APIs

### `posix_spawn`

`posix_spawn` remains the preferred non-continuation process API. Programs that
can use `posix_spawn` should continue to work without Asyncify.

### `waitpid`

Existing specific-child `waitpid(pid > 0)` should work for forked children.

`wait()` and `waitpid(-1, ...)` are not required by this fork slice. They remain
natural follow-ups because shells often want wait-any behavior.

### `execve`

`execve()` is not part of this spec.

That means the first fork milestone validates fork-only behavior, child exit,
memory divergence, fd inheritance, and wait. Full shell fork/exec command
execution needs a later `execve` or fork-aware spawn design.

### `setjmp` / `longjmp`

`setjmp` and `longjmp` move under the same continuation mode.

Existing setjmp canaries must continue to pass after the rename. A process that
forks after saving a `jmp_buf` must copy the saved bridge state so parent and
child can use their inherited jump buffers independently.

### Threads

Forking a multi-threaded guest is unsupported in the first slice. If the process
has created Codepod guest threads or uses shared memory, `fork()` returns
`-1/EAGAIN` or `-1/ENOSYS` with a clear diagnostic in debug logs.

## Error Handling

The guest-visible behavior is POSIX-like:

```c
pid_t pid = fork();
if (pid < 0) {
  /* errno explains the failure */
}
```

Runtime errors map as follows:

| Runtime condition | Guest errno |
| --- | --- |
| `host_fork` unavailable | `ENOSYS` |
| module not in continuation mode | loader error |
| continuation metadata but missing Asyncify exports | loader error |
| process limit exceeded | `EAGAIN` |
| unsupported pending state | `EAGAIN` |
| shared memory / guest threads active | `EAGAIN` or `ENOSYS` |
| memory clone failed | `ENOMEM` |

Loader errors are acceptable for malformed artifacts because those artifacts
cannot run `fork()` correctly. Runtime limitations for a valid artifact should
return `-1` and set `errno`.

## Tests And Acceptance

### Toolchain Tests

- `CPCC_USE_CONTINUATIONS=1` links `libcodepod_continuations.a`.
- `CPCC_USE_CONTINUATIONS=1` runs `wasm-opt --asyncify`.
- `CPCC_USE_CONTINUATIONS=1` emits `codepod.features` with
  `continuations`.
- `CPCC_USE_SETJMP=1` remains an alias and emits a compatibility warning or
  documented deprecation note.
- Default builds do not include `--asyncify`.
- A default build that calls `fork()` links and returns `ENOSYS`.
- A continuation build that calls `fork()` imports `codepod.host_fork`.
- A continuation build's strong `fork()` implementation wins over the default
  stub.

### Loader Tests

- A module importing `host_fork` without continuation metadata fails to load.
- A module declaring continuation metadata without Asyncify exports fails to
  load.
- A continuation module runs under `AsyncifyAsyncBridge` even when JSPI exists.
- A non-continuation module still uses JSPI when available.
- Legacy `codepod.features` containing `setjmp` still enables existing setjmp
  canaries during the migration.

### Runtime Canaries

Add C canaries under guest compatibility conformance:

1. Basic return split:
   - parent prints `parent:<child_pid>`
   - child prints `child:0`
   - both exit cleanly
2. PID relationship:
   - child `getppid()` is parent PID
   - parent can `waitpid(child_pid, ...)`
3. Memory copy:
   - parent and child mutate the same global after fork
   - values diverge
4. Saved setjmp state:
   - save a `jmp_buf`
   - fork
   - parent and child can use continuation state independently
5. Shared fd offset:
   - parent opens a file and reads one byte
   - child reads from inherited fd and observes the next byte
6. Pipe refcounts:
   - parent creates pipe and forks
   - EOF is not observed until all write-end references close
7. VFS namespace sharing:
   - child writes a file
   - parent sees it after wait
8. Resource limit:
   - process limit forces `fork()` to fail with `EAGAIN`

### Integration Tests

- A small shell-oriented canary forks a child, redirects stdout, waits, and
  observes the child output.
- Existing `setjmp` / `longjmp` tests continue to pass in continuation mode.
- Existing `posix_spawn` tests continue to pass without continuation mode.
- `git diff --check` and the relevant Deno/Rust checks pass for the touched
  packages.

## Implementation Slices

1. Rename toolchain surface:
   - add `CPCC_USE_CONTINUATIONS`
   - keep `CPCC_USE_SETJMP` alias
   - rename archive plumbing
   - update metadata helpers
2. Move setjmp support into `libcodepod_continuations.a`.
3. Make default `fork()` stubs explicitly overridable or split from the base
   archive.
4. Add `host_fork` declarations and the continuation `fork()` shim.
5. Extend loader validation from `setjmp` to `continuations`.
6. Extend `AsyncifyAsyncBridge` with explicit fork state.
7. Add synchronous process-kernel snapshot and child process registration.
8. Add memory clone / async child instance rewind from the copied snapshot.
9. Refactor fd tables to support shared open file descriptions if needed.
10. Add conformance canaries and acceptance tests.

## Open Follow-Ups

- `execve()` or a fork-aware spawn path for full fork/exec shell behavior.
- `wait()` / `waitpid(-1)` wait-any support.
- `vfork()` semantics or a deliberate `vfork -> fork` compatibility mode.
- Copy-on-write linear memory optimization.
- Validation or rejection of non-cpcc Wasm mutable-global/table state.
- Browser persistence of forked process trees across sandbox suspend/resume.
