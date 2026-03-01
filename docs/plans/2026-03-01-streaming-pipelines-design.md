# Streaming Pipelines — Mini-POSIX Process Kernel

## Goal

Replace the sequential, fully-buffered pipeline execution model with a streaming model based on POSIX process semantics. Every process (shell, python3, cat, grep, ...) does I/O through WASI `fd_read`/`fd_write`. Pipelines stream data between stages via kernel-managed pipe buffers. JSPI provides cooperative scheduling — processes suspend on blocked I/O and resume when data arrives.

## Motivation

The current model runs each pipeline stage to completion, buffers its entire stdout as a string, then passes it to the next stage. This breaks for:

- **Long-running producers:** `python3 gen.py | grep pattern` — grep can't start until Python finishes.
- **Early termination:** `python3 gen.py | head -10` — Python runs to completion even though only 10 lines are needed.
- **Large output:** Multi-megabyte stdout must fit in a single string between stages.

## Architecture

Three layers, clean separation:

```
+---------------------------------------------+
|  Runner (TypeScript)                        |
|  Manages shell lifecycle, env sync,         |
|  captures results for Sandbox.run() API     |
+---------------------------------------------+
|  Process Kernel (TypeScript)                |
|  Process table, fd table, pipe buffers,     |
|  JSPI scheduling, SIGPIPE, validation       |
+---------------------------------------------+
|  Processes (WASM)                           |
|  Shell, python3, cat, grep, head, ...       |
|  All use WASI fd_read/fd_write for I/O      |
|  All can call pipe/spawn/waitpid/close      |
+---------------------------------------------+
```

The shell is not special. It is a process that happens to use process-management syscalls, just like `/bin/bash` is a regular process that calls `fork`/`pipe`/`waitpid`.

## Uniform Process Model — "Link Against the Stdlib"

Every WASM process links against two import namespaces at compile time:

1. **`wasi_snapshot_preview1`** — the "libc." Standard I/O (`fd_read`, `fd_write`), filesystem, clock, args, environ. Every process gets this. The process doesn't know whether fd 1 is a pipe, a capture buffer, or `/dev/null` — it just calls `fd_write(1, data)` and the kernel routes it.

2. **`codepod`** — kernel syscalls. Process management (`host_pipe`, `host_spawn`, `host_waitpid`, `host_close_fd`), network (`host_network_fetch`), extensions (`host_extension_invoke`). A process imports only what it needs — detected automatically via `WebAssembly.Module.imports()`.

There is no per-process-type branching. No `createPythonImports()` vs `createShellImports()`. One function — `createKernelImports()` — provides all `codepod` namespace imports to any process that declares them.

### Fd table as the only per-instance configuration

The kernel builds an fd table at spawn time and passes it to `WasiHost`. The `WasiHost` doesn't know what kind of process it's hosting — it just serves fds.

```
FdTarget =
  | { type: 'buffer', buf: Uint8Array[] }       // capture (stdout/stderr)
  | { type: 'pipe_read', pipe: AsyncPipe }       // pipe input
  | { type: 'pipe_write', pipe: AsyncPipe }      // pipe output
  | { type: 'static', data: Uint8Array }         // pre-loaded (stdin)
  | { type: 'null' }                             // /dev/null

WasiHost(fdTable: Map<number, FdTarget>)

fd_read(fd):  look up fdTable[fd], dispatch by type
fd_write(fd): look up fdTable[fd], dispatch by type
```

Examples:

```
Shell process:
  fd 0 → { type: 'static', data: <terminal stdin> }
  fd 1 → { type: 'buffer', buf: [] }               // captured by runner
  fd 2 → { type: 'buffer', buf: [] }

Pipeline stage "python3":
  fd 0 → { type: 'static', data: <empty> }
  fd 1 → { type: 'pipe_write', pipe: pipe1 }       // streams to grep
  fd 2 → { type: 'buffer', buf: [] }

Pipeline stage "grep":
  fd 0 → { type: 'pipe_read', pipe: pipe1 }        // streams from python
  fd 1 → { type: 'buffer', buf: [] }               // last stage, captured
  fd 2 → { type: 'buffer', buf: [] }
```

