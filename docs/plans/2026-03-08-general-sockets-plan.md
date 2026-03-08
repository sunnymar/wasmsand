# General Socket Support + Tiered Network Modes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add general-purpose socket syscalls to the sandbox, tiered network modes (restricted/full), HTTPS support, and extract Python shims to static files.

**Architecture:** Socket operations become WASM-level syscalls in the `codepod` namespace (like file I/O). The bridge protocol is extended with multiplexed socket ops. Python shims are static `.py` files selected by mode. See `docs/plans/2026-03-08-general-sockets-design.md` for full design.

**Tech Stack:** TypeScript (orchestrator), Rust (shell-exec, python host), Python (socket shims), WASM

---

## Phase 1: Static Python shims + HTTPS support

### Task 1: Rename socket.py to socket_fetch.py

**Files:**
- Rename: `packages/orchestrator/src/network/python-shims/socket.py` → `socket_fetch.py`

**Step 1: Rename the file**

```bash
cd packages/orchestrator/src/network/python-shims
mv socket.py socket_fetch.py
```

**Step 2: Commit**

```bash
git add -A packages/orchestrator/src/network/python-shims/
git commit -m "refactor: rename socket.py to socket_fetch.py for restricted mode"
```

### Task 2: Create ssl.py shim

**Files:**
- Create: `packages/orchestrator/src/network/python-shims/ssl.py`

**Step 1: Extract ssl shim from socket-shim.ts to static file**

Create `ssl.py` with the same content as `SSL_SHIM_SOURCE` in socket-shim.ts, but as a real Python file (no TS escaping). The shim provides minimal SSLContext/wrap_socket that marks sockets for HTTPS — the host bridge handles actual TLS.

**Step 2: Commit**

```bash
git add packages/orchestrator/src/network/python-shims/ssl.py
git commit -m "feat: add ssl.py shim for Python HTTPS support"
```

### Task 3: Create sitecustomize.py

**Files:**
- Create: `packages/orchestrator/src/network/python-shims/sitecustomize.py`

**Step 1: Extract sitecustomize from socket-shim.ts to static file**

The sitecustomize.py injects our socket shim into `sys.modules["socket"]` at interpreter startup, overriding RustPython's frozen socket module. It also injects the ssl shim into `sys.modules["ssl"]`.

```python
import sys
import types
import importlib.machinery

# Inject socket shim
_spec = importlib.machinery.ModuleSpec("socket", None, origin="/usr/lib/python/socket.py")
_mod = types.ModuleType("socket")
_mod.__spec__ = _spec
_mod.__file__ = "/usr/lib/python/socket.py"
with open("/usr/lib/python/socket.py") as _f:
    _code = _f.read()
exec(compile(_code, "/usr/lib/python/socket.py", "exec"), _mod.__dict__)
sys.modules["socket"] = _mod
del _spec, _mod, _f, _code

# Inject ssl shim
_spec2 = importlib.machinery.ModuleSpec("ssl", None, origin="/usr/lib/python/ssl.py")
_mod2 = types.ModuleType("ssl")
_mod2.__spec__ = _spec2
_mod2.__file__ = "/usr/lib/python/ssl.py"
with open("/usr/lib/python/ssl.py") as _f2:
    _code2 = _f2.read()
exec(compile(_code2, "/usr/lib/python/ssl.py", "exec"), _mod2.__dict__)
sys.modules["ssl"] = _mod2
del _spec2, _mod2, _f2, _code2
```

**Step 2: Commit**

```bash
git add packages/orchestrator/src/network/python-shims/sitecustomize.py
git commit -m "feat: add sitecustomize.py to inject socket+ssl shims at startup"
```

### Task 4: Update socket-shim.ts to read static files

**Files:**
- Modify: `packages/orchestrator/src/network/socket-shim.ts`

**Step 1: Replace template string exports with file-reading functions**

