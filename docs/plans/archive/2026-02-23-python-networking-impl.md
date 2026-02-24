# Python Networking via Socket Shim — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable Python's `requests`, `urllib`, and `http.client` to work inside the sandbox by replacing `socket.py` with a shim that communicates via a control file descriptor.

**Architecture:** A replacement `socket.py` is written to the VFS at sandbox creation. It implements the minimal socket API needed for HTTP clients (`connect`, `send`, `recv`, `makefile`). Internally it sends JSON commands over a reserved control fd (`0xFFFFFFFE`). WasiHost intercepts reads/writes on this fd, dispatches HTTP requests via the existing `NetworkBridge.fetchSync()`, and returns responses.

**Tech Stack:** TypeScript, Python, bun:test, WASI Preview 1, SharedArrayBuffer/Atomics

**Design doc:** `docs/plans/2026-02-23-python-networking-design.md`

---

## Task 1: Create the Python socket shim source

**Files:**
- Create: `packages/orchestrator/src/network/socket-shim.ts`
- Test: `packages/orchestrator/src/network/__tests__/socket-shim.test.ts`

This task creates the Python socket replacement as a TypeScript string constant. We test it's valid Python syntax by running it through the sandbox later (Task 5), but here we verify the export exists and contains the expected API surface.

**Step 1: Write the failing test**

Create `packages/orchestrator/src/network/__tests__/socket-shim.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { SOCKET_SHIM_SOURCE } from '../socket-shim.js';

describe('socket shim source', () => {
  it('exports a non-empty Python source string', () => {
    expect(typeof SOCKET_SHIM_SOURCE).toBe('string');
    expect(SOCKET_SHIM_SOURCE.length).toBeGreaterThan(100);
  });

  it('contains the required socket API surface', () => {
    expect(SOCKET_SHIM_SOURCE).toContain('class socket:');
    expect(SOCKET_SHIM_SOURCE).toContain('def connect(');
    expect(SOCKET_SHIM_SOURCE).toContain('def send(');
    expect(SOCKET_SHIM_SOURCE).toContain('def sendall(');
    expect(SOCKET_SHIM_SOURCE).toContain('def recv(');
    expect(SOCKET_SHIM_SOURCE).toContain('def makefile(');
    expect(SOCKET_SHIM_SOURCE).toContain('def close(');
    expect(SOCKET_SHIM_SOURCE).toContain('def create_connection(');
    expect(SOCKET_SHIM_SOURCE).toContain('def getaddrinfo(');
    expect(SOCKET_SHIM_SOURCE).toContain('CONTROL_FD');
    expect(SOCKET_SHIM_SOURCE).toContain('0xFFFFFFFE');
  });

  it('contains Content-Length aware flush logic', () => {
    expect(SOCKET_SHIM_SOURCE).toContain('content-length');
    expect(SOCKET_SHIM_SOURCE).toContain('_should_flush');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/orchestrator/src/network/__tests__/socket-shim.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the socket shim**

Create `packages/orchestrator/src/network/socket-shim.ts`:

```typescript
/**
 * Python socket module replacement that routes through a host control fd.
 *
 * This source is written to the VFS at /usr/lib/python/socket.py by
 * Sandbox.create() when networking is enabled. It shadows RustPython's
 * frozen socket module via PYTHONPATH.
 */
