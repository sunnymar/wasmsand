# Server Sockets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete POSIX TCP server socket support for Codepod guests: `bind`, `listen`, `accept`, loopback connects, mapped host ports, and Rust/C canaries.

**Architecture:** The kernel owns socket fd state, sandbox-visible address metadata, and listen authorization. Runtime backends own actual listener implementation: Node/Deno uses `net.Server`; unsupported backends return explicit errors until they implement the same `SocketBackend` contract. Loopback listeners bind to backend ephemeral host ports and are reachable inside the sandbox at the sandbox port; `0.0.0.0` listeners require a configured port mapping and an `onListen` authorization check.

**Tech Stack:** TypeScript kernel/imports/network bridge, Node `net`, C `libcodepod.a` socket shims, Rust std patches/canaries, Deno tests, guest-compat WASM fixtures.

---

## Design Decisions

- Server socket support is backend-backed, not a fake in-kernel TCP stack. The backend `accept` operation is a nonblocking poll so the single-SAB bridge request loop can continue servicing loopback `connect` requests. POSIX blocking semantics are implemented above that poll surface by the C/Rust socket shim paths.
- Sandbox-visible local address remains fake metadata. Accepted loopback sockets report `127.0.0.1:<sandboxPort>`. Connected outbound sockets report `10.0.2.15:<ephemeral>`. The host’s actual IP is never reported.
- Listening on `127.0.0.1` or `localhost` is allowed only when `serverSockets.allowLoopback === true`.
- Listening on `0.0.0.0` is allowed only when `serverSockets.portMappings` contains the sandbox port and `serverSockets.onListen` does not reject it. The first implementation binds the host listener to `127.0.0.1:<hostPort>` unless the mapping later grows an explicit host bind address.
- `bind()` records local address intent on a socket fd. `listen()` creates a listener from that bound metadata. `accept()` returns a new connected socket fd.
- Unsupported backends must fail clearly with `EOPNOTSUPP`; they must not silently no-op.

## File Structure

| Path | Responsibility |
| --- | --- |
| `packages/orchestrator/src/network/socket-backend.ts` | Extend backend contract with `listen`, `accept`, and listener handles. |
| `packages/orchestrator/src/network/bridge.ts` | Node worker implementation for listen/accept plus loopback connect routing. |
| `packages/orchestrator/src/host-imports/kernel-imports.ts` | `host_socket_bind`, `host_socket_listen`, `host_socket_accept` policy, fd allocation, and address metadata. |
| `packages/orchestrator/src/wasi/fd-target.ts` | Socket fd target metadata for bound/listening/connected states. |
| `packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts` | Policy and fd-level server socket tests. |
| `packages/orchestrator/src/network/__tests__/bridge.test.ts` | Backend bridge listener/connect/accept tests against Node `net`. |
| `packages/guest-compat/src/codepod_socket.c` | POSIX `bind`, `listen`, `accept` shims that call `host_socket_*`. |
| `packages/guest-compat/conformance/c/socket-listen-canary.c` | End-to-end C server/client canary using `posix_spawn`. |
| `packages/guest-compat/conformance/rust/std-net-listener-canary/` | Rust `std::net::TcpListener` canary. |
| `packages/guest-compat/Makefile` | Build new canaries and fixtures. |
| `packages/orchestrator/src/__tests__/guest-compat.test.ts` | Run new C/Rust canaries inside the sandbox. |
| `patches/rust/1.93.0`, `patches/rust/1.94.1`, `patches/rust/1.95.0` | Patch Rust std listener APIs if current Codepod std only covers `TcpStream`. |

---

## Task 1: Backend Contract For Listeners

**Files:**
- Modify: `packages/orchestrator/src/network/socket-backend.ts`
- Test: `packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts`

- [x] **Step 1: Write the failing type-level test**

Replace the current “without enabling listen” expectation in `packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts` with a backend that records `listen` calls:

```ts
it('authorizes loopback listen and stores listener handle on the socket fd', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const listenPolicy: SocketListenPolicy = { allowLoopback: true };
  const calls: unknown[] = [];
  const backend: SocketBackend = {
    connect: () => ({ ok: false, error: 'not used' }),
    send: () => ({ ok: true, bytes_sent: 0 }),
    recv: () => ({ ok: true, data_b64: '' }),
    close: () => ({ ok: true }),
    listen(req) {
      calls.push(req);
      return {
        ok: true,
        listener: 9001,
        host: '127.0.0.1',
        port: req.port,
      };
    },
    accept: () => ({ ok: false, error: 'not used' }),
    closeListener: () => ({ ok: true }),
  };
  const imports = createKernelImports({
    memory,
    kernel,
    socketBackend: backend,
    serverSockets: listenPolicy,
  });
  const fd = (imports.host_socket_open as (...args: number[]) => number)(2, 1, 0);
  const bindLen = writeString(memory, 16, JSON.stringify({
    fd,
    host: '127.0.0.1',
    port: 18081,
  }));
  const bindOut = (imports.host_socket_bind as (...args: number[]) => number)(16, bindLen, 256, 4096);
  expect(readJson(memory, 256, bindOut)).toEqual({ ok: true });

  const listenLen = writeString(memory, 16, JSON.stringify({ fd, backlog: 8 }));
  const listenOut = (imports.host_socket_listen as (...args: number[]) => number)(16, listenLen, 256, 4096);

  expect(readJson(memory, 256, listenOut)).toEqual({ ok: true });
  expect(calls).toEqual([{
    host: '127.0.0.1',
    port: 18081,
    backlog: 8,
  }]);
  expect(kernel.getFdTarget(0, fd)).toMatchObject({
    type: 'socket',
    listener: 9001,
    boundHost: '127.0.0.1',
    boundPort: 18081,
  });
});
```

- [x] **Step 2: Run the test and verify it fails**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts
```

Expected: fails because `SocketBackend` has no `listen`/`accept`/`closeListener` members and `host_socket_bind/listen` still return “server sockets are not implemented”.

- [x] **Step 3: Extend the backend types**

In `packages/orchestrator/src/network/socket-backend.ts`, add listener handles and request/result types:

```ts
export type SocketHandle = number;
export type SocketListenerHandle = number;

export interface SocketListenBackendRequest {
  host: '127.0.0.1' | 'localhost' | '0.0.0.0';
  port: number;
  backlog: number;
  mapping?: SocketPortMapping;
}

export type SocketListenBackendResult =
  | { ok: true; listener: SocketListenerHandle; host: string; port: number }
  | { ok: false; error: string };

export type SocketAcceptBackendResult =
  | {
      ok: true;
      socket: SocketHandle;
      peerHost: string;
      peerPort: number;
      localHost: string;
      localPort: number;
    }
  | { ok: false; wouldBlock: true; error: 'accept would block' }
  | { ok: false; error: string };

