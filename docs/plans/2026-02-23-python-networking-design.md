# Python Networking via Socket Shim

**Date:** 2026-02-23
**Status:** Approved

## Overview

Enable Python's standard networking libraries (`requests`, `urllib`, `http.client`) to work inside the sandbox without forking RustPython. A replacement `socket.py` on the VFS communicates with the host via a reserved control file descriptor. The host dispatches HTTP requests through the existing NetworkBridge (SAB+Atomics).

## Architecture

```
Python code: requests.get("https://api.example.com/data")
  -> urllib3 -> http.client.HTTPConnection
  -> import socket  (replacement from VFS /usr/lib/python/socket.py)
  -> socket.connect((host, port))
      -> os.write(CONTROL_FD, '{"cmd":"connect",...}\n')
      -> WasiHost intercepts fd_write on CONTROL_FD
      -> Stores connection entry, returns conn_id
      -> os.read(CONTROL_FD, ...) -> '{"ok":true,"id":"c0"}\n'
  -> socket.sendall(http_request_bytes)
      -> Buffers in Python, waits for full request (headers + Content-Length body)
  -> socket.recv(bufsize) / makefile().readline()
      -> Triggers flush: parses HTTP request from buffer
      -> os.write(CONTROL_FD, '{"cmd":"request","id":"c0",...}\n')
      -> WasiHost calls bridge.fetchSync(url, method, headers, body)
      -> Blocks via Atomics.wait, worker does real fetch
      -> os.read(CONTROL_FD, ...) -> '{"ok":true,"status":200,...}\n'
      -> Formats raw HTTP response, returns to caller
```

Three layers:
1. **Python shim** (`socket.py` on VFS) — implements socket API, talks JSON over control fd
2. **Control fd handler** (in WasiHost) — parses commands, calls bridge, buffers responses
3. **NetworkBridge** (existing) — SAB+Atomics sync->async fetch through worker

## Control FD Protocol

**Reserved fd:** `0xFFFFFFFE` (4294967294) — one below the 32-bit WASI max. Defined as a named constant `CONTROL_FD` in both Python shim and WasiHost.

WasiHost registers this fd as a special control fd during construction when `networkBridge` is present. Writes go to the command parser instead of VFS. Reads return buffered response data.

Protocol is newline-delimited JSON:

| Command | Request | Response |
|---------|---------|----------|
| connect | `{"cmd":"connect","host":"example.com","port":443}` | `{"ok":true,"id":"c0"}` |
| request | `{"cmd":"request","id":"c0","method":"GET","path":"/api","headers":{"Accept":"*/*"},"body":""}` | `{"ok":true,"status":200,"headers":{"content-type":"text/plain"},"body":"hello"}` |
| close | `{"cmd":"close","id":"c0"}` | `{"ok":true}` |

Design choices:
- **HTTP parsing in Python** — the shim parses raw HTTP request bytes into structured method/path/headers/body before sending the `request` command.
- **One-shot request/response** — no streaming. Full HTTP response returned in a single JSON response. Matches bridge's fetchSync behavior.
- **Connection IDs** — simple incrementing strings (`c0`, `c1`, ...) managed by WasiHost. Map to host+port+scheme for URL reconstruction.
- **Scheme inference** — port 443 -> `https`, everything else -> `http`.

## Python Socket Shim

Shipped to VFS at `/usr/lib/python/socket.py`. Sandbox sets `PYTHONPATH=/usr/lib/python` so Python resolves it before the frozen stdlib module.

Implements minimal `socket` class for HTTP client use:

### Module-level functions and constants

```python
AF_INET, AF_INET6, SOCK_STREAM, IPPROTO_TCP, SOL_SOCKET, SO_KEEPALIVE, TCP_NODELAY

def create_connection(address, timeout=None, source_address=None) -> socket
def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0) -> list
```

### socket class

| Method | Behavior |
|--------|----------|
| `connect(address)` | Sends `connect` command to control fd, stores conn_id |
| `send(data)` / `sendall(data)` | Buffers data (no host call yet) |
| `recv(bufsize)` | Triggers flush if complete request buffered, returns response chunk |
| `makefile(mode)` | Returns `_SocketFile` wrapper with `read()`, `readline()`, `write()`, `flush()`, `close()` |
| `settimeout(t)` | Stores value, no-op |
| `setsockopt(...)` | No-op |
| `getpeername()` | Returns (host, port) |
| `close()` | Sends `close` command to control fd |

### Flush logic (Content-Length aware)

`send()`/`sendall()` just buffer. The actual HTTP request is dispatched on first `recv()`/`readline()` call, but only when the buffer contains a complete request:

