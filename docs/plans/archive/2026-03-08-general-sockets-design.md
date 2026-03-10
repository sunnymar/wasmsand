# General Socket Support + Tiered Network Modes

## Problem

The sandbox networking stack only supports HTTP via two ad-hoc paths:

1. **Virtual commands** (`curl`/`wget`) — Rust code inside the shell binary
   that calls `HostInterface::fetch()` → `host_fetch` shell import → bridge.
2. **Python socket shim** — replaces Python's socket module, buffers entire
   HTTP requests, calls `_codepod.fetch()` → `host_network_fetch` kernel
   import → bridge.

Neither path provides general socket access. Issues:

- **No HTTPS for Python** — `urllib` needs an `ssl` module for `HTTPSHandler`.
- **HTTP only** — any non-HTTP protocol is impossible.
- **No socket syscalls** — WASM binaries can't open sockets. Only the shell's
  virtual commands and Python's shimmed socket module can do networking.
- **Child process bug** — `spawnAsyncProcess()` doesn't pass `networkBridge`
  to child kernel imports, so `python3` gets "networking not configured".
- **Python shims are TS template strings** — harder to read, test, and edit.

## Design principle: sockets as syscalls

Socket operations are **sandbox-level syscalls** in the `codepod` WASM
namespace, accessible to every WASM process — the shell, python3, coreutils,
and any future tool binary. This is the same model as file I/O (`fd_read`,
`fd_write`): the sandbox provides the capability, tools consume it.

The `host_network_fetch` (high-level HTTP) remains for `restricted` mode and
backward compatibility. The new `host_socket_*` calls provide general-purpose
socket access in `full` mode.

## Network modes

| Mode | Platform | Capabilities |
|------|----------|-------------|
| `"restricted"` | Browser + Deno | HTTP/HTTPS only via `fetch()`. Default. |
| `"full"` | Deno/Node only | Real TCP/TLS sockets via host. Any protocol. |
| (none) | Any | No networking (current default when no policy set). |

Listening on ports is always blocked unless `allowListen: true`.

## NetworkPolicy changes

```typescript
interface NetworkPolicy {
  // Existing
  allowedHosts?: string[];
  blockedHosts?: string[];
  onRequest?: (request: { url: string; method: string }) => Promise<boolean>;

  // New
  mode?: 'restricted' | 'full';  // default: 'restricted'
  allowListen?: boolean;          // default: false
}
```

## Architecture

### Layer 1: Bridge protocol

Extend the SAB worker to handle multiplexed operations:

```
Int32[0] = status (0=idle, 1=request_ready, 2=response_ready, 3=error)
Int32[1] = data length
Bytes 8+ = JSON payload
```

Operations:

| Op | Request | Response |
|----|---------|----------|
| `fetch` | `{op:"fetch", url, method, headers, body}` | `{ok, status, headers, body}` |
| `connect` | `{op:"connect", host, port, tls}` | `{ok, socket_id}` |
| `send` | `{op:"send", socket_id, data_b64}` | `{ok, bytes_sent}` |
| `recv` | `{op:"recv", socket_id, max_bytes}` | `{ok, data_b64}` |
| `close` | `{op:"close", socket_id}` | `{ok}` |
| `listen` | `{op:"listen", port}` | `{ok, socket_id}` |
| `accept` | `{op:"accept", socket_id}` | `{ok, client_socket_id}` |

The worker maintains `Map<number, net.Socket | tls.TLSSocket>`.

Existing requests without an `op` field are treated as `fetch` for backward
compatibility.

### Layer 2: Kernel imports (WASM syscalls)

New functions in the `codepod` WASM namespace, available to ALL WASM processes:

- `host_socket_connect(req_ptr, req_len, out_ptr, out_cap) → i32`
- `host_socket_send(req_ptr, req_len, out_ptr, out_cap) → i32`
- `host_socket_recv(req_ptr, req_len, out_ptr, out_cap) → i32`
- `host_socket_close(req_ptr, req_len) → i32`

These call through `networkBridge.requestSync(op_json)` — a generalized version
of the current `fetchSync()`.

The existing `host_network_fetch` remains unchanged for restricted mode and
backward compat.

### Layer 3: Rust HostInterface

The shell's `HostInterface` trait gains socket methods:

```rust
trait HostInterface {
    // Existing
    fn fetch(&self, url, method, headers, body) -> FetchResult;

    // New — available when mode == "full"
    fn socket_connect(&self, host: &str, port: u16, tls: bool) -> Result<u32, String>;
    fn socket_send(&self, socket_id: u32, data: &[u8]) -> Result<usize, String>;
    fn socket_recv(&self, socket_id: u32, max_bytes: usize) -> Result<Vec<u8>, String>;
    fn socket_close(&self, socket_id: u32) -> Result<(), String>;
}
```

`curl`/`wget` virtual commands continue using `host.fetch()` (HTTP-level,
works in both modes). Future commands that need raw sockets use
`host.socket_*()`.

### Layer 4: Python shims (static `.py` files)

```
packages/orchestrator/src/network/python-shims/
  socket_fetch.py       # restricted mode — HTTP-level interception
  socket_native.py      # full mode — real socket proxy via _codepod
  ssl.py                # ssl shim for restricted mode (makes HTTPS work)
  sitecustomize.py      # module injection at interpreter startup
```

**`socket_fetch.py`** — current shim behavior (buffer HTTP → `_codepod.fetch()`),
plus the ssl.py shim enables HTTPS via `HTTPSHandler`.

**`socket_native.py`** — thin proxy to syscalls:
- `connect()` → `_codepod.socket_connect(host, port, tls)`
- `send(data)` → `_codepod.socket_send(socket_id, data)`
- `recv(n)` → `_codepod.socket_recv(socket_id, n)`
- `close()` → `_codepod.socket_close(socket_id)`

TLS is determined by port (443) or explicit `ssl.wrap_socket()` call, which
sets a flag that gets passed to `socket_connect(tls=True)`.

### Layer 5: _codepod Rust module (Python FFI)

New functions in `packages/python/crates/codepod-host/src/lib.rs`:

- `_codepod.socket_connect(host, port, tls=False)` → socket_id
- `_codepod.socket_send(socket_id, data)` → bytes_sent
- `_codepod.socket_recv(socket_id, max_bytes)` → bytes
- `_codepod.socket_close(socket_id)`

Each calls the corresponding `host_socket_*` WASM import (layer 2).

## How each consumer uses the stack

```
curl/wget (virtual commands)
  └→ HostInterface::fetch()
      └→ host_fetch (shell import)
          └→ bridge.fetchSync()          [restricted + full]

python3 urllib (restricted mode)
  └→ socket_fetch.py + ssl.py
      └→ _codepod.fetch()
          └→ host_network_fetch (kernel import)
              └→ bridge.fetchSync()

python3 socket (full mode)
  └→ socket_native.py
      └→ _codepod.socket_connect/send/recv/close()
          └→ host_socket_* (kernel imports)
              └→ bridge.requestSync()

future WASM binary (full mode)
  └→ codepod::host_socket_* (WASM imports)
      └→ bridge.requestSync()
```

## Error handling

- **Policy enforcement**: `connect()` checks host against allow/block lists via
  the gateway before opening the socket. `send`/`recv`/`close` use the
  already-authorized socket_id.
- **Timeouts**: `recv()` has a 30s default timeout. Returns `{ok: false, error: "timeout"}`.
- **Mode mismatch**: if mode is `"full"` but running in browser (no `net`
  module), socket ops return an error. Sandbox should detect and fall back to
  `"restricted"` with a warning.
- **Broken connections**: `recv()` returns empty data (0 bytes) on EOF.
  Standard socket behavior.
- **`full` mode denied**: if a caller tries `host_socket_connect` but mode is
  `"restricted"`, kernel import returns `{ok: false, error: "raw sockets
  not available in restricted mode"}`.

## Testing

1. **Bridge protocol** — test each op against a local test server
   (`Deno.listen()`). Verify SAB status transitions.
2. **Policy on connect** — test allow/block lists on the socket path.
3. **Python shim surface** — static analysis tests for required API
   (`connect`, `send`, `recv`, `makefile`).
4. **Sandbox HTTP** — `python3 urllib` with both `restricted` and `full`
   modes. Verify HTTP and HTTPS.
5. **Sandbox raw TCP** — Python script opens raw TCP socket, sends/receives.
   Only works in `full` mode; `restricted` rejects.
6. **networkBridge propagation** — child processes receive the bridge (regression).
7. **MCP smoke test** — CI smoke test includes a network fetch.

## Files changed