The application code (shell, python, cat, grep) is completely separated from the OS communication layer. A process doesn't know and doesn't care how its fds are wired.

## Syscalls

Four new host imports in the `codepod` namespace. Available to any process — the shell uses them for pipelines, but RustPython could use them for `subprocess.run()` in the future.

### `host_pipe(out_ptr: i32, out_cap: i32) -> i32`

Creates a pipe. Writes JSON `{"read_fd": N, "write_fd": M}` to the output buffer. Returns bytes written (or needed capacity for retry). Fd numbers start at 3 and increment per-process.

Sync — instant, no JSPI.

### `host_spawn(req_ptr: i32, req_len: i32) -> i32`

Spawns a new process. Request is JSON:

```json
{
  "prog": "python3",
  "args": ["gen.py"],
  "env": [["PATH", "/bin:/usr/bin"], ["PYTHONPATH", "/usr/lib/python"]],
  "cwd": "/home/user",
  "stdin_fd": 0,
  "stdout_fd": 4,
  "stderr_fd": 2
}
```

The kernel validates (tool allowlist, network policy), loads the precompiled WASM module, creates a `WasiHost` with the specified fd assignments, wraps WASI imports with `WebAssembly.Suspending`, wraps `_start` with `WebAssembly.promising`, and starts the process. Returns pid (>0) on success, -1 on error.

The env, cwd, and args are determined by the caller — the shell passes its current environment and working directory, just like POSIX `execve(prog, argv, envp)`.

Sync — the process is created and started but the caller does not wait for it to finish.

### `host_waitpid(pid: i32, out_ptr: i32, out_cap: i32) -> i32`

Blocks until the specified process exits. Writes JSON `{"exit_code": N}` to the output buffer. Returns bytes written.

**JSPI — suspends the calling WASM stack.** The kernel resumes the caller when the target process exits.

### `host_close_fd(fd: i32) -> i32`

Closes a pipe fd. Returns 0 on success. Closing the write end triggers EOF for readers. Closing the read end triggers EPIPE for writers.

Sync — instant.

## I/O: fd_read / fd_write Dispatch by Fd Table

No new imports for I/O. `WasiHost` dispatches existing WASI `fd_read` and `fd_write` calls through the fd table:

```
fd_read(fd):
  target = fdTable[fd]
  switch target.type:
    'static':     serve bytes from target.data (advance offset, 0 = EOF)
    'pipe_read':  read from pipe buffer
                    data available → return bytes
                    empty + write end open → JSPI suspends, resumes when data arrives
                    empty + write end closed → return 0 (EOF)
    'buffer':     not readable, return EBADF
    'null':       return 0 (EOF)

fd_write(fd):
  target = fdTable[fd]
  switch target.type:
    'buffer':     append to target.buf
    'pipe_write': write to pipe buffer
                    space available → return bytes written
                    full → JSPI suspends, resumes when reader drains
                    read end closed → return EPIPE
    'static':     not writable, return EBADF
    'null':       discard, report success
```

The dispatch is generic — no hardcoded fd 0/1/2 behavior. The fd table determines everything.

## JSPI Wrapping

For processes with pipe fds (pipeline stages):

- `fd_read` and `fd_write` WASI imports: wrapped with `WebAssembly.Suspending`
- `host_waitpid`: wrapped with `WebAssembly.Suspending`
- `_start` export: wrapped with `WebAssembly.promising`

For non-pipeline single commands (e.g., `grep pattern file`):
- Current `spawnSync` path remains — no JSPI, fully synchronous, zero overhead change.

JSPI handles scheduling implicitly. Each pipeline stage's `_start()` returns a `Promise`. When a stage suspends on I/O, the JS microtask queue runs, allowing other stages' Promises to execute. No manual scheduler needed.

