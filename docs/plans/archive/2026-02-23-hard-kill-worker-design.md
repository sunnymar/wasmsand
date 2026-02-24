# Hard Kill via Worker Boundary Design

## Context

The current timeout mechanism uses `Promise.race` — when a command exceeds `timeoutMs`, the caller gets a timeout result but the WASM execution continues running in the background. There is no way to interrupt synchronous WASM execution (`host.start(instance)` calls `_start()` and blocks the thread until completion). The only way to kill a running WASM instance is to terminate its thread.

The `feature/security-mvp` branch adds cooperative cancellation via deadline checks in WASI calls. This handles commands that make frequent WASI calls but cannot stop pure-WASM infinite loops that never yield. The Worker boundary is the backstop.

## Architecture

The execution boundary is `ShellRunner.run(command)`. Everything from that call down (parsing, AST execution, WASM spawning, WASI calls) runs in a Worker thread. The main thread owns the VFS and handles proxy requests via its event loop.

```
Main Thread (event loop alive)           Execution Worker (sync execution)
────────────────────────────────         ──────────────────────────────────
Sandbox.run("cmd")
  → workerExecutor.run(cmd, timeout)
    → postMessage({type:'run', cmd})
    → set timeout timer                  ShellRunner.run(cmd)
    → return Promise                       ├── parse (shell.wasm)
                                           ├── execCommand()
  ← vfs proxy request ←─────────────      │   └── WasiHost.fd_read()
  real vfs.readFile() on main thread             → vfsProxy.readFile(path)
  write result to SAB                            → write req to SAB, Atomics.wait()
  Atomics.notify()  ────────────→              ← unblocks, reads result
                                               ← returns data to WASM
  ← result message ←────────────         └── return RunResult

  resolve Promise with result
```

Kill mechanism: `worker.terminate()` instantly destroys the thread. VFS on the main thread is always consistent — any in-flight proxy write is lost (correct behavior for a killed command).

### Worker lifecycle

- **Long-lived between runs**: Worker stays alive after a command completes, preserving WASM module cache.
- **Killed only on timeout/cancel**: `worker.terminate()` destroys it.
- **Recreated on next run**: Fresh Worker with fresh state, no leaked execution.
- **Self-sufficient for WASM loading**: Worker loads modules from filesystem (Node Worker threads have fs access). Module cache lives in the Worker.

### Browser fallback

Browser lacks `node:worker_threads`. Falls back to current behavior: direct `ShellRunner.run()` with `Promise.race` timeout. The PlatformAdapter exposes `supportsWorkerExecution: boolean` so Sandbox can choose the right path.

## VFS Proxy Protocol

### SharedArrayBuffer layout (32 MB)

```
Offset   Size    Field
[0-3]    Int32   status: IDLE=0, REQUEST=1, RESPONSE=2, ERROR=3
[4-7]    Int32   metadata length (JSON bytes)
[8-11]   Int32   binary data length (raw bytes)
[12..]   Uint8   JSON metadata (UTF-8)
[12+N..] Uint8   binary payload (raw file content, no base64)
```

Binary data goes directly into the SAB — no encoding overhead. JSON metadata carries operation name, paths, stat results, error codes.

### Operations

VFS operations (9 methods):

| Op | Request metadata | Request binary | Response metadata | Response binary |
|----|-----------------|----------------|-------------------|-----------------|
| `readFile` | `{path}` | — | `{}` | file content |
| `writeFile` | `{path}` | file content | `{ok:true}` | — |
| `stat` | `{path}` | — | `{type,size,permissions,mtime,ctime,atime}` | — |
| `readdir` | `{path}` | — | `{entries:[{name,type},...]}` | — |
| `mkdir` | `{path}` | — | `{ok:true}` | — |
| `unlink` | `{path}` | — | `{ok:true}` | — |
| `rmdir` | `{path}` | — | `{ok:true}` | — |
| `rename` | `{oldPath,newPath}` | — | `{ok:true}` | — |
| `chmod` | `{path,mode}` | — | `{ok:true}` | — |

