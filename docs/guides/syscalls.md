# WASM Syscall Reference

All WASM processes in the sandbox import host functions from the `codepod` namespace. These are the syscalls available to shell, Python, and tool binaries (including BusyBox applets via the `libcodepod_guest_compat` libc shims).

## Process management

| Syscall | Signature | Description |
|---------|-----------|-------------|
| `host_pipe` | `(out_ptr, out_cap) → i32` | Creates a pipe. Writes `{ read_fd, write_fd }` JSON to output buffer. Backs `pipe(2)`. |
| `host_spawn` | `(req_ptr, req_len) → i32` | Spawns a child WASM process. Returns PID or -1. Request is JSON `SpawnRequest`. Backs `posix_spawn(3)` / `fork`+`exec` for tools that ship with the compat shim. |
| `host_waitpid` | `(pid, out_ptr, out_cap) → i32` | Waits for child to exit. Writes `{ exit_code }`. **Async (JSPI)**. Backs `waitpid(2)`. |
| `host_waitpid_nohang` | `(pid) → i32` | Non-blocking — returns the child's exit code or -1 if still running. Backs `waitpid(WNOHANG)`. |
| `host_close_fd` | `(fd) → i32` | Closes a file descriptor. Returns 0 on success. |
| `host_read_fd` | `(fd, out_ptr, out_cap) → i32` | Reads from a pipe fd. Returns bytes written, or needed size if buffer too small. |
| `host_write_fd` | `(fd, data_ptr, data_len) → i32` | Writes to a pipe fd. Returns bytes written or negative error. |
| `host_dup` | `(fd, out_ptr, out_cap) → i32` | Duplicates fd. Writes `{ fd: new_fd }` JSON. Backs `dup(2)`. |
| `host_dup2` | `(src_fd, dst_fd) → i32` | Makes `dst_fd` point to the same target as `src_fd`. Applies to both the active WASI host's stdio targets and kernel-managed pipe fds. Backs `dup2(2)`. Returns 0 on success. |
| `host_getpid` | `() → i32` | Caller's pid. Backs `getpid(2)`. PID 1 is the boot shell (Unix init); nested processes — including child shells — get sequential pids. |
| `host_getppid` | `() → i32` | Caller's parent pid (0 for the topmost shell, mirroring init). Backs `getppid(2)`. |
| `host_kill` | `(pid, sig) → i32` | Best-effort signal delivery: cancels the target's WASI host so it exits with code 124 (`SIGTERM`-style). `sig == 0` is the existence probe. Returns 0 on success, -1 with `ESRCH` if no such process. Backs `kill(2)`. |
| `host_list_processes` | `(out_ptr, out_cap) → i32` | Returns JSON `[{ pid, ppid, state, cmd, … }, …]` — used by the shell `ps` builtin and by `/proc/<pid>/*` synthesis. |
| `host_setjmp` | `(env_ptr) → i32` | POSIX `setjmp`. Phase 1 stub returns 0; Phase 2 (in progress) drives the Asyncify state machine to capture the current stack into `env`. Always uses Asyncify regardless of the host scheduler. |
| `host_longjmp` | `(env_ptr, val) → void` | POSIX `longjmp`. Phase 1 raises an abort if invoked without a matching `setjmp` save; Phase 2 unwinds via Asyncify and rewinds back to the matching `host_setjmp` call site, returning `val`. |
| `host_yield` | `() → void` | Yields to JS microtask queue. **Async (JSPI)**. The cooperative-scheduling primitive — `sleep(0)`. |

## Network

| Syscall | Signature | Description |
|---------|-----------|-------------|
| `host_network_fetch` | `(req_ptr, req_len, out_ptr, out_cap) → i32` | HTTP fetch. Request: `{ url, method, headers, body }`. Response: `{ ok, status, headers, body, error }`. **Async (JSPI)**. |

## Sockets (full mode only)

These syscalls are available when the network policy `mode` is `"full"`. They proxy to real TCP/TLS connections on the host.

