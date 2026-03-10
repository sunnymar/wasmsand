# Streaming Pipelines Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace sequential buffered pipeline execution with streaming POSIX-style pipes, where every process (shell, python, coreutils) does I/O through a uniform fd table and JSPI enables cooperative scheduling.

**Architecture:** A mini-POSIX kernel in TypeScript manages processes, pipes, and fd tables. WASM processes link against `wasi_snapshot_preview1` (stdlib I/O) and optionally `codepod` (kernel syscalls). The kernel dispatches fd_read/fd_write through a per-process fd table — processes don't know whether their fds are pipes, buffers, or /dev/null. JSPI suspends WASM stacks on blocked pipe I/O, enabling cooperative multitasking.

**Tech Stack:** Rust (wasm32-wasip1), TypeScript, JSPI (WebAssembly.Suspending/promising), Deno test runner

**Design doc:** `docs/plans/2026-03-01-streaming-pipelines-design.md`

---

## Task 1: Async Pipe with Back-Pressure

The foundation. Extend the existing synchronous pipe with Promise-based read/write, capacity limits, EOF, and EPIPE signaling.

**Files:**
- Modify: `packages/orchestrator/src/vfs/pipe.ts`
- Modify: `packages/orchestrator/src/vfs/__tests__/pipe.test.ts` (create if missing, or add to existing fd.test.ts)

**Step 1: Write failing tests for async pipe**

Create test file `packages/orchestrator/src/vfs/__tests__/pipe.test.ts`:

```typescript
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createAsyncPipe } from '../pipe.js';

describe('AsyncPipe', () => {
  it('write then read returns data', async () => {
    const [read, write] = createAsyncPipe();
    const data = new TextEncoder().encode('hello');
    write.write(data);
    const buf = new Uint8Array(16);
    const n = await read.read(buf);
    expect(n).toBe(5);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe('hello');
    read.close();
    write.close();
  });

  it('read on empty pipe resolves when data arrives', async () => {
    const [read, write] = createAsyncPipe();
    const buf = new Uint8Array(16);
    const readPromise = read.read(buf);
    // Read is pending — write should unblock it
    const data = new TextEncoder().encode('world');
    write.write(data);
    const n = await readPromise;
    expect(n).toBe(5);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe('world');
    read.close();
    write.close();
  });

  it('read returns 0 on EOF (write end closed, buffer empty)', async () => {
    const [read, write] = createAsyncPipe();
    write.close();
    const buf = new Uint8Array(16);
    const n = await read.read(buf);
    expect(n).toBe(0);
    read.close();
  });

  it('read drains buffer before returning EOF', async () => {
    const [read, write] = createAsyncPipe();
    write.write(new TextEncoder().encode('data'));
    write.close();
    const buf = new Uint8Array(16);
    const n1 = await read.read(buf);
    expect(n1).toBe(4);
    const n2 = await read.read(buf);
    expect(n2).toBe(0); // EOF after drain
    read.close();
  });

  it('write returns -1 (EPIPE) when read end closed', () => {
    const [read, write] = createAsyncPipe();
    read.close();
    const result = write.write(new TextEncoder().encode('data'));
    expect(result).toBe(-1); // EPIPE
    write.close();
  });

  it('back-pressure: write blocks when pipe full', async () => {
    const [read, write] = createAsyncPipe(64); // 64 byte capacity
    const big = new Uint8Array(64).fill(0x41);
    write.write(big); // fills pipe
    // Next write should return a Promise (blocked)
    const smallData = new Uint8Array(1).fill(0x42);
    const writePromise = write.writeAsync(smallData);
    // Drain some data to unblock
    const buf = new Uint8Array(32);
    await read.read(buf);
    await writePromise; // should resolve now
    read.close();
    write.close();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
/Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/vfs/__tests__/pipe.test.ts
```

Expected: FAIL — `createAsyncPipe` does not exist.

**Step 3: Implement async pipe**

In `packages/orchestrator/src/vfs/pipe.ts`, add alongside the existing `createPipe()`:

```typescript
const DEFAULT_PIPE_CAPACITY = 65536; // 64KB, matches Linux PIPE_BUF

export interface AsyncPipeReadEnd {
  /** Read up to buf.length bytes. Returns 0 on EOF. Suspends if empty. */
  read(buf: Uint8Array): Promise<number>;
  close(): void;
  readonly closed: boolean;
}

export interface AsyncPipeWriteEnd {
  /** Write data. Returns bytes written, or -1 on EPIPE (read end closed). */
  write(data: Uint8Array): number;
  /** Write data, waiting for space if pipe is full. Returns -1 on EPIPE. */
  writeAsync(data: Uint8Array): Promise<number>;
  close(): void;
  readonly closed: boolean;
}

interface AsyncPipeBuffer {
  chunks: Uint8Array[];
  totalBytes: number;
  writeClosed: boolean;
  readClosed: boolean;
  capacity: number;
  /** Resolve a pending reader when data arrives or write end closes. */
  pendingReader: ((n: number) => void) | null;
  pendingReaderBuf: Uint8Array | null;
  /** Resolve a pending writer when space becomes available. */
  pendingWriter: ((n: number) => void) | null;
  pendingWriterData: Uint8Array | null;
}

export function createAsyncPipe(capacity = DEFAULT_PIPE_CAPACITY): [AsyncPipeReadEnd, AsyncPipeWriteEnd] {
  const shared: AsyncPipeBuffer = {
    chunks: [],
    totalBytes: 0,
    writeClosed: false,
    readClosed: false,
    capacity,
    pendingReader: null,
    pendingReaderBuf: null,
    pendingWriter: null,
    pendingWriterData: null,
  };

  function drainChunks(buf: Uint8Array): number {
    let offset = 0;
    while (offset < buf.length && shared.chunks.length > 0) {
      const chunk = shared.chunks[0];
      const needed = buf.length - offset;
      if (chunk.length <= needed) {
        buf.set(chunk, offset);
        offset += chunk.length;
        shared.totalBytes -= chunk.length;
        shared.chunks.shift();
      } else {
        buf.set(chunk.subarray(0, needed), offset);
        shared.chunks[0] = chunk.subarray(needed);
        shared.totalBytes -= needed;
        offset += needed;
      }
    }
    return offset;
  }

  function tryFlushPendingWriter(): void {
    if (!shared.pendingWriter || !shared.pendingWriterData) return;
    if (shared.readClosed) {
      const resolve = shared.pendingWriter;
      shared.pendingWriter = null;
      shared.pendingWriterData = null;
      resolve(-1); // EPIPE
      return;
    }
    const spaceAvailable = shared.capacity - shared.totalBytes;
    if (spaceAvailable <= 0) return;
    const data = shared.pendingWriterData;
    const toWrite = Math.min(data.length, spaceAvailable);
    shared.chunks.push(data.slice(0, toWrite));
    shared.totalBytes += toWrite;
    const resolve = shared.pendingWriter;
    shared.pendingWriter = null;
    shared.pendingWriterData = null;
    resolve(toWrite);
  }

  const readEnd: AsyncPipeReadEnd = {
    get closed() { return shared.readClosed; },
    async read(buf: Uint8Array): Promise<number> {
      // Data available — drain immediately
      if (shared.totalBytes > 0) {
        const n = drainChunks(buf);
        tryFlushPendingWriter(); // unblock writer if waiting
        return n;
      }
      // Write end closed + empty = EOF
      if (shared.writeClosed) return 0;
      // Empty, write end open — suspend until data arrives
      return new Promise<number>((resolve) => {
        shared.pendingReader = resolve;
        shared.pendingReaderBuf = buf;
      });
    },
    close() {
      shared.readClosed = true;
      // Wake pending writer with EPIPE
      if (shared.pendingWriter) {
        const resolve = shared.pendingWriter;
        shared.pendingWriter = null;
        shared.pendingWriterData = null;
        resolve(-1);
      }
    },
  };

  const writeEnd: AsyncPipeWriteEnd = {
    get closed() { return shared.writeClosed; },
    write(data: Uint8Array): number {
      if (shared.readClosed) return -1; // EPIPE
      if (shared.writeClosed) return -1;
      const spaceAvailable = shared.capacity - shared.totalBytes;
      const toWrite = Math.min(data.length, spaceAvailable);
      if (toWrite > 0) {
        shared.chunks.push(data.slice(0, toWrite));
        shared.totalBytes += toWrite;
      }
      // Wake pending reader
      if (shared.pendingReader && shared.pendingReaderBuf) {
        const n = drainChunks(shared.pendingReaderBuf);
        const resolve = shared.pendingReader;
        shared.pendingReader = null;
        shared.pendingReaderBuf = null;
        resolve(n);
      }
      return toWrite;
    },
    async writeAsync(data: Uint8Array): Promise<number> {
      if (shared.readClosed) return -1;
      if (shared.writeClosed) return -1;
      const spaceAvailable = shared.capacity - shared.totalBytes;
      if (spaceAvailable >= data.length) {
        return this.write(data);
      }
      // Not enough space — write what we can, then suspend for the rest
      if (spaceAvailable > 0) {
        this.write(data.subarray(0, spaceAvailable));
        data = data.subarray(spaceAvailable);
      }
      // Suspend until space available
      return new Promise<number>((resolve) => {
        shared.pendingWriter = resolve;
        shared.pendingWriterData = data;
      });
    },
    close() {
      shared.writeClosed = true;
      // Wake pending reader with EOF
      if (shared.pendingReader) {
        const resolve = shared.pendingReader;
        shared.pendingReader = null;
        shared.pendingReaderBuf = null;
        resolve(0);
      }
    },
  };

  return [readEnd, writeEnd];
}
```

