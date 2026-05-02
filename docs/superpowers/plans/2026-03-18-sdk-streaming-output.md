# SDK Streaming Output — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in streaming stdout/stderr callbacks to `Sandbox.run()` in both TypeScript and Python SDKs, so consumers get real-time output during long-running commands.

**Architecture:** Add `onChunk` callback to the existing `buffer` fd target type. Every code path that writes to a buffer target calls `onChunk` after pushing the chunk. `Sandbox.run()` accepts optional `onStdout`/`onStderr` callbacks, sets `onChunk` on the pid 0 buffer targets before execution, and clears them after. The Python SDK uses JSON-RPC notifications to relay chunks from the TypeScript SDK server.

**Tech Stack:** TypeScript (Deno), Python 3, JSON-RPC 2.0, WASI fd_write.

**Spec:** `docs/superpowers/specs/2026-03-18-sdk-streaming-output-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/orchestrator/src/wasi/fd-target.ts` | Modify | Add `onChunk` to buffer target type + factory |
| `packages/orchestrator/src/wasi/wasi-host.ts` | Modify | Call `onChunk` in `fdWrite` buffer path |
| `packages/orchestrator/src/shell/shell-instance.ts` | Modify | Call `onChunk` in inline `fd_write` buffer path |
| `packages/orchestrator/src/sandbox.ts` | Modify | Accept streaming callbacks, wire to buffer targets |
| `packages/sdk-server/src/server.ts` | Modify | Add `notify()` helper |
| `packages/sdk-server/src/dispatcher.ts` | Modify | Stream RPC notifications when `stream: true` |
| `packages/python-sdk/src/codepod/_rpc.py` | Modify | Handle output notifications in message loop |
| `packages/python-sdk/src/codepod/commands.py` | Modify | Accept `stream`/`on_stdout`/`on_stderr` params |
| `packages/orchestrator/src/__tests__/streaming.test.ts` | Create | TypeScript streaming tests |
| `packages/python-sdk/tests/test_streaming.py` | Create | Python streaming tests |

---

### Task 1: Add `onChunk` to buffer target

**Files:**
- Modify: `packages/orchestrator/src/wasi/fd-target.ts`

- [ ] **Step 1: Add `onChunk` to the buffer type**

In `packages/orchestrator/src/wasi/fd-target.ts`, update the buffer variant of `FdTarget` (line 5):

```typescript
  | { type: 'buffer'; buf: Uint8Array[]; total: number; limit: number; truncated: boolean; onChunk?: (data: Uint8Array) => void }
```

- [ ] **Step 2: Update `createBufferTarget` factory**

Replace the existing `createBufferTarget` function:

```typescript
export function createBufferTarget(limit = Infinity, onChunk?: (data: Uint8Array) => void): FdTarget & { type: 'buffer' } {
  return { type: 'buffer', buf: [], total: 0, limit, truncated: false, onChunk };
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/wasi/fd-target.ts
git commit -m "feat(streaming): add onChunk callback to buffer fd target"
```

---

### Task 2: Call `onChunk` in all buffer write paths

**Files:**
- Modify: `packages/orchestrator/src/wasi/wasi-host.ts`
- Modify: `packages/orchestrator/src/shell/shell-instance.ts`

There are two code paths that push to buffer targets. Both need `onChunk` calls.

- [ ] **Step 1: Add `onChunk` call in `WasiHost.fdWrite`**

In `packages/orchestrator/src/wasi/wasi-host.ts`, in the `fdWrite` method, find the `case 'buffer'` block (around line 456). After `target.buf.push(slice);` (line 460), add:

```typescript
              target.onChunk?.(slice);
```

So the block becomes:

```typescript
          case 'buffer': {
            if (target.total < target.limit) {
              const remaining = target.limit - target.total;
              const slice = data.byteLength <= remaining ? data : data.slice(0, remaining);
              target.buf.push(slice);
              target.onChunk?.(slice);
              if (data.byteLength > remaining) target.truncated = true;
            } else {
              target.truncated = true;
            }
            target.total += data.byteLength;
            totalWritten += data.byteLength;
            break;
          }
```

