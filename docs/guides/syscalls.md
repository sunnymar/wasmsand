# WASM Syscall Reference

All WASM processes in the sandbox import host functions from the `codepod` namespace. These are the syscalls available to shell, Python, and tool binaries.

## Process management

| Syscall | Signature | Description |
|---------|-----------|-------------|
| `host_pipe` | `(out_ptr, out_cap) → i32` | Creates a pipe. Writes `{ read_fd, write_fd }` JSON to output buffer. |
| `host_spawn` | `(req_ptr, req_len) → i32` | Spawns a child WASM process. Returns PID or -1. Request is JSON `SpawnRequest`. |
| `host_waitpid` | `(pid, out_ptr, out_cap) → i32` | Waits for child to exit. Writes `{ exit_code }`. **Async (JSPI)**. |
| `host_close_fd` | `(fd) → i32` | Closes a file descriptor. Returns 0 on success. |
| `host_read_fd` | `(fd, out_ptr, out_cap) → i32` | Reads from a pipe fd. Returns bytes written, or needed size if buffer too small. |
| `host_write_fd` | `(fd, data_ptr, data_len) → i32` | Writes to a pipe fd. Returns bytes written or negative error. |
| `host_dup` | `(fd, out_ptr, out_cap) → i32` | Duplicates fd. Writes `{ fd: new_fd }` JSON. |
| `host_dup2` | `(src_fd, dst_fd) → i32` | Makes `dst_fd` point to the same target as `src_fd`. For guest libc compatibility this now applies to the active WASI host's stdio targets as well as kernel-managed pipe fds. Returns 0 on success. |
| `host_yield` | `() → void` | Yields to JS microtask queue. **Async (JSPI)**. |

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

The codepod guest compatibility runtime (see [`docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`](../superpowers/specs/2026-04-19-guest-compat-runtime-design.md)) also ships narrow libc header overrides in
`packages/guest-compat/include/`, currently including:

- `sched.h` for single-CPU affinity behavior
- `unistd.h` for `dup2()`
- `codepod_compat.h` for codepod-specific command helpers

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