**Step 4: Run tests to verify they pass**

```bash
/Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/vfs/__tests__/pipe.test.ts
```

**Step 5: Commit**

```bash
git add packages/orchestrator/src/vfs/pipe.ts packages/orchestrator/src/vfs/__tests__/pipe.test.ts
git commit -m "feat: async pipe with back-pressure, EOF, and EPIPE"
```

---

## Task 2: FdTarget Type and WasiHost Fd Table Refactor

Refactor `WasiHost` to dispatch `fd_read`/`fd_write` through a generic fd table instead of hardcoded fd 0/1/2 behavior. This is the uniform "stdlib" layer.

**Files:**
- Create: `packages/orchestrator/src/wasi/fd-target.ts`
- Modify: `packages/orchestrator/src/wasi/wasi-host.ts` (lines 45-54 options, 134-164 constructor, 378-429 fdWrite, 431-480 fdRead, 170-176 getStdout/getStderr)
- Test: `packages/orchestrator/src/wasi/__tests__/fd-target.test.ts`

**Step 1: Create FdTarget type**

Create `packages/orchestrator/src/wasi/fd-target.ts`:

```typescript
import type { AsyncPipeReadEnd, AsyncPipeWriteEnd } from '../vfs/pipe.js';

/** Target for a file descriptor in a process's fd table. */
export type FdTarget =
  | { type: 'buffer'; buf: Uint8Array[]; total: number; limit: number; truncated: boolean }
  | { type: 'pipe_read'; pipe: AsyncPipeReadEnd }
  | { type: 'pipe_write'; pipe: AsyncPipeWriteEnd }
  | { type: 'static'; data: Uint8Array; offset: number }
  | { type: 'null' };

export function createBufferTarget(limit = Infinity): FdTarget & { type: 'buffer' } {
  return { type: 'buffer', buf: [], total: 0, limit, truncated: false };
}

export function createStaticTarget(data: Uint8Array): FdTarget & { type: 'static' } {
  return { type: 'static', data, offset: 0 };
}

export function createNullTarget(): FdTarget & { type: 'null' } {
  return { type: 'null' };
}

/** Concatenate buffer target chunks into a string. */
export function bufferToString(target: FdTarget & { type: 'buffer' }): string {
  const total = target.buf.reduce((sum, b) => sum + b.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of target.buf) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
```

**Step 2: Write failing test for fd table dispatch**

Create `packages/orchestrator/src/wasi/__tests__/fd-target.test.ts`:

```typescript
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createBufferTarget, createStaticTarget, createNullTarget, bufferToString } from '../fd-target.js';

describe('FdTarget', () => {
  it('buffer target accumulates data', () => {
    const target = createBufferTarget();
    target.buf.push(new TextEncoder().encode('hello'));
    target.total += 5;
    expect(bufferToString(target)).toBe('hello');
  });

  it('buffer target respects limit', () => {
    const target = createBufferTarget(3);
    const data = new TextEncoder().encode('hello');
    const toWrite = Math.min(data.length, target.limit - target.total);
    target.buf.push(data.subarray(0, toWrite));
    target.total += data.length;
    target.truncated = data.length > toWrite;
    expect(bufferToString(target)).toBe('hel');
    expect(target.truncated).toBe(true);
  });

  it('static target serves bytes with offset', () => {
    const target = createStaticTarget(new TextEncoder().encode('hello world'));
    const buf = new Uint8Array(5);
    const n = Math.min(buf.length, target.data.length - target.offset);
    buf.set(target.data.subarray(target.offset, target.offset + n));
    target.offset += n;
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe('hello');
    expect(target.offset).toBe(5);
  });

  it('static target returns 0 at EOF', () => {
    const target = createStaticTarget(new Uint8Array(0));
    const n = Math.min(5, target.data.length - target.offset);
    expect(n).toBe(0);
  });
});
```

**Step 3: Run tests**

```bash
/Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/wasi/__tests__/fd-target.test.ts
```

**Step 4: Refactor WasiHost to use FdTarget**

In `packages/orchestrator/src/wasi/wasi-host.ts`:

1. **Add import** at top:
   ```typescript
   import type { FdTarget } from './fd-target.js';
   import { createBufferTarget, createStaticTarget, createNullTarget, bufferToString } from './fd-target.js';
   ```

2. **Add `ioFds` to WasiHostOptions** (alongside existing fields):
   ```typescript
   export interface WasiHostOptions {
     // ... existing fields ...
     /** Per-fd I/O targets. If provided, overrides stdin/stdoutLimit/stderrLimit. */
     ioFds?: Map<number, FdTarget>;
   }
   ```

3. **Initialize fd table in constructor** (after existing stdinData/stdoutLimit setup):
   ```typescript
   if (options.ioFds) {
     this.ioFds = options.ioFds;
   } else {
     // Legacy mode: build fd table from existing options
     this.ioFds = new Map<number, FdTarget>();
     this.ioFds.set(0, options.stdin
       ? createStaticTarget(options.stdin)
       : createNullTarget());
     this.ioFds.set(1, createBufferTarget(options.stdoutLimit ?? Infinity));
     this.ioFds.set(2, createBufferTarget(options.stderrLimit ?? Infinity));
   }
   ```

4. **Refactor fdWrite** to dispatch through fd table:
   ```typescript
   private fdWrite(fd, iovsPtr, iovsLen, nwrittenPtr): number {
     this.checkDeadline();
     const target = this.ioFds.get(fd);
     if (!target) {
       // Fall through to VFS file write (existing behavior for fd > 2)
       return this.fdWriteFile(fd, iovsPtr, iovsLen, nwrittenPtr);
     }
     const bytes = this.getBytes();
     const iovecs = readIovecs(this.getView(), iovsPtr, iovsLen);
     let totalWritten = 0;
     for (const iov of iovecs) {
       const data = bytes.slice(iov.buf, iov.buf + iov.len);
       switch (target.type) {
         case 'buffer': {
           if (target.total < target.limit) {
             const remaining = target.limit - target.total;
             const slice = data.byteLength <= remaining ? data : data.slice(0, remaining);
             target.buf.push(slice);
             if (data.byteLength > remaining) target.truncated = true;
           } else {
             target.truncated = true;
           }
           target.total += data.byteLength;
           totalWritten += data.byteLength;
           break;
         }
         case 'pipe_write': {
           const n = target.pipe.write(data);
           if (n === -1) return WASI_EPIPE;
           totalWritten += n;
           break;
         }
         case 'null':
           totalWritten += data.byteLength;
           break;
         default:
           return WASI_EBADF;
       }
     }
     const viewAfter = this.getView();
     viewAfter.setUint32(nwrittenPtr, totalWritten, true);
     return WASI_ESUCCESS;
   }
   ```