Replace `SOCKET_SHIM_SOURCE`, `SSL_SHIM_SOURCE`, and `SITE_CUSTOMIZE_SOURCE` template strings with functions that read the static `.py` files. Use `import.meta.dirname` or `new URL('.', import.meta.url)` to resolve paths relative to the module.

```typescript
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIM_DIR = join(dirname(fileURLToPath(import.meta.url)), 'python-shims');

export function getSocketShimSource(mode: 'restricted' | 'full' = 'restricted'): string {
  const filename = mode === 'full' ? 'socket_native.py' : 'socket_fetch.py';
  return readFileSync(join(SHIM_DIR, filename), 'utf-8');
}

export function getSslShimSource(): string {
  return readFileSync(join(SHIM_DIR, 'ssl.py'), 'utf-8');
}

export function getSiteCustomizeSource(): string {
  return readFileSync(join(SHIM_DIR, 'sitecustomize.py'), 'utf-8');
}

// Keep old exports for backward compat during transition
export const SOCKET_SHIM_SOURCE = readFileSync(join(SHIM_DIR, 'socket_fetch.py'), 'utf-8');
export const SSL_SHIM_SOURCE = readFileSync(join(SHIM_DIR, 'ssl.py'), 'utf-8');
export const SITE_CUSTOMIZE_SOURCE = readFileSync(join(SHIM_DIR, 'sitecustomize.py'), 'utf-8');
```

**Step 2: Update all callers of the old exports**

Search for `SOCKET_SHIM_SOURCE`, `SSL_SHIM_SOURCE`, `SITE_CUSTOMIZE_SOURCE` imports in sandbox.ts and other files. Update them to use the new functions or keep using the re-exports.

**Step 3: Run TypeScript type check**

```bash
cd packages/orchestrator && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add packages/orchestrator/src/network/socket-shim.ts
git commit -m "refactor: read Python shims from static .py files instead of TS templates"
```

### Task 5: Write HTTPS test

**Files:**
- Modify: `packages/orchestrator/src/__tests__/sandbox.test.ts` (or create network-specific test)

**Step 1: Add test for Python HTTPS**

```typescript
Deno.test("python3 urllib HTTPS request", async () => {
  const sandbox = await Sandbox.create({ network: { allowedHosts: ["*"] } });
  const result = await sandbox.runCommand(
    `python3 -c "import urllib.request; r = urllib.request.urlopen('https://httpbin.org/get'); print(r.status)"`
  );
  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, "200");
  sandbox.destroy();
});
```

**Step 2: Run test**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts --filter "HTTPS"
```
Expected: PASS (ssl shim makes HTTPSHandler work, host bridge handles TLS via fetch)

**Step 3: Commit**

```bash
git add packages/orchestrator/src/__tests__/sandbox.test.ts
git commit -m "test: add HTTPS test for Python urllib with ssl shim"
```

### Task 6: Write networkBridge propagation test

**Files:**
- Modify: `packages/orchestrator/src/__tests__/sandbox.test.ts`

**Step 1: Add regression test for child process networking**

```typescript
Deno.test("python3 subprocess has network access", async () => {
  const sandbox = await Sandbox.create({ network: { allowedHosts: ["*"] } });
  // python3 is spawned as a child process of the shell — this tests networkBridge propagation
  const result = await sandbox.runCommand(
    `python3 -c "import urllib.request; r = urllib.request.urlopen('http://httpbin.org/get'); print(r.status)"`
  );
  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.stdout, "200");
  sandbox.destroy();
});
```

**Step 2: Run test**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts --filter "subprocess has network"
```

**Step 3: Commit**

```bash
git add packages/orchestrator/src/__tests__/sandbox.test.ts
git commit -m "test: add regression test for child process networkBridge propagation"
```

---

## Phase 2: NetworkPolicy + Bridge protocol extension

### Task 7: Add mode and allowListen to NetworkPolicy

**Files:**
- Modify: `packages/orchestrator/src/network/gateway.ts`