export const SOCKET_SHIM_SOURCE = `\
"""
Wasmsand socket shim — routes HTTP through host control fd.

Replaces the standard socket module. Supports connect/send/recv/makefile
for HTTP client use (requests, urllib, http.client).
"""

import os as _os
import json as _json

# Control fd for host communication — 0xFFFFFFFE (one below 32-bit WASI max)
CONTROL_FD = 0xFFFFFFFE

# Constants expected by http.client and urllib3
AF_INET = 2
AF_INET6 = 10
SOCK_STREAM = 1
SOCK_DGRAM = 2
IPPROTO_TCP = 6
SOL_SOCKET = 1
SO_KEEPALIVE = 9
TCP_NODELAY = 1
SHUT_RDWR = 2
_GLOBAL_DEFAULT_TIMEOUT = object()
timeout = OSError
error = OSError
herror = OSError
gaierror = OSError


def create_connection(address, timeout=_GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    host, port = address
    sock = socket(AF_INET, SOCK_STREAM)
    if timeout is not _GLOBAL_DEFAULT_TIMEOUT and timeout is not None:
        sock.settimeout(timeout)
    sock.connect((host, port))
    return sock


def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    if isinstance(port, str):
        port = int(port)
    return [(AF_INET, SOCK_STREAM, IPPROTO_TCP, '', (host, port or 80))]


def getfqdn(name=''):
    return name or 'localhost'


def gethostname():
    return 'localhost'


def gethostbyname(hostname):
    return '127.0.0.1'


def _control(cmd):
    """Send a JSON command to the host control fd, read JSON response."""
    payload = _json.dumps(cmd).encode('utf-8') + b"\\n"
    _os.write(CONTROL_FD, payload)
    data = _os.read(CONTROL_FD, 16 * 1024 * 1024)
    return _json.loads(data)


class socket:
    """Minimal socket implementing the subset needed for HTTP clients."""

    def __init__(self, family=AF_INET, type=SOCK_STREAM, proto=0, fileno=None):
        self._family = family
        self._type = type
        self._host = None
        self._port = None
        self._conn_id = None
        self._timeout = None
        self._sendbuf = b""
        self._recvbuf = b""
        self._closed = False

    def connect(self, address):
        host, port = address
        if isinstance(port, str):
            port = int(port)
        self._host = host
        self._port = port
        resp = _control({"cmd": "connect", "host": host, "port": port})
        self._conn_id = resp["id"]

    def connect_ex(self, address):
        try:
            self.connect(address)
            return 0
        except Exception:
            return 1

    def sendall(self, data):
        if isinstance(data, memoryview):
            data = bytes(data)
        self._sendbuf += data

    def send(self, data):
        if isinstance(data, memoryview):
            data = bytes(data)
        self._sendbuf += data
        return len(data)

    def recv(self, bufsize):
        if not self._recvbuf and self._should_flush():
            self._flush_request()
        chunk = self._recvbuf[:bufsize]
        self._recvbuf = self._recvbuf[bufsize:]
        return chunk

    def recv_into(self, buffer, nbytes=0):
        data = self.recv(nbytes or len(buffer))
        buffer[:len(data)] = data
        return len(data)

    def makefile(self, mode="r", buffering=-1, **kwargs):
        return _SocketFile(self, mode)

    def settimeout(self, timeout):
        self._timeout = timeout

    def gettimeout(self):
        return self._timeout

    def setblocking(self, flag):
        self._timeout = None if flag else 0.0

    def setsockopt(self, *args):
        pass

    def getsockopt(self, *args):
        return 0

    def getpeername(self):
        return (self._host, self._port)

    def fileno(self):
        return -1

    def close(self):
        if self._conn_id and not self._closed:
            try:
                _control({"cmd": "close", "id": self._conn_id})
            except Exception:
                pass
            self._closed = True

    def shutdown(self, how):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _should_flush(self):
        """Check if send buffer contains a complete HTTP request."""
        idx = self._sendbuf.find(b"\\r\\n\\r\\n")
        if idx < 0:
            return False
        header_block = self._sendbuf[:idx].decode("utf-8", errors="replace")
        for line in header_block.split("\\r\\n"):
            if line.lower().startswith("content-length:"):
                expected = int(line.split(":", 1)[1].strip())
                body_start = idx + 4
                return len(self._sendbuf) - body_start >= expected
        return True

    def _flush_request(self):
        """Parse buffered HTTP request, send via control fd, buffer response."""
        raw = self._sendbuf.decode("utf-8", errors="replace")
        head, _, body = raw.partition("\\r\\n\\r\\n")
        first_line, _, header_block = head.partition("\\r\\n")
        parts = first_line.split(" ", 2)
        method = parts[0] if parts else "GET"
        path = parts[1] if len(parts) > 1 else "/"
        headers = {}
        for line in header_block.split("\\r\\n"):
            if ": " in line:
                k, v = line.split(": ", 1)
                headers[k] = v
        resp = _control({
            "cmd": "request",
            "id": self._conn_id,
            "method": method,
            "path": path,
            "headers": headers,
            "body": body,
        })
        status = resp.get("status", 200)
        resp_headers = resp.get("headers", {})
        resp_body = resp.get("body", "")
        status_line = "HTTP/1.1 {} OK\\r\\n".format(status)
        header_lines = "".join("{}: {}\\r\\n".format(k, v) for k, v in resp_headers.items())
        body_bytes = resp_body.encode("utf-8") if isinstance(resp_body, str) else resp_body
        cl = "Content-Length: {}\\r\\n".format(len(body_bytes))
        self._recvbuf = (status_line + header_lines + cl + "\\r\\n").encode("utf-8") + body_bytes
        self._sendbuf = b""


class _SocketFile:
    """File-like wrapper returned by socket.makefile() — used by http.client."""

    def __init__(self, sock, mode):
        self._sock = sock
        self._mode = mode
        self.closed = False

    def read(self, n=-1):
        if not self._sock._recvbuf and self._sock._should_flush():
            self._sock._flush_request()
        if n is None or n < 0:
            data = self._sock._recvbuf
            self._sock._recvbuf = b""
            return data
        return self._sock.recv(n)

    def read1(self, n=-1):
        return self.read(n)

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)

    def readline(self, limit=-1):
        if not self._sock._recvbuf and self._sock._should_flush():
            self._sock._flush_request()
        buf = self._sock._recvbuf
        idx = buf.find(b"\\n")
        if idx >= 0:
            if limit > 0 and idx >= limit:
                line = buf[:limit]
                self._sock._recvbuf = buf[limit:]
            else:
                line = buf[:idx + 1]
                self._sock._recvbuf = buf[idx + 1:]
            return line
        if limit > 0:
            line = buf[:limit]
            self._sock._recvbuf = buf[limit:]
            return line
        self._sock._recvbuf = b""
        return buf

    def readlines(self, hint=-1):
        lines = []
        while True:
            line = self.readline()
            if not line:
                break
            lines.append(line)
        return lines

    def write(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self._sock.sendall(data)
        return len(data)

    def flush(self):
        pass

    def close(self):
        self.closed = True

    def readable(self):
        return "r" in self._mode or "b" in self._mode

    def writable(self):
        return "w" in self._mode

    def seekable(self):
        return False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __iter__(self):
        return self

    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line
`;
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/orchestrator/src/network/__tests__/socket-shim.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add packages/orchestrator/src/network/socket-shim.ts packages/orchestrator/src/network/__tests__/socket-shim.test.ts
git commit -m "feat: add Python socket shim source for networking via control fd"
```

---

## Task 2: Add control fd handler to WasiHost

**Files:**
- Modify: `packages/orchestrator/src/wasi/wasi-host.ts:107-160` (fields, constructor), `:353-437` (fdWrite, fdRead), `:849-950` (remove dead socket code)
- Test: `packages/orchestrator/src/wasi/__tests__/wasi-host.test.ts` (add control fd tests)

This task adds the control fd protocol to WasiHost, intercepting fd_write/fd_read on `0xFFFFFFFE`. It also removes the dead `sockSend`/`sockRecv`/`sockShutdown`/`processHttpRequest` code.

**Step 1: Write the failing tests**

Add to `packages/orchestrator/src/wasi/__tests__/wasi-host.test.ts` (or create a new `control-fd.test.ts` alongside it):

Create `packages/orchestrator/src/network/__tests__/control-fd.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { NetworkBridge } from '../bridge.js';
import { NetworkGateway } from '../gateway.js';
import { WasiHost } from '../../wasi/wasi-host.js';
import { VFS } from '../../vfs/vfs.js';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Tests for the control fd protocol in WasiHost.
 *
 * These tests create a WasiHost with a NetworkBridge and exercise
 * the control fd (0xFFFFFFFE) by simulating what the Python socket
 * shim would do: write JSON commands, read JSON responses.
 *
 * We can't call fdWrite/fdRead directly (they need WASM memory),
 * so we test through a minimal WASM module or by testing the
 * parseControlCommand / getControlResponse methods if exposed.
 *
 * For the integration path, we test via Sandbox.run() in Task 5.
 * Here we test the command parsing and response generation in isolation.
 */