```python
def _should_flush(self):
    idx = self._sendbuf.find(b"\r\n\r\n")
    if idx < 0:
        return False
    header_block = self._sendbuf[:idx].decode("utf-8", errors="replace")
    for line in header_block.split("\r\n"):
        if line.lower().startswith("content-length:"):
            expected = int(line.split(":", 1)[1].strip())
            body_start = idx + 4
            return len(self._sendbuf) - body_start >= expected
    # No Content-Length -> no body (GET, HEAD, DELETE, etc.)
    return True
```

This handles:
- **GET/HEAD/DELETE** — no Content-Length, flushes on `\r\n\r\n`
- **POST/PUT with body** — waits for Content-Length bytes after headers
- **Chunked transfer encoding** — not supported for outgoing requests (requests/urllib3 use Content-Length)

### _SocketFile class

Returned by `makefile()`. Implements `read(n)`, `readline()`, `write(data)`, `flush()`, `close()`. `http.client` uses this for reading responses line-by-line.

## WasiHost Control FD Handler

When `networkBridge` is present:

1. **Registration** — reserve `0xFFFFFFFE` as control fd during construction.
2. **State:**
   ```typescript
   private controlConnections: Map<string, { host: string; port: number; scheme: string }> = new Map();
   private controlResponseBuf: Uint8Array | null = null;
   private nextControlConnId = 0;
   ```
3. **fd_write interception** — when fd is CONTROL_FD, parse JSON command:
   - `connect` -> store in controlConnections, buffer `{"ok":true,"id":"cN"}` response
   - `request` -> reconstruct URL from connection's scheme/host + path, call `bridge.fetchSync()`, buffer JSON response
   - `close` -> delete from controlConnections, buffer `{"ok":true}` response
4. **fd_read interception** — when fd is CONTROL_FD, return buffered response bytes, clear buffer.

URL reconstruction:
```typescript
const conn = this.controlConnections.get(cmd.id);
const url = `${conn.scheme}://${conn.host}${cmd.path}`;
const result = this.networkBridge!.fetchSync(url, cmd.method, cmd.headers, cmd.body);
```

## Sandbox Bootstrap

In `Sandbox.create()`, when a bridge exists:

```typescript
if (bridge) {
  vfs.mkdir('/usr/lib/python');
  vfs.writeFile('/usr/lib/python/socket.py', new TextEncoder().encode(socketShimSource));
  runner.setEnv('PYTHONPATH', '/usr/lib/python');
}
```

The shim source lives as a string constant in `packages/orchestrator/src/network/socket-shim.ts`.

`fork()` inherits automatically — VFS is COW-cloned (socket.py comes along), env is copied (PYTHONPATH comes along).

## Cleanup: Remove Dead Socket Code

The control fd approach replaces the `sock_send`/`sock_recv`/`sock_shutdown` implementations added in the previous feature. Remove from `wasi-host.ts`:

- `sockConnections` map and its type
- `sockSend()`, `sockRecv()`, `sockShutdown()`, `processHttpRequest()` methods
- Revert `sock_send`, `sock_recv`, `sock_shutdown` back to stubs in `getImports()`
- `WASI_EAGAIN` import

Keep:
- `networkBridge` field (used by control fd handler)
- `sock_accept` stub

## Testing

### Layer 1: Control fd handler unit tests
- Write `connect` command -> get connection id
- Write `request` command -> get HTTP response (mock bridge)
- Write `close` command -> connection cleaned up
- Non-control fd writes -> VFS as normal
- Control fd not registered when no networkBridge -> EBADF

### Layer 2: Python socket shim integration tests
- `import socket` loads the VFS shim (not frozen module)
- `urllib.request.urlopen(url)` GET request end-to-end
- `urllib.request.urlopen(Request(url, data=b'hello', method='POST'))` POST with body
- `http.client.HTTPConnection` request/response cycle

### Layer 3: Sandbox integration tests
- Sandbox with `network: { allowedHosts: ['...'] }` -> Python HTTP GET succeeds
- Sandbox with blocked host -> Python request fails with policy error
- POST request -> body arrives at server

Python integration tests use a child-process HTTP server (same approach as bridge tests) to avoid Atomics.wait deadlock with same-process servers.

## Scope Limitations

- **HTTP only** — no WebSocket, no arbitrary TCP streams
- **No streaming** — full response buffered in memory
- **No chunked outgoing** — requests must use Content-Length
- **No SSL certificate validation** — the bridge's `fetch()` handles TLS transparently
- **`onRequest` callback bypassed** — the bridge uses synchronous `checkAccess()` only (inherent limitation of sync bridge, documented in previous feature)