- [ ] **Step 2: Add `onChunk` call in shell-instance inline `fd_write`**

In `packages/orchestrator/src/shell/shell-instance.ts`, find the inline `fd_write` function's `case 'buffer'` block (around line 223). After `target.buf.push(slice);` (line 227), add:

```typescript
              target.onChunk?.(slice);
```

So the block becomes:

```typescript
            case 'buffer': {
              if (target.total < target.limit) {
                const remaining = target.limit - target.total;
                const slice = data.byteLength <= remaining ? data : data.slice(0, remaining);
                target.buf.push(slice);
                target.onChunk?.(slice);
                if (data.byteLength > remaining) target.truncated = true;
              } else {
                target.truncated = true;
              }
              target.total += data.byteLength;
              totalWritten += data.byteLength;
              break;
            }
```

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/wasi/wasi-host.ts packages/orchestrator/src/shell/shell-instance.ts
git commit -m "feat(streaming): call onChunk in all buffer write paths"
```

---

### Task 3: Add streaming callbacks to `Sandbox.run()`

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts`

- [ ] **Step 1: Add the `StreamCallbacks` type and update `run()` signature**

Near the top of `packages/orchestrator/src/sandbox.ts` (after the imports), add the type:

```typescript
export interface StreamCallbacks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}
```

Then update the `run` method signature (line 425) from:

```typescript
  async run(command: string): Promise<RunResult> {
```

to:

```typescript
  async run(command: string, callbacks?: StreamCallbacks): Promise<RunResult> {
```

- [ ] **Step 2: Wire callbacks to buffer targets**

Inside the `run()` method, after the command size check and before the execution block, add code to set `onChunk` on the pid 0 buffer targets. Find the line `const effectiveTimeout = ...` (line 454) and insert before it:

```typescript
    // Set up streaming callbacks on pid 0 stdout/stderr buffer targets
    const stdoutDecoder = callbacks?.onStdout ? new TextDecoder() : null;
    const stderrDecoder = callbacks?.onStderr ? new TextDecoder() : null;
    if (callbacks?.onStdout && this.runner.kernel) {
      const target = this.runner.kernel.getFdTarget(0, 1);
      if (target?.type === 'buffer') {
        target.onChunk = (data: Uint8Array) => {
          callbacks.onStdout!(stdoutDecoder!.decode(data, { stream: true }));
        };
      }
    }
    if (callbacks?.onStderr && this.runner.kernel) {
      const target = this.runner.kernel.getFdTarget(0, 2);
      if (target?.type === 'buffer') {
        target.onChunk = (data: Uint8Array) => {
          callbacks.onStderr!(stderrDecoder!.decode(data, { stream: true }));
        };
      }
    }
```

Note: `this.runner` is a `ShellInstance` which has a `kernel` property. We need to check if `kernel` is publicly accessible.

- [ ] **Step 3: Check kernel access**

Read `packages/orchestrator/src/shell/shell-instance.ts` to find how `kernel` is declared. If it's `private`, we need to add a getter or make it `readonly`. Look for the property declaration.

In `shell-instance.ts`, the kernel is stored as a private field. Add a public getter if needed:

```typescript
  get kernel(): ProcessKernel | null {
    return this._kernel;
  }
```

Or if the field is already named `kernel`, change `private kernel` to `readonly kernel`.

- [ ] **Step 4: Clear callbacks after execution**

After the execution block and before the audit section (after the `if (this.workerExecutor) { ... } else { ... }` block, around line 488), add cleanup:

```typescript
    // Clear streaming callbacks
    if (this.runner.kernel) {
      const stdoutTarget = this.runner.kernel.getFdTarget(0, 1);
      if (stdoutTarget?.type === 'buffer') stdoutTarget.onChunk = undefined;
      const stderrTarget = this.runner.kernel.getFdTarget(0, 2);
      if (stderrTarget?.type === 'buffer') stderrTarget.onChunk = undefined;
    }
```