export interface SocketBackend {
  connect(req: { host: string; port: number; tls: boolean }): { ok: true; socket: SocketHandle } | { ok: false; error: string };
  send(socket: SocketHandle, dataB64: string): SocketBackendResult;
  recv(socket: SocketHandle, maxBytes: number): SocketBackendResult;
  setNoDelay?(socket: SocketHandle, enabled: boolean): SocketBackendResult;
  listen?(req: SocketListenBackendRequest): SocketListenBackendResult;
  /** Polls for one accepted socket. Must not block the bridge request loop. */
  accept?(listener: SocketListenerHandle): SocketAcceptBackendResult;
  closeListener?(listener: SocketListenerHandle): SocketBackendResult;
  close(socket: SocketHandle): SocketBackendResult;
}
```

Do not delete the existing `SocketListenPolicy`; it remains the kernel-facing policy object.

- [x] **Step 4: Run type-check**

Run:

```bash
source scripts/dev-init.sh && deno check packages/orchestrator/src/network/socket-backend.ts packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts
```

Expected: type-check passes or only fails in `kernel-imports.ts` because bind/listen are not implemented yet.

- [x] **Step 5: Commit**

```bash
git add packages/orchestrator/src/network/socket-backend.ts packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts
git commit -m "feat(socket): define listener backend contract"
```

---

## Task 2: Kernel Bind/Listen/Accept Semantics

**Files:**
- Modify: `packages/orchestrator/src/wasi/fd-target.ts`
- Modify: `packages/orchestrator/src/process/kernel.ts`
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts`
- Test: `packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts`
- Test: `packages/orchestrator/src/host-imports/__tests__/socket-fds.test.ts`

- [x] **Step 1: Add policy rejection tests**

Append these tests to `packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts`:

```ts
it('rejects loopback listen when allowLoopback is not enabled', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const backend: SocketBackend = {
    connect: () => ({ ok: false, error: 'not used' }),
    send: () => ({ ok: true, bytes_sent: 0 }),
    recv: () => ({ ok: true, data_b64: '' }),
    close: () => ({ ok: true }),
    listen: () => { throw new Error('policy denial must happen before backend.listen'); },
    accept: () => ({ ok: false, error: 'not used' }),
    closeListener: () => ({ ok: true }),
  };
  const imports = createKernelImports({
    memory,
    kernel,
    socketBackend: backend,
    serverSockets: { allowLoopback: false },
  });
  const fd = (imports.host_socket_open as (...args: number[]) => number)(2, 1, 0);
  const bindLen = writeString(memory, 16, JSON.stringify({ fd, host: '127.0.0.1', port: 18081 }));
  (imports.host_socket_bind as (...args: number[]) => number)(16, bindLen, 256, 4096);
  const listenLen = writeString(memory, 16, JSON.stringify({ fd, backlog: 8 }));

  const out = (imports.host_socket_listen as (...args: number[]) => number)(16, listenLen, 256, 4096);

  expect(readJson(memory, 256, out)).toEqual({
    ok: false,
    error: 'listen on 127.0.0.1:18081 is not allowed by sandbox policy',
  });
});

it('allows mapped 0.0.0.0 listen only for configured mapped ports', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const calls: unknown[] = [];
  const backend: SocketBackend = {
    connect: () => ({ ok: false, error: 'not used' }),
    send: () => ({ ok: true, bytes_sent: 0 }),
    recv: () => ({ ok: true, data_b64: '' }),
    close: () => ({ ok: true }),
    listen(req) {
      calls.push(req);
      return { ok: true, listener: 44, host: '127.0.0.1', port: 19081 };
    },
    accept: () => ({ ok: false, error: 'not used' }),
    closeListener: () => ({ ok: true }),
  };
  const imports = createKernelImports({
    memory,
    kernel,
    socketBackend: backend,
    serverSockets: {
      allowLoopback: false,
      portMappings: [{ sandboxHost: '0.0.0.0', sandboxPort: 8080, hostPort: 19081 }],
      onListen: (req) => req.port === 8080,
    },
  });
  const fd = (imports.host_socket_open as (...args: number[]) => number)(2, 1, 0);
  const bindLen = writeString(memory, 16, JSON.stringify({ fd, host: '0.0.0.0', port: 8080 }));
  expect(readJson(memory, 256, (imports.host_socket_bind as (...args: number[]) => number)(16, bindLen, 256, 4096))).toEqual({ ok: true });

  const listenLen = writeString(memory, 16, JSON.stringify({ fd, backlog: 8 }));
  const out = (imports.host_socket_listen as (...args: number[]) => number)(16, listenLen, 256, 4096);

  expect(readJson(memory, 256, out)).toEqual({ ok: true });
  expect(calls).toEqual([{
    host: '0.0.0.0',
    port: 8080,
    backlog: 8,
    mapping: { sandboxHost: '0.0.0.0', sandboxPort: 8080, hostPort: 19081 },
  }]);
});
```

- [x] **Step 2: Add accept fd allocation test**

Add this test to `packages/orchestrator/src/host-imports/__tests__/socket-fds.test.ts`:

```ts
it('accepts a listener connection and allocates a connected socket fd', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const backend: SocketBackend = {
    connect: () => ({ ok: false, error: 'not used' }),
    send: () => ({ ok: true, bytes_sent: 0 }),
    recv: () => ({ ok: true, data_b64: '' }),
    close: () => ({ ok: true }),
    listen: () => ({ ok: true, listener: 55, host: '127.0.0.1', port: 18081 }),
    accept: () => ({
      ok: true,
      socket: 66,
      peerHost: '127.0.0.1',
      peerPort: 50123,
      localHost: '127.0.0.1',
      localPort: 18081,
    }),
    closeListener: () => ({ ok: true }),
  };
  const imports = createKernelImports({
    memory,
    kernel,
    socketBackend: backend,
    serverSockets: { allowLoopback: true },
  });
  const fd = (imports.host_socket_open as (...args: number[]) => number)(2, 1, 0);
  const bindLen = writeString(memory, 16, JSON.stringify({ fd, host: '127.0.0.1', port: 18081 }));
  (imports.host_socket_bind as (...args: number[]) => number)(16, bindLen, 256, 4096);
  const listenLen = writeString(memory, 16, JSON.stringify({ fd, backlog: 8 }));
  (imports.host_socket_listen as (...args: number[]) => number)(16, listenLen, 256, 4096);

  const acceptLen = writeString(memory, 16, JSON.stringify({ fd }));
  const out = (imports.host_socket_accept as (...args: number[]) => number)(16, acceptLen, 256, 4096);
  const accepted = readJson(memory, 256, out) as { ok: true; fd: number };

  expect(accepted.ok).toBe(true);
  expect(typeof accepted.fd).toBe('number');
  expect(kernel.getFdTarget(0, accepted.fd)).toMatchObject({
    type: 'socket',
    socket: 66,
    peerHost: '127.0.0.1',
    peerPort: 50123,
    localHost: '127.0.0.1',
    localPort: 18081,
  });
});
```

- [x] **Step 3: Run tests and verify failures**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts packages/orchestrator/src/host-imports/__tests__/socket-fds.test.ts
```

Expected: policy and accept tests fail because `host_socket_bind/listen/accept` still return fixed errors.

- [x] **Step 4: Extend fd target metadata**

In `packages/orchestrator/src/wasi/fd-target.ts`, extend the socket target union:

```ts
  | {
      type: 'socket';
      socket: SocketHandle | null;
      listener?: SocketListenerHandle | null;
      refs: number;
      boundHost?: '127.0.0.1' | 'localhost' | '0.0.0.0';
      boundPort?: number;
      peerHost?: string;
      peerPort?: number;
      localHost?: string;
      localPort?: number;
      noDelay?: boolean;
      peekBuffer?: Uint8Array;
      fdFlags?: number;
      readShutdown?: boolean;
      writeShutdown?: boolean;
      send: (socket: SocketHandle, dataB64: string) => SocketBackendResult;
      recv: (socket: SocketHandle, maxBytes: number) => SocketBackendResult;
      setNoDelay?: (socket: SocketHandle, enabled: boolean) => SocketBackendResult;
      close: (socket: SocketHandle) => void;
      closeListener?: (listener: SocketListenerHandle) => void;
    }
