# Hard Kill via Worker Boundary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move WASM execution into a Worker thread so `worker.terminate()` can hard-kill infinite loops, with VFS proxied over SharedArrayBuffer.

**Architecture:** Sandbox.run() delegates to WorkerExecutor on the main thread, which posts commands to an execution Worker. The Worker runs ShellRunner against a VfsProxy (SAB + Atomics) that relays VFS calls back to the main thread. On timeout/cancel, `worker.terminate()` kills the thread instantly. Browser falls back to current Promise.race behavior.

**Tech Stack:** TypeScript, `node:worker_threads`, `SharedArrayBuffer`, `Atomics`, `bun:test`

**Reference design:** `docs/plans/2026-02-23-hard-kill-worker-design.md`

---

### Task 1: Proxy Protocol — SAB Layout Constants and Helpers

**Files:**
- Create: `packages/orchestrator/src/execution/proxy-protocol.ts`
- Create: `packages/orchestrator/src/execution/__tests__/proxy-protocol.test.ts`

This module defines the SharedArrayBuffer layout constants and JSON encode/decode helpers used by both sides of the VFS proxy.

**Step 1: Write the failing test**

Create `packages/orchestrator/src/execution/__tests__/proxy-protocol.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import {
  SAB_SIZE,
  STATUS_IDLE,
  STATUS_REQUEST,
  STATUS_RESPONSE,
  STATUS_ERROR,
  METADATA_OFFSET,
  encodeRequest,
  decodeRequest,
  encodeResponse,
  decodeResponse,
} from '../proxy-protocol.js';

describe('proxy-protocol', () => {
  it('exports correct SAB layout constants', () => {
    expect(STATUS_IDLE).toBe(0);
    expect(STATUS_REQUEST).toBe(1);
    expect(STATUS_RESPONSE).toBe(2);
    expect(STATUS_ERROR).toBe(3);
    expect(METADATA_OFFSET).toBe(12);
    expect(SAB_SIZE).toBeGreaterThanOrEqual(1024 * 1024); // at least 1MB
  });

  it('encodes and decodes a request with no binary', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const meta = { op: 'readFile', path: '/tmp/foo' };
    encodeRequest(sab, meta);
    const decoded = decodeRequest(sab);
    expect(decoded.metadata).toEqual(meta);
    expect(decoded.binary).toBeNull();
  });

  it('encodes and decodes a request with binary data', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const meta = { op: 'writeFile', path: '/tmp/bar' };
    const binary = new Uint8Array([1, 2, 3, 4, 5]);
    encodeRequest(sab, meta, binary);
    const decoded = decodeRequest(sab);
    expect(decoded.metadata).toEqual(meta);
    expect(decoded.binary).toEqual(binary);
  });

  it('encodes and decodes a response with no binary', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const meta = { ok: true };
    encodeResponse(sab, meta);
    const decoded = decodeResponse(sab);
    expect(decoded.metadata).toEqual(meta);
    expect(decoded.binary).toBeNull();
  });

  it('encodes and decodes a response with binary data', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const meta = {};
    const binary = new TextEncoder().encode('hello world');
    encodeResponse(sab, meta, binary);
    const decoded = decodeResponse(sab);
    expect(decoded.metadata).toEqual(meta);
    expect(new TextDecoder().decode(decoded.binary!)).toBe('hello world');
  });

  it('encodes and decodes an error response', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const meta = { error: true, code: 'ENOENT', message: 'no such file' };
    encodeResponse(sab, meta);
    const decoded = decodeResponse(sab);
    expect(decoded.metadata.error).toBe(true);
    expect(decoded.metadata.code).toBe('ENOENT');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/orchestrator && bun test src/execution/__tests__/proxy-protocol.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `packages/orchestrator/src/execution/proxy-protocol.ts`:

```ts
/**
 * SharedArrayBuffer layout and encode/decode helpers for the VFS proxy protocol.
 *
 * Layout (32 MB total):
 *   [0-3]    Int32   status: IDLE=0, REQUEST=1, RESPONSE=2, ERROR=3
 *   [4-7]    Int32   metadata length (JSON bytes)
 *   [8-11]   Int32   binary data length (raw bytes)
 *   [12..]   Uint8   JSON metadata (UTF-8)
 *   [12+N..] Uint8   binary payload (raw file content, no base64)
 */

export const SAB_SIZE = 32 * 1024 * 1024; // 32 MB

export const STATUS_IDLE = 0;
export const STATUS_REQUEST = 1;
export const STATUS_RESPONSE = 2;
export const STATUS_ERROR = 3;

/** Byte offset where metadata/binary payload begins. */
export const METADATA_OFFSET = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Write a request (metadata JSON + optional binary) into the SAB. */
export function encodeRequest(
  sab: SharedArrayBuffer,
  metadata: Record<string, unknown>,
  binary?: Uint8Array,
): void {
  const int32 = new Int32Array(sab);
  const uint8 = new Uint8Array(sab);

  const jsonBytes = encoder.encode(JSON.stringify(metadata));
  uint8.set(jsonBytes, METADATA_OFFSET);
  Atomics.store(int32, 1, jsonBytes.byteLength); // metadata length

  if (binary && binary.byteLength > 0) {
    uint8.set(binary, METADATA_OFFSET + jsonBytes.byteLength);
    Atomics.store(int32, 2, binary.byteLength); // binary length
  } else {
    Atomics.store(int32, 2, 0);
  }
}

/** Read a request from the SAB. */
export function decodeRequest(sab: SharedArrayBuffer): {
  metadata: Record<string, unknown>;
  binary: Uint8Array | null;
} {
  const int32 = new Int32Array(sab);
  const uint8 = new Uint8Array(sab);

  const metaLen = Atomics.load(int32, 1);
  const binLen = Atomics.load(int32, 2);

  const metaBytes = uint8.slice(METADATA_OFFSET, METADATA_OFFSET + metaLen);
  const metadata = JSON.parse(decoder.decode(metaBytes));

  const binary = binLen > 0
    ? uint8.slice(METADATA_OFFSET + metaLen, METADATA_OFFSET + metaLen + binLen)
    : null;

  return { metadata, binary };
}