// Use a child-process HTTP server to avoid Atomics.wait deadlock
let serverProcess: ChildProcess;
let baseUrl: string;

beforeEach(async () => {
  const serverScript = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        if (req.url === '/data') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('control fd response');
          return;
        }
        if (req.url === '/echo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, body }));
          return;
        }
        res.writeHead(404);
        res.end('not found');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n');
    });
  `;

  serverProcess = spawn(process.execPath, ['-e', serverScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    serverProcess.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.trim()) {
          try {
            const info = JSON.parse(line.trim());
            if (info.port) { resolve(info.port); return; }
          } catch {}
        }
      }
    });
    serverProcess.on('error', reject);
    setTimeout(() => reject(new Error('Timeout')), 5000);
  });

  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  serverProcess?.kill();
});

describe('WasiHost control fd', () => {
  it('handles connect command', () => {
    const vfs = new VFS();
    const gateway = new NetworkGateway({ allowedHosts: ['127.0.0.1'] });
    const bridge = new NetworkBridge(gateway);
    const host = new WasiHost({
      vfs,
      args: ['test'],
      env: {},
      preopens: { '/': '/' },
      networkBridge: bridge,
    });

    const resp = host.handleControlCommand({ cmd: 'connect', host: '127.0.0.1', port: 80 });
    expect(resp.ok).toBe(true);
    expect(resp.id).toBeDefined();
  });

  it('handles request command via bridge', async () => {
    const vfs = new VFS();
    const gateway = new NetworkGateway({ allowedHosts: ['127.0.0.1'] });
    const bridge = new NetworkBridge(gateway);
    await bridge.start();

    const host = new WasiHost({
      vfs,
      args: ['test'],
      env: {},
      preopens: { '/': '/' },
      networkBridge: bridge,
    });

    // First connect
    const connResp = host.handleControlCommand({ cmd: 'connect', host: '127.0.0.1', port: new URL(baseUrl).port });
    const connId = connResp.id;

    // Then request
    const reqResp = host.handleControlCommand({
      cmd: 'request',
      id: connId,
      method: 'GET',
      path: '/data',
      headers: {},
      body: '',
    });

    expect(reqResp.ok).toBe(true);
    expect(reqResp.status).toBe(200);
    expect(reqResp.body).toBe('control fd response');

    bridge.dispose();
  });

  it('handles POST request with body', async () => {
    const vfs = new VFS();
    const gateway = new NetworkGateway({ allowedHosts: ['127.0.0.1'] });
    const bridge = new NetworkBridge(gateway);
    await bridge.start();

    const host = new WasiHost({
      vfs,
      args: ['test'],
      env: {},
      preopens: { '/': '/' },
      networkBridge: bridge,
    });

    const connResp = host.handleControlCommand({ cmd: 'connect', host: '127.0.0.1', port: new URL(baseUrl).port });

    const reqResp = host.handleControlCommand({
      cmd: 'request',
      id: connResp.id,
      method: 'POST',
      path: '/echo',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello world',
    });

    expect(reqResp.ok).toBe(true);
    expect(reqResp.status).toBe(200);
    const parsed = JSON.parse(reqResp.body);
    expect(parsed.method).toBe('POST');
    expect(parsed.body).toBe('hello world');

    bridge.dispose();
  });

  it('handles close command', () => {
    const vfs = new VFS();
    const gateway = new NetworkGateway({ allowedHosts: ['127.0.0.1'] });
    const bridge = new NetworkBridge(gateway);
    const host = new WasiHost({
      vfs,
      args: ['test'],
      env: {},
      preopens: { '/': '/' },
      networkBridge: bridge,
    });

    const connResp = host.handleControlCommand({ cmd: 'connect', host: '127.0.0.1', port: 80 });
    const closeResp = host.handleControlCommand({ cmd: 'close', id: connResp.id });
    expect(closeResp.ok).toBe(true);
  });

  it('returns error when no bridge is configured', () => {
    const vfs = new VFS();
    const host = new WasiHost({
      vfs,
      args: ['test'],
      env: {},
      preopens: { '/': '/' },
    });

    const resp = host.handleControlCommand({ cmd: 'connect', host: 'example.com', port: 80 });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBeDefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/orchestrator/src/network/__tests__/control-fd.test.ts`