```

Add imports at the top:

```ts
import type { SocketBackendResult, SocketHandle, SocketListenerHandle } from '../network/socket-backend.js';
```

- [x] **Step 5: Implement policy helper in kernel imports**

In `packages/orchestrator/src/host-imports/kernel-imports.ts`, add this helper near the socket helpers:

```ts
function authorizeListen(
  policy: SocketListenPolicy | undefined,
  host: '127.0.0.1' | 'localhost' | '0.0.0.0',
  port: number,
  backlog: number,
): { ok: true; mapping?: SocketPortMapping } | { ok: false; error: string } {
  if (!policy) {
    return { ok: false, error: `listen on ${host}:${port} is not allowed by sandbox policy` };
  }
  if (host === '127.0.0.1' || host === 'localhost') {
    if (policy.allowLoopback === true) return { ok: true };
    return { ok: false, error: `listen on ${host}:${port} is not allowed by sandbox policy` };
  }
  const mapping = policy.portMappings?.find((m) =>
    m.sandboxHost === '0.0.0.0' && m.sandboxPort === port
  );
  if (!mapping) {
    return { ok: false, error: `listen on 0.0.0.0:${port} requires an explicit port mapping` };
  }
  const allowed = policy.onListen?.({ host, port, backlog, mapping });
  if (allowed === false) {
    return { ok: false, error: `listen on 0.0.0.0:${port} was denied by sandbox policy` };
  }
  if (allowed && typeof (allowed as Promise<boolean>).then === 'function') {
    return { ok: false, error: 'async listen authorization is not supported by synchronous socket imports' };
  }
  return { ok: true, mapping };
}
```

Also import `SocketListenPolicy` and `SocketPortMapping` if not already present:

```ts
import type { SocketBackend, SocketListenPolicy, SocketPortMapping } from '../network/socket-backend.js';
```

- [x] **Step 6: Implement `host_socket_bind`**

Replace the fixed `host_socket_bind` body in `kernel-imports.ts` with:

```ts
host_socket_bind(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
  try {
    const req = JSON.parse(readString(memory, reqPtr, reqLen));
    if (typeof req.fd !== 'number') {
      return writeJson(memory, outPtr, outCap, { ok: false, error: 'missing socket fd' });
    }
    const target = opts.kernel?.getFdTarget(callerPid, req.fd);
    if (!target || target.type !== 'socket') {
      return writeJson(memory, outPtr, outCap, { ok: false, error: `not a socket fd: ${req.fd}` });
    }
    const host = req.host === 'localhost' ? 'localhost' : req.host;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '0.0.0.0') {
      return writeJson(memory, outPtr, outCap, { ok: false, error: `unsupported bind host: ${String(req.host)}` });
    }
    if (typeof req.port !== 'number' || req.port < 0 || req.port > 65535) {
      return writeJson(memory, outPtr, outCap, { ok: false, error: `invalid bind port: ${String(req.port)}` });
    }
    target.boundHost = host;
    target.boundPort = req.port;
    target.localHost = host === '0.0.0.0' ? socketLocalHost : host;
    target.localPort = req.port;
    return writeJson(memory, outPtr, outCap, { ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
  }
},
```

- [x] **Step 7: Implement `host_socket_listen`**

Replace `host_socket_listen` with:

```ts
host_socket_listen(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
  try {
    const req = JSON.parse(readString(memory, reqPtr, reqLen));
    if (typeof req.fd !== 'number') {
      return writeJson(memory, outPtr, outCap, { ok: false, error: 'missing socket fd' });
    }
    const target = opts.kernel?.getFdTarget(callerPid, req.fd);
    if (!target || target.type !== 'socket') {
      return writeJson(memory, outPtr, outCap, { ok: false, error: `not a socket fd: ${req.fd}` });
    }
    const host = target.boundHost ?? '127.0.0.1';
    const port = target.boundPort ?? 0;
    const backlog = typeof req.backlog === 'number' && req.backlog > 0 ? req.backlog : 128;
    const auth = authorizeListen(serverSockets, host, port, backlog);
    if (!auth.ok) return writeJson(memory, outPtr, outCap, auth);
    if (!socketBackend?.listen) {
      return writeJson(memory, outPtr, outCap, { ok: false, error: 'server sockets are not supported by this backend' });
    }
    const result = socketBackend.listen({ host, port, backlog, mapping: auth.mapping });
    if (!result.ok) return writeJson(memory, outPtr, outCap, result);
    target.listener = result.listener;
    target.boundHost = host;
    target.boundPort = port;
    target.localHost = result.host;
    target.localPort = result.port;
    target.closeListener = (listener) => { socketBackend.closeListener?.(listener); };
    return writeJson(memory, outPtr, outCap, { ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
  }
},
```

- [x] **Step 8: Implement `host_socket_accept`**

Replace `host_socket_accept` with:

```ts
host_socket_accept(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
  if (!socketBackend?.accept) {
    return writeJson(memory, outPtr, outCap, { ok: false, error: 'server sockets are not supported by this backend' });
  }
  try {
    const req = JSON.parse(readString(memory, reqPtr, reqLen));
    if (typeof req.fd !== 'number') {
      return writeJson(memory, outPtr, outCap, { ok: false, error: 'missing socket fd' });
    }
    const target = opts.kernel?.getFdTarget(callerPid, req.fd);
    if (!target || target.type !== 'socket' || target.listener == null) {
      return writeJson(memory, outPtr, outCap, { ok: false, error: `not a listening socket fd: ${req.fd}` });
    }
    const accepted = socketBackend.accept(target.listener);
    if (!accepted.ok) return writeJson(memory, outPtr, outCap, accepted);
    if (!opts.kernel) {
      return writeJson(memory, outPtr, outCap, { ok: false, error: 'kernel not configured' });
    }
    const acceptedFd = opts.kernel.allocFd(callerPid, {
      type: 'socket',
      socket: accepted.socket,
      refs: 1,
      peerHost: accepted.peerHost,
      peerPort: accepted.peerPort,
      localHost: accepted.localHost,
      localPort: accepted.localPort,
      send: socketBackend.send.bind(socketBackend),
      recv: socketBackend.recv.bind(socketBackend),
      setNoDelay: socketBackend.setNoDelay?.bind(socketBackend),
      close: (socket) => { socketBackend.close(socket); },
    });
    return writeJson(memory, outPtr, outCap, {
      ok: true,
      fd: acceptedFd,
      peer_host: accepted.peerHost,
      peer_port: accepted.peerPort,
      local_host: accepted.localHost,
      local_port: accepted.localPort,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
  }
},
```

- [x] **Step 9: Ensure close cleans listeners**

In `ProcessKernel.cleanupFds` and `closeFd`, when target type is `socket`:

```ts
if (target.type === 'socket') {
  if (target.listener != null && target.closeListener) {
    target.closeListener(target.listener);
    target.listener = null;
  }
  if (target.socket !== null) {
    target.close(target.socket);
    target.socket = null;
  }
}
```

If the current code already closes connected sockets in one place, update that branch rather than duplicating it.

- [x] **Step 10: Run tests**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts packages/orchestrator/src/host-imports/__tests__/socket-fds.test.ts
source scripts/dev-init.sh && deno check packages/orchestrator/src/host-imports/kernel-imports.ts packages/orchestrator/src/wasi/fd-target.ts
git diff --check -- packages/orchestrator/src/host-imports/kernel-imports.ts packages/orchestrator/src/wasi/fd-target.ts packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts packages/orchestrator/src/host-imports/__tests__/socket-fds.test.ts
```

Expected: all pass.

- [x] **Step 11: Commit**

```bash
git add packages/orchestrator/src/wasi/fd-target.ts packages/orchestrator/src/host-imports/kernel-imports.ts packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts packages/orchestrator/src/host-imports/__tests__/socket-fds.test.ts
git commit -m "feat(kernel): implement server socket fd imports"
```

---

## Task 3: Node Bridge Listener Backend

**Files:**
- Modify: `packages/orchestrator/src/network/socket-backend.ts`
- Modify: `packages/orchestrator/src/network/bridge.ts`
- Test: `packages/orchestrator/src/network/__tests__/bridge.test.ts`

- [x] **Step 1: Add bridge integration test**

Append to `packages/orchestrator/src/network/__tests__/bridge.test.ts`:

```ts
it('routes sandbox loopback connect to a backend listener', async () => {
  const gateway = new NetworkGateway({ allowedHosts: ['127.0.0.1', 'localhost'] });
  const bridge = new NetworkBridge(gateway);
  await bridge.start();
  try {
    const backend = createNetworkBridgeSocketBackend(bridge);
    const listen = backend.listen!({ host: '127.0.0.1', port: 18081, backlog: 8 });
    expect(listen.ok).toBe(true);
    if (!listen.ok) throw new Error(listen.error);

    const emptyAccept = backend.accept!(listen.listener);
    expect(emptyAccept).toEqual({ ok: false, wouldBlock: true, error: 'accept would block' });

    const client = backend.connect({ host: '127.0.0.1', port: 18081, tls: false });
    expect(client.ok).toBe(true);
    if (!client.ok) throw new Error(client.error);
    const accepted = backend.accept!(listen.listener);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(accepted.error);

    expect(backend.send(client.socket, btoa('ping'))).toEqual({ ok: true, bytes_sent: 4 });
    expect(backend.recv(accepted.socket, 4)).toEqual({ ok: true, data_b64: btoa('ping') });
    expect(backend.send(accepted.socket, btoa('pong'))).toEqual({ ok: true, bytes_sent: 4 });
    expect(backend.recv(client.socket, 4)).toEqual({ ok: true, data_b64: btoa('pong') });

    backend.close(client.socket);
    backend.close(accepted.socket);
    backend.closeListener!(listen.listener);
  } finally {
    bridge.dispose();
  }
});
```

- [x] **Step 2: Run and verify failure**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/network/__tests__/bridge.test.ts
```

Expected: fails because `createNetworkBridgeSocketBackend` does not implement `listen` and the worker has no `listen`/nonblocking `accept` operations.

- [x] **Step 3: Add bridge adapter methods**

In `createNetworkBridgeSocketBackend`, add:

```ts
listen(req) {
  const result = bridge.requestSync({
    op: 'listen',
    host: req.host,
    port: req.port,
    backlog: req.backlog,
    mapping: req.mapping,
  });
  if (!result.ok || typeof result.listener_id !== 'number') {
    return {
      ok: false,
      error: typeof result.error === 'string' ? result.error : 'socket listen failed',
    };
  }
  return {
    ok: true,
    listener: result.listener_id,
    host: typeof result.host === 'string' ? result.host : req.host,
    port: typeof result.port === 'number' ? result.port : req.port,
  };
},

accept(listener) {
  const result = bridge.requestSync({ op: 'accept', listener_id: listener });
  if (!result.ok && result.would_block === true) {
    return { ok: false, wouldBlock: true, error: 'accept would block' };
  }
  if (!result.ok || typeof result.socket_id !== 'number') {
    return {
      ok: false,
      error: typeof result.error === 'string' ? result.error : 'socket accept failed',
    };
  }
  return {
    ok: true,
    socket: result.socket_id,
    peerHost: typeof result.peer_host === 'string' ? result.peer_host : '127.0.0.1',
    peerPort: typeof result.peer_port === 'number' ? result.peer_port : 0,
    localHost: typeof result.local_host === 'string' ? result.local_host : '127.0.0.1',
    localPort: typeof result.local_port === 'number' ? result.local_port : 0,
  };
},

closeListener(listener) {
  return socketResult(bridge.requestSync({
    op: 'close_listener',
    listener_id: listener,
  }));
},
```

- [x] **Step 4: Add worker listener state**

Inside the worker code string in `NetworkBridge.start()`, near `const sockets = new Map();`, add:

```js
const listeners = new Map();
const loopbackRoutes = new Map();
let nextListenerId = 1;
function routeKey(host, port) {
  const normalized = host === 'localhost' ? '127.0.0.1' : host;
  return normalized + ':' + port;
}
```

- [x] **Step 5: Route loopback connects**

At the start of `handleConnect(req)` in the worker string, after policy check:

```js
const requestedKey = routeKey(req.host, req.port);
const routed = loopbackRoutes.get(requestedKey);
const host = routed ? routed.host : req.host;
const port = routed ? routed.port : req.port;
```

Then change:

```js
const opts = { host: req.host, port: req.port };
if (req.tls) opts.servername = req.host;
```

to:

```js
const opts = { host, port };
if (req.tls) opts.servername = req.host;
```

- [x] **Step 6: Implement `handleListen`**

Add in the worker string:

```js
async function handleListen(req) {
  if (!net) { writeErr('sockets not available (no net module)'); return; }
  const listenerId = nextListenerId++;
  const server = net.createServer();
  const pending = [];
  server.on('connection', (sock) => {
    const socketId = nextSocketId++;
    sockets.set(socketId, sock);
    const item = {
      socket_id: socketId,
      peer_host: sock.remoteAddress || '127.0.0.1',
      peer_port: sock.remotePort || 0,
      local_host: req.host === '0.0.0.0' ? '10.0.2.15' : '127.0.0.1',
      local_port: req.port,
    };
    pending.push(item);
  });
  const hostPort = req.mapping && req.host === '0.0.0.0' ? req.mapping.hostPort : 0;
  const bindHost = '127.0.0.1';
  return new Promise((resolve) => {
    let settled = false;
    function finishOk() {
      if (settled) return;
      settled = true;
      server.off('error', finishErr);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : hostPort;
      listeners.set(listenerId, { server, pending, actualPort });
      loopbackRoutes.set(routeKey(req.host, req.port), { host: bindHost, port: actualPort, listenerId });
      if (req.host === 'localhost') loopbackRoutes.set(routeKey('127.0.0.1', req.port), { host: bindHost, port: actualPort, listenerId });
      writeOk({ ok: true, listener_id: listenerId, host: req.host, port: req.port });
      resolve();
    }
    function finishErr(err) {
      if (settled) return;
      settled = true;
      writeErr('listen: ' + err.message);
      resolve();
    }
    server.once('error', finishErr);
    server.listen({ host: bindHost, port: hostPort, backlog: req.backlog || 128 }, () => {
      finishOk();
    });
  });
}
```

- [x] **Step 7: Implement nonblocking `handleAccept` and close listener**

Add in the worker string:

```js
function handleAccept(req) {
  const listener = listeners.get(req.listener_id);
  if (!listener) { writeErr('accept: invalid listener_id'); return; }
  if (listener.pending.length > 0) {
    const item = listener.pending.shift();
    writeOk({ ok: true, ...item });
    return;
  }
  writeOk({ ok: false, would_block: true, error: 'accept would block' });
}

function handleCloseListener(req) {
  const listener = listeners.get(req.listener_id);
  if (!listener) { writeErr('close_listener: invalid listener_id'); return; }
  listener.server.close();
  listeners.delete(req.listener_id);
  for (const [key, route] of loopbackRoutes.entries()) {
    if (route.listenerId === req.listener_id) loopbackRoutes.delete(key);
  }
  writeOk({ ok: true });
}
```

`accept` is deliberately a poll operation. It must never wait for a future connection inside the bridge worker because `requestSync` has a single shared SAB request slot; a blocking `accept` would prevent the worker from processing the `connect` request that satisfies it. Blocking POSIX semantics are implemented above the backend by retrying `host_socket_accept` from the C/Rust shim path when the socket is in blocking mode.

- [x] **Step 8: Register worker operations**

In the worker switch, add:

```js
case 'listen': await handleListen(req); break;
case 'accept': handleAccept(req); break;
case 'close_listener': handleCloseListener(req); break;
```

- [x] **Step 9: Run bridge tests**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/network/__tests__/bridge.test.ts packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts packages/orchestrator/src/host-imports/__tests__/socket-fds.test.ts
source scripts/dev-init.sh && deno check packages/orchestrator/src/network/socket-backend.ts packages/orchestrator/src/network/bridge.ts
git diff --check -- packages/orchestrator/src/network/socket-backend.ts packages/orchestrator/src/network/bridge.ts packages/orchestrator/src/network/__tests__/bridge.test.ts
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add packages/orchestrator/src/network/socket-backend.ts packages/orchestrator/src/network/bridge.ts packages/orchestrator/src/network/__tests__/bridge.test.ts
git commit -m "feat(socket): implement node listener backend"
```

---

## Task 4: C POSIX `bind` / `listen` / `accept`

**Files:**
- Modify: `packages/guest-compat/src/codepod_socket.c`
- Modify: `packages/guest-compat/src/codepod_runtime.h`
- Modify: `packages/guest-compat/conformance/c/socket-canary.c`
- Create: `packages/guest-compat/conformance/c/socket-listen-canary.c`
- Modify: `packages/guest-compat/Makefile`
- Modify: `packages/orchestrator/src/__tests__/guest-compat.test.ts`
- Modify: `packages/orchestrator/src/process/loader.ts`

- [x] **Step 1: Add runtime import declarations**

In `packages/guest-compat/src/codepod_runtime.h`, add:

```c
__attribute__((import_module("codepod"), import_name("host_socket_bind")))
int codepod_host_socket_bind(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_socket_listen")))
int codepod_host_socket_listen(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_socket_accept")))
int codepod_host_socket_accept(int req_ptr, int req_len, int out_ptr, int out_cap);
```

- [x] **Step 2: Replace `bind` shim**

In `packages/guest-compat/src/codepod_socket.c`, replace the current `bind` body with:

```c
int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  CODEPOD_MARKER_CALL(bind);
  char host[INET_ADDRSTRLEN];
  int port;
  char req[256];
  char resp[CODEPOD_SOCKET_RESP_CAP];
  int req_len;
  int n;

  if (codepod_sockaddr_to_host_port(addr, addrlen, host, sizeof(host), &port) != 0) {
    return -1;
  }
  req_len = snprintf(req, sizeof(req), "{\"fd\":%d,\"host\":\"%s\",\"port\":%d}", sockfd, host, port);
  if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
    errno = EOVERFLOW;
    return -1;
  }
  n = codepod_host_socket_bind((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
  if (n <= 0 || !parse_json_ok(resp, (size_t)n)) {
    errno = EOPNOTSUPP;
    return -1;
  }
  return 0;
}
```

If `codepod_sockaddr_to_host_port` does not exist yet, add it next to the current sockaddr fill helper:

```c
static int codepod_sockaddr_to_host_port(
  const struct sockaddr *addr,
  socklen_t addrlen,
  char *host,
  size_t host_cap,
  int *port
) {
  const struct sockaddr_in *in;
  if (!addr || addrlen < sizeof(struct sockaddr_in) || addr->sa_family != AF_INET) {
    errno = EAFNOSUPPORT;
    return -1;
  }
  in = (const struct sockaddr_in *)addr;
  if (!inet_ntop(AF_INET, &in->sin_addr, host, host_cap)) {
    errno = EINVAL;
    return -1;
  }
  *port = (int)ntohs(in->sin_port);
  return 0;
}
```

- [x] **Step 3: Replace `listen` shim**

Replace `listen` with:

```c
int listen(int sockfd, int backlog) {
  CODEPOD_MARKER_CALL(listen);
  char req[128];
  char resp[CODEPOD_SOCKET_RESP_CAP];
  int req_len;
  int n;

  req_len = snprintf(req, sizeof(req), "{\"fd\":%d,\"backlog\":%d}", sockfd, backlog);
  if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
    errno = EOVERFLOW;
    return -1;
  }
  n = codepod_host_socket_listen((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
  if (n <= 0 || !parse_json_ok(resp, (size_t)n)) {
    errno = EOPNOTSUPP;
    return -1;
  }
  return 0;
}
```

- [x] **Step 4: Replace `accept` shim**

Replace `codepod_accept_impl` with:

```c
static int codepod_accept_impl(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  CODEPOD_MARKER_CALL(accept);
  char req[128];
  char resp[CODEPOD_SOCKET_RESP_CAP];
  char peer_host[64];
  int peer_port = 0;
  int accepted_fd = -1;
  int req_len;
  int n;
  int attempts = 0;

  req_len = snprintf(req, sizeof(req), "{\"fd\":%d}", sockfd);
  if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
    errno = EOVERFLOW;
    return -1;
  }
  for (;;) {
    n = codepod_host_socket_accept((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
    if (n <= 0) {
      errno = EOPNOTSUPP;
      return -1;
    }
    if (parse_json_ok(resp, (size_t)n)) break;
    if (strstr(resp, "\"wouldBlock\":true") || strstr(resp, "\"would_block\":true")) {
      if (++attempts > 100000) {
        errno = EAGAIN;
        return -1;
      }
      continue;
    }
    errno = EOPNOTSUPP;
    return -1;
  }
  if (parse_json_int(resp, (size_t)n, "fd", &accepted_fd) != 0) {
    return -1;
  }
  if (addr && addrlen && *addrlen >= sizeof(struct sockaddr_in)) {
    if (parse_json_string_field(resp, (size_t)n, "peer_host", peer_host, sizeof(peer_host)) != 0 ||
        parse_json_int(resp, (size_t)n, "peer_port", &peer_port) != 0 ||
        codepod_fill_sockaddr_from_host(addr, addrlen, peer_host, peer_port) != 0) {
      return -1;
    }
  } else if (addrlen) {
    *addrlen = sizeof(struct sockaddr_in);
  }
  return accepted_fd;
}
```

- [x] **Step 5: Add C listen canary**

Create `packages/guest-compat/conformance/c/socket-listen-canary.c`:

```c
#include <arpa/inet.h>
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int run_client(const char *port_s) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in addr;
  char buf[8] = {0};
  if (fd < 0) return 2;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons((unsigned short)atoi(port_s));
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) return 3;
  if (send(fd, "ping", 4, 0) != 4) return 4;
  if (recv(fd, buf, 4, 0) != 4 || memcmp(buf, "pong", 4) != 0) return 5;
  close(fd);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "client") == 0) {
    return run_client(argv[2]);
  }

  const int port = 18081;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in addr;
  pid_t pid;
  char port_s[16];
  char *child_argv[] = { argv[0], "client", port_s, NULL };
  int accepted;
  char buf[8] = {0};
  int status = 0;

  if (fd < 0) { puts("socket=failed"); return 1; }
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    printf("bind=%d\n", errno);
    return 1;
  }
  if (listen(fd, 8) != 0) {
    printf("listen=%d\n", errno);
    return 1;
  }
  snprintf(port_s, sizeof(port_s), "%d", port);
  if (posix_spawn(&pid, argv[0], NULL, NULL, child_argv, environ) != 0) {
    puts("spawn=failed");
    return 1;
  }
  accepted = accept(fd, NULL, NULL);
  if (accepted < 0) {
    printf("accept=%d\n", errno);
    return 1;
  }
  if (recv(accepted, buf, 4, 0) != 4 || memcmp(buf, "ping", 4) != 0) {
    puts("recv=failed");
    return 1;
  }
  if (send(accepted, "pong", 4, 0) != 4) {
    puts("send=failed");
    return 1;
  }
  close(accepted);
  close(fd);
  waitpid(pid, &status, 0);
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    printf("client=%d\n", status);
    return 1;
  }
  puts("socket-listen=ok");
  return 0;
}
```

- [x] **Step 6: Update existing socket canary expectations**

In `packages/guest-compat/conformance/c/socket-canary.c`, keep the unsupported checks only for unmapped `0.0.0.0` or invalid policy. Replace the current `bind/listen/accept` unsupported block with:

```c
  struct sockaddr_in unsupported;
  memset(&unsupported, 0, sizeof(unsupported));
  unsupported.sin_family = AF_INET;
  unsupported.sin_port = htons(6553);
  inet_pton(AF_INET, "0.0.0.0", &unsupported.sin_addr);
  errno = 0;
  if (bind(fd, (struct sockaddr *)&unsupported, sizeof(unsupported)) != 0) {
    /* bind records intent; listen enforces policy. */
  }
  errno = 0;
  if (listen(fd, 1) != -1 || errno != EOPNOTSUPP) {
    emit("listen_policy", 1);
    freeaddrinfo(res);
    return 1;
  }
```

- [x] **Step 7: Wire Makefile and guest test**

In `packages/guest-compat/Makefile`, add `socket-listen-canary.wasm` to the C canary targets next to `socket-canary.wasm`.

In `packages/orchestrator/src/__tests__/guest-compat.test.ts`, add:

```ts
it('runs C POSIX socket listener through bind/listen/accept', async () => {
  sandbox = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter: new NodeAdapter(),
    network: { allowedHosts: ['127.0.0.1', 'localhost'] },
    serverSockets: { allowLoopback: true },
  });
  const result = await sandbox.run('socket-listen-canary');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('socket-listen=ok');
});
```

- [x] **Step 8: Build and run C canaries**

Run:

```bash
source scripts/dev-init.sh && make -C packages/guest-compat build/socket-listen-canary.wasm
cp packages/guest-compat/build/socket-listen-canary.wasm packages/orchestrator/src/platform/__tests__/fixtures/socket-listen-canary.wasm
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/guest-compat.test.ts
git diff --check -- packages/guest-compat/src/codepod_socket.c packages/guest-compat/src/codepod_runtime.h packages/guest-compat/conformance/c/socket-listen-canary.c packages/guest-compat/Makefile packages/orchestrator/src/__tests__/guest-compat.test.ts
```

Expected: guest compat passes including `socket-listen-canary`.

- [ ] **Step 9: Commit**

```bash
git add packages/guest-compat/src/codepod_socket.c packages/guest-compat/src/codepod_runtime.h packages/guest-compat/conformance/c/socket-canary.c packages/guest-compat/conformance/c/socket-listen-canary.c packages/guest-compat/Makefile packages/orchestrator/src/__tests__/guest-compat.test.ts packages/orchestrator/src/platform/__tests__/fixtures/socket-listen-canary.wasm
git commit -m "feat(socket): support POSIX bind listen accept"
```

---

## Task 5: Rust `TcpListener` Canary

**Files:**
- Create: `packages/guest-compat/conformance/rust/std-net-listener-canary/Cargo.toml`
- Create: `packages/guest-compat/conformance/rust/std-net-listener-canary/src/main.rs`
- Modify: `packages/guest-compat/Makefile`
- Create: `patches/rust/1.93.0/0018-wasip1-net-listener.patch`
- Create: `patches/rust/1.94.1/0018-wasi-net-listener.patch`
- Create: `patches/rust/1.95.0/0018-wasi-net-listener.patch`
- Modify: `packages/orchestrator/src/__tests__/guest-compat.test.ts`

- [x] **Step 1: Add Rust listener canary**

Create `packages/guest-compat/conformance/rust/std-net-listener-canary/Cargo.toml`:

```toml
[package]
name = "std-net-listener-canary"
version = "0.1.0"
edition = "2021"

[workspace]
```

Create `packages/guest-compat/conformance/rust/std-net-listener-canary/src/main.rs`:

```rust
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};

fn main() {
    let port = 18082;
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let listener = TcpListener::bind(addr).expect("bind loopback listener");
    let mut client = TcpStream::connect(addr).expect("connect loopback listener");
    client.write_all(b"ping").expect("write ping");

    let (mut stream, peer) = listener.accept().expect("accept client");
    assert_eq!(peer.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
    let mut buf = [0_u8; 4];
    stream.read_exact(&mut buf).expect("read ping");
    assert_eq!(&buf, b"ping");
    stream.write_all(b"pong").expect("write pong");

    let mut reply = [0_u8; 4];
    client.read_exact(&mut reply).expect("read pong");
    assert_eq!(&reply, b"pong");

    println!("std-net-listener=ok");
}
```

- [x] **Step 2: Wire canary build**

In `packages/guest-compat/Makefile`, add `std-net-listener-canary` beside the other Rust std net canaries and copy its `.wasm` fixture.

- [x] **Step 3: Run canary build and capture failure**

Run:

```bash
source scripts/dev-init.sh && make -C packages/guest-compat rust-std-canaries
```

Expected: fails before Step 4 because stock `wasm32-wasip1` `TcpListener::bind` is still unsupported by the current Codepod Rust std patch stack.

- [x] **Step 4: Patch Rust std listener APIs**

Create listener patches for all supported Rust versions (`1.93.0`, `1.94.1`, `1.95.0`). Each patch targets `library/std/src/sys/net/connection/wasip1.rs` after the existing Codepod TCP patches have been applied.

```bash
cp /tmp/rust-src-1.93.0/library/std/src/sys/net/connection/wasip1.rs /tmp/wasip1-before-listener-1.93.0.rs
cp /tmp/rust-src-1.94.1/library/std/src/sys/net/connection/wasip1.rs /tmp/wasip1-before-listener-1.94.1.rs
cp /tmp/rust-src-1.95.0/library/std/src/sys/net/connection/wasip1.rs /tmp/wasip1-before-listener-1.95.0.rs
```

Add the following extern declarations to the existing `unsafe extern "C"` block, keeping the existing `socket`, `connect`, `close`, `dup`, `recv`, `getsockname`, and `getaddrinfo` entries:

```rust
fn bind(fd: i32, addr: *const CodepodSockAddr, addr_len: CodepodSockLen) -> i32;
fn listen(fd: i32, backlog: i32) -> i32;
fn accept(fd: i32, addr: *mut CodepodSockAddr, addr_len: *mut CodepodSockLen) -> i32;
```

Add these helper functions beside `tcp_connect_addr`, `sockaddr_in_to_addr`, and the other Codepod socket helpers:

```rust
fn socket_addr_to_sockaddr_in(addr: &SocketAddr) -> io::Result<CodepodSockAddrIn> {
    let SocketAddr::V4(addr) = addr else {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "IPv6 sockets are not supported by Codepod wasm32-wasip1 yet",
        ));
    };
    Ok(CodepodSockAddrIn {
        sin_family: CODEPOD_AF_INET as CodepodSaFamily,
        sin_port: addr.port().to_be(),
        sin_addr: CodepodInAddr {
            s_addr: u32::from_ne_bytes(addr.ip().octets()),
        },
    })
}

fn tcp_listener_bind_addr(addr: &SocketAddr) -> io::Result<TcpListener> {
    let raw = socket_addr_to_sockaddr_in(addr)?;
    let fd = unsafe { socket(CODEPOD_AF_INET, CODEPOD_SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    let bind_rc = unsafe {
        bind(
            fd,
            &raw as *const CodepodSockAddrIn as *const CodepodSockAddr,
            mem::size_of::<CodepodSockAddrIn>() as CodepodSockLen,
        )
    };
    if bind_rc != 0 {
        let err = io::Error::last_os_error();
        unsafe { close(fd) };
        return Err(err);
    }

    let listen_rc = unsafe { listen(fd, 128) };
    if listen_rc != 0 {
        let err = io::Error::last_os_error();
        unsafe { close(fd) };
        return Err(err);
    }

    Ok(TcpListener { inner: unsafe { Socket::from_raw_fd(fd as RawFd) } })
}

fn tcp_listener_accept(listener: &TcpListener) -> io::Result<(TcpStream, SocketAddr)> {
    let mut raw = CodepodSockAddrIn {
        sin_family: 0,
        sin_port: 0,
        sin_addr: CodepodInAddr { s_addr: 0 },
    };
    let mut len = mem::size_of::<CodepodSockAddrIn>() as CodepodSockLen;
    let fd = unsafe {
        accept(
            listener.as_inner().as_inner().as_raw_fd() as i32,
            &mut raw as *mut CodepodSockAddrIn as *mut CodepodSockAddr,
            &mut len as *mut CodepodSockLen,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let peer = sockaddr_in_to_addr(&raw);
    Ok((
        TcpStream {
            inner: unsafe { Socket::from_raw_fd(fd as RawFd) },
            peer_addr: Some(peer),
        },
        peer,
    ))
}
```

Replace the `TcpListener` methods in `impl TcpListener`:

```rust
pub fn bind<A: ToSocketAddrs>(addr: A) -> io::Result<TcpListener> {
    super::each_addr(addr, tcp_listener_bind_addr)
}

pub fn socket_addr(&self) -> io::Result<SocketAddr> {
    let mut raw = CodepodSockAddrIn {
        sin_family: 0,
        sin_port: 0,
        sin_addr: CodepodInAddr { s_addr: 0 },
    };
    let mut len = mem::size_of::<CodepodSockAddrIn>() as CodepodSockLen;
    let rc = unsafe {
        getsockname(
            self.socket().as_raw_fd() as i32,
            &mut raw as *mut CodepodSockAddrIn as *mut CodepodSockAddr,
            &mut len as *mut CodepodSockLen,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(sockaddr_in_to_addr(&raw))
}

pub fn accept(&self) -> io::Result<(TcpStream, SocketAddr)> {
    tcp_listener_accept(self)
}
```

Generate the patch files with:

```bash
diff -u /tmp/wasip1-before-listener-1.93.0.rs /tmp/rust-src-1.93.0/library/std/src/sys/net/connection/wasip1.rs > patches/rust/1.93.0/0018-wasip1-net-listener.patch
diff -u /tmp/wasip1-before-listener-1.94.1.rs /tmp/rust-src-1.94.1/library/std/src/sys/net/connection/wasip1.rs > patches/rust/1.94.1/0018-wasi-net-listener.patch
diff -u /tmp/wasip1-before-listener-1.95.0.rs /tmp/rust-src-1.95.0/library/std/src/sys/net/connection/wasip1.rs > patches/rust/1.95.0/0018-wasi-net-listener.patch
```

These listener patches must use the guest libc symbols from `libcodepod.a`. They must not add a Rust-only host import path.

- [x] **Step 5: Add guest test**

In `packages/orchestrator/src/__tests__/guest-compat.test.ts`, add:

```ts
it('runs Rust std::net::TcpListener through Codepod std patches', async () => {
  sandbox = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter: new NodeAdapter(),
    network: { allowedHosts: ['127.0.0.1', 'localhost'] },
    serverSockets: { allowLoopback: true },
  });
  const result = await sandbox.run('std-net-listener-canary');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('std-net-listener=ok');
});
```

- [x] **Step 6: Verify Rust versions**

Run:

```bash
source scripts/dev-init.sh && ./scripts/check-rust-std-matrix.sh
source scripts/dev-init.sh && make -C packages/guest-compat rust-std-canaries
CPCC_ARCHIVE="$PWD/packages/guest-compat/build/libcodepod.a" CPCC_NO_WASM_OPT=1 CODEPOD_RUST_STD="$PWD/packages/guest-compat/build/rust-std/1.94.1" CARGO_TARGET_DIR="$PWD/target/rust-std-canaries/1.94.1-listener" RUSTUP_TOOLCHAIN=1.94.1 target/release/cargo-codepod codepod build --release --manifest-path packages/guest-compat/conformance/rust/std-net-listener-canary/Cargo.toml
CPCC_ARCHIVE="$PWD/packages/guest-compat/build/libcodepod.a" CPCC_NO_WASM_OPT=1 CODEPOD_RUST_STD="$PWD/packages/guest-compat/build/rust-std/1.95.0" CARGO_TARGET_DIR="$PWD/target/rust-std-canaries/1.95.0-listener" RUSTUP_TOOLCHAIN=1.95.0 target/release/cargo-codepod codepod build --release --manifest-path packages/guest-compat/conformance/rust/std-net-listener-canary/Cargo.toml
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/guest-compat.test.ts
git diff --check -- packages/guest-compat/conformance/rust/std-net-listener-canary packages/guest-compat/Makefile packages/orchestrator/src/__tests__/guest-compat.test.ts patches/rust
```

Expected: matrix and guest compat pass.

- [ ] **Step 7: Commit**

```bash
git add packages/guest-compat/conformance/rust/std-net-listener-canary packages/guest-compat/Makefile packages/orchestrator/src/__tests__/guest-compat.test.ts packages/orchestrator/src/platform/__tests__/fixtures/std-net-listener-canary.wasm patches/rust
git commit -m "feat(rust-std): support tcp listeners"
```

---

## Task 6: Mapped Host Port Integration

**Files:**
- Modify: `packages/orchestrator/src/network/__tests__/bridge.test.ts`
- Modify: `packages/orchestrator/src/__tests__/guest-compat.test.ts`
- Modify: `packages/orchestrator/src/network/bridge.ts`
- Create: `packages/guest-compat/conformance/c/socket-listen-denied-canary.c`
- Modify: `packages/guest-compat/Makefile`

- [ ] **Step 1: Add mapped-port bridge test**

In `packages/orchestrator/src/network/__tests__/bridge.test.ts`, add:

```ts
it('binds mapped 0.0.0.0 sandbox listeners to configured host port', async () => {
  const gateway = new NetworkGateway({ allowedHosts: ['127.0.0.1', 'localhost'] });
  const bridge = new NetworkBridge(gateway);
  await bridge.start();
  try {
    const backend = createNetworkBridgeSocketBackend(bridge);
    const listen = backend.listen!({
      host: '0.0.0.0',
      port: 8080,
      backlog: 8,
      mapping: { sandboxHost: '0.0.0.0', sandboxPort: 8080, hostPort: 0 },
    });
    expect(listen.ok).toBe(true);
    if (!listen.ok) throw new Error(listen.error);
    expect(listen.port).toBe(8080);
    backend.closeListener!(listen.listener);
  } finally {
    bridge.dispose();
  }
});
```

This test uses `hostPort: 0` to avoid collisions while still proving the mapped path is required and accepted.

- [ ] **Step 2: Add denied-listen C canary**

Create `packages/guest-compat/conformance/c/socket-listen-denied-canary.c`:

```c
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("socket");
        return 1;
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(8080);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        perror("bind");
        close(fd);
        return 1;
    }

    if (listen(fd, 1) == 0) {
        fprintf(stderr, "listen unexpectedly allowed\n");
        close(fd);
        return 1;
    }

    if (errno != EOPNOTSUPP && errno != EACCES && errno != EPERM) {
        fprintf(stderr, "unexpected errno: %d\n", errno);
        close(fd);
        return 1;
    }

    close(fd);
    puts("listen-denied=ok");
    return 0;
}
```

In `packages/guest-compat/Makefile`, build `socket-listen-denied-canary.wasm` beside `socket-listen-canary.wasm` and copy it to `packages/orchestrator/src/platform/__tests__/fixtures/`.

- [ ] **Step 3: Add guest policy test for denied mapping**

In `packages/orchestrator/src/__tests__/guest-compat.test.ts`, add:

```ts
it('rejects 0.0.0.0 listener when mapped port authorization denies it', async () => {
  sandbox = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter: new NodeAdapter(),
    network: { allowedHosts: ['127.0.0.1', 'localhost'] },
    serverSockets: {
      portMappings: [{ sandboxHost: '0.0.0.0', sandboxPort: 8080, hostPort: 0 }],
      onListen: () => false,
    },
  });
  const result = await sandbox.run('socket-listen-denied-canary');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('listen-denied=ok');
});
```

- [ ] **Step 4: Verify**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/network/__tests__/bridge.test.ts packages/orchestrator/src/__tests__/guest-compat.test.ts
git diff --check -- packages/orchestrator/src/network/__tests__/bridge.test.ts packages/orchestrator/src/__tests__/guest-compat.test.ts packages/orchestrator/src/network/bridge.ts packages/guest-compat/conformance/c/socket-listen-denied-canary.c packages/guest-compat/Makefile
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/network/__tests__/bridge.test.ts packages/orchestrator/src/__tests__/guest-compat.test.ts packages/orchestrator/src/network/bridge.ts packages/guest-compat/conformance/c/socket-listen-denied-canary.c packages/guest-compat/Makefile
git commit -m "test(socket): cover mapped listener policy"
```

---

## Task 7: Acceptance And Docs

**Files:**
- Modify: `docs/superpowers/specs/2026-04-29-bash-on-libcodepod-design.md`
- Modify: `docs/superpowers/plans/2026-05-01-server-sockets.md`

- [ ] **Step 1: Update socket status in spec**

In `docs/superpowers/specs/2026-04-29-bash-on-libcodepod-design.md`, replace the server-socket deferral language with:

```markdown
Server sockets are supported for TCP loopback listeners and explicit mapped
`0.0.0.0` ports. Loopback listeners are sandbox-local and do not expose host
ports. Mapped listeners require `Sandbox.create({ serverSockets })` policy and
the runtime backend must authorize the final `listen()` call. Backends without
listener support return `EOPNOTSUPP`.
```

- [ ] **Step 2: Run final acceptance**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/host-imports/__tests__/socket-fds.test.ts packages/orchestrator/src/host-imports/__tests__/socket-listen-policy.test.ts packages/orchestrator/src/network/__tests__/bridge.test.ts packages/orchestrator/src/__tests__/guest-compat.test.ts
source scripts/dev-init.sh && deno check packages/orchestrator/src/network/socket-backend.ts packages/orchestrator/src/network/bridge.ts packages/orchestrator/src/host-imports/kernel-imports.ts packages/orchestrator/src/wasi/fd-target.ts packages/orchestrator/src/__tests__/guest-compat.test.ts
source scripts/dev-init.sh && make -C packages/guest-compat canaries rust-std-canaries
source scripts/dev-init.sh && scripts/check-runtime-engines.sh
git diff --check
```

Expected:
- Deno tests pass.
- Type-check passes.
- Guest C and Rust canaries build.
- Runtime engines smoke still passes with the existing Bun async gaps documented by the script.

- [ ] **Step 3: Mark this plan complete**

In this file, change every task checkbox that passed from `[ ]` to `[x]`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-04-29-bash-on-libcodepod-design.md docs/superpowers/plans/2026-05-01-server-sockets.md
git commit -m "docs(socket): document server socket support"
```

---

## Self-Review

- Spec coverage: The plan covers TCP `bind`, `listen`, `accept`, loopback listeners, mapped `0.0.0.0` listener policy, backend implementation, C POSIX canary, Rust `TcpListener` canary, and acceptance docs.
- Explicitly not covered: UDP/datagram sockets, IPv6 listener behavior, public host-interface binding, TLS server sockets, browser listener backend, wasmtime/wasmer full listener backends. These are not part of the current “finish server sockets” slice because they require separate runtime-specific design.
- Language scan: Every task names concrete files, commands, expected results, and test assertions.
- Type consistency: The plan consistently uses `SocketListenerHandle`, `listen`, `accept`, `closeListener`, `listener`, `listener_id`, `peer_host`, `peer_port`, `local_host`, and `local_port`.