**Step 1: Update NetworkPolicy interface**

Add `mode?: 'restricted' | 'full'` (default: `'restricted'`) and `allowListen?: boolean` (default: `false`) to the `NetworkPolicy` interface.

**Step 2: Update gateway logic**

The gateway should check `mode` when socket operations are requested:
- `restricted`: only `fetch` ops allowed
- `full`: `fetch` + `connect`/`send`/`recv`/`close` allowed

**Step 3: Run type check**

```bash
cd packages/orchestrator && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add packages/orchestrator/src/network/gateway.ts
git commit -m "feat: add mode and allowListen to NetworkPolicy"
```

### Task 8: Extend bridge worker with socket operations

**Files:**
- Modify: `packages/orchestrator/src/network/bridge.ts`

**Step 1: Add requestSync() method**

Generalize the existing `fetchSync()` to handle any operation via an `op` field in the JSON payload. Existing requests without `op` are treated as `fetch` for backward compat.

**Step 2: Add socket op handlers in the worker**

The worker should handle:
- `connect`: `{op:"connect", host, port, tls}` → opens `Deno.connect()` or `Deno.connectTls()`, returns `{ok, socket_id}`
- `send`: `{op:"send", socket_id, data_b64}` → writes to socket, returns `{ok, bytes_sent}`
- `recv`: `{op:"recv", socket_id, max_bytes}` → reads from socket, returns `{ok, data_b64}`
- `close`: `{op:"close", socket_id}` → closes socket, returns `{ok}`

The worker maintains `Map<number, Deno.Conn>` for open sockets.

**Step 3: Policy check on connect**

Before opening a connection, check host against `allowedHosts`/`blockedHosts` lists. For `send`/`recv`/`close`, the socket_id was already authorized at connect time.

**Step 4: Run existing network tests**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts --filter "network"
```
Expected: existing tests still pass (backward compat)

**Step 5: Commit**

```bash
git add packages/orchestrator/src/network/bridge.ts
git commit -m "feat: extend bridge worker with socket connect/send/recv/close ops"
```

---

## Phase 3: WASM syscalls + Rust HostInterface

### Task 9: Add host_socket_* kernel imports

**Files:**
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts`

**Step 1: Add socket syscalls to kernel imports**

Add four new functions to the `codepod` namespace:

```typescript
host_socket_connect(req_ptr: number, req_len: number, out_ptr: number, out_cap: number): number {
  // Read JSON request from WASM memory: {host, port, tls}
  // Check mode === 'full', else return error
  // Call networkBridge.requestSync({op:"connect", host, port, tls})
  // Write JSON response to out_ptr, return bytes written
},
host_socket_send(req_ptr: number, req_len: number, out_ptr: number, out_cap: number): number { ... },
host_socket_recv(req_ptr: number, req_len: number, out_ptr: number, out_cap: number): number { ... },
host_socket_close(req_ptr: number, req_len: number): number { ... },
```

Follow the same pattern as `host_network_fetch`: read JSON from WASM memory, call bridge, write response back.

**Step 2: Add to shell imports**

Wire the same functions through `packages/orchestrator/src/host-imports/shell-imports.ts` so the shell binary can also use them.

**Step 3: Run type check**

```bash
cd packages/orchestrator && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add packages/orchestrator/src/host-imports/kernel-imports.ts packages/orchestrator/src/host-imports/shell-imports.ts
git commit -m "feat: add host_socket_* WASM syscalls for general socket access"
```

### Task 10: Add socket methods to Rust HostInterface

**Files:**
- Modify: `packages/shell-exec/src/host.rs`

**Step 1: Add socket methods to HostInterface trait**

```rust
fn socket_connect(&self, host: &str, port: u16, tls: bool) -> Result<u32, HostError>;
fn socket_send(&self, socket_id: u32, data: &[u8]) -> Result<usize, HostError>;
fn socket_recv(&self, socket_id: u32, max_bytes: usize) -> Result<Vec<u8>, HostError>;
fn socket_close(&self, socket_id: u32) -> Result<(), HostError>;
```