| File | Change |
|------|--------|
| `network/gateway.ts` | Add `mode`, `allowListen` to `NetworkPolicy` |
| `network/bridge.ts` | Extend worker to handle socket ops, add `requestSync()` |
| `network/python-shims/socket_fetch.py` | Extracted from TS template |
| `network/python-shims/socket_native.py` | New: real socket proxy |
| `network/python-shims/ssl.py` | New: ssl shim for restricted mode |
| `network/python-shims/sitecustomize.py` | Extracted from TS template |
| `network/socket-shim.ts` | Replace templates with file reads |
| `host-imports/kernel-imports.ts` | Add `host_socket_*` syscalls |
| `host-imports/shell-imports.ts` | Wire `host_socket_*` to `HostInterface` |
| `shell-exec/src/host.rs` | Add `socket_*` methods to `HostInterface` |
| `python/crates/codepod-host/src/lib.rs` | Add `_codepod.socket_*` FFI |
| `sandbox.ts` | Pick shim by mode, fix bridge propagation |
| `shell/shell-instance.ts` | Pass networkBridge to children (done) |
| `docs/guides/syscalls.md` | New: complete syscall reference |
| `docs/guides/creating-commands.md` | Update capability table, add network I/O section |
| `docs/guides/security.md` | Update WASI capability table, network isolation section |

## Documentation updates

### `docs/guides/syscalls.md` (NEW)

Complete syscall reference for WASM binaries. Two namespaces:

**`wasi_snapshot_preview1`** — standard WASI P1 syscalls (file I/O, clock,
random, process exit). Already documented piecemeal in security.md and
creating-commands.md; this consolidates them.

**`codepod`** — sandbox-specific extensions. Every function, its signature,
request/response JSON format, and error behavior:

| Category | Syscalls |
|----------|----------|
| Process management | `host_pipe`, `host_spawn`, `host_waitpid`, `host_close_fd`, `host_read_fd`, `host_write_fd`, `host_dup`, `host_dup2`, `host_yield` |
| Network (HTTP) | `host_network_fetch` |
| Network (sockets) | `host_socket_connect`, `host_socket_send`, `host_socket_recv`, `host_socket_close` |
| Extensions | `host_extension_invoke`, `host_is_extension` |

For Rust command authors: shows the `extern "C"` declarations and JSON
formats needed to call each syscall. References `creating-commands.md` for
the build/deploy workflow.

### `docs/guides/creating-commands.md`

The "What Your Executable Cannot Do" table (line 222) currently says:

```
| Network access | No | WASI sockets not implemented |
```

This changes to:

```
| Network access (restricted) | Yes | HTTP/HTTPS via `host_network_fetch` syscall |
| Network access (full) | Yes | Raw TCP/TLS sockets via `host_socket_*` syscalls (Deno/Node only) |
```

Add a new "Network I/O" section under "What Your Executable Can Do" showing
how a Rust WASM binary can use the `codepod` namespace imports for networking:

```rust
// These are available when the sandbox has networking enabled.
// The codepod namespace is auto-injected by the kernel for any
// WASM module that imports from it.
extern "C" {
    fn host_network_fetch(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_socket_connect(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_socket_send(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_socket_recv(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_socket_close(req_ptr: *const u8, req_len: u32) -> i32;
}
```

### `docs/guides/security.md`

Update the WASI capability table (line 108):

```
| Sockets (restricted) | host_network_fetch | Implemented — HTTP/HTTPS via NetworkBridge |
| Sockets (full)       | host_socket_connect, host_socket_send, host_socket_recv, host_socket_close | Implemented — real TCP/TLS via host (Deno/Node only) |
```

Update "Network isolation" section (line 59):

- Remove "HTTP only" and "No raw sockets" language
- Document the two modes: restricted (HTTP/HTTPS via fetch) and full (TCP/TLS sockets)
- Document `allowListen` option
- Update the `NetworkPolicy` example to show `mode` and `allowListen`

### `docs/guides/shell-reference.md`

Add a note that `curl`/`wget` work in both restricted and full modes (they use
the HTTP-level `host_fetch` path). Python `urllib`/`requests` also works in
both modes — restricted uses the fetch shim, full uses real sockets.

### `docs/guides/typescript-sdk.md` / `docs/guides/python-sdk.md`

Update `NetworkPolicy` interface docs to include `mode` and `allowListen`.

## Backward compatibility

- No `mode` → defaults to `"restricted"` → identical to current behavior.
- `host_network_fetch` and `host_fetch` unchanged.
- `curl`/`wget` virtual commands unchanged (use `fetch`, work in both modes).
- Socket mode adds new kernel imports alongside, doesn't replace.
- Python shim selection is transparent to callers.