5. **Refactor fdRead** similarly:
   ```typescript
   private fdRead(fd, iovsPtr, iovsLen, nreadPtr): number {
     this.checkDeadline();
     const target = this.ioFds.get(fd);
     if (!target) {
       return this.fdReadFile(fd, iovsPtr, iovsLen, nreadPtr);
     }
     const iovecs = readIovecs(this.getView(), iovsPtr, iovsLen);
     let totalRead = 0;
     for (const iov of iovecs) {
       switch (target.type) {
         case 'static': {
           if (target.offset >= target.data.byteLength) break;
           const remaining = target.data.byteLength - target.offset;
           const toRead = Math.min(iov.len, remaining);
           const bytes = this.getBytes();
           bytes.set(target.data.subarray(target.offset, target.offset + toRead), iov.buf);
           target.offset += toRead;
           totalRead += toRead;
           if (toRead < iov.len) break; // short read
           continue;
         }
         case 'pipe_read': {
           // Sync attempt — for JSPI, this will be overridden in Task 8
           break;
         }
         case 'null':
           break; // EOF
         default:
           return WASI_EBADF;
       }
       break; // short read or EOF
     }
     const viewAfter = this.getView();
     viewAfter.setUint32(nreadPtr, totalRead, true);
     return WASI_ESUCCESS;
   }
   ```

6. **Update getStdout/getStderr** to use fd table:
   ```typescript
   getStdout(): string {
     const target = this.ioFds.get(1);
     if (target?.type === 'buffer') return bufferToString(target);
     return '';
   }
   getStderr(): string {
     const target = this.ioFds.get(2);
     if (target?.type === 'buffer') return bufferToString(target);
     return '';
   }
   ```

**Step 5: Run existing tests to verify backward compatibility**

```bash
/Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/wasi/__tests__/
/Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts
```

All existing tests must pass — the `ioFds` field is optional, so legacy WasiHost creation is unchanged.

**Step 6: Commit**

```bash
git add packages/orchestrator/src/wasi/fd-target.ts packages/orchestrator/src/wasi/__tests__/fd-target.test.ts packages/orchestrator/src/wasi/wasi-host.ts
git commit -m "refactor: WasiHost fd table dispatch via FdTarget abstraction"
```

---

## Task 3: Process Kernel

The TypeScript "OS kernel" — manages processes, pipes, and fd tables. Provides spawn, waitpid, and pipe syscalls.

**Files:**
- Create: `packages/orchestrator/src/process/kernel.ts`
- Test: `packages/orchestrator/src/process/__tests__/kernel.test.ts`

**Step 1: Write failing tests**