**Step 2: Add extern "C" host import declarations**

In the `#[cfg(target_arch = "wasm32")]` block:

```rust
extern "C" {
    fn host_socket_connect(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_socket_send(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_socket_recv(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_socket_close(req_ptr: *const u8, req_len: u32) -> i32;
}
```

**Step 3: Implement WasmHost methods**

Each method serializes a JSON request, calls the host import, deserializes the response. Same pattern as `fetch()`.

**Step 4: Add stubs to MockHost in test_support.rs**

```rust
fn socket_connect(&self, _host: &str, _port: u16, _tls: bool) -> Result<u32, HostError> {
    Err(HostError::IoError("not available in test".into()))
}
// ... same for send/recv/close
```

**Step 5: Build and test**

```bash
cd packages/shell-exec && cargo fmt && cargo test && cargo build --target wasm32-wasip1 --release
```

**Step 6: Commit**

```bash
git add packages/shell-exec/src/host.rs packages/shell-exec/src/test_support.rs
git commit -m "feat: add socket_connect/send/recv/close to Rust HostInterface"
```

---

## Phase 4: Python full-mode shim + _codepod FFI

### Task 11: Create socket_native.py

**Files:**
- Create: `packages/orchestrator/src/network/python-shims/socket_native.py`

**Step 1: Write the native socket shim**

This shim proxies real socket operations through `_codepod.socket_*()`:

```python
"""
Wasmsand socket shim (full mode) — proxies to real host sockets via _codepod.

Replaces the standard socket module. Provides connect/send/recv/close
through host socket syscalls for real TCP/TLS connections.
"""

import _codepod
import base64 as _base64

# ... same constants as socket_fetch.py ...

class socket:
    def __init__(self, family=AF_INET, type=SOCK_STREAM, proto=0, fileno=None):
        self._family = family
        self._type = type
        self._socket_id = None
        self._host = None
        self._port = None
        self._timeout = None
        self._closed = False
        self._tls = False

    def connect(self, address):
        host, port = address
        if isinstance(port, str):
            port = int(port)
        self._host = host
        self._port = port
        result = _codepod.socket_connect(host, port, self._tls)
        self._socket_id = result

    def send(self, data):
        if isinstance(data, memoryview):
            data = bytes(data)
        return _codepod.socket_send(self._socket_id, data)

    def sendall(self, data):
        if isinstance(data, memoryview):
            data = bytes(data)
        sent = 0
        while sent < len(data):
            sent += _codepod.socket_send(self._socket_id, data[sent:])

    def recv(self, bufsize):
        return _codepod.socket_recv(self._socket_id, bufsize)

    def close(self):
        if not self._closed and self._socket_id is not None:
            _codepod.socket_close(self._socket_id)
            self._closed = True

    # ... same utility methods as socket_fetch.py (settimeout, makefile, etc.)
```

**Step 2: Commit**

```bash
git add packages/orchestrator/src/network/python-shims/socket_native.py
git commit -m "feat: add socket_native.py for full-mode real socket proxy"
```

### Task 12: Add _codepod.socket_* Python FFI

**Files:**
- Modify: `packages/python/crates/codepod-host/src/lib.rs`

**Step 1: Add socket functions to the _codepod module**

```rust
#[pyfunction]
fn socket_connect(host: String, port: u16, tls: Option<bool>) -> PyResult<u32> {
    // Serialize JSON, call host_socket_connect, deserialize response
}

#[pyfunction]
fn socket_send(socket_id: u32, data: &[u8]) -> PyResult<usize> { ... }

#[pyfunction]
fn socket_recv(socket_id: u32, max_bytes: usize) -> PyResult<Vec<u8>> { ... }

#[pyfunction]
fn socket_close(socket_id: u32) -> PyResult<()> { ... }
```

**Step 2: Register in the module**

