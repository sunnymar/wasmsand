# WASIX Portability And Kernel Lessons

## Status

Investigation note from 2026-04-30.

Evidence was gathered in the isolated experiment worktree at
`/Users/sunny/work/codepod/codepod/.worktrees/wasix-portability` on branch
`experiment/wasix-portability`. The browser leg is not complete yet: Chrome
and Safari have not been run with a dedicated harness. The native and JS
runtime probes were still enough to reject the assumption that "WASIX already
gives us portable rich-kernel semantics everywhere."

Useful upstream references:

- Wasmer JS SDK: <https://docs.wasmer.io/sdk/wasmer-js/>
- Wasmer CLI: <https://docs.wasmer.io/runtime/cli/>
- WASIX C usage: <https://wasix.org/docs/language-guide/c/usage>
- WASIX `proc_fork`: <https://wasix.org/docs/api-reference/wasix/proc_fork>
- `wasix-libc` release used: <https://github.com/wasix-org/wasix-libc/releases/tag/v2026-03-02.1>
- `wasi-sdk` release used: <https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-32>

## Summary

WASIX is strong evidence that the world wants a kernel ABI richer than plain
WASI. It is not, today, a portable substrate we can simply adopt and build
Codepod on.

The practical conclusion is:

- keep `wasm32-wasip1` as the baseline artifact target
- keep `libcodepod.a` and the Codepod kernel imports as the normative platform
  contract
- learn from WASIX's ABI shape and tooling, but do not make WASIX the primary
  spec
- consider a small optional `wasix_32v1` compatibility adapter only when it
  helps run real third-party software

That is one of the reasons Codepod has value: it can provide rich sandbox
semantics across browser, Node, Deno, Bun, native Wasmtime, native Wasmer, and
future engines without betting the whole system on one runtime vendor's
extension ABI.

## What We Saw

### Plain WASI Is The Control

The unpacked Wasmer registry package `syrusakbary/cowsay` contained a plain
WASI module:

- module: `artifacts/unpacked-cowsay/modules/cowsay`
- SHA256: `b72f6b51b2672c1a766adfee3c2b8b724d50996b6b5026b3db4f582afd981602`
- imports: `wasi_snapshot_preview1` only

It ran under both native Wasmer and native Wasmtime. This validates the matrix
harness and confirms the unsurprising baseline: simple WASI is portable.

It does not exercise subprocesses, pipes, sockets, fork-like process behavior,
or the richer kernel surface we need.

### Real WASIX Does Not Run On Wasmtime Without A Shim

A C canary built with `wasi-sdk` 32 plus `wasix-libc` imported
`wasix_32v1::fd_pipe` and `wasix_32v1::getcwd`:

- module: `c-canary/canary.wasm`
- SHA256: `613708083302dc6e8494fed77b972242fa1d25b0817f2f9bf2de44cec9236fc5`

Native Wasmer ran it successfully:

```text
argc=2
argv0=c-canary/canary.wasm
cwd=/
pipe_read=7:pipe-ok
```

Native Wasmtime rejected the same unmodified artifact because the
`wasix_32v1` imports are unknown. That means WASIX is not "same app, any
engine" unless something supplies the WASIX imports for every engine.

### Current Wasmer Tooling Has Internal Skew

`cargo-wasix 0.1.26` downloaded the Wasix Rust toolchain
`v2026-03-27.1+rust-1.90` and produced a Rust WASIX canary:

- module:
  `rust-canary/target/wasm32-wasmer-wasi/release/wasix-rust-canary.wasm`
- SHA256: `77a09571ed49975c0e17d7fe0f0bba9164de1e4c59d5185e03c32460fa288fe0`

The module imports many `wasix_32v1` functions and requires shared memory and
exception handling. With the relevant feature flags enabled, Wasmtime parsed
the module but then failed on missing `wasix_32v1` imports. More importantly,
Homebrew Wasmer 7.1.0 also failed to run the current `cargo-wasix` output on
this machine with:

```text
No backends support the required features for the Wasm module
```

That is a toolchain/runtime compatibility warning even inside the Wasmer
ecosystem.