Create `packages/orchestrator/src/process/__tests__/kernel.test.ts`. Test the kernel in isolation using mock WASM modules (or by testing the kernel's pipe/process tracking without actual WASM):

```typescript
import { describe, it, beforeEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ProcessKernel } from '../kernel.js';
import { createAsyncPipe } from '../../vfs/pipe.js';

describe('ProcessKernel', () => {
  it('createPipe returns connected read/write ends', async () => {
    const kernel = new ProcessKernel();
    const { readFd, writeFd } = kernel.createPipe(/*callerPid=*/ 0);
    expect(readFd).toBeGreaterThanOrEqual(3);
    expect(writeFd).toBeGreaterThanOrEqual(3);
    expect(writeFd).toBe(readFd + 1);
    kernel.dispose();
  });

  it('closeFd closes pipe ends', () => {
    const kernel = new ProcessKernel();
    const { readFd, writeFd } = kernel.createPipe(0);
    kernel.closeFd(0, writeFd);
    kernel.closeFd(0, readFd);
    kernel.dispose();
  });

  it('getFdTarget returns the target for a given fd', () => {
    const kernel = new ProcessKernel();
    const { readFd } = kernel.createPipe(0);
    const target = kernel.getFdTarget(0, readFd);
    expect(target).not.toBeNull();
    expect(target!.type).toBe('pipe_read');
    kernel.dispose();
  });
});
```

**Step 2: Implement ProcessKernel**

Create `packages/orchestrator/src/process/kernel.ts`:

```typescript
import type { FdTarget } from '../wasi/fd-target.js';
import { createAsyncPipe, type AsyncPipeReadEnd, type AsyncPipeWriteEnd } from '../vfs/pipe.js';
import type { WasiHost } from '../wasi/wasi-host.js';

export interface SpawnRequest {
  prog: string;
  args: string[];
  env: [string, string][];
  cwd: string;
  stdinFd: number;
  stdoutFd: number;
  stderrFd: number;
}

export interface ProcessEntry {
  pid: number;
  promise: Promise<void> | null;
  exitCode: number;
  state: 'running' | 'exited';
  wasiHost: WasiHost | null;
  waiters: ((exitCode: number) => void)[];
}

export class ProcessKernel {
  private processTable = new Map<number, ProcessEntry>();
  private nextPid = 1;

  /** Per-process fd tables. pid 0 = the shell process. */
  private fdTables = new Map<number, Map<number, FdTarget>>();
  private nextFds = new Map<number, number>(); // per-process fd counter

  /** Pipe tracking for SIGPIPE. */
  private pipeReadEnds = new Map<AsyncPipeReadEnd, { writeEnd: AsyncPipeWriteEnd }>();
  private pipeWriteEnds = new Map<AsyncPipeWriteEnd, { readEnd: AsyncPipeReadEnd }>();

  constructor() {
    // Process 0 (shell) gets a default fd table — configured by the runner
    this.fdTables.set(0, new Map());
    this.nextFds.set(0, 3); // 0,1,2 reserved
  }

  /** Create a pipe for the calling process. Returns read and write fd numbers. */
  createPipe(callerPid: number): { readFd: number; writeFd: number } {
    const fdTable = this.fdTables.get(callerPid);
    if (!fdTable) throw new Error(`No fd table for pid ${callerPid}`);

    const [readEnd, writeEnd] = createAsyncPipe();
    this.pipeReadEnds.set(readEnd, { writeEnd });
    this.pipeWriteEnds.set(writeEnd, { readEnd });

    let nextFd = this.nextFds.get(callerPid) ?? 3;
    const readFd = nextFd++;
    const writeFd = nextFd++;
    this.nextFds.set(callerPid, nextFd);

    fdTable.set(readFd, { type: 'pipe_read', pipe: readEnd });
    fdTable.set(writeFd, { type: 'pipe_write', pipe: writeEnd });

    return { readFd, writeFd };
  }

  /** Get the FdTarget for a given process + fd number. */
  getFdTarget(pid: number, fd: number): FdTarget | null {
    return this.fdTables.get(pid)?.get(fd) ?? null;
  }

  /** Set an fd target for a process (used by runner to configure shell fds). */
  setFdTarget(pid: number, fd: number, target: FdTarget): void {
    let fdTable = this.fdTables.get(pid);
    if (!fdTable) {
      fdTable = new Map();
      this.fdTables.set(pid, fdTable);
    }
    fdTable.set(fd, target);
  }

  /** Build the fd table (Map<number, FdTarget>) for a new process from spawn request. */
  buildFdTableForSpawn(callerPid: number, req: SpawnRequest): Map<number, FdTarget> {
    const callerFdTable = this.fdTables.get(callerPid);
    if (!callerFdTable) throw new Error(`No fd table for caller pid ${callerPid}`);

    const newFdTable = new Map<number, FdTarget>();

    // Map the requested fds from the caller's fd table
    const stdinTarget = callerFdTable.get(req.stdinFd);
    if (stdinTarget) newFdTable.set(0, stdinTarget);

    const stdoutTarget = callerFdTable.get(req.stdoutFd);
    if (stdoutTarget) newFdTable.set(1, stdoutTarget);

    const stderrTarget = callerFdTable.get(req.stderrFd);
    if (stderrTarget) newFdTable.set(2, stderrTarget);

    return newFdTable;
  }

  /** Register a spawned process. */
  registerProcess(pid: number, promise: Promise<void>, wasiHost: WasiHost): void {
    this.processTable.set(pid, {
      pid,
      promise,
      exitCode: -1,
      state: 'running',
      wasiHost,
      waiters: [],
    });

    // When process exits, update state and notify waiters
    promise.then(() => {
      const entry = this.processTable.get(pid);
      if (entry) {
        entry.state = 'exited';
        entry.exitCode = wasiHost.getExitCode();
        for (const waiter of entry.waiters) {
          waiter(entry.exitCode);
        }
        entry.waiters.length = 0;
      }
    });
  }

  allocPid(): number {
    return this.nextPid++;
  }

  /** Wait for a process to exit. Returns exit code. */
  async waitpid(pid: number): Promise<number> {
    const entry = this.processTable.get(pid);
    if (!entry) return -1;
    if (entry.state === 'exited') return entry.exitCode;

    return new Promise<number>((resolve) => {
      entry.waiters.push(resolve);
    });
  }

  /** Close an fd for a process. */
  closeFd(pid: number, fd: number): void {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) return;
    const target = fdTable.get(fd);
    if (!target) return;

    if (target.type === 'pipe_read') {
      target.pipe.close();
    } else if (target.type === 'pipe_write') {
      target.pipe.close();
    }
    fdTable.delete(fd);
  }

  /** Initialize fd table for a new process. */
  initProcess(pid: number): void {
    if (!this.fdTables.has(pid)) {
      this.fdTables.set(pid, new Map());
      this.nextFds.set(pid, 3);
    }
  }

  dispose(): void {
    // Close all pipe ends
    for (const fdTable of this.fdTables.values()) {
      for (const target of fdTable.values()) {
        if (target.type === 'pipe_read') target.pipe.close();
        if (target.type === 'pipe_write') target.pipe.close();
      }
    }
    this.fdTables.clear();
    this.processTable.clear();
  }
}
```

**Step 3: Run tests**

```bash
/Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/process/__tests__/kernel.test.ts
```

**Step 4: Commit**

```bash
git add packages/orchestrator/src/process/kernel.ts packages/orchestrator/src/process/__tests__/kernel.test.ts
git commit -m "feat: ProcessKernel — process table, fd table, pipe management"
```

---

## Task 4: Unified Kernel Imports

Replace `createPythonImports()` and the `codepod` namespace portion of `createShellImports()` with a single `createKernelImports()` that provides all syscalls to any process.

**Files:**
- Create: `packages/orchestrator/src/host-imports/kernel-imports.ts`
- Modify: `packages/orchestrator/src/host-imports/shell-imports.ts` — remove codepod-namespace functions that move to kernel-imports
- Modify: `packages/orchestrator/src/process/manager.ts` — use `createKernelImports()` instead of `createPythonImports()`
- Delete: `packages/orchestrator/src/host-imports/python-imports.ts` (absorbed)

**Step 1: Create kernel-imports.ts**

This provides the `codepod` import namespace for any WASM process. Includes:
- Existing: `host_network_fetch`, `host_extension_invoke`, `host_is_extension`
- New: `host_pipe`, `host_spawn`, `host_waitpid`, `host_close_fd`

```typescript
import { readString, readBytes, writeJson } from './common.js';
import type { ProcessKernel, SpawnRequest } from '../process/kernel.js';
import type { NetworkBridgeLike } from '../network/bridge-types.js';
import type { ExtensionRegistry } from '../extension/registry.js';

export interface KernelImportsOptions {
  memory: WebAssembly.Memory;
  callerPid: number;
  kernel: ProcessKernel;
  networkBridge?: NetworkBridgeLike;
  extensionRegistry?: ExtensionRegistry;
  toolAllowlist?: string[];
  /** Called by host_spawn to actually create and start a WASM process. */
  spawnProcess?: (req: SpawnRequest, fdTable: Map<number, unknown>) => number;
}

export function createKernelImports(opts: KernelImportsOptions): Record<string, WebAssembly.ImportValue> {
  const { memory, callerPid, kernel } = opts;

  return {
    host_pipe(outPtr: number, outCap: number): number {
      const { readFd, writeFd } = kernel.createPipe(callerPid);
      return writeJson(memory, outPtr, outCap, { read_fd: readFd, write_fd: writeFd });
    },

    host_spawn(reqPtr: number, reqLen: number): number {
      const reqJson = readString(memory, reqPtr, reqLen);
      const req = JSON.parse(reqJson) as SpawnRequest;
      if (opts.spawnProcess) {
        const fdTable = kernel.buildFdTableForSpawn(callerPid, req);
        return opts.spawnProcess(req, fdTable);
      }
      return -1;
    },

    // host_waitpid is async — must be wrapped with WebAssembly.Suspending
    async host_waitpid(pid: number, outPtr: number, outCap: number): Promise<number> {
      const exitCode = await kernel.waitpid(pid);
      return writeJson(memory, outPtr, outCap, { exit_code: exitCode });
    },

    host_close_fd(fd: number): number {
      kernel.closeFd(callerPid, fd);
      return 0;
    },

    // --- Existing syscalls (migrated from python-imports + shell-imports) ---

    host_network_fetch(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      if (!opts.networkBridge) {
        return writeJson(memory, outPtr, outCap, {
          error: true, message: 'network not available',
        });
      }
      const reqJson = readString(memory, reqPtr, reqLen);
      const req = JSON.parse(reqJson);
      const result = opts.networkBridge.fetchSync(req);
      return writeJson(memory, outPtr, outCap, result);
    },

    host_extension_invoke(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      if (!opts.extensionRegistry) {
        return writeJson(memory, outPtr, outCap, {
          exit_code: 1, stdout: '', stderr: 'no extension registry\n',
        });
      }
      const reqJson = readString(memory, reqPtr, reqLen);
      const req = JSON.parse(reqJson);
      // Sync extension invoke for Python — shell uses the async JSPI path separately
      const name = req.name ?? req.extension;
      const args = req.args ?? [];
      const stdin = req.stdin ?? '';
      // For sync callers, we can't await — return immediately
      // This will be overridden with JSPI wrapping for async callers
      return writeJson(memory, outPtr, outCap, {
        exit_code: 127, stdout: '', stderr: 'async extension invoke required\n',
      });
    },

    host_is_extension(namePtr: number, nameLen: number): number {
      if (!opts.extensionRegistry) return 0;
      const name = readString(memory, namePtr, nameLen);
      if (opts.toolAllowlist && !opts.toolAllowlist.includes(name)) return 0;
      return opts.extensionRegistry.has(name) ? 1 : 0;
    },
  };
}
```

**Step 2: Update manager.ts to use createKernelImports**

In `packages/orchestrator/src/process/manager.ts`, replace the `createPythonImports` call (around line 119-141) with `createKernelImports`. The `needsCodepod` check stays — it just calls a different function.

**Step 3: Update shell-imports.ts**

Remove `host_network_fetch`, `host_extension_invoke`, `host_is_extension` from `createShellImports()` — they now come from `createKernelImports()`. Keep the shell-specific imports: `host_spawn` (the existing sync one), `host_has_tool`, `host_check_cancel`, `host_time_ms`, file I/O helpers, glob.

**Step 4: Run all tests**

```bash
/Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/
```

**Step 5: Commit**

```bash
git add packages/orchestrator/src/host-imports/kernel-imports.ts
git add packages/orchestrator/src/host-imports/shell-imports.ts
git add packages/orchestrator/src/host-imports/python-imports.ts
git add packages/orchestrator/src/process/manager.ts
git commit -m "refactor: unified createKernelImports() replacing per-process-type imports"
```

---

## Task 5: Rust Host Imports — Pipe, Spawn, Waitpid, Close

Add the four new host imports to the Rust shell-exec binary. These are extern "C" functions in the `codepod` WASM import namespace.

**Files:**
- Modify: `packages/shell-exec/src/host.rs` — add new extern declarations and HostInterface methods
- Modify: `packages/shell-exec/src/main.rs` — wire new host imports if needed

**Step 1: Add extern declarations to host.rs**

After the existing `extern "C"` block (around line 172-276), add the new syscalls in the same `#[link(wasm_import_module = "codepod")]` block:

```rust
// Process management syscalls
fn host_pipe(out_ptr: *mut u8, out_cap: u32) -> i32;
fn host_spawn(req_ptr: *const u8, req_len: u32) -> i32;
fn host_waitpid(pid: i32, out_ptr: *mut u8, out_cap: u32) -> i32;
fn host_close_fd(fd: i32) -> i32;
```

**Step 2: Add HostInterface methods**

Add to the `HostInterface` trait:

```rust
fn pipe(&self) -> Result<(i32, i32), HostError>; // returns (read_fd, write_fd)
fn spawn_async(&self, program: &str, args: &[&str], env: &[(&str, &str)], cwd: &str,
               stdin_fd: i32, stdout_fd: i32, stderr_fd: i32) -> Result<i32, HostError>; // returns pid
fn waitpid(&self, pid: i32) -> Result<i32, HostError>; // returns exit_code
fn close_fd(&self, fd: i32) -> Result<(), HostError>;
```

**Step 3: Implement for WasmHost**

In the `impl HostInterface for WasmHost` block:

```rust
fn pipe(&self) -> Result<(i32, i32), HostError> {
    let result_json = call_with_outbuf(|out_ptr, out_cap| unsafe {
        host_pipe(out_ptr, out_cap)
    })?;
    let parsed: serde_json::Value = serde_json::from_str(&result_json)
        .map_err(|e| HostError::Io(e.to_string()))?;
    let read_fd = parsed["read_fd"].as_i64().unwrap_or(-1) as i32;
    let write_fd = parsed["write_fd"].as_i64().unwrap_or(-1) as i32;
    Ok((read_fd, write_fd))
}

fn spawn_async(&self, program: &str, args: &[&str], env: &[(&str, &str)], cwd: &str,
               stdin_fd: i32, stdout_fd: i32, stderr_fd: i32) -> Result<i32, HostError> {
    let req = serde_json::json!({
        "prog": program,
        "args": args,
        "env": env,
        "cwd": cwd,
        "stdin_fd": stdin_fd,
        "stdout_fd": stdout_fd,
        "stderr_fd": stderr_fd,
    });
    let req_bytes = req.to_string();
    let pid = unsafe {
        host_spawn(req_bytes.as_ptr(), req_bytes.len() as u32)
    };
    if pid < 0 { return Err(HostError::Io("spawn failed".into())); }
    Ok(pid)
}

fn waitpid(&self, pid: i32) -> Result<i32, HostError> {
    let result_json = call_with_outbuf(|out_ptr, out_cap| unsafe {
        host_waitpid(pid, out_ptr, out_cap)
    })?;
    let parsed: serde_json::Value = serde_json::from_str(&result_json)
        .map_err(|e| HostError::Io(e.to_string()))?;
    Ok(parsed["exit_code"].as_i64().unwrap_or(-1) as i32)
}

fn close_fd(&self, fd: i32) -> Result<(), HostError> {
    let rc = unsafe { host_close_fd(fd) };
    if rc < 0 { return Err(HostError::Io("close_fd failed".into())); }
    Ok(())
}
```

**Step 4: Build WASM**

```bash
cd packages/shell-exec && cargo build --target wasm32-wasip1 --release
```

Note: This will compile but the new host imports won't be available until the TypeScript side provides them. The build verifies the Rust code compiles correctly.

**Step 5: Commit**

```bash
git add packages/shell-exec/src/host.rs
git commit -m "feat: Rust host imports for pipe, spawn, waitpid, close_fd"
```

---

## Task 6: Rust Builtins Write to Fd

Change builtins (`echo`, `printf`, `cat`, `read`) to write output through WASI `fd_write` instead of returning stdout strings. This is the key change that makes the shell a "standard process."

**Files:**
- Modify: `packages/shell-exec/src/builtins.rs` — echo, printf output via fd_write
- Modify: `packages/shell-exec/src/executor.rs` — pass stdout_fd context through execution, use fd_write for command output
- Modify: `packages/shell-exec/src/state.rs` — add stdout_fd/stdin_fd to ShellState

**Step 1: Add I/O fd context to ShellState**

In `packages/shell-exec/src/state.rs`, add:

```rust
/// Current stdout fd for the executing context (default: 1).
/// Pipeline stages override this to write to pipe fds.
pub stdout_fd: i32,
/// Current stdin fd for the executing context (default: 0).
pub stdin_fd: i32,
```

Initialize both to `1` and `0` respectively in `new_default()`.

**Step 2: Add fd_write/fd_read wrappers**

In `packages/shell-exec/src/host.rs`, add WASI fd_write/fd_read extern declarations and wrapper functions:

```rust
// WASI P1 imports for direct fd I/O
extern "C" {
    fn fd_write(fd: i32, iovs: *const WasiIovec, iovs_len: u32, nwritten: *mut u32) -> u32;
    fn fd_read(fd: i32, iovs: *const WasiIovec, iovs_len: u32, nread: *mut u32) -> u32;
}

#[repr(C)]
struct WasiIovec {
    buf: *const u8,
    buf_len: u32,
}

pub fn write_to_fd(fd: i32, data: &[u8]) -> Result<usize, HostError> {
    let iov = WasiIovec { buf: data.as_ptr(), buf_len: data.len() as u32 };
    let mut nwritten: u32 = 0;
    let errno = unsafe { fd_write(fd, &iov, 1, &mut nwritten) };
    if errno != 0 { return Err(HostError::Io(format!("fd_write errno {}", errno))); }
    Ok(nwritten as usize)
}

pub fn read_from_fd(fd: i32, buf: &mut [u8]) -> Result<usize, HostError> {
    let iov = WasiIovec { buf: buf.as_ptr() as *const u8, buf_len: buf.len() as u32 };
    let mut nread: u32 = 0;
    let errno = unsafe { fd_read(fd, &iov as *const _ as *const WasiIovec, 1, &mut nread) };
    if errno != 0 { return Err(HostError::Io(format!("fd_read errno {}", errno))); }
    Ok(nread as usize)
}
```

**Step 3: Modify builtins to write to fd**

In `builtins.rs`, change `builtin_echo` to write to `state.stdout_fd`:

```rust
fn builtin_echo(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    // ... existing flag parsing, text construction ...
    let output = /* existing output construction */;
    let _ = write_to_fd(state.stdout_fd, output.as_bytes());
    BuiltinResult::Result(RunResult { exit_code: 0, stdout: String::new(), stderr: String::new(), .. })
}
```

Similarly for `printf` (when not `-v`), `cat` builtin, and any other builtins that produce stdout.

The `read` builtin changes to read from `state.stdin_fd` instead of `stdin_data`/`pipeline_stdin`:

```rust
fn builtin_read(state: &mut ShellState, args: &[String], _stdin_data: &str) -> BuiltinResult {
    // Read from state.stdin_fd via read_from_fd()
    let mut buf = vec![0u8; 4096];
    let n = read_from_fd(state.stdin_fd, &mut buf).unwrap_or(0);
    let input = String::from_utf8_lossy(&buf[..n]).to_string();
    // ... existing variable assignment logic ...
}
```

**Step 4: Update executor to pass fd context**

In `executor.rs`, the pipeline handling (around line 812) sets `state.stdout_fd` and `state.stdin_fd` for each stage before executing it.

**Step 5: Build and test**

```bash
cd packages/shell-exec && cargo build --target wasm32-wasip1 --release
```

**Step 6: Commit**

```bash
git add packages/shell-exec/src/builtins.rs packages/shell-exec/src/executor.rs packages/shell-exec/src/state.rs packages/shell-exec/src/host.rs
git commit -m "refactor: builtins write to fd instead of accumulating strings"
```

---

## Task 7: Rust Pipeline Rewrite

Rewrite the pipeline loop in `executor.rs` to use pipe/spawn/waitpid instead of sequential string-passing.

**Files:**
- Modify: `packages/shell-exec/src/executor.rs` — `Command::Pipeline` match arm (lines 812-920)

**Step 1: Implement new pipeline logic**

Replace the `Command::Pipeline` match arm:

```rust
Command::Pipeline { commands } => {
    if commands.len() == 1 {
        return exec_command(state, host, &commands[0]);
    }

    let saved_env = state.env.clone();
    let saved_arrays = state.arrays.clone();
    let saved_assoc = state.assoc_arrays.clone();
    let saved_stdout_fd = state.stdout_fd;
    let saved_stdin_fd = state.stdin_fd;

    let pipefail = state.flags.contains(&ShellFlag::Pipefail);
    let mut pipefail_code = 0;

    let stage_count = commands.len();

    // Create pipes between adjacent stages
    let mut pipes: Vec<(i32, i32)> = Vec::new();
    for _ in 0..stage_count - 1 {
        let (read_fd, write_fd) = host.pipe()?;
        pipes.push((read_fd, write_fd));
    }

    let mut pids: Vec<i32> = Vec::new();

    for (i, cmd) in commands.iter().enumerate() {
        let stdin_fd = if i == 0 { saved_stdin_fd } else { pipes[i - 1].0 };
        let stdout_fd = if i == stage_count - 1 { saved_stdout_fd } else { pipes[i].1 };

        match cmd {
            Command::Simple { words, redirects, assignments } => {
                // Process assignments and expand words (existing logic)
                let _ = process_assignments(state, assignments, Some(&exec_fn));
                let resolved_words = resolve_process_subs(state, host, words, &exec_fn);
                let expanded = expand_words_with_splitting(state, &resolved_words, Some(&exec_fn));
                let braced = expand_braces(&expanded);
                let restored = restore_brace_sentinels(&braced);
                let globbed = expand_globs(host, &restored, &state.cwd);
                let globbed = restore_glob_sentinels(&globbed);

                if globbed.is_empty() { continue; }

                let cmd_name = &globbed[0];
                let cmd_args = &globbed[1..];

                // Check if it's a builtin
                if is_builtin(cmd_name) {
                    // Run builtin with redirected fds
                    state.stdout_fd = stdout_fd;
                    state.stdin_fd = stdin_fd;
                    let result = try_builtin(state, host, cmd_name, cmd_args, "", Some(&exec_fn));
                    // Builtins now write to fd directly — no stdout in result
                    if let Some(BuiltinResult::Result(r)) = result {
                        state.last_exit_code = r.exit_code;
                        if pipefail && r.exit_code != 0 { pipefail_code = r.exit_code; }
                    }
                } else {
                    // External command — spawn as separate process
                    let env_pairs: Vec<(&str, &str)> = state.env.iter()
                        .map(|(k, v)| (k.as_str(), v.as_str())).collect();
                    let arg_refs: Vec<&str> = cmd_args.iter().map(|s| s.as_str()).collect();
                    let pid = host.spawn_async(
                        cmd_name, &arg_refs, &env_pairs, &state.cwd,
                        stdin_fd, stdout_fd, 2, // stderr always fd 2
                    )?;
                    pids.push(pid);
                }
            }
            _ => {
                // Compound command — run inside shell with redirected fds
                state.stdout_fd = stdout_fd;
                state.stdin_fd = stdin_fd;
                let result = exec_command(state, host, cmd);
                if let Ok(ControlFlow::Normal(r)) = &result {
                    if pipefail && r.exit_code != 0 { pipefail_code = r.exit_code; }
                }
            }
        }
    }

    // Close parent copies of pipe fds
    for (read_fd, write_fd) in &pipes {
        let _ = host.close_fd(*read_fd);
        let _ = host.close_fd(*write_fd);
    }

    // Wait for all spawned processes
    let mut last_exit_code = 0;
    for (i, pid) in pids.iter().enumerate() {
        let exit_code = host.waitpid(*pid)?;
        if i == pids.len() - 1 {
            last_exit_code = exit_code;
        }
        if pipefail && exit_code != 0 {
            pipefail_code = exit_code;
        }
    }

    // Restore state
    state.stdout_fd = saved_stdout_fd;
    state.stdin_fd = saved_stdin_fd;
    state.env = saved_env;
    state.arrays = saved_arrays;
    state.assoc_arrays = saved_assoc;

    let final_code = if pipefail && pipefail_code != 0 { pipefail_code } else { last_exit_code };
    state.last_exit_code = final_code;

    Ok(ControlFlow::Normal(RunResult {
        exit_code: final_code,
        stdout: String::new(), // stdout went through fds
        stderr: String::new(),
        execution_time_ms: 0,
    }))
}
```

**Step 2: Update __run_command output protocol**

In `main.rs`, the `__run_command` return now only carries metadata (exit_code, env). Stdout/stderr have already been written to fds 1 and 2 by builtins and the executor.

**Step 3: Build WASM**

```bash
cd packages/shell-exec && cargo build --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/codepod_shell_exec.wasm \
   ../orchestrator/src/shell/__tests__/fixtures/codepod-shell.wasm
cp target/wasm32-wasip1/release/codepod_shell_exec.wasm \
   ../orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm
```

**Step 4: Commit**

```bash
git add packages/shell-exec/
git commit -m "feat: pipeline rewrite with pipe/spawn/waitpid"
```

---

## Task 8: Shell Instance Integration

Wire the shell WASM binary to use a real WasiHost (replacing no-op stubs), JSPI-wrap fd_read/fd_write for pipe suspension, and update the output protocol.

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-instance.ts`
- Modify: `packages/orchestrator/src/host-imports/shell-imports.ts`
- Modify: `packages/orchestrator/src/sandbox.ts`

**Step 1: Give the shell a real WasiHost**

In `shell-instance.ts`, the `create()` method currently creates minimal WASI stubs (lines 141-203). Replace these with a real `WasiHost` instance configured with an fd table:

```typescript
// Create WasiHost for the shell process
const shellHost = new WasiHost({
  vfs: opts.vfs,
  args: ['shell'],
  env: {},
  preopens: { '/': '/' },
  ioFds: new Map([
    [0, createNullTarget()],          // stdin: no terminal input
    [1, createBufferTarget(opts.stdoutLimitBytes)],  // stdout: captured
    [2, createBufferTarget(opts.stderrLimitBytes)],  // stderr: captured
  ]),
});

const wasiImports = shellHost.getImports();
```

**Step 2: JSPI-wrap fd_read and fd_write**

For the shell (and any pipeline stage), wrap the WASI `fd_read` and `fd_write` imports with `WebAssembly.Suspending` so they can suspend on pipe I/O:

```typescript
if (typeof WebAssembly.Suspending === 'function') {
  // Make fd_read/fd_write suspendable for pipe I/O
  wasiImports.wasi_snapshot_preview1.fd_read = new WebAssembly.Suspending(
    wasiImports.wasi_snapshot_preview1.fd_read
  );
  wasiImports.wasi_snapshot_preview1.fd_write = new WebAssembly.Suspending(
    wasiImports.wasi_snapshot_preview1.fd_write
  );
}
```

**Step 3: Add kernel imports to the shell**

Merge the `codepod` namespace from `createKernelImports()` with the existing shell-specific imports:

```typescript
const kernelImports = createKernelImports({
  memory: memoryProxy,
  callerPid: 0, // shell is pid 0
  kernel,
  networkBridge: opts.networkBridge,
  extensionRegistry: opts.extensionRegistry,
  toolAllowlist: opts.toolAllowlist,
  spawnProcess: (req, fdTable) => {
    // Spawn a WASM tool process — uses ProcessManager
    return spawnAsyncProcess(req, fdTable, mgr, kernel, adapter);
  },
});

// Merge with shell-specific imports
const codepodImports = { ...shellImports, ...kernelImports };
```

**Step 4: Update run() to read stdout/stderr from WasiHost**

In `ShellInstance.run()`, after `__run_command` returns:

```typescript
// __run_command now returns only metadata: {exit_code, env}
const metadata = JSON.parse(resultJson);

// stdout/stderr came through fd 1/2 via the WasiHost
const stdout = shellHost.getStdout();
const stderr = shellHost.getStderr();
// Clear buffers for next command
shellHost.resetOutputBuffers();

return {
  exitCode: metadata.exit_code,
  stdout,
  stderr,
  // ... env sync from metadata.env
};
```

**Step 5: Implement spawnAsyncProcess helper**

This is the function that the kernel calls when the shell calls `host_spawn`:

```typescript
async function spawnAsyncProcess(
  req: SpawnRequest,
  fdTable: Map<number, FdTarget>,
  mgr: ProcessManager,
  kernel: ProcessKernel,
  adapter: PlatformAdapter,
): Promise<number> {
  const pid = kernel.allocPid();
  kernel.initProcess(pid);

  const module = mgr.getModule(req.prog);
  if (!module) return -1;

  const host = new WasiHost({
    vfs: mgr.vfs,
    args: [req.prog, ...req.args],
    env: Object.fromEntries(req.env),
    preopens: { '/': '/' },
    ioFds: fdTable,
  });

  // JSPI-wrap fd_read/fd_write for pipe I/O
  const imports = host.getImports();
  if (typeof WebAssembly.Suspending === 'function') {
    imports.wasi_snapshot_preview1.fd_read = new WebAssembly.Suspending(
      imports.wasi_snapshot_preview1.fd_read
    );
    imports.wasi_snapshot_preview1.fd_write = new WebAssembly.Suspending(
      imports.wasi_snapshot_preview1.fd_write
    );
  }

  // Add kernel imports if the module needs them
  const moduleImports = WebAssembly.Module.imports(module);
  if (moduleImports.some(imp => imp.module === 'codepod')) {
    imports.codepod = createKernelImports({
      memory: host.getMemory(),
      callerPid: pid,
      kernel,
      spawnProcess: (req, fdTable) => spawnAsyncProcess(req, fdTable, mgr, kernel, adapter),
    });
  }

  const instance = await adapter.instantiate(module, imports);
  host.setMemory(instance.exports.memory as WebAssembly.Memory);

  // Wrap _start with promising for JSPI suspension
  let startFn = instance.exports._start as Function;
  if (typeof WebAssembly.promising === 'function') {
    startFn = WebAssembly.promising(startFn);
  }

  // Start the process — returns a Promise that resolves when process exits
  const promise = Promise.resolve().then(() => startFn()).catch(() => {});
  kernel.registerProcess(pid, promise, host);

  return pid;
}
```

**Step 6: Run tests**

```bash
/Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts
```

**Step 7: Commit**

```bash
git add packages/orchestrator/src/shell/shell-instance.ts packages/orchestrator/src/host-imports/ packages/orchestrator/src/sandbox.ts
git commit -m "feat: shell uses real WasiHost with JSPI pipe suspension"
```

---

## Task 9: Integration Tests

End-to-end streaming pipeline tests.

**Files:**
- Create: `packages/orchestrator/src/__tests__/pipeline-streaming.test.ts`

**Step 1: Write integration tests**

```typescript
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Sandbox } from '../sandbox.js';