Expected: FAIL — `handleControlCommand` does not exist

**Step 3: Implement the control fd handler**

In `packages/orchestrator/src/wasi/wasi-host.ts`:

A. Add the control fd constant and new fields (around line 107-133):

```typescript
/** Control fd for Python socket shim communication. */
const CONTROL_FD = 0xFFFFFFFE;

// In WasiHost class, replace sockConnections with:
private controlConnections: Map<string, { host: string; port: number; scheme: string }> = new Map();
private controlResponseBuf: Uint8Array | null = null;
private nextControlConnId = 0;
```

B. Remove the old `sockConnections` map (lines 126-132).

C. Add `handleControlCommand` public method:

```typescript
/** Handle a control fd command. Public for testing. */
handleControlCommand(cmd: Record<string, unknown>): Record<string, unknown> {
  if (!this.networkBridge) {
    return { ok: false, error: 'networking not configured' };
  }

  switch (cmd.cmd) {
    case 'connect': {
      const host = cmd.host as string;
      const port = cmd.port as number;
      const scheme = port === 443 ? 'https' : 'http';
      const id = `c${this.nextControlConnId++}`;
      this.controlConnections.set(id, { host, port, scheme });
      return { ok: true, id };
    }
    case 'request': {
      const conn = this.controlConnections.get(cmd.id as string);
      if (!conn) return { ok: false, error: 'unknown connection id' };
      const url = `${conn.scheme}://${conn.host}${cmd.path as string}`;
      const result = this.networkBridge.fetchSync(
        url, cmd.method as string, (cmd.headers as Record<string, string>) ?? {}, (cmd.body as string) || undefined,
      );
      return {
        ok: true,
        status: result.status,
        headers: result.headers,
        body: result.body,
        error: result.error,
      };
    }
    case 'close': {
      this.controlConnections.delete(cmd.id as string);
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown command: ${cmd.cmd}` };
  }
}
```

D. Modify `fdWrite` (line 353) to intercept the control fd:

```typescript
private fdWrite(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
  const view = this.getView();
  const bytes = this.getBytes();
  const iovecs = readIovecs(view, iovsPtr, iovsLen);

  let totalWritten = 0;

  for (const iov of iovecs) {
    const data = bytes.slice(iov.buf, iov.buf + iov.len);

    if (fd === 1) {
      this.stdoutBuf.push(data);
      totalWritten += data.byteLength;
    } else if (fd === 2) {
      this.stderrBuf.push(data);
      totalWritten += data.byteLength;
    } else if (fd === CONTROL_FD) {
      // Control fd: parse JSON command, buffer response
      const cmdStr = this.decoder.decode(data).trim();
      if (cmdStr) {
        try {
          const cmd = JSON.parse(cmdStr);
          const resp = this.handleControlCommand(cmd);
          this.controlResponseBuf = this.encoder.encode(JSON.stringify(resp));
        } catch {
          this.controlResponseBuf = this.encoder.encode(JSON.stringify({ ok: false, error: 'invalid JSON' }));
        }
      }
      totalWritten += data.byteLength;
    } else {
      try {
        totalWritten += this.fdTable.write(fd, data);
      } catch (err) {
        return fdErrorToWasi(err);
      }
    }
  }

  const viewAfter = this.getView();
  viewAfter.setUint32(nwrittenPtr, totalWritten, true);
  return WASI_ESUCCESS;
}
```

E. Modify `fdRead` (line 389) to intercept the control fd:

```typescript
// In fdRead, after the fd === 0 (stdin) block, add before the FdTable read:
if (fd === CONTROL_FD) {
  if (!this.controlResponseBuf) break;
  const remaining = this.controlResponseBuf.byteLength;
  const toRead = Math.min(iov.len, remaining);
  const bytes = this.getBytes();
  bytes.set(this.controlResponseBuf.subarray(0, toRead), iov.buf);
  totalRead += toRead;
  this.controlResponseBuf = null; // consumed
  break;
}
```

F. Remove dead socket code:
- Delete `sockSend()` method (lines 860-888)
- Delete `sockRecv()` method (lines 890-913)
- Delete `sockShutdown()` method (lines 915-918)
- Delete `processHttpRequest()` method (lines 920-950)
- Revert `sock_send`, `sock_recv`, `sock_shutdown` in `getImports()` (lines 250-252) back to `this.stub.bind(this)`
- Remove `WASI_EAGAIN` from the import (line 17) and the `sockConnections` type (lines 126-132)
- Update `fdClose` (line 448) to remove `this.sockConnections.delete(fd)` — replace with `this.controlConnections` cleanup if needed (not necessary since control connections use string IDs not fd numbers)

G. Update `fdFdstatGet` (around line 515) to recognize the control fd:

```typescript
// In fdFdstatGet, add a check for CONTROL_FD before the EBADF return:
} else if (fd === CONTROL_FD) {
  filetype = WASI_FILETYPE_CHARACTER_DEVICE;
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/orchestrator/src/network/__tests__/control-fd.test.ts`
Expected: PASS (5 tests)

Run: `bun test` (full suite)
Expected: All tests PASS — no regressions

**Step 5: Commit**

```bash
git add packages/orchestrator/src/wasi/wasi-host.ts packages/orchestrator/src/network/__tests__/control-fd.test.ts
git commit -m "feat: add control fd handler to WasiHost for Python networking"
```

---

## Task 3: Bootstrap socket shim in Sandbox

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts:72-105` (create method), `:185-222` (fork method)
- Test: `packages/orchestrator/src/__tests__/sandbox.test.ts`

This task wires up the socket shim into the sandbox lifecycle.

**Step 1: Write the failing tests**

Add to `packages/orchestrator/src/__tests__/sandbox.test.ts`:

```typescript
describe('socket shim bootstrap', () => {
  it('writes socket.py to VFS when network is configured', async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter,
      network: { allowedHosts: ['example.com'] },
    });
    const data = sandbox.readFile('/usr/lib/python/socket.py');
    const content = new TextDecoder().decode(data);
    expect(content).toContain('CONTROL_FD');
    expect(content).toContain('class socket:');
    sandbox.destroy();
  });

  it('sets PYTHONPATH when network is configured', async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter,
      network: { allowedHosts: ['example.com'] },
    });
    expect(sandbox.getEnv('PYTHONPATH')).toBe('/usr/lib/python');
    sandbox.destroy();
  });

  it('does not write socket.py when network is not configured', async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter,
    });
    expect(() => sandbox.readFile('/usr/lib/python/socket.py')).toThrow();
    sandbox.destroy();
  });

  it('forked sandbox inherits socket.py', async () => {
    const parent = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter,
      network: { allowedHosts: ['example.com'] },
    });
    const child = await parent.fork();
    const data = child.readFile('/usr/lib/python/socket.py');
    expect(new TextDecoder().decode(data)).toContain('CONTROL_FD');
    child.destroy();
    parent.destroy();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/orchestrator/src/__tests__/sandbox.test.ts`
Expected: FAIL — socket.py not found in VFS

**Step 3: Implement the bootstrap**

In `packages/orchestrator/src/sandbox.ts`:

A. Add import at the top:
```typescript
import { SOCKET_SHIM_SOURCE } from './network/socket-shim.js';
```

B. In `create()` (after line 102, before the return), add:
```typescript
// Bootstrap Python socket shim when networking is enabled
if (bridge) {
  vfs.mkdir('/usr/lib');
  vfs.mkdir('/usr/lib/python');
  vfs.writeFile('/usr/lib/python/socket.py', new TextEncoder().encode(SOCKET_SHIM_SOURCE));
  runner.setEnv('PYTHONPATH', '/usr/lib/python');
}
```

Note: `/usr/lib` may already exist from the default VFS layout. Check if `vfs.mkdir` throws on existing dirs — if so, wrap in try/catch or check first.

C. No changes needed for `fork()` — the COW-cloned VFS already contains socket.py, and the env (including PYTHONPATH) is copied in the existing env copy loop.

**Step 4: Run tests to verify they pass**

Run: `bun test packages/orchestrator/src/__tests__/sandbox.test.ts`
Expected: PASS

Run: `bun test` (full suite)
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/orchestrator/src/__tests__/sandbox.test.ts
git commit -m "feat: bootstrap Python socket shim in sandbox when networking enabled"
```