Network operation (replaces separate NetworkBridge worker):

| Op | Request metadata | Request binary | Response metadata | Response binary |
|----|-----------------|----------------|-------------------|-----------------|
| `fetch` | `{url,method,headers,body}` | — | `{status,headers}` | response body |

### Worker-side call flow

Example: `vfsProxy.readFile("/tmp/foo")`:

1. Encode `{op:'readFile', path:'/tmp/foo'}` as JSON, write to SAB at offset 12.
2. Set metadata length at [4-7].
3. Set status to `REQUEST` (1) at [0-3].
4. `parentPort.postMessage('proxy-request')` — nudge main thread event loop.
5. `Atomics.wait(int32, 0, REQUEST)` — block Worker until status changes.
6. Read response status. If `ERROR`, decode error metadata and throw `VfsError`.
7. Read metadata length and binary length, decode response.
8. Reset status to `IDLE` (0).
9. Return file content as `Uint8Array`.

### Main-thread handler

1. Receives `'proxy-request'` message via `worker.on('message')`.
2. Reads request metadata and binary from SAB.
3. Calls real VFS method. For elevated operations (init-phase only), wraps in `vfs.withWriteAccess()`.
4. Writes response metadata and binary to SAB.
5. Sets status to `RESPONSE` (2) or `ERROR` (3).
6. `Atomics.notify(int32, 0)` — wake Worker.

### Error handling

VFS errors (ENOENT, ENOSPC, EROFS, etc.) are caught by the main thread handler and serialized as `{error: true, code: 'ENOENT', message: '...'}` with status `ERROR`. The Worker-side proxy rethrows a matching `VfsError`.

## Worker Executor

### WorkerExecutor class (main thread)

```ts
class WorkerExecutor {
  private worker: Worker | null;
  private sab: SharedArrayBuffer;
  private pendingResolve: ((r: RunResult) => void) | null;

  constructor(config: WorkerConfig);

  // Send command to Worker, return result or timeout/cancel.
  run(command: string, env: Map<string,string>, timeoutMs: number): Promise<RunResult>;

  // Terminate Worker immediately, resolve pending with CANCELLED.
  kill(): void;

  // Whether a command is currently executing in the Worker.
  isRunning(): boolean;

  // Clean shutdown (terminate Worker if alive).
  dispose(): void;
}
```

### Worker initialization

When creating a Worker, send init message:

```ts
{
  type: 'init',
  sab: SharedArrayBuffer,
  wasmDir: string,
  shellWasmPath: string,
  toolRegistry: [string, string][],
  networkEnabled: boolean,
}
```

Worker constructs its own VfsProxy, ProcessManager, and ShellRunner. ShellRunner skips `populateBin()` (already done on main thread during `Sandbox.create()`).

### Run flow

1. Main thread posts `{type: 'run', command, env: [...entries]}`.
2. Worker calls `shellRunner.run(command)`.
3. During execution, Worker makes VFS proxy calls as needed (blocks on Atomics.wait).
4. Worker posts `{type: 'result', result: RunResult}` when done.
5. Main thread resolves Promise.

### Timeout flow

1. `setTimeout(timeoutMs)` fires on main thread.
2. `worker.terminate()` — instant thread destruction.
3. Resolve Promise with `{exitCode: 124, errorClass: 'TIMEOUT'}`.
4. Set `this.worker = null` — next `run()` creates fresh Worker.

### Cancel flow

1. `sandbox.cancel()` → `workerExecutor.kill()`.
2. `worker.terminate()`.
3. Resolve with `{exitCode: 125, errorClass: 'CANCELLED'}`.
4. `this.worker = null`.

## Sandbox Integration

### Changes to Sandbox.create()