const WASM_DIR = new URL('../platform/__tests__/fixtures', import.meta.url).pathname;
const SHELL_WASM = new URL('../shell/__tests__/fixtures/codepod-shell.wasm', import.meta.url).pathname;

describe('Streaming Pipelines', () => {
  let sandbox: Sandbox;

  afterEach(() => { sandbox?.dispose(); });

  it('simple pipeline: echo | cat', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellExecWasmPath: SHELL_WASM });
    const result = await sandbox.run('echo hello | cat');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('multi-stage pipeline: echo | grep | cat', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellExecWasmPath: SHELL_WASM });
    const result = await sandbox.run('echo "hello world" | grep hello | cat');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('compound command in pipeline: echo | while read', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellExecWasmPath: SHELL_WASM });
    const result = await sandbox.run('echo hello | while read line; do echo "got: $line"; done');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('got: hello');
  });

  it('head terminates pipeline early (SIGPIPE)', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellExecWasmPath: SHELL_WASM });
    // seq produces 1000 lines but head only takes 5
    const result = await sandbox.run('seq 1 1000 | head -5');
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe('1');
    expect(lines[4]).toBe('5');
  });

  it('non-pipeline commands still work (regression)', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellExecWasmPath: SHELL_WASM });

    const echo = await sandbox.run('echo hello');
    expect(echo.exitCode).toBe(0);
    expect(echo.stdout.trim()).toBe('hello');

    const env = await sandbox.run('export FOO=bar && echo $FOO');
    expect(env.stdout.trim()).toBe('bar');
  });
});
```

**Step 2: Run tests**

```bash
/Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/__tests__/pipeline-streaming.test.ts
```

**Step 3: Run full regression suite**

```bash
/Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/ packages/sdk-server/ packages/mcp-server/
```

All 329 shell conformance test steps must still pass.

**Step 4: Commit**

```bash
git add packages/orchestrator/src/__tests__/pipeline-streaming.test.ts
git commit -m "test: streaming pipeline integration tests"
```

---

## Task 10: Build and Copy WASM Binaries

After all Rust changes, rebuild and copy WASM binaries to test fixture directories.

**Step 1: Format and lint Rust**

```bash
cd packages/shell-exec && cargo fmt && cargo clippy --target wasm32-wasip1
```

**Step 2: Build release WASM**

```bash
cd packages/shell-exec && cargo build --target wasm32-wasip1 --release
```

**Step 3: Copy to fixture directories**

```bash
cp packages/shell-exec/target/wasm32-wasip1/release/codepod_shell_exec.wasm \
   packages/orchestrator/src/shell/__tests__/fixtures/codepod-shell.wasm
