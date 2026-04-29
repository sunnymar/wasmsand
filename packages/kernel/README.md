# @codepod/kernel

The codepod kernel is a TypeScript library for running wasm guests with a
generic process and resource runtime. It is embedded by `mcp-server`,
`sdk-server`, and other hosts that need codepod sandboxes.

## Boundary Principle

The kernel exposes primitives, not userland features.

Use two tests for new kernel code:

1. Naming test: a kernel symbol names a primitive such as `spawn`, `pipe`,
   `read_fd`, `mutex_lock`, or `extension_invoke`. It does not name a userland
   feature such as `run_command`, `shell_*`, or `python_*`.
2. Agnosticism test: kernel behavior does not depend on which userland is
   running. Replacing bash with another boot binary must not require kernel
   changes.

This rule is enforceable for new code and aspirational for legacy code. Current
Python-coupled debt includes `python/`, `host_run_command`,
`extension/codepod-ext-shim.ts`, and the Python shim install in
`Sandbox.create()`. Those clear with the planned CPython port. Touching those
files in unrelated work does not obligate cleanup; keep scope disciplined and
refer to the kernel/userland separation spec when in doubt.

## Guest-Facing Imports

The kernel provides the `codepod::host_*` import namespace used by wasm guests.

Process:

- `host_pipe`
- `host_spawn`
- `host_waitpid`
- `host_waitpid_nohang`
- `host_close_fd`
- `host_getpid`
- `host_getppid`
- `host_kill`
- `host_list_processes`

Fd I/O:

- `host_read_fd`
- `host_write_fd`
- `host_dup`
- `host_dup2`

Network:

- `host_network_fetch`
- `host_socket_connect`
- `host_socket_send`
- `host_socket_recv`
- `host_socket_close`

Threading, when `threadsBackend` is enabled:

- `host_thread_spawn`
- `host_thread_join`
- `host_thread_detach`
- `host_thread_self`
- `host_thread_yield`
- `host_mutex_lock`
- `host_mutex_unlock`
- `host_mutex_trylock`
- `host_cond_wait`
- `host_cond_signal`
- `host_cond_broadcast`

Extensions:

- `host_extension_invoke`
- `host_native_invoke`

These are currently consumed by RustPython through the auto-create virtual
command machinery. That is Python-coupled debt. New host integrations should
prefer the host-side extension registry exposed through `SandboxOptions`.

Control flow:

- `host_setjmp`
- `host_longjmp`
- `host_yield`

Deferred Python-coupled import:

- `host_run_command`

`host_run_command` delegates to a host-registered `runCommandHandler` callback
passed via `Sandbox.create({ runCommandHandler })`. The bash implementations in
`sdk-server` and `mcp-server` spawn a fresh resident bash per call so Python
subprocess shell-outs never re-enter PID 1's `callExport` queue.

The kernel also exposes standard WASI Preview 1 imports.

## Host-Facing TypeScript API

Sandbox lifecycle:

- `Sandbox.create({ bootArgv, bootImports, runCommandHandler, ... })`
- `sandbox.destroy()`
- `sandbox.fork()`
- `sandbox.snapshot()`
- `sandbox.restore()`

Generic process control:

- `sandbox.spawn(argv, opts)`
- `sandbox.process(pid).callExport(name, ...args)`
- `sandbox.process(pid).fdReadAndClear(fd)`
- `sandbox.process(pid).terminate()`
- `sandbox.process(pid).wait()`

`callExport` is JSPI/Asyncify-aware and FIFO-queued per resident process. A PID
is inviolate: do not recursively call exports on the same resident process. When
userland needs to shell out during an import callback, spawn another process.

`KernelApi` is passed to `bootImports(api)` and contains:

- `vfs`
- `processManager`
- `time`
- `memory`

`KernelApi.memory` is late-bound. Build import handlers during `bootImports`;
read or write wasm memory only inside those handlers after instantiation.

## Userland Protocols

Userland protocols live outside this package.

`bashDispatch.runCommand(...)` lives in `sdk-server/src/bash-dispatch.ts` and
`mcp-server/src/bash-dispatch.ts`. It encodes bash's `__run_command` JSON
protocol. Another boot binary should provide its own host-side dispatch wrapper
without changing the kernel.

The current bash wasm is still a Rust userland binary with compatibility
imports. Moving bash itself to the proper process/fd channels is a future task,
blocked on the Rust port work needed for the shell and standard library.

## Not In The Kernel

- Bash-specific host imports such as `host_stat`, `host_register_tool`, and
  `host_glob`.
- The `__run_command` JSON protocol.
- Shell history.
- SDK/MCP RPC dispatch.
- Python package policy.

Those belong in host servers, userland-specific boot-import modules, or the
guest binaries themselves.

Everything above moved out in the kernel/userland separation refactor
(PR1-PR6, 2026-04). See
`docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md`.