---

## Task 4: Python integration tests

**Files:**
- Create: `packages/orchestrator/src/network/__tests__/python-networking.test.ts`

This is the end-to-end test: create a sandbox with networking, run Python code that uses `urllib`/`http.client`, verify it works. Uses a child-process HTTP server.

**NOTE:** These tests require `python3.wasm` to be available in the fixture directory. If it's not present, the tests should be skipped. Check for the WASM file path used in existing sandbox tests.

**Step 1: Write the tests**

Create `packages/orchestrator/src/network/__tests__/python-networking.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Sandbox } from '../../sandbox.js';
import { NodeAdapter } from '../../platform/node-adapter.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

const WASM_DIR = new URL('../../platform/__tests__/fixtures', import.meta.url).pathname;
const PYTHON_WASM = `${WASM_DIR}/python3.wasm`;

// Skip all tests if python3.wasm is not available
const hasPython = existsSync(PYTHON_WASM);

let serverProcess: ChildProcess;
let serverPort: number;
const adapter = new NodeAdapter();

beforeAll(async () => {
  if (!hasPython) return;

  const serverScript = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        if (req.url === '/hello') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Hello from test server');
          return;
        }
        if (req.url === '/echo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, body, headers: req.headers }));
          return;
        }
        res.writeHead(404);
        res.end('not found');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n');
    });
  `;

  serverProcess = spawn(process.execPath, ['-e', serverScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  serverPort = await new Promise<number>((resolve, reject) => {
    let output = '';
    serverProcess.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.trim()) {
          try {
            const info = JSON.parse(line.trim());
            if (info.port) { resolve(info.port); return; }
          } catch {}
        }
      }
    });
    serverProcess.on('error', reject);
    setTimeout(() => reject(new Error('Timeout')), 5000);
  });
});