cp packages/shell-exec/target/wasm32-wasip1/release/codepod_shell_exec.wasm \
   packages/orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm
```

**Step 4: Run full test suite**

```bash
/Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/ packages/sdk-server/ packages/mcp-server/
```

**Step 5: Commit**

```bash
git add packages/orchestrator/src/shell/__tests__/fixtures/ packages/orchestrator/src/platform/__tests__/fixtures/
git commit -m "build: rebuild shell-exec WASM with streaming pipeline support"
```

---

## Task 11: Developer Guide — Creating WASM Commands

Document the process model and how to create new Rust WASM tools for the sandbox. This serves both external contributors and as a reference for ourselves (and Claude).

**Files:**
- Create: `docs/guides/creating-commands.md`

**Step 1: Write the guide**

Create `docs/guides/creating-commands.md`:

````markdown
# Creating WASM Commands

This guide explains how to create new commands (coreutils, custom tools) that run inside the codepod sandbox. Commands are Rust binaries compiled to WebAssembly (WASI P1) and executed by the sandbox's process kernel.

## Process Model

Every command runs as an isolated WASM process. The sandbox provides a mini-POSIX kernel:

```
+-------------------------------------------+
|  Process Kernel (TypeScript)              |
|  Manages processes, pipes, fd tables      |
+-------------------------------------------+
|  Your Command (WASM)                      |
|  Standard Rust — stdin/stdout/stderr/fs   |
+-------------------------------------------+
```

Your command links against standard Rust libraries. The WASI layer transparently maps:

| Rust stdlib | WASI syscall | Kernel provides |
|-------------|-------------|-----------------|
| `std::io::stdin()` | `fd_read(0, ...)` | Pre-loaded bytes, pipe, or /dev/null |
| `std::io::stdout()` | `fd_write(1, ...)` | Capture buffer or pipe to next command |
| `std::io::stderr()` | `fd_write(2, ...)` | Capture buffer |
| `std::fs::File::open()` | `path_open(...)` | In-memory VFS |
| `std::env::args()` | `args_get(...)` | Arguments from the shell |
| `std::env::var()` | `environ_get(...)` | Environment from the shell |
| `std::process::exit()` | `proc_exit(...)` | Reports exit code to caller |

You don't need to know about WASI, pipes, or the kernel. Write normal Rust.

## Quick Start: Add a Command to Coreutils

All standard commands live in `packages/coreutils/` as binary targets in a single Cargo workspace crate.

### 1. Create the source file

```bash
# Example: adding a 'rot13' command
touch packages/coreutils/src/bin/rot13.rs
```

Write standard Rust:

```rust
use std::env;
use std::io::{self, BufRead, Write};
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    // Read from stdin
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = line.unwrap_or_else(|e| {
            eprintln!("rot13: {}", e);
            process::exit(1);
        });
        let rotated: String = line.chars().map(|c| match c {
            'a'..='m' | 'A'..='M' => (c as u8 + 13) as char,
            'n'..='z' | 'N'..='Z' => (c as u8 - 13) as char,
            _ => c,
        }).collect();
        writeln!(out, "{}", rotated).unwrap();
    }
}
```

### 2. Register the binary target

Add to `packages/coreutils/Cargo.toml`:

```toml
[[bin]]
name = "rot13"
path = "src/bin/rot13.rs"
```

### 3. Build

```bash
cargo build --target wasm32-wasip1 --release
```

Output: `target/wasm32-wasip1/release/rot13.wasm`

### 4. Deploy to fixture directories

```bash
cp target/wasm32-wasip1/release/rot13.wasm \
   packages/orchestrator/src/platform/__tests__/fixtures/