## SIGPIPE

When a reader closes its pipe end (e.g., `head -10` exits after reading 10 lines):

1. Pipe's read end is marked closed.
2. Next `fd_write` from the writer returns EPIPE.
3. Writer's WasiHost translates this to process termination with exit code 141 (128 + SIGPIPE).

This is how `python3 gen.py | head -10` stops Python early — identical to POSIX behavior.

## Pipe Buffer

Extend existing `createPipe()` from `pipe.ts`:

- Capacity limit: 64 KB (matches Linux default).
- `read()` returns `Promise<number>` — resolves immediately if data available, suspends if empty.
- `write()` returns `Promise<number>` — resolves immediately if space available, suspends if full.
- EOF: `read()` resolves with 0 when write end closed and buffer empty.
- EPIPE: `write()` rejects when read end closed.
- Thread-safe: only one WASM stack is active at a time (cooperative scheduling), so no mutex needed.

## Per-Process Fd Table

Each process gets its own fd table, assigned at spawn time by the kernel:

```
Process "python3" (pid 2):
  fd 0: pipe read end (connected to terminal stdin or previous stage)
  fd 1: pipe write end (connected to next stage's fd 0)
  fd 2: stderr buffer
  fd 3+: dynamically allocated by host_pipe()

Process "grep" (pid 3):
  fd 0: pipe read end (connected to python's fd 1)
  fd 1: stdout buffer (last stage — output captured by runner)
  fd 2: stderr buffer
```

## Process Kernel (TypeScript)

New module: `packages/orchestrator/src/process/kernel.ts`

```
ProcessKernel:
  processTable: Map<pid, ProcessEntry>
  nextPid: number

  ProcessEntry:
    promise: Promise<void>      // the _start() Promise
    wasiHost: WasiHost
    fdTable: Map<fd, FdTarget>
    state: 'running' | 'exited'
    exitCode: number

  createPipe(): { readEnd: PipeReadEnd, writeEnd: PipeWriteEnd }
  spawn(req: SpawnRequest): pid
  waitpid(pid): Promise<{ exit_code: number }>
  closeFd(callerPid, fd): void
```

The kernel is used by both the shell process (via host imports) and the runner (to set up the shell process itself).

## Rust Shell Changes

### Pipeline loop (executor.rs)

Changes from sequential string-passing to pipe/spawn/waitpid:

```rust
// Create pipes between adjacent stages
let mut pipes = Vec::new();
for _ in 0..stages.len() - 1 {
    pipes.push(host_pipe());
}

// Spawn each stage
let mut pids = Vec::new();
for (i, stage) in stages.iter().enumerate() {
    let stdin_fd = if i == 0 { STDIN_FD } else { pipes[i - 1].read_fd };
    let stdout_fd = if i == stages.len() - 1 { STDOUT_FD }
                    else { pipes[i].write_fd };

    match stage {
        Command::Simple { .. } => {
            // External command — spawn as separate process
            let pid = host_spawn(prog, args, env, cwd, stdin_fd, stdout_fd, STDERR_FD);
            pids.push(pid);
        }
        _ => {
            // Compound command — run inside shell, using pipe fds for I/O
            exec_compound_with_fds(state, host, stage, stdin_fd, stdout_fd);
        }
    }
}

// Close parent copies of pipe fds
for pipe in &pipes {
    host_close_fd(pipe.read_fd);
    host_close_fd(pipe.write_fd);
}

// Wait for last stage
let result = host_waitpid(pids.last());
```

### Builtin output (builtins.rs)

Builtins (`echo`, `printf`, `read`, `cat`, etc.) write to the stage's assigned stdout fd via WASI `fd_write` instead of appending to a result string. The fd is passed as context through the executor.

### Non-pipeline commands