- [ ] **Step 5: Skip streaming for worker executor**

In the worker executor branch (line 459), if callbacks are provided, emit a warning. Add before the `workerResult` line:

```typescript
      if (callbacks?.onStdout || callbacks?.onStderr) {
        console.warn('[codepod] Streaming callbacks not supported with worker executor (security.hardKill). Output will be returned in result only.');
      }
```

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/orchestrator/src/shell/shell-instance.ts
git commit -m "feat(streaming): add onStdout/onStderr callbacks to Sandbox.run()"
```

---

### Task 4: TypeScript streaming tests

**Files:**
- Create: `packages/orchestrator/src/__tests__/streaming.test.ts`

- [ ] **Step 1: Create test file**

Create `packages/orchestrator/src/__tests__/streaming.test.ts`:

```typescript
/**
 * Integration tests for streaming stdout/stderr callbacks on Sandbox.run().
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');

describe('Streaming output', { sanitizeResources: false, sanitizeOps: false }, () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('onStdout fires with output chunks', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const chunks: string[] = [];
    const result = await sandbox.run('echo hello', {
      onStdout: (chunk) => chunks.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toBe('hello\n');
    expect(result.stdout.trim()).toBe('hello');
  });

  it('onStderr fires separately from onStdout', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const result = await sandbox.run('echo out && echo err >&2', {
      onStdout: (chunk) => stdoutChunks.push(chunk),
      onStderr: (chunk) => stderrChunks.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    expect(stdoutChunks.join('')).toContain('out');
    expect(stderrChunks.join('')).toContain('err');
  });

  it('streamed chunks concatenated equal result.stdout', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const chunks: string[] = [];
    const result = await sandbox.run('for i in $(seq 1 5); do echo $i; done', {
      onStdout: (chunk) => chunks.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toBe(result.stdout);
  });

  it('no callbacks does not change behavior', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('pipeline output streams from final stage', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const chunks: string[] = [];
    const result = await sandbox.run('echo hello | cat', {
      onStdout: (chunk) => chunks.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toBe(result.stdout);
  });

  it('multiple runs reset callbacks properly', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const chunks1: string[] = [];
    await sandbox.run('echo first', {
      onStdout: (chunk) => chunks1.push(chunk),
    });

    const chunks2: string[] = [];
    await sandbox.run('echo second', {
      onStdout: (chunk) => chunks2.push(chunk),
    });

    // First run's callback should not fire during second run
    expect(chunks1.join('')).toBe('first\n');
    expect(chunks2.join('')).toBe('second\n');
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/streaming.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/__tests__/streaming.test.ts
git commit -m "test(streaming): add TypeScript SDK streaming output tests"
```

---

### Task 5: SDK server streaming notifications

**Files:**
- Modify: `packages/sdk-server/src/server.ts`
- Modify: `packages/sdk-server/src/dispatcher.ts`

- [ ] **Step 1: Add `notify()` helper to server.ts**

In `packages/sdk-server/src/server.ts`, after the `respond()` function (line 33), add:

```typescript
function notify(method: string, params: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
```

Export it so the dispatcher can use it. Either export it directly or pass it to the dispatcher.

- [ ] **Step 2: Pass `notify` to the Dispatcher**

The Dispatcher needs access to `notify()` to send streaming notifications. Update the Dispatcher constructor or add a method. The simplest approach: pass `notify` as a parameter to the `dispatch` method, or store it on the Dispatcher.

In `packages/sdk-server/src/server.ts`, where the Dispatcher is created, pass `notify`:

```typescript
const dispatcher = new Dispatcher(sandbox, notify);
```

In `packages/sdk-server/src/dispatcher.ts`, update the constructor:

```typescript
export class Dispatcher {
  private sandbox: Sandbox;
  private notify: (method: string, params: Record<string, unknown>) => void;

  constructor(sandbox: Sandbox, notify: (method: string, params: Record<string, unknown>) => void) {
    this.sandbox = sandbox;
    this.notify = notify;
  }
```

(Check the existing constructor and adapt — it may already have other parameters.)

- [ ] **Step 3: Update the `run` RPC method to support streaming**

In `packages/sdk-server/src/dispatcher.ts`, update the `run` method (around line 186):

```typescript
  private async run(params: Record<string, unknown>, requestId?: number | string) {
    const command = this.requireString(params, 'command');
    if (command.length > 65536) {
      throw this.rpcError(-32602, 'Command too large');
    }
    const sb = this.resolveSandbox(params);
    const stream = params.stream === true;

    const callbacks = stream && requestId !== undefined ? {
      onStdout: (chunk: string) => {
        this.notify('output', { request_id: requestId, stream: 'stdout', data: chunk });
      },
      onStderr: (chunk: string) => {
        this.notify('output', { request_id: requestId, stream: 'stderr', data: chunk });
      },
    } : undefined;

    const result = await sb.run(command, callbacks);
    const response: Record<string, unknown> = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      executionTimeMs: result.executionTimeMs,
    };
    if (result.truncated) response.truncated = result.truncated;
    if (result.errorClass) response.errorClass = result.errorClass;
    return response;
  }
```

Note: The `requestId` parameter needs to be passed from the dispatch router. Check how `dispatch()` calls `run()` and thread the request ID through.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-server/src/server.ts packages/sdk-server/src/dispatcher.ts
git commit -m "feat(streaming): add JSON-RPC output notifications to SDK server"
```

---

### Task 6: Python SDK streaming support

**Files:**
- Modify: `packages/python-sdk/src/codepod/_rpc.py`
- Modify: `packages/python-sdk/src/codepod/commands.py`

- [ ] **Step 1: Add notification handling to `_rpc.py`**

In `packages/python-sdk/src/codepod/_rpc.py`, add a notification callback registry and update the message loop.

Add a field to `RpcClient.__init__`:

```python
        self._output_handlers: dict[int | str, dict[str, Callable]] = {}
```

Add methods to register/unregister handlers:

```python
    def register_output_handler(
        self, request_id: int, on_stdout: Callable | None, on_stderr: Callable | None
    ) -> None:
        handlers: dict[str, Callable] = {}
        if on_stdout:
            handlers["stdout"] = on_stdout
        if on_stderr:
            handlers["stderr"] = on_stderr
        if handlers:
            self._output_handlers[request_id] = handlers

    def unregister_output_handler(self, request_id: int) -> None:
        self._output_handlers.pop(request_id, None)
```

Update the `call()` message loop (line 44-62). Add a new branch before the callback check to handle output notifications:

```python
        while True:
            resp_line = self._proc.stdout.readline()
            if not resp_line:
                raise RuntimeError("Server closed connection")
            msg = json.loads(resp_line)

            # Output streaming notification (no id, method = "output")
            if "method" in msg and msg["method"] == "output" and "id" not in msg:
                params = msg.get("params", {})
                rid = params.get("request_id")
                handlers = self._output_handlers.get(rid, {})
                stream_type = params.get("stream")
                data = params.get("data", "")
                handler = handlers.get(stream_type)
                if handler:
                    handler(data)
                continue

            # Callback request from server? (id starts with 'cb_' and has a method)
            if (
                "method" in msg
                and isinstance(msg.get("id"), str)
                and msg["id"].startswith("cb_")
            ):
                self._handle_callback(msg)
                continue

            # Normal response to our request
            if "error" in msg and msg["error"]:
                raise RpcError(msg["error"]["code"], msg["error"]["message"])
            return msg.get("result")
```

- [ ] **Step 2: Update `commands.py` to accept streaming params**

In `packages/python-sdk/src/codepod/commands.py`, update the `run` method:

```python
    def run(
        self,
        command: str,
        *,
        stream: bool = False,
        on_stdout: "Callable[[str], None] | None" = None,
        on_stderr: "Callable[[str], None] | None" = None,
    ) -> CommandResult:
        params: dict = {"command": command}
        if self._sandbox_id is not None:
            params["sandboxId"] = self._sandbox_id
        if stream:
            params["stream"] = True

        # Register output handlers before the RPC call
        req_id = self._client._next_id  # peek at the next request ID
        if stream and (on_stdout or on_stderr):
            self._client.register_output_handler(req_id, on_stdout, on_stderr)

        try:
            result = self._client.call("run", params)
        finally:
            if stream:
                self._client.unregister_output_handler(req_id)

        return CommandResult(
            stdout=result["stdout"],
            stderr=result["stderr"],
            exit_code=result["exitCode"],
            execution_time_ms=result["executionTimeMs"],
            truncated=result.get("truncated"),
        )
```

Add the import at the top:

```python
from typing import Callable
```

(Check if `Callable` is already imported.)

- [ ] **Step 3: Commit**

```bash
git add packages/python-sdk/src/codepod/_rpc.py packages/python-sdk/src/codepod/commands.py
git commit -m "feat(streaming): add streaming output support to Python SDK"
```

---

### Task 7: Python streaming tests

**Files:**
- Create: `packages/python-sdk/tests/test_streaming.py`

- [ ] **Step 1: Create test file**

Create `packages/python-sdk/tests/test_streaming.py`:

```python
"""Tests for streaming output from sandbox commands."""
import pytest
from codepod import Sandbox


def test_streaming_stdout():
    """on_stdout callback fires with output chunks."""
    with Sandbox() as sb:
        chunks = []
        result = sb.commands.run(
            "echo hello",
            stream=True,
            on_stdout=lambda chunk: chunks.append(chunk),
        )
        assert result.exit_code == 0
        assert "".join(chunks) == "hello\n"
        assert result.stdout.strip() == "hello"


def test_streaming_stderr():
    """on_stderr callback fires for stderr output."""
    with Sandbox() as sb:
        stderr_chunks = []
        result = sb.commands.run(
            "echo err >&2",
            stream=True,
            on_stderr=lambda chunk: stderr_chunks.append(chunk),
        )
        assert result.exit_code == 0
        assert "err" in "".join(stderr_chunks)


def test_non_streaming_unchanged():
    """Default (no stream) behavior is unchanged."""
    with Sandbox() as sb:
        result = sb.commands.run("echo hello")
        assert result.exit_code == 0
        assert result.stdout.strip() == "hello"


def test_streaming_concatenation():
    """Streamed chunks concatenated equal result.stdout."""
    with Sandbox() as sb:
        chunks = []
        result = sb.commands.run(
            "for i in $(seq 1 3); do echo $i; done",
            stream=True,
            on_stdout=lambda chunk: chunks.append(chunk),
        )
        assert result.exit_code == 0
        assert "".join(chunks) == result.stdout
```

- [ ] **Step 2: Run the tests**

Run: `cd packages/python-sdk && pip install -e . && pytest tests/test_streaming.py -v`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/python-sdk/tests/test_streaming.py
git commit -m "test(streaming): add Python SDK streaming output tests"
```

---

### Task 8: Run full test suites

- [ ] **Step 1: Run TypeScript tests**

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/streaming.test.ts packages/orchestrator/src/__tests__/sandbox.test.ts packages/orchestrator/src/__tests__/wasi-syscalls.test.ts`
Expected: All pass. Existing tests unaffected by the optional callbacks.

- [ ] **Step 2: Run Python tests**

Run: `cd packages/python-sdk && pytest tests/ -v`
Expected: All pass (existing + new streaming tests).

- [ ] **Step 3: Commit any fixups**

```bash
git add -u
git commit -m "fix(streaming): address test failures"
```