```

The sandbox auto-discovers `.wasm` files in the `wasmDir` directory. No registration code needed — just drop the file in.

### 5. Test

```bash
# Run the sandbox test suite
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts
```

Or test interactively via the SDK:

```typescript
const sandbox = await Sandbox.create({ wasmDir: './path/to/fixtures' });
const result = await sandbox.run('echo "hello world" | rot13');
console.log(result.stdout); // "uryyb jbeyq\n"
```

## Standalone Command (Separate Crate)

For commands that need their own dependencies or more complex structure, create a separate crate:

```bash
mkdir -p packages/my-tool
cd packages/my-tool
cargo init --name my-tool
```

Add to the workspace in the root `Cargo.toml`:

```toml
[workspace]
members = [
  # ... existing members ...
  "packages/my-tool",
]
```

Build and deploy the same way:

```bash
cargo build --target wasm32-wasip1 --release -p my-tool
cp target/wasm32-wasip1/release/my-tool.wasm \
   packages/orchestrator/src/platform/__tests__/fixtures/
```

The command name is derived from the `.wasm` filename: `my-tool.wasm` → command `my-tool`.

## What Your Command Can Do

### File I/O

Read and write files in the sandbox's virtual filesystem:

```rust
use std::fs;

// Read a file
let content = fs::read_to_string("/home/user/data.txt").unwrap();