| Syscall | Signature | Description |
|---------|-----------|-------------|
| `host_socket_connect` | `(req_ptr, req_len, out_ptr, out_cap) → i32` | Opens a TCP/TLS socket. Request: `{ host, port, tls }`. Response: `{ ok, socket_id }`. |
| `host_socket_send` | `(req_ptr, req_len, out_ptr, out_cap) → i32` | Sends data. Request: `{ socket_id, data_b64 }`. Response: `{ ok, bytes_sent }`. |
| `host_socket_recv` | `(req_ptr, req_len, out_ptr, out_cap) → i32` | Receives data. Request: `{ socket_id, max_bytes }`. Response: `{ ok, data_b64 }`. |
| `host_socket_close` | `(req_ptr, req_len) → i32` | Closes a socket. Request: `{ socket_id }`. Returns 0 or -1. |

Socket data is base64-encoded in JSON since the bridge protocol is JSON-based.

## Extensions

| Syscall | Signature | Description |
|---------|-----------|-------------|
| `host_extension_invoke` | `(req_ptr, req_len, out_ptr, out_cap) → i32` | Invokes a host extension. Request: `{ name, args, stdin, env, cwd }`. Response: `{ exit_code, stdout, stderr }`. **Async (JSPI)**. |
| `host_is_extension` | `(name_ptr, name_len) → i32` | Returns 1 if the named extension is available, 0 otherwise. |
| `host_run_command` | `(req_ptr, req_len, out_ptr, out_cap) → i32` | Runs a shell command and captures output. Request: `{ cmd, stdin? }`. Response: `{ exit_code, stdout, stderr }`. The return value is the byte count written, or the required byte count if `out_cap` is too small. **Async (JSPI)**. |

`host_run_command` is the low-level guest extension used by the Python subprocess shim today. It is also the intended primitive for optional guest-compat helpers such as `codepod_system()` and `codepod_popen()`. In the Phase A C frontend, `codepod_pclose()` reports the captured command exit code, and JSON string decoding supports the standard short escapes plus ASCII-range `\u00XX` escapes only. This is an extension API for command execution, not a POSIX process syscall surface.

The codepod guest compatibility runtime (see [`docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`](../superpowers/specs/2026-04-19-guest-compat-runtime-design.md)) ships libc surface in
`packages/guest-compat/include/` plus real symbols in
`libcodepod_guest_compat.a` for everything autoconf-style ports
expect to find. cpcc compiles guest C as **`-std=gnu23`** by default
(C23 + GNU extensions; gives `nullptr`, `unreachable()`, etc.).

### Headers + symbols provided

| Header | Surface |
|--------|---------|
| `unistd.h` | `dup`/`dup2`/`dup3` (real impls via `host_dup`/`host_dup2`), `pipe`/`pipe2` (via `host_pipe`), `getpid`/`getppid` (via `host_getpid`/`host_getppid`), `kill` (via `host_kill`), `chown`/`lchown`/`fchown`/`fchdir`/`chroot` no-ops, `setresuid`/`setresgid` (Linux ext), real-uid (1000) overrides |
| `sys/wait.h` | `wait`/`waitpid` (waitpid via `host_waitpid` async-blocking; full W*EXITSTATUS macros) |
| `spawn.h` | Full `posix_spawn` family: `posix_spawn`/`posix_spawnp`, `posix_spawn_file_actions_*` (init/destroy/addopen/addclose/adddup2/addchdir_np), `posix_spawnattr_*` (init/destroy/setflags/setpgroup/setsigmask/setsigdefault/setschedparam/setschedpolicy) |
| `signal.h` | `sigaction`, `signal`, `raise`, `kill`, `alarm`, `sigemptyset` family; full POSIX signal numbers (SIGFPE/SIGSEGV/SIGBUS/SIGTRAP/SIGIOT included); `NSIG=32` (gnulib-compatible) |
| `setjmp.h` | Asyncify-backed `setjmp`/`longjmp` |
| `sys/resource.h` | `getrlimit`/`setrlimit` with sandbox defaults (RLIMIT_NOFILE=1024, RLIMIT_STACK=1MB), `getpriority`/`setpriority`/`getrusage` no-ops |
| `time.h` | `tzset()` no-op; `tzname[]`, `timezone`, `daylight` UTC-defaulted globals |
| `stdio.h` | `popen`/`pclose` (via `host_run_command`); `flockfile`/`funlockfile`/`ftrylockfile` no-ops |
| `stdlib.h` | `mktemp`/`mkstemp`/`mkostemp`/`mkdtemp` real impls (open + crypto-random suffix); `qsort_r` GNU 5-arg signature |
| `sched.h` | Single-CPU affinity (`cpu_set_t`, `sched_*affinity`, `sched_getcpu`); `struct sched_param` |
| `pwd.h` / `grp.h` | Synthesized `codepod` user/group records (uid/gid 1000) |
| `sys/utsname.h` | `uname()` returns codepod build identity (`sysname=codepod`, `machine=wasm32`) |
| `sys/sysinfo.h` | Memory/uptime queries answered from `/proc` |
| `netdb.h` | `gethostbyname`/`getaddrinfo` via `host_socket_connect`; `getservbyname`, `struct servent` |
| `codepod_compat.h` | Codepod-specific command helpers + version macros |