### The JS SDK Is Not A Portable Runner Today

Using `@wasmer/sdk@0.10.0`:

- Node and Bun could resolve registry packages through `@wasmer/sdk/node`
  when network access was available.
- Deno failed or hung depending on the import route.
- `syrusakbary/cowsay` started and emitted stdout in Node, but
  `instance.wait()` did not settle within the probe timeout.
- Bun hung or failed in the same package execution path.
- Local C WASIX via `Wasmer.fromWasm()` initialized and started in Node, but
  `instance.wait()` timed out.
- Bun failed SDK context/store initialization.
- Deno failed importing `@wasmer/sdk/wasm-inline` with
  `ReferenceError: buf is not defined`.

This is enough to say the Wasmer JS SDK is not currently the portable
Node/Bun/Deno WASIX runner we would need.

The browser path also has a structural constraint: Wasmer's JS SDK requires
Cross-Origin Isolation / `SharedArrayBuffer`. That may be reasonable for some
deployments, but it is too expensive as the baseline requirement for every
single-threaded Codepod sandbox.

### BusyBox Is Still A Port

The obvious registry package names were not available:

- `wasmer/busybox`
- `busybox/busybox`

Building BusyBox ourselves with `wasi-sdk` plus `wasix-libc` got past the
first step, but a minimal applet config still stopped on portability details:

- `sys/mman.h` requires `_WASI_EMULATED_MMAN` and `-lwasi-emulated-mman`
- `sys/resource.h` requires `_WASI_EMULATED_PROCESS_CLOCKS` and
  `-lwasi-emulated-process-clocks`
- `sys/sysmacros.h` was missing

So BusyBox is not a one-command proof that WASIX solves portability. It remains
a porting task, just with a different ABI underneath.

## Why This Project Has Value

Codepod is valuable because it is not just "run wasm." It is an attempt to
define a stable, testable kernel contract for rich sandboxed programs across
many hosts.

The WASIX experiment reinforces several product reasons:

1. **Runtime independence.** Native Wasmer, native Wasmtime, browsers, Node,
   Deno, and Bun do not expose the same capabilities or extension imports.
   Codepod can own the portability contract above them.
2. **Adaptive capabilities.** Some hosts have JSPI, some have WASI preview 2,
   some have threads/shared memory, some have only async JS and plain wasm.
   Codepod can use stronger host features when present without forcing the
   least common denominator into the guest ABI.
3. **Browser-first constraints.** Requiring `SharedArrayBuffer` or
   Cross-Origin Isolation for every program is too high a baseline. Codepod
   should keep single-threaded programs viable without that requirement.
4. **Deterministic kernel semantics.** FDs, subprocesses, pipes, sockets,
   cwd/env inheritance, and wait statuses need conformance tests and stable
   behavior, not ad hoc runtime behavior.
5. **Toolchain UX without runtime lock-in.** `cargo-wasix` and `wasixcc` are
   good product ideas. The target should be Codepod's ABI and conformance
   suite, not a Wasmer-only runtime path.
6. **Incremental compatibility.** We can support the POSIX-like surface real
   ports need without promising full Unix, full fork, or full thread semantics
   everywhere.

## What To Learn Or Port From WASIX

### Versioned Import Namespaces

WASIX's `wasix_32v1` namespace is clearer than a loose collection of
`host_*` functions. Codepod should move toward an explicit versioned kernel
ABI, for example:

- `codepod_fd_v1`
- `codepod_process_v1`
- `codepod_path_v1`
- `codepod_socket_v1`
- `codepod_clock_v1`

or a single `codepod_kernel_v1` module with grouped function names. The exact
shape matters less than making the import contract inspectable and versioned.

### ABI Taxonomy

WASIX is useful as a checklist for the kernel surface we should be explicit
about:

- fd lifecycle: `pipe`, `dup`, `dup2`, `close`, `read`, `write`
- process lifecycle: spawn, join/wait, status, signals, parent/child ids
- path state: cwd, chdir, path open/stat/readlink/symlink
- sockets: open, bind, listen, accept, connect, send, recv, shutdown
- polling: poll/epoll-like readiness
- terminal: tty metadata and foreground process-group behavior if we ever need
  interactive shell fidelity