Add `m.add_function(wrap_pyfunction!(socket_connect, m)?)?;` etc.

**Step 3: Build**

```bash
cd packages/python && cargo build --target wasm32-wasip1 --release
```

**Step 4: Commit**

```bash
git add packages/python/crates/codepod-host/src/lib.rs
git commit -m "feat: add _codepod.socket_* FFI for Python full-mode sockets"
```

### Task 13: Mode-based shim selection in sandbox.ts

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts`

**Step 1: Update shim writing logic**

When creating the sandbox with networking enabled, select the socket shim based on `network.mode`:

```typescript
const socketSource = getSocketShimSource(network?.mode ?? 'restricted');
vfs.writeFile('/usr/lib/python/socket.py', socketSource);
vfs.writeFile('/usr/lib/python/ssl.py', getSslShimSource());
vfs.writeFile('/usr/lib/python/sitecustomize.py', getSiteCustomizeSource());
```

**Step 2: Run existing tests**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts
```

**Step 3: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts
git commit -m "feat: select socket shim by network mode (restricted/full)"
```

---

## Phase 5: Integration tests

### Task 14: End-to-end network tests

**Files:**
- Create or modify: `packages/orchestrator/src/__tests__/network.test.ts`

**Step 1: Write test suite**

```typescript
// Test 1: HTTP fetch in restricted mode (existing behavior)
// Test 2: HTTPS fetch in restricted mode (ssl shim)
// Test 3: curl/wget still work (both modes)
// Test 4: Python urllib HTTP
// Test 5: Python urllib HTTPS
// Test 6: Raw socket rejected in restricted mode
// Test 7: Raw TCP socket in full mode (connects to test server)
// Test 8: networkBridge propagation to child processes
// Test 9: Policy enforcement on socket connect (blocked host rejected)
```

**Step 2: Run tests**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/network.test.ts
```

**Step 3: Commit**

```bash
git add packages/orchestrator/src/__tests__/network.test.ts
git commit -m "test: add end-to-end network tests for restricted and full modes"
```

---

## Phase 6: Documentation

### Task 15: Create syscalls.md

**Files:**
- Create: `docs/guides/syscalls.md`

**Step 1: Write complete syscall reference**

Two namespaces:

1. **`wasi_snapshot_preview1`** — standard WASI P1 syscalls (fd_read, fd_write, clock_time_get, random_get, proc_exit, etc.)

2. **`codepod`** — sandbox extensions:
   - Process: host_pipe, host_spawn, host_waitpid, host_close_fd, host_read_fd, host_write_fd, host_dup, host_dup2, host_yield
   - Network (HTTP): host_network_fetch
   - Network (sockets): host_socket_connect, host_socket_send, host_socket_recv, host_socket_close
   - Extensions: host_extension_invoke, host_is_extension

For each syscall: signature, JSON request/response format, error behavior, availability by mode.

Include Rust `extern "C"` declarations for command authors.

**Step 2: Commit**

```bash
git add docs/guides/syscalls.md
git commit -m "docs: add complete syscall reference for WASM binaries"
```

### Task 16: Update existing docs

**Files:**
- Modify: `docs/guides/creating-commands.md`
- Modify: `docs/guides/security.md`
- Modify: `docs/guides/shell-reference.md` (if exists)
- Modify: `docs/guides/typescript-sdk.md` (if exists)

**Step 1: Update creating-commands.md**

Change "Network access | No | WASI sockets not implemented" to document both restricted and full mode network access. Add "Network I/O" section showing `extern "C"` declarations.

**Step 2: Update security.md**

Update WASI capability table and "Network isolation" section to document both modes, `allowListen`, and `NetworkPolicy` changes.

**Step 3: Update SDK docs**

Add `mode` and `allowListen` to NetworkPolicy interface examples.

**Step 4: Commit**

```bash
git add docs/guides/
git commit -m "docs: update guides for socket syscalls and tiered network modes"
```