// Write a file
fs::write("/home/user/output.txt", "result").unwrap();

// List a directory
for entry in fs::read_dir("/home/user").unwrap() {
    println!("{}", entry.unwrap().path().display());
}
```

All paths are within the in-memory VFS. The command cannot access the host filesystem.

### Stdin / Stdout / Stderr

Standard I/O works normally. In pipelines, stdin/stdout are connected to pipes:

```rust
use std::io::{self, BufRead, Write};

// Read stdin line by line
let stdin = io::stdin();
for line in stdin.lock().lines() {
    let line = line.unwrap();
    // Process and write to stdout
    println!("{}", line.to_uppercase());
}
```

Use `BufWriter` for performance with many small writes:

```rust
use std::io::{self, BufWriter, Write};

let stdout = io::stdout();
let mut out = BufWriter::new(stdout.lock());
for i in 0..1000 {
    writeln!(out, "{}", i).unwrap();
}
```

### Environment Variables

```rust
use std::env;

let path = env::var("PATH").unwrap_or_default();
let home = env::var("HOME").unwrap_or_default();

// Iterate all env vars
for (key, value) in env::vars() {
    println!("{}={}", key, value);
}
```

### Command-Line Arguments

```rust
use std::env;

let args: Vec<String> = env::args().collect();
// args[0] = command name (e.g., "rot13")
// args[1..] = arguments passed by the user
```

### Exit Codes

```rust
use std::process;

// Success
process::exit(0);

// Error
eprintln!("my-tool: something went wrong");
process::exit(1);
```

## What Your Command Cannot Do

| Capability | Status | Reason |
|-----------|--------|--------|
| Network access | No | WASI sockets not implemented |
| Spawn subprocesses | Not yet | Process management syscalls are shell-only (for now) |
| Multithreading | No | `wasm32-wasip1` is single-threaded |
| Host filesystem access | No | All I/O goes through the sandboxed VFS |
| Signals (SIGINT, etc.) | No | No signal delivery mechanism |

## Build Configuration

The workspace uses these release optimizations (`Cargo.toml` at root):

```toml
[profile.release]
lto = true          # link-time optimization
opt-level = "z"     # optimize for binary size
strip = true        # strip debug symbols
```

This keeps `.wasm` files small (typically 50KB–500KB per tool).

### Dependencies

Coreutils commands share the workspace dependencies:

```toml
[dependencies]
flate2 = { version = "1.0", default-features = false, features = ["rust_backend"] }
regex = { version = "1", default-features = false, features = ["std", "unicode-perl", "unicode-case"] }
tar = "0.4"
```

Use `default-features = false` to minimize binary size. Avoid dependencies that require system libraries (OpenSSL, etc.) — they won't compile to WASI.

## Conventions

- **Error messages:** Write to stderr with the command name prefix: `eprintln!("mytool: error message");`
- **Exit codes:** 0 = success, 1 = general error, 2 = usage error (matches GNU conventions)
- **Flags:** Support both short (`-n`) and long (`--number`) forms where practical
- **Stdin handling:** If no file arguments are given, read from stdin (like `cat`, `grep`, `wc`)
- **Binary names:** Use lowercase, hyphen-separated names. The `.wasm` filename becomes the command name.

## File Summary

| Path | Purpose |
|------|---------|
| `packages/coreutils/Cargo.toml` | Coreutils crate — add `[[bin]]` entries here |
| `packages/coreutils/src/bin/` | One `.rs` file per command |
| `Cargo.toml` (root) | Workspace config — add standalone crates to `members` |
| `target/wasm32-wasip1/release/` | Build output — `.wasm` binaries |
| `packages/orchestrator/src/platform/__tests__/fixtures/` | Test fixtures — drop `.wasm` files here |
| `scripts/copy-wasm.sh` | Copies fixtures to packaging directory |
````

**Step 2: Commit**

```bash
git add docs/guides/creating-commands.md
git commit -m "docs: guide for creating WASM commands"
```

---

## Verification Checklist

After all tasks complete:

```bash
# Rust checks
cd packages/shell-exec && cargo fmt --check && cargo clippy --target wasm32-wasip1

# TypeScript type check
cd packages/orchestrator && npx tsc --noEmit

# Full test suite
/Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/ packages/sdk-server/ packages/mcp-server/

# Python tests
cd packages/python-sdk && ../.venv/bin/python -m pytest tests/ -v
```

All must pass. Key properties to verify:
- `echo hello | cat` → streams, not buffers
- `seq 1 1000 | head -5` → producer killed early (SIGPIPE)
- `echo hello | while read line; do echo "$line"; done` → compound commands in pipeline work
- `echo hello` (no pipe) → unchanged behavior via legacy path
- `export FOO=bar` → env sync still works
- All 329 shell conformance test steps pass