afterAll(() => {
  serverProcess?.kill();
});

describe('Python networking via socket shim', () => {
  it.skipIf(!hasPython)('GET request via urllib', async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter,
      network: { allowedHosts: ['127.0.0.1'] },
    });

    const result = await sandbox.run(`python3 -c "
from urllib.request import urlopen
resp = urlopen('http://127.0.0.1:${serverPort}/hello')
print(resp.read().decode())
"`);

    expect(result.stdout.trim()).toBe('Hello from test server');
    expect(result.exitCode).toBe(0);
    sandbox.destroy();
  }, 30_000);

  it.skipIf(!hasPython)('GET request via http.client', async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter,
      network: { allowedHosts: ['127.0.0.1'] },
    });

    const result = await sandbox.run(`python3 -c "
import http.client
conn = http.client.HTTPConnection('127.0.0.1', ${serverPort})
conn.request('GET', '/hello')
resp = conn.getresponse()
print(resp.read().decode())
conn.close()
"`);

    expect(result.stdout.trim()).toBe('Hello from test server');
    expect(result.exitCode).toBe(0);
    sandbox.destroy();
  }, 30_000);

  it.skipIf(!hasPython)('POST request with body', async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter,
      network: { allowedHosts: ['127.0.0.1'] },
    });

    const result = await sandbox.run(`python3 -c "
from urllib.request import urlopen, Request
req = Request('http://127.0.0.1:${serverPort}/echo', data=b'test body', method='POST')
resp = urlopen(req)
import json
data = json.loads(resp.read().decode())
print(data['method'])
print(data['body'])
"`);

    const lines = result.stdout.trim().split('\n');
    expect(lines[0]).toBe('POST');
    expect(lines[1]).toBe('test body');
    expect(result.exitCode).toBe(0);
    sandbox.destroy();
  }, 30_000);

  it.skipIf(!hasPython)('blocked host returns error', async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter,
      network: { allowedHosts: ['allowed.com'] },
    });

    const result = await sandbox.run(`python3 -c "
from urllib.request import urlopen
try:
    urlopen('http://127.0.0.1:${serverPort}/hello')
    print('should not reach here')
except Exception as e:
    print('blocked')
"`);

    expect(result.stdout.trim()).toBe('blocked');
    sandbox.destroy();
  }, 30_000);

  it.skipIf(!hasPython)('no networking without network config', async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter,
    });

    // socket module should be the frozen stdlib, not our shim
    const result = await sandbox.run(`python3 -c "
import socket
print(hasattr(socket, 'CONTROL_FD'))
"`);

    expect(result.stdout.trim()).toBe('False');
    sandbox.destroy();
  }, 30_000);
});
```

**Step 2: Run tests**

Run: `bun test packages/orchestrator/src/network/__tests__/python-networking.test.ts`
Expected: PASS (or all skipped if python3.wasm not available)

Run: `bun test` (full suite)
Expected: All tests PASS

**Step 3: Commit**

```bash
git add packages/orchestrator/src/network/__tests__/python-networking.test.ts
git commit -m "test: add Python networking integration tests via socket shim"
```

---

## Task 5: Full test suite verification

**Step 1: Run all orchestrator tests**

Run: `bun test packages/orchestrator`
Expected: All PASS

**Step 2: Run SDK server tests**

Run: `bun test packages/sdk-server`
Expected: All PASS

**Step 3: Run full suite**

Run: `bun test`
Expected: All PASS — no regressions

**Step 4: Commit if any fixups needed**

```bash
git add -A && git commit -m "fix: test suite fixups after Python networking integration"
```