Initialization stays on main thread (before any Worker):
- Create VFS, register tools, populate `/bin` stubs.
- Set up Python socket shim if networking enabled.
- Create `WorkerExecutor` with config (wasmDir, shellWasmPath, tool registry, network flag).

### Changes to Sandbox.run()

```ts
async run(command: string): Promise<RunResult> {
  this.assertAlive();

  // Pre-check: command length (stays on main thread)
  if (Buffer.byteLength(command) > this.limits.commandBytes) {
    return { exitCode: 1, ..., errorClass: 'LIMIT_EXCEEDED' };
  }

  // Delegate to Worker
  const result = await this.workerExecutor.run(
    command, this.runner.getEnvMap(), this.timeoutMs
  );

  // Post-check: output truncation (stays on main thread)
  return this.applyOutputLimits(result);
}
```

### Cancel

```ts
cancel(): void {
  this.workerExecutor.kill();
}
```

### Fork

Forked sandboxes get their own `WorkerExecutor` with their own Worker.

### Destroy

```ts
destroy(): void {
  this.workerExecutor.dispose();
  this.bridge?.dispose();
  this.destroyed = true;
}
```

### Environment variable sync

Env vars are managed on the main thread (`sandbox.setEnv`/`getEnv`). The current env map is sent to the Worker with each `run()` message. The Worker's ShellRunner sets these before executing. If the command modifies env vars (export/unset), those changes are sent back in the result and applied on the main thread.

## Compatibility with feature/security-mvp

The `feature/security-mvp` branch adds:
- `SecurityOptions` with `toolAllowlist`, audit events, `limits`
- Cooperative cancel via `CancelledError` and deadline checks in WASI calls
- `runner.resetCancel(timeout)` and `mgr.cancelCurrent()`

These mechanisms complement the Worker kill:
- **Cooperative cancel**: Fast for commands making frequent WASI calls (catches at next syscall boundary). This runs inside the Worker.
- **Worker terminate**: Backstop for commands that spin in pure WASM computation without WASI calls.

Both can coexist. The Worker's ShellRunner uses the cooperative cancel mechanism internally. If cooperative cancel doesn't work within the timeout, `worker.terminate()` forces it.

## New Files

| File | Purpose |
|------|---------|
| `execution/proxy-protocol.ts` | SAB layout constants, status flags, JSON encode/decode helpers |
| `execution/vfs-proxy.ts` | Worker-side VFS proxy (implements VFS-like interface via SAB + Atomics) |
| `execution/worker-executor.ts` | Main-thread: Worker lifecycle, VFS proxy server, timeout/kill |
| `execution/execution-worker.ts` | Worker entrypoint: construct ShellRunner, handle run messages |

## Modified Files

| File | Change |
|------|--------|
| `sandbox.ts` | Use WorkerExecutor for run/cancel/destroy on Node; fallback on browser |
| `shell/shell-runner.ts` | Add `skipInit` constructor option to skip populateBin() |
| `platform/adapter.ts` | Add optional `supportsWorkerExecution: boolean` |
| `process/manager.ts` | Accept VFS-like interface (VfsProxy or VFS) via duck typing |

## Test Files

| File | Coverage |
|------|----------|
| `execution/__tests__/worker-executor.test.ts` | Worker lifecycle, VFS proxy roundtrip, timeout kill, cancel, error propagation |
| `execution/__tests__/vfs-proxy.test.ts` | Each VFS operation through proxy, error cases |
| `__tests__/sandbox.test.ts` | Hard timeout kills infinite loop, cancel during execution |

## Acceptance Criteria

1. Infinite WASM loop is terminated by hard timeout — does not continue running in background.
2. `sandbox.cancel()` immediately terminates execution and returns `CANCELLED`.
3. No leaked Worker after timeout/cancel.
4. VFS is consistent after kill (no partial writes).
5. Next `run()` after kill works correctly (fresh Worker).
6. All existing tests pass (resource limits, fork, snapshot, etc.).
7. Browser fallback works (Promise.race timeout, no hard kill).