/** Write a response (metadata JSON + optional binary) into the SAB. */
export function encodeResponse(
  sab: SharedArrayBuffer,
  metadata: Record<string, unknown>,
  binary?: Uint8Array,
): void {
  // Same layout — reuses the buffer
  encodeRequest(sab, metadata, binary);
}

/** Read a response from the SAB. */
export function decodeResponse(sab: SharedArrayBuffer): {
  metadata: Record<string, unknown>;
  binary: Uint8Array | null;
} {
  return decodeRequest(sab);
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/orchestrator && bun test src/execution/__tests__/proxy-protocol.test.ts`
Expected: PASS — all 6 tests pass

**Step 5: Commit**

```bash
git add packages/orchestrator/src/execution/proxy-protocol.ts packages/orchestrator/src/execution/__tests__/proxy-protocol.test.ts
git commit -m "feat: add SAB proxy protocol constants and helpers"
```

---

### Task 2: VfsProxy — Worker-Side VFS Interface Over SAB

**Files:**
- Create: `packages/orchestrator/src/execution/vfs-proxy.ts`
- Create: `packages/orchestrator/src/execution/__tests__/vfs-proxy.test.ts`
- Reference: `packages/orchestrator/src/execution/proxy-protocol.ts`

VfsProxy implements the same interface as VFS (readFile, writeFile, stat, readdir, mkdir, unlink, rmdir, rename, chmod) but relays each call through the SAB using `Atomics.wait()`. The test simulates the main-thread responder on the same thread (no actual Worker needed).

**Step 1: Write the failing test**

Create `packages/orchestrator/src/execution/__tests__/vfs-proxy.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { VfsProxy } from '../vfs-proxy.js';
import {
  SAB_SIZE,
  STATUS_REQUEST,
  STATUS_RESPONSE,
  STATUS_ERROR,
  decodeRequest,
  encodeResponse,
} from '../proxy-protocol.js';

/**
 * Simulate the main-thread handler: reads request from SAB,
 * calls a handler function, writes response back.
 * Since we're on the same thread, we call this manually between
 * encode-request and Atomics.wait (which we skip in tests).
 */
function simulateHandler(
  sab: SharedArrayBuffer,
  handler: (metadata: Record<string, unknown>, binary: Uint8Array | null) => {
    metadata: Record<string, unknown>;
    binary?: Uint8Array;
    isError?: boolean;
  },
): void {
  const int32 = new Int32Array(sab);
  const { metadata, binary } = decodeRequest(sab);
  const response = handler(metadata, binary);
  encodeResponse(sab, response.metadata, response.binary);
  Atomics.store(int32, 0, response.isError ? STATUS_ERROR : STATUS_RESPONSE);
  Atomics.notify(int32, 0);
}

describe('VfsProxy', () => {
  it('readFile returns binary content', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const proxy = new VfsProxy(sab, { skipAtomicsWait: true });

    // Pre-load a response before calling readFile
    const content = new TextEncoder().encode('hello world');
    const int32 = new Int32Array(sab);

    // Intercept: when proxy writes a request, handle it immediately
    proxy._setTestHandler((meta, bin) => {
      expect(meta.op).toBe('readFile');
      expect(meta.path).toBe('/tmp/foo');
      return { metadata: {}, binary: content };
    });

    const result = proxy.readFile('/tmp/foo');
    expect(new TextDecoder().decode(result)).toBe('hello world');
  });

  it('writeFile sends binary content', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const proxy = new VfsProxy(sab, { skipAtomicsWait: true });

    let receivedBinary: Uint8Array | null = null;
    proxy._setTestHandler((meta, bin) => {
      expect(meta.op).toBe('writeFile');
      expect(meta.path).toBe('/tmp/bar');
      receivedBinary = bin;
      return { metadata: { ok: true } };
    });

    proxy.writeFile('/tmp/bar', new TextEncoder().encode('test'));
    expect(new TextDecoder().decode(receivedBinary!)).toBe('test');
  });

  it('stat returns parsed metadata', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const proxy = new VfsProxy(sab, { skipAtomicsWait: true });

    proxy._setTestHandler((meta) => {
      expect(meta.op).toBe('stat');
      return {
        metadata: {
          type: 'file',
          size: 42,
          permissions: 0o644,
          mtime: new Date().toISOString(),
          ctime: new Date().toISOString(),
          atime: new Date().toISOString(),
        },
      };
    });

    const result = proxy.stat('/tmp/foo');
    expect(result.type).toBe('file');
    expect(result.size).toBe(42);
  });

  it('readdir returns entries array', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const proxy = new VfsProxy(sab, { skipAtomicsWait: true });

    proxy._setTestHandler(() => ({
      metadata: { entries: [{ name: 'a.txt', type: 'file' }, { name: 'b', type: 'dir' }] },
    }));

    const entries = proxy.readdir('/tmp');
    expect(entries).toEqual([{ name: 'a.txt', type: 'file' }, { name: 'b', type: 'dir' }]);
  });

  it('throws VfsError on ERROR status', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const proxy = new VfsProxy(sab, { skipAtomicsWait: true });

    proxy._setTestHandler(() => ({
      metadata: { error: true, code: 'ENOENT', message: 'no such file' },
      isError: true,
    }));

    expect(() => proxy.readFile('/tmp/missing')).toThrow(/ENOENT/);
  });

  it('mkdir, unlink, rmdir, rename, chmod send correct ops', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const proxy = new VfsProxy(sab, { skipAtomicsWait: true });

    const ops: string[] = [];
    proxy._setTestHandler((meta) => {
      ops.push(meta.op as string);
      return { metadata: { ok: true } };
    });

    proxy.mkdir('/tmp/dir');
    proxy.unlink('/tmp/file');
    proxy.rmdir('/tmp/dir');
    proxy.rename('/tmp/a', '/tmp/b');
    proxy.chmod('/tmp/file', 0o755);

    expect(ops).toEqual(['mkdir', 'unlink', 'rmdir', 'rename', 'chmod']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/orchestrator && bun test src/execution/__tests__/vfs-proxy.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `packages/orchestrator/src/execution/vfs-proxy.ts`:

```ts
/**
 * Worker-side VFS proxy — implements the VFS interface by relaying
 * each call through a SharedArrayBuffer using Atomics.
 *
 * Used inside the execution Worker so ShellRunner/WasiHost/ProcessManager
 * can make synchronous VFS calls that are fulfilled by the main thread.
 */

import {
  STATUS_IDLE,
  STATUS_REQUEST,
  STATUS_RESPONSE,
  STATUS_ERROR,
  METADATA_OFFSET,
  encodeRequest,
  decodeResponse,
} from './proxy-protocol.js';
import { VfsError } from '../vfs/inode.js';
import type { DirEntry, StatResult } from '../vfs/inode.js';

type TestHandler = (
  metadata: Record<string, unknown>,
  binary: Uint8Array | null,
) => { metadata: Record<string, unknown>; binary?: Uint8Array; isError?: boolean };

export class VfsProxy {
  private sab: SharedArrayBuffer;
  private int32: Int32Array;
  private skipAtomicsWait: boolean;
  private testHandler: TestHandler | null = null;
  private parentPort: { postMessage(msg: unknown): void } | null = null;

  constructor(
    sab: SharedArrayBuffer,
    options?: { skipAtomicsWait?: boolean; parentPort?: { postMessage(msg: unknown): void } },
  ) {
    this.sab = sab;
    this.int32 = new Int32Array(sab);
    this.skipAtomicsWait = options?.skipAtomicsWait ?? false;
    this.parentPort = options?.parentPort ?? null;
  }

  /** For testing only: set a synchronous handler that simulates the main thread. */
  _setTestHandler(handler: TestHandler): void {
    this.testHandler = handler;
  }

  private call(
    op: string,
    params: Record<string, unknown>,
    binary?: Uint8Array,
  ): { metadata: Record<string, unknown>; binary: Uint8Array | null } {
    const metadata = { op, ...params };
    encodeRequest(this.sab, metadata, binary);

    if (this.testHandler) {
      // Test mode: call handler synchronously
      const { metadata: reqMeta, binary: reqBin } = decodeRequest_inline(this.sab);
      const response = this.testHandler(reqMeta, reqBin);
      const { encodeResponse: encResp } = require_inline();
      encResp(this.sab, response.metadata, response.binary);
      Atomics.store(this.int32, 0, response.isError ? STATUS_ERROR : STATUS_RESPONSE);
    } else {
      // Production mode: signal main thread and block
      Atomics.store(this.int32, 0, STATUS_REQUEST);
      this.parentPort?.postMessage('proxy-request');

      if (!this.skipAtomicsWait) {
        Atomics.wait(this.int32, 0, STATUS_REQUEST);
      }
    }

    const status = Atomics.load(this.int32, 0);
    if (status === STATUS_ERROR) {
      const resp = decodeResponse(this.sab);
      const meta = resp.metadata;
      Atomics.store(this.int32, 0, STATUS_IDLE);
      throw new VfsError(
        (meta.code as string) ?? 'EIO',
        (meta.message as string) ?? 'proxy error',
      );
    }

    const resp = decodeResponse(this.sab);
    Atomics.store(this.int32, 0, STATUS_IDLE);
    return resp;
  }

  readFile(path: string): Uint8Array {
    const resp = this.call('readFile', { path });
    return resp.binary ?? new Uint8Array(0);
  }

  writeFile(path: string, data: Uint8Array): void {
    this.call('writeFile', { path }, data);
  }

  stat(path: string): StatResult {
    const resp = this.call('stat', { path });
    const m = resp.metadata;
    return {
      type: m.type as 'file' | 'dir' | 'symlink',
      size: m.size as number,
      permissions: m.permissions as number,
      mtime: new Date(m.mtime as string),
      ctime: new Date(m.ctime as string),
      atime: new Date(m.atime as string),
    };
  }

  readdir(path: string): DirEntry[] {
    const resp = this.call('readdir', { path });
    return resp.metadata.entries as DirEntry[];
  }

  mkdir(path: string): void {
    this.call('mkdir', { path });
  }

  mkdirp(path: string): void {
    this.call('mkdirp', { path });
  }

  unlink(path: string): void {
    this.call('unlink', { path });
  }

  rmdir(path: string): void {
    this.call('rmdir', { path });
  }

  rename(oldPath: string, newPath: string): void {
    this.call('rename', { oldPath, newPath });
  }

  chmod(path: string, mode: number): void {
    this.call('chmod', { path, mode });
  }

  symlink(target: string, path: string): void {
    this.call('symlink', { target, path });
  }

  /** Bypass writable-path checks — proxied to main thread. */
  withWriteAccess(fn: () => void): void {
    // The main thread handler decides whether to grant write access.
    // For the Worker, we just run the function — the proxy call itself
    // triggers withWriteAccess on the main thread as needed.
    fn();
  }
}

// Inline helpers to avoid circular imports in test mode
function decodeRequest_inline(sab: SharedArrayBuffer) {
  const int32 = new Int32Array(sab);
  const uint8 = new Uint8Array(sab);
  const metaLen = Atomics.load(int32, 1);
  const binLen = Atomics.load(int32, 2);
  const metaBytes = uint8.slice(METADATA_OFFSET, METADATA_OFFSET + metaLen);
  const metadata = JSON.parse(new TextDecoder().decode(metaBytes));
  const binary = binLen > 0
    ? uint8.slice(METADATA_OFFSET + metaLen, METADATA_OFFSET + metaLen + binLen)
    : null;
  return { metadata, binary };
}

function require_inline() {
  return { encodeResponse: (await_import() as any).encodeResponse };
}

// This is a workaround — in practice the test handler writes directly.
// The actual implementation will use the imported functions.
function await_import() {
  return {
    encodeResponse: (sab: SharedArrayBuffer, metadata: Record<string, unknown>, binary?: Uint8Array) => {
      const encoder = new TextEncoder();
      const int32 = new Int32Array(sab);
      const uint8 = new Uint8Array(sab);
      const jsonBytes = encoder.encode(JSON.stringify(metadata));
      uint8.set(jsonBytes, METADATA_OFFSET);
      Atomics.store(int32, 1, jsonBytes.byteLength);
      if (binary && binary.byteLength > 0) {
        uint8.set(binary, METADATA_OFFSET + jsonBytes.byteLength);
        Atomics.store(int32, 2, binary.byteLength);
      } else {
        Atomics.store(int32, 2, 0);
      }
    }
  };
}
```

**Note to implementer:** The test handler code above is intentionally rough. The actual implementation should be cleaner — the `_setTestHandler` should directly call `encodeResponse` from proxy-protocol.ts (no `require_inline` hack). The inline helpers above are just a sketch; refactor them to use proper imports. The key contract: `call()` method encodes request, signals main thread (or test handler), blocks, reads response, throws on ERROR status.

**Step 4: Run test to verify it passes**

Run: `cd packages/orchestrator && bun test src/execution/__tests__/vfs-proxy.test.ts`
Expected: PASS — all 6 tests pass

**Step 5: Commit**

```bash
git add packages/orchestrator/src/execution/vfs-proxy.ts packages/orchestrator/src/execution/__tests__/vfs-proxy.test.ts
git commit -m "feat: add VfsProxy — Worker-side VFS interface over SAB"
```

---

### Task 3: Execution Worker Entrypoint

**Files:**
- Create: `packages/orchestrator/src/execution/execution-worker.ts`
- Modify: `packages/orchestrator/src/shell/shell-runner.ts` (add `skipPopulateBin` option)

The Worker entrypoint receives an `init` message with the SAB and config, constructs VfsProxy + ProcessManager + ShellRunner, then handles `run` messages.

**Step 1: Add `skipPopulateBin` option to ShellRunner**

In `packages/orchestrator/src/shell/shell-runner.ts`, the constructor currently always calls `this.vfs.withWriteAccess(() => this.populateBin())`. The Worker version needs to skip this since `/bin` was already populated on the main thread.

Add a new constructor parameter:

```ts
constructor(
  vfs: VFS,       // Change type annotation — see note below
  mgr: ProcessManager,
  adapter: PlatformAdapter,
  shellWasmPath: string,
  gateway?: NetworkGateway,
  options?: { skipPopulateBin?: boolean },
) {
  // ... existing field assignments ...

  if (!options?.skipPopulateBin) {
    this.vfs.withWriteAccess(() => this.populateBin());
  }

  // ... existing env defaults ...
}
```

**Note:** The `vfs` parameter type needs to be a union or duck-type that accepts both VFS and VfsProxy. The simplest approach: change the type to accept any object with the VFS methods ShellRunner uses (readFile, writeFile, stat, readdir, mkdir, unlink, rmdir, rename, chmod, symlink, withWriteAccess). Create a `VfsLike` interface or just use the existing VFS type and have VfsProxy satisfy it.

**Step 2: Write the execution-worker.ts**

Create `packages/orchestrator/src/execution/execution-worker.ts`:

```ts
/**
 * Execution Worker entrypoint.
 *
 * Runs inside a Worker thread. Receives init + run messages from the main
 * thread, executes commands via ShellRunner, and posts results back.
 * VFS access goes through VfsProxy (SAB + Atomics).
 */

import { parentPort, workerData } from 'node:worker_threads';
import { VfsProxy } from './vfs-proxy.js';
import { ProcessManager } from '../process/manager.js';
import { ShellRunner } from '../shell/shell-runner.js';
import type { RunResult } from '../shell/shell-runner.js';

if (!parentPort) throw new Error('Must run as Worker thread');

interface InitMessage {
  type: 'init';
  sab: SharedArrayBuffer;
  wasmDir: string;
  shellWasmPath: string;
  toolRegistry: [string, string][];
  networkEnabled: boolean;
}

interface RunMessage {
  type: 'run';
  command: string;
  env: [string, string][];
  timeoutMs?: number;
}

let runner: ShellRunner | null = null;

parentPort.on('message', async (msg: InitMessage | RunMessage) => {
  if (msg.type === 'init') {
    const { sab, wasmDir, shellWasmPath, toolRegistry } = msg;

    // Dynamic import to get the Node adapter inside the Worker
    const { NodeAdapter } = await import('../platform/node-adapter.js');
    const adapter = new NodeAdapter();

    const vfs = new VfsProxy(sab, { parentPort: parentPort! });
    const mgr = new ProcessManager(vfs as any, adapter);

    // Re-register tools
    for (const [name, path] of toolRegistry) {
      mgr.registerTool(name, path);
    }

    runner = new ShellRunner(vfs as any, mgr, adapter, shellWasmPath, undefined, {
      skipPopulateBin: true,
    });

    parentPort!.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'run') {
    if (!runner) {
      parentPort!.postMessage({
        type: 'result',
        result: { exitCode: 1, stdout: '', stderr: 'Worker not initialized\n', executionTimeMs: 0 },
      });
      return;
    }

    // Apply env vars from main thread
    for (const [k, v] of msg.env) {
      runner.setEnv(k, v);
    }

    // Set deadline if timeout provided
    if (msg.timeoutMs !== undefined) {
      runner.resetCancel(msg.timeoutMs);
    }

    try {
      const result = await runner.run(msg.command);
      // Send back env changes
      const envMap = runner.getEnvMap();
      parentPort!.postMessage({
        type: 'result',
        result,
        env: Array.from(envMap.entries()),
      });
    } catch (err) {
      parentPort!.postMessage({
        type: 'result',
        result: {
          exitCode: 1,
          stdout: '',
          stderr: `Worker execution error: ${(err as Error).message}\n`,
          executionTimeMs: 0,
        },
      });
    }
  }
});
```

**Step 3: Run existing tests to verify nothing broke**

Run: `cd packages/orchestrator && bun test`
Expected: All existing tests pass (no tests exercise the new files yet)

**Step 4: Commit**

```bash
git add packages/orchestrator/src/execution/execution-worker.ts packages/orchestrator/src/shell/shell-runner.ts
git commit -m "feat: add execution Worker entrypoint and skipPopulateBin option"
```

---

### Task 4: WorkerExecutor — Main-Thread Worker Lifecycle and VFS Proxy Server

**Files:**
- Create: `packages/orchestrator/src/execution/worker-executor.ts`
- Create: `packages/orchestrator/src/execution/__tests__/worker-executor.test.ts`
- Reference: `packages/orchestrator/src/execution/proxy-protocol.ts`
- Reference: `packages/orchestrator/src/vfs/vfs.ts`

WorkerExecutor manages the Worker lifecycle on the main thread: creates Workers, handles VFS proxy requests from the SAB, implements timeout/kill, and provides `run()`, `kill()`, `dispose()`.

**Step 1: Write the failing test**

Create `packages/orchestrator/src/execution/__tests__/worker-executor.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { WorkerExecutor } from '../worker-executor.js';
import { VFS } from '../../vfs/vfs.js';

const WASM_DIR = resolve(import.meta.dirname, '../../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../../shell/__tests__/fixtures/wasmsand-shell.wasm');

describe('WorkerExecutor', () => {
  let executor: WorkerExecutor;
  let vfs: VFS;

  afterEach(() => {
    executor?.dispose();
  });

  it('runs a simple echo command through the Worker', async () => {
    vfs = new VFS();
    executor = new WorkerExecutor({
      vfs,
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      toolRegistry: [],
    });

    const env = new Map([['HOME', '/home/user'], ['PWD', '/home/user'], ['PATH', '/bin:/usr/bin']]);
    const result = await executor.run('echo hello from worker', env, 10000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello from worker');
  });

  it('VFS proxy roundtrip: Worker reads file written on main thread', async () => {
    vfs = new VFS();
    vfs.writeFile('/tmp/test.txt', new TextEncoder().encode('proxy works'));
    executor = new WorkerExecutor({
      vfs,
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      toolRegistry: [],
    });

    const env = new Map([['HOME', '/home/user'], ['PWD', '/home/user'], ['PATH', '/bin:/usr/bin']]);
    const result = await executor.run('cat /tmp/test.txt', env, 10000);
    expect(result.stdout).toBe('proxy works');
  });

  it('timeout kills Worker and returns TIMEOUT result', async () => {
    vfs = new VFS();
    executor = new WorkerExecutor({
      vfs,
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      toolRegistry: [],
    });

    const env = new Map([['HOME', '/home/user'], ['PWD', '/home/user'], ['PATH', '/bin:/usr/bin']]);
    // seq 1 billion will not complete in 100ms
    const result = await executor.run('seq 1 999999999', env, 100);
    expect(result.exitCode).toBe(124);
    expect(result.errorClass).toBe('TIMEOUT');
  });

  it('kill() terminates Worker and returns CANCELLED', async () => {
    vfs = new VFS();
    executor = new WorkerExecutor({
      vfs,
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      toolRegistry: [],
    });

    const env = new Map([['HOME', '/home/user'], ['PWD', '/home/user'], ['PATH', '/bin:/usr/bin']]);
    // Start a long-running command
    const promise = executor.run('seq 1 999999999', env, 30000);
    // Kill after 50ms
    await new Promise(r => setTimeout(r, 50));
    executor.kill();
    const result = await promise;
    expect(result.exitCode).toBe(125);
    expect(result.errorClass).toBe('CANCELLED');
  });

  it('next run after kill creates fresh Worker', async () => {
    vfs = new VFS();
    executor = new WorkerExecutor({
      vfs,
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      toolRegistry: [],
    });

    const env = new Map([['HOME', '/home/user'], ['PWD', '/home/user'], ['PATH', '/bin:/usr/bin']]);
    // Kill the first run
    const promise1 = executor.run('seq 1 999999999', env, 30000);
    await new Promise(r => setTimeout(r, 50));
    executor.kill();
    await promise1;

    // Second run should work on a fresh Worker
    const result2 = await executor.run('echo recovered', env, 10000);
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout.trim()).toBe('recovered');
  });

  it('isRunning() returns correct state', async () => {
    vfs = new VFS();
    executor = new WorkerExecutor({
      vfs,
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      toolRegistry: [],
    });

    expect(executor.isRunning()).toBe(false);

    const env = new Map([['HOME', '/home/user'], ['PWD', '/home/user'], ['PATH', '/bin:/usr/bin']]);
    const promise = executor.run('echo quick', env, 10000);
    // isRunning might be true while command executes
    const result = await promise;
    expect(executor.isRunning()).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/orchestrator && bun test src/execution/__tests__/worker-executor.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `packages/orchestrator/src/execution/worker-executor.ts`:

```ts
/**
 * WorkerExecutor — main-thread Worker lifecycle manager.
 *
 * Creates Worker threads for command execution, serves VFS proxy
 * requests over SharedArrayBuffer, and handles timeout/kill.
 */

import type { Worker } from 'node:worker_threads';
import type { VFS } from '../vfs/vfs.js';
import type { RunResult } from '../shell/shell-runner.js';
import {
  SAB_SIZE,
  STATUS_IDLE,
  STATUS_REQUEST,
  STATUS_RESPONSE,
  STATUS_ERROR,
  decodeRequest,
  encodeResponse,
} from './proxy-protocol.js';
import { VfsError } from '../vfs/inode.js';

export interface WorkerConfig {
  vfs: VFS;
  wasmDir: string;
  shellWasmPath: string;
  toolRegistry: [string, string][];
  networkEnabled?: boolean;
}

export class WorkerExecutor {
  private worker: Worker | null = null;
  private sab: SharedArrayBuffer;
  private int32: Int32Array;
  private config: WorkerConfig;
  private pendingResolve: ((r: RunResult) => void) | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.sab = new SharedArrayBuffer(SAB_SIZE);
    this.int32 = new Int32Array(this.sab);
  }

  async run(
    command: string,
    env: Map<string, string>,
    timeoutMs: number,
  ): Promise<RunResult> {
    // Create Worker if needed
    if (!this.worker) {
      await this.createWorker();
    }

    this.running = true;

    return new Promise<RunResult>((resolve) => {
      this.pendingResolve = resolve;

      // Set timeout
      this.timeoutTimer = setTimeout(() => {
        this.terminateWorker({
          exitCode: 124,
          stdout: '',
          stderr: 'command timeout\n',
          executionTimeMs: timeoutMs,
          errorClass: 'TIMEOUT',
        });
      }, timeoutMs);

      // Send run message
      this.worker!.postMessage({
        type: 'run',
        command,
        env: Array.from(env.entries()),
        timeoutMs,
      });
    });
  }

  kill(): void {
    this.terminateWorker({
      exitCode: 125,
      stdout: '',
      stderr: 'command cancelled\n',
      executionTimeMs: 0,
      errorClass: 'CANCELLED',
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  dispose(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.running = false;
  }

  private async createWorker(): Promise<void> {
    const { Worker } = await import('node:worker_threads');
    const workerPath = new URL('./execution-worker.js', import.meta.url).pathname;

    this.worker = new Worker(workerPath);

    // Handle VFS proxy requests
    this.worker.on('message', (msg: any) => {
      if (msg === 'proxy-request') {
        this.handleProxyRequest();
        return;
      }
      if (msg?.type === 'ready') {
        return;
      }
      if (msg?.type === 'result') {
        this.running = false;
        if (this.timeoutTimer) {
          clearTimeout(this.timeoutTimer);
          this.timeoutTimer = null;
        }
        if (this.pendingResolve) {
          const resolve = this.pendingResolve;
          this.pendingResolve = null;
          resolve(msg.result as RunResult);
        }
      }
    });

    this.worker.on('error', (err) => {
      this.terminateWorker({
        exitCode: 1,
        stdout: '',
        stderr: `Worker error: ${err.message}\n`,
        executionTimeMs: 0,
      });
    });

    // Send init message
    this.worker.postMessage({
      type: 'init',
      sab: this.sab,
      wasmDir: this.config.wasmDir,
      shellWasmPath: this.config.shellWasmPath,
      toolRegistry: this.config.toolRegistry,
      networkEnabled: this.config.networkEnabled ?? false,
    });

    // Wait for ready signal
    await new Promise<void>((resolve) => {
      const onMsg = (msg: any) => {
        if (msg?.type === 'ready') {
          this.worker!.off('message', onMsg);
          resolve();
        }
      };
      this.worker!.on('message', onMsg);
    });
  }

  private handleProxyRequest(): void {
    const { metadata, binary } = decodeRequest(this.sab);
    const op = metadata.op as string;
    const vfs = this.config.vfs;

    try {
      switch (op) {
        case 'readFile': {
          const content = vfs.readFile(metadata.path as string);
          encodeResponse(this.sab, {}, content);
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'writeFile': {
          vfs.writeFile(metadata.path as string, binary ?? new Uint8Array(0));
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'stat': {
          const st = vfs.stat(metadata.path as string);
          encodeResponse(this.sab, {
            type: st.type,
            size: st.size,
            permissions: st.permissions,
            mtime: st.mtime.toISOString(),
            ctime: st.ctime.toISOString(),
            atime: st.atime.toISOString(),
          });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'readdir': {
          const entries = vfs.readdir(metadata.path as string);
          encodeResponse(this.sab, { entries });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'mkdir': {
          vfs.mkdir(metadata.path as string);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'mkdirp': {
          vfs.mkdirp(metadata.path as string);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'unlink': {
          vfs.unlink(metadata.path as string);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'rmdir': {
          vfs.rmdir(metadata.path as string);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'rename': {
          vfs.rename(metadata.oldPath as string, metadata.newPath as string);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'chmod': {
          vfs.chmod(metadata.path as string, metadata.mode as number);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'symlink': {
          vfs.symlink(metadata.target as string, metadata.path as string);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        default: {
          encodeResponse(this.sab, { error: true, code: 'ENOSYS', message: `Unknown op: ${op}` });
          Atomics.store(this.int32, 0, STATUS_ERROR);
          break;
        }
      }
    } catch (err) {
      if (err instanceof VfsError) {
        encodeResponse(this.sab, { error: true, code: err.errno, message: err.message });
      } else {
        encodeResponse(this.sab, { error: true, code: 'EIO', message: (err as Error).message });
      }
      Atomics.store(this.int32, 0, STATUS_ERROR);
    }

    Atomics.notify(this.int32, 0);
  }

  private terminateWorker(result: RunResult): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.running = false;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(result);
    }
  }
}
```

**Step 4: Run tests**

Run: `cd packages/orchestrator && bun test src/execution/__tests__/worker-executor.test.ts`
Expected: All tests pass

**Step 5: Run all existing tests**

Run: `cd packages/orchestrator && bun test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add packages/orchestrator/src/execution/worker-executor.ts packages/orchestrator/src/execution/__tests__/worker-executor.test.ts
git commit -m "feat: add WorkerExecutor — main-thread Worker lifecycle and VFS proxy server"
```

---

### Task 5: VfsLike Interface — Duck Typing for VFS and VfsProxy

**Files:**
- Create: `packages/orchestrator/src/vfs/vfs-like.ts`
- Modify: `packages/orchestrator/src/wasi/wasi-host.ts` (accept VfsLike instead of VFS)
- Modify: `packages/orchestrator/src/process/manager.ts` (accept VfsLike instead of VFS)
- Modify: `packages/orchestrator/src/shell/shell-runner.ts` (accept VfsLike instead of VFS)

Currently WasiHost, ProcessManager, and ShellRunner all import `VFS` directly. For the Worker to use `VfsProxy`, these need to accept a `VfsLike` interface.

**Step 1: Create the VfsLike interface**

Create `packages/orchestrator/src/vfs/vfs-like.ts`:

```ts
/**
 * Common interface for VFS and VfsProxy.
 *
 * Used by WasiHost, ProcessManager, and ShellRunner so they can
 * accept either the real VFS (main thread) or VfsProxy (Worker thread).
 */
import type { DirEntry, StatResult } from './inode.js';

export interface VfsLike {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  stat(path: string): StatResult;
  readdir(path: string): DirEntry[];
  mkdir(path: string): void;
  mkdirp(path: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  rename(oldPath: string, newPath: string): void;
  symlink(target: string, path: string): void;
  chmod(path: string, mode: number): void;
  withWriteAccess(fn: () => void): void;
}
```

**Step 2: Update WasiHost to accept VfsLike**

In `packages/orchestrator/src/wasi/wasi-host.ts`:
- Change `import type { VFS }` to `import type { VfsLike }`
- Change `WasiHostOptions.vfs` type from `VFS` to `VfsLike`
- Change `this.vfs` type from `VFS` to `VfsLike`

**Step 3: Update ProcessManager to accept VfsLike**

In `packages/orchestrator/src/process/manager.ts`:
- Change `import type { VFS }` to `import type { VfsLike }`
- Change `private vfs: VFS` to `private vfs: VfsLike`
- Change constructor param type

**Step 4: Update ShellRunner to accept VfsLike**

In `packages/orchestrator/src/shell/shell-runner.ts`:
- Change `import type { VFS }` to `import type { VfsLike }`
- Change `private vfs: VFS` to `private vfs: VfsLike`
- Change constructor param type

**Step 5: Run all tests**

Run: `cd packages/orchestrator && bun test`
Expected: All tests pass — VFS implements VfsLike, so no runtime changes

**Step 6: Commit**

```bash
git add packages/orchestrator/src/vfs/vfs-like.ts packages/orchestrator/src/wasi/wasi-host.ts packages/orchestrator/src/process/manager.ts packages/orchestrator/src/shell/shell-runner.ts
git commit -m "refactor: introduce VfsLike interface for VFS/VfsProxy duck typing"
```

---

### Task 6: Platform Adapter — `supportsWorkerExecution` Flag

**Files:**
- Modify: `packages/orchestrator/src/platform/adapter.ts`
- Modify: `packages/orchestrator/src/platform/node-adapter.ts`
- Modify: `packages/orchestrator/src/platform/browser-adapter.ts`

**Step 1: Add flag to PlatformAdapter interface**

In `packages/orchestrator/src/platform/adapter.ts`, add:

```ts
/** Whether the platform supports Worker-based execution (hard kill). */
supportsWorkerExecution?: boolean;
```

**Step 2: Set `true` in NodeAdapter**

In `packages/orchestrator/src/platform/node-adapter.ts`, add the property:

```ts
supportsWorkerExecution = true;
```

**Step 3: Set `false` in BrowserAdapter**

In `packages/orchestrator/src/platform/browser-adapter.ts`, add:

```ts
supportsWorkerExecution = false;
```

**Step 4: Run all tests**

Run: `cd packages/orchestrator && bun test`
Expected: All pass

**Step 5: Commit**

```bash
git add packages/orchestrator/src/platform/adapter.ts packages/orchestrator/src/platform/node-adapter.ts packages/orchestrator/src/platform/browser-adapter.ts
git commit -m "feat: add supportsWorkerExecution flag to PlatformAdapter"
```

---

### Task 7: Sandbox Integration — Use WorkerExecutor for run/cancel/destroy

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts`
- Modify: `packages/orchestrator/src/__tests__/sandbox.test.ts`

This is the main integration point. On Node (when `adapter.supportsWorkerExecution` is true), Sandbox uses WorkerExecutor. On browser, it falls back to the current direct ShellRunner.run() approach.

**Step 1: Modify Sandbox to use WorkerExecutor**

In `packages/orchestrator/src/sandbox.ts`:

1. Import `WorkerExecutor` and `WorkerConfig` from `./execution/worker-executor.js`
2. Add `private workerExecutor: WorkerExecutor | null = null` field
3. In `Sandbox.create()`, after setting up the runner, create a WorkerExecutor if the adapter supports it:

```ts
let workerExecutor: WorkerExecutor | null = null;
if (adapter.supportsWorkerExecution) {
  const toolRegistry: [string, string][] = [];
  for (const [name, path] of tools) {
    toolRegistry.push([name, path]);
  }
  if (!tools.has('python3')) {
    toolRegistry.push(['python3', `${options.wasmDir}/python3.wasm`]);
  }
  workerExecutor = new WorkerExecutor({
    vfs,
    wasmDir: options.wasmDir,
    shellWasmPath,
    toolRegistry,
    networkEnabled: !!options.network,
  });
}
```

4. Pass `workerExecutor` to the constructor and store it.

5. In `Sandbox.run()`, choose the execution path:

```ts
async run(command: string): Promise<RunResult> {
  this.assertAlive();

  // Command size check (stays on main thread)
  const commandLimit = this.security?.limits?.commandBytes ?? 65536;
  if (new TextEncoder().encode(command).byteLength > commandLimit) {
    this.audit('limit.exceeded', { subtype: 'command', command });
    return { exitCode: 1, stdout: '', stderr: 'command too large\n', executionTimeMs: 0, errorClass: 'LIMIT_EXCEEDED' };
  }

  this.audit('command.start', { command });
  const effectiveTimeout = this.security?.limits?.timeoutMs ?? this.timeoutMs;
  const startTime = performance.now();

  let result: RunResult;
  if (this.workerExecutor) {
    // Worker-based execution (Node) — hard kill on timeout
    result = await this.workerExecutor.run(command, this.runner.getEnvMap(), effectiveTimeout);
  } else {
    // Fallback (browser) — cooperative cancel + Promise.race
    this.runner.resetCancel(effectiveTimeout);
    try {
      result = await this.runner.run(command);
    } catch (e) {
      if (e instanceof CancelledError) {
        const executionTimeMs = performance.now() - startTime;
        result = { exitCode: 124, stdout: '', stderr: `command ${e.reason.toLowerCase()}\n`, executionTimeMs, errorClass: e.reason };
      } else {
        throw e;
      }
    }
  }

  // Post-execution audit and truncation (stays on main thread)
  // ... existing audit/truncation code ...

  return result;
}
```

6. In `Sandbox.cancel()`:

```ts
cancel(): void {
  if (this.workerExecutor) {
    this.workerExecutor.kill();
  } else {
    this.runner.cancel('CANCELLED');
    this.runner.setDeadlineNow();
    this.mgr.cancelCurrent();
  }
}
```

7. In `Sandbox.destroy()`:

```ts
destroy(): void {
  this.audit('sandbox.destroy');
  this.workerExecutor?.dispose();
  this.destroyed = true;
  this.bridge?.dispose();
}
```

8. In `Sandbox.fork()`, create a new WorkerExecutor for the child:

```ts
async fork(): Promise<Sandbox> {
  // ... existing VFS clone, bridge, mgr, runner setup ...

  let childWorkerExecutor: WorkerExecutor | null = null;
  if (this.adapter.supportsWorkerExecution) {
    const toolRegistry: [string, string][] = [];
    for (const [name, path] of tools) {
      toolRegistry.push([name, path]);
    }
    if (!tools.has('python3')) {
      toolRegistry.push(['python3', `${this.wasmDir}/python3.wasm`]);
    }
    childWorkerExecutor = new WorkerExecutor({
      vfs: childVfs,
      wasmDir: this.wasmDir,
      shellWasmPath: this.shellWasmPath,
      toolRegistry,
      networkEnabled: !!this.networkPolicy,
    });
  }

  // Pass childWorkerExecutor to new Sandbox constructor
  // ...
}
```

**Step 2: Add hard kill test to sandbox.test.ts**

Add to `packages/orchestrator/src/__tests__/sandbox.test.ts`:

```ts
describe('hard kill via Worker', () => {
  it('timeout terminates execution via worker.terminate()', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      security: { limits: { timeoutMs: 200 } },
    });
    const start = performance.now();
    const result = await sandbox.run('seq 1 999999999');
    const elapsed = performance.now() - start;
    expect(result.errorClass).toBe('TIMEOUT');
    expect(result.exitCode).toBe(124);
    expect(elapsed).toBeLessThan(5000); // Should terminate near 200ms, not 30s
  });

  it('cancel() immediately kills Worker execution', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      timeoutMs: 30000,
    });
    const promise = sandbox.run('seq 1 999999999');
    await new Promise(r => setTimeout(r, 100));
    sandbox.cancel();
    const result = await promise;
    expect(result.errorClass).toBe('CANCELLED');
    expect(result.exitCode).toBe(125);
  });

  it('next run after timeout works correctly', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      security: { limits: { timeoutMs: 100 } },
    });
    // First run: timeout
    const r1 = await sandbox.run('seq 1 999999999');
    expect(r1.errorClass).toBe('TIMEOUT');
    // Second run: should work on fresh Worker
    const r2 = await sandbox.run('echo recovered');
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout.trim()).toBe('recovered');
  });

  it('VFS is consistent after timeout kill', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      security: { limits: { timeoutMs: 100 } },
    });
    sandbox.writeFile('/tmp/pre.txt', new TextEncoder().encode('before'));
    const r1 = await sandbox.run('seq 1 999999999');
    expect(r1.errorClass).toBe('TIMEOUT');
    // VFS should still be readable
    const content = sandbox.readFile('/tmp/pre.txt');
    expect(new TextDecoder().decode(content)).toBe('before');
  });
});
```

**Step 3: Run all tests**

Run: `cd packages/orchestrator && bun test`
Expected: All pass, including new hard kill tests

**Step 4: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/orchestrator/src/__tests__/sandbox.test.ts
git commit -m "feat: integrate WorkerExecutor into Sandbox for hard kill on timeout/cancel"
```

---

### Task 8: Export New Modules from Index

**Files:**
- Modify: `packages/orchestrator/src/index.ts`

**Step 1: Add exports**

```ts
export type { VfsLike } from './vfs/vfs-like.js';
export { WorkerExecutor } from './execution/worker-executor.js';
export type { WorkerConfig } from './execution/worker-executor.js';
```

**Step 2: Run all tests**

Run: `cd packages/orchestrator && bun test`
Expected: All pass

**Step 3: Commit**

```bash
git add packages/orchestrator/src/index.ts
git commit -m "feat: export VfsLike and WorkerExecutor from package index"
```

---

### Task 9: Final Verification

**Step 1: Run all orchestrator tests**

Run: `cd packages/orchestrator && bun test`
Expected: All pass (490+ tests)

**Step 2: Run all workspace tests**

Run: `bun test`
Expected: All tests across all packages pass

**Step 3: Verify acceptance criteria**

1. **Infinite WASM loop terminated** — The `hard kill via Worker > timeout terminates execution` test proves this
2. **cancel() works** — The `cancel() immediately kills Worker execution` test proves this
3. **No leaked Worker** — `dispose()` terminates Worker; `terminateWorker()` sets `worker = null`
4. **VFS consistent after kill** — The `VFS is consistent after timeout kill` test proves this
5. **Next run after kill works** — The `next run after timeout works correctly` test proves this
6. **All existing tests pass** — Full test suite green
7. **Browser fallback** — `supportsWorkerExecution: false` in BrowserAdapter triggers Promise.race path

**Step 4: Commit (if any fixups needed)**

```bash
git add -A && git commit -m "test: verify hard kill acceptance criteria"
```