- clocks and timers
- capability discovery

This does not mean copying every function. It means Codepod should define
these areas intentionally instead of letting each port invent a private escape
hatch.

### Spawn/Wait Over Fork

WASIX exposes `proc_fork`, but Codepod should not make true fork a baseline
requirement. Real fork semantics imply copy-on-write address spaces, subtle fd
inheritance behavior, and runtime snapshotting that will not map cleanly to
every host.

The core Codepod model should remain:

- spawn/exec with explicit argv/env/cwd
- explicit fd inheritance and remapping
- wait/join with structured status
- optional compatibility emulation for narrow fork-like use cases

That matches the direction already taken by `libcodepod.a`, bash-rs, and the
kernel/userland separation work.

### FD And Handle Semantics

WASIX's existence reinforces that fd semantics must be first-class:

- numeric fd identity
- atomic `dup2`
- close behavior
- pipe read/write byte fidelity
- inheritance into child processes
- close-on-exec policy
- wait status preservation

These should be kernel conformance tests, not just incidental bash tests.

### Capability-Gated Threads

The JS SDK's `SharedArrayBuffer` requirement is the important negative lesson.
Threads, futexes, and shared memory should be optional Codepod capabilities,
not part of the minimum contract for ordinary process, pipe, and filesystem
programs.

### Toolchain Ergonomics

`wasixcc` and `cargo-wasix` are the right UX shape:

- one command wraps target flags
- sysroot and libraries are selected automatically
- output is a normal `.wasm`
- the user does not hand-maintain low-level link flags

Codepod should copy that experience through `codepod-cc`, `cargo-codepod`,
and `libcodepod.a`, while keeping the artifact target rooted in
`wasm32-wasip1` unless a stronger target is deliberately introduced.

### Import-Shape And Runtime Matrix Tests

The WASIX probe was valuable because it inspected imports and ran the same
artifact in multiple engines. We should make that normal:

- inspect every blessed fixture's imports
- keep a plain-WASI control canary
- keep a Codepod-kernel canary
- optionally keep a WASIX-compat canary if we add an adapter
- matrix-run Node, Deno, Bun, browser, Wasmtime, and Wasmer where practical

The important rule is that the app `.wasm` is unmodified across the matrix.
Only the runner/import provider changes.

## What Not To Inherit

Do not adopt these as baseline Codepod requirements:

- `proc_fork` as a mandatory primitive
- threads/shared memory/`SharedArrayBuffer` for single-threaded programs
- a custom Rust toolchain as the first-class path
- Wasmer registry/package execution as the required distribution model
- WASIX as the normative API just because it exists
- "works on Wasmer" as a substitute for browser, Deno, Bun, Node, and Wasmtime
  evidence

## Optional WASIX Compatibility Adapter

A narrow `wasix_32v1` adapter may still be worth building later. The right
reason would be practical compatibility: if real packages build more easily
with existing WASIX toolchains, Codepod could import a subset of WASIX and
lower it onto the Codepod kernel.

Good initial adapter candidates:

- `fd_pipe`
- `fd_dup` / `fd_dup2`
- `getcwd` / `chdir`
- basic spawn/wait if needed by real ports
- a small socket subset if a concrete package requires it

This adapter should be treated like a foreign ABI layer, not the core kernel
spec. Codepod's own guests should target `wasm32-wasip1` plus `libcodepod.a`.

## Recommended Next Steps

1. Write a `codepod_kernel_v1` import-shape spec from the categories above.
2. Add an import-inspection test for `bash.wasm`, coreutils fixtures, and the
   guest-compat canaries.
3. Promote the WASIX experiment into a reusable matrix harness only after the
   current kernel/tooling work stabilizes.
4. Continue BusyBox through `codepod-cc` and `libcodepod.a`; use WASIX only as
   comparison data unless a package proves the adapter path is cheaper.
5. Keep browser and Deno as first-class acceptance targets. They are where
   runtime-coupled solutions tend to fail first.