Single commands without pipes (`grep pattern file`, `echo hello`, `export FOO=bar`) continue using the existing `host_spawn` (synchronous, string-based) path. The pipeline path only activates when the parser produces a `Command::Pipeline`.

## Shell Output Protocol Change

**Before:** `__run_command` returns JSON `{stdout, stderr, exit_code, env}` via shared memory.

**After:** stdout and stderr flow through fd 1 and fd 2. The `__run_command` return value carries only metadata: `{exit_code, env}`. The runner reads stdout/stderr from the shell's WasiHost capture buffers.

## Runner (TypeScript)

The runner wraps the shell process for `Sandbox.run()`:

```
ShellRunner.exec(command):
  1. Shell process: fd 0 = stdin, fd 1 = stdout capture, fd 2 = stderr capture
  2. Dispatch command via __run_command (existing entry point)
  3. Shell executes — pipelines stream internally via kernel-managed pipes
  4. __run_command returns metadata: {exit_code, env}
  5. Runner reads stdout from WasiHost.getStdout(), stderr from WasiHost.getStderr()
  6. Return RunResult to Sandbox.run() caller
```

The runner handles env sync, output limits, cancellation — same responsibilities as today, but stdout/stderr come from WasiHost buffers instead of the JSON return value.

## What Stays the Same

- `__run_command` as command dispatch entry point.
- Env sync via `__run_command` return value (metadata only).
- `spawnSync` path for non-pipeline single commands (no JSPI overhead).
- Tool allowlist validation in the kernel.
- Network policy enforcement.
- VFS proxy over SharedArrayBuffer (file I/O is orthogonal to pipe I/O).
- Extension invoke via existing JSPI path.

## What Changes

| Component | Change |
|-----------|--------|
| `executor.rs` | Pipeline loop: pipe/spawn/waitpid. Builtins write to fds via WASI fd_write. |
| `host.rs` | New host imports: host_pipe, host_spawn, host_waitpid, host_close_fd |
| `main.rs` / WASM exports | Wire new host imports |
| `WasiHost` | fd_read/fd_write dispatch through fd table (`Map<number, FdTarget>`) |
| `kernel.ts` (new) | Process table, fd table, pipe management, spawn, waitpid |
| `kernel-imports.ts` (new) | Single `createKernelImports()` replacing `createPythonImports()` + `createShellImports()` |
| `pipe.ts` | Extend with capacity limit, async read/write (Promise-based) |
| `shell-instance.ts` | Shell gets real WasiHost (replaces no-op stubs). JSPI wrapping for fd_read/fd_write. |
| `manager.ts` | `spawnAsync()` alongside existing `spawnSync()`. Unified import wiring via `createKernelImports()`. |
| `python-imports.ts` | Removed — absorbed into `createKernelImports()` |
| `shell-imports.ts` | Slimmed — process management moves to `createKernelImports()` |

## Testing

1. **Unit: pipe.ts** — async read/write, EOF, EPIPE, back-pressure, capacity limit.
2. **Unit: kernel.ts** — spawn, waitpid, fd routing, SIGPIPE, process table cleanup.
3. **Integration: simple pipeline** — `echo hello | cat` streams through pipe.
4. **Integration: streaming** — verify Python killed early: `python3 -c "for i in range(1000): print(i)" | head -5`.
5. **Integration: compound in pipeline** — `echo hello | while read line; do echo "$line"; done`.
6. **Integration: multi-stage** — `cat file | grep pattern | wc -l`.
7. **Integration: back-pressure** — large producer, slow consumer, verify pipe blocks producer.
8. **Regression: non-pipeline** — `ls`, `echo hello`, `export FOO=bar` unchanged via spawnSync.
9. **Regression: existing shell conformance** — all 329 shell test steps still pass.

## JSPI Runtime Requirement

JSPI requires Node 25+ or Deno with V8 flags. This is already a requirement for the extension invoke path. Non-JSPI runtimes fall back to the current sequential buffered model (pipelines still work, just not streaming).