### Why real symbols vs static-inline?

Most of these used to be `static inline` no-ops in our headers.
Autotools-built ports (`coreutils`, `file/file`, etc.) include
gnulib, which probes for each POSIX function via a *link* test —
when our inline doesn't appear in `libc.a`'s symbol table, gnulib
concludes "missing" and compiles its own replacement. Then both
definitions collide at compile time. Real symbols in
`libcodepod_guest_compat.a` (statically `--whole-archive`-linked
into every guest binary by cpcc) make autoconf detect them and
skip the redundant gnulib replacement entirely.

## VFS-backed POSIX

These WASI syscalls (preview-1) are implemented against the in-memory VFS and surface real POSIX semantics — not stubs:

| WASI op | Backed by | Notes |
|---------|-----------|-------|
| `path_link` | `vfs.link()` | Real hardlinks: writes through either path are visible at the other; `EEXIST` on conflict, `EACCES` on directories. Used by BusyBox `ln` and libc `link()`. |
| `path_symlink` | `vfs.symlink()` | Symbolic links followed transparently by `path_open`/`path_readlink`. Used by BusyBox `ln -s`. |
| `path_unlink_file` / `path_remove_directory` | `vfs.unlink()` / `vfs.rmdir()` | |
| `path_rename` | `vfs.rename()` | Atomic within the same mount. |
| `fd_pwrite` / `fd_pread` | VFS positional I/O | Required by BusyBox stdio. |
| `clock_time_get` | Host `Date.now()` / monotonic counter | Backs `time(2)`, `clock_gettime`. |
| `random_get` | `crypto.getRandomValues` | Backs `getentropy(3)` and `/dev/urandom`. |

## JSON protocol

All syscalls use a shared JSON-over-linear-memory protocol:

1. **Input**: Caller writes JSON string to WASM linear memory, passes `(ptr, len)`.
2. **Output**: Host writes JSON response to caller's output buffer at `(out_ptr, out_cap)`. Returns bytes written.
3. **Buffer too small**: If the response exceeds `out_cap`, the syscall returns the required size. Caller should retry with a larger buffer.

The `call_with_outbuf` helper in Rust (and equivalent in the orchestrator) handles the retry loop automatically.

## Python access

Python code accesses these syscalls through the `_codepod` native module:

```python
import _codepod

# HTTP fetch (restricted + full modes)
result = _codepod.fetch("GET", "https://example.com", {}, None)

# Socket operations (full mode only)
sock_id = _codepod.socket_connect("example.com", 443, True)
_codepod.socket_send(sock_id, b"GET / HTTP/1.1\r\n\r\n")
data = _codepod.socket_recv(sock_id, 65536)
_codepod.socket_close(sock_id)
```

## Shell access

Shell builtins (`curl`, `wget`) use `host_network_fetch` internally. The shell executor uses process management syscalls for pipelines and command substitution.
