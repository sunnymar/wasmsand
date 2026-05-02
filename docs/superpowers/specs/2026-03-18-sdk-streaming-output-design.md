# SDK Streaming Output

Stream stdout/stderr from sandbox commands as they execute, instead of waiting for full completion. Enables real-time feedback for LLM integrations and interactive SDK consumers.

## Goal

Add streaming output to both the TypeScript and Python SDKs. The existing `run()` API continues to work unchanged — streaming is opt-in via callbacks. The full `RunResult` is still returned at the end.

## Background

Today, `sandbox.run('make build')` blocks until the command completes, then returns the entire stdout/stderr as strings. For long-running commands (builds, test suites, data processing), the caller gets no feedback until completion. This is problematic for LLM agents that need to observe progress and decide whether to cancel or wait.

The output data is already available incrementally — buffer targets accumulate `Uint8Array` chunks during execution. We just need to expose these chunks to the caller as they arrive.

## Architecture: Output Write Paths

There are **three distinct code paths** that write to buffer targets. All three must support the `onChunk` callback for streaming to work end-to-end:

1. **Shell process (pid 0) inline `fd_write`** — `shell-instance.ts` lines ~196-244. The shell binary's own WASI import table has an inline `fd_write` that writes to `ProcessKernel` fd targets. This handles all builtin command output and the shell's own stdout/stderr.

2. **Child WASM processes via `WasiHost.fdWrite()`** — `wasi-host.ts` lines ~437-507. Used when the shell spawns external commands (e.g., `cat`, `grep`). Each child process gets its own `WasiHost` instance.

3. **Direct buffer pushes in process spawning** — `shell-instance.ts` in `spawnAsyncProcess` and `spawnSyncProcess`. When child process output is collected and forwarded to the parent's buffer targets.

The common point is the **buffer target** (`FdTarget` with `type: 'buffer'`). All three paths write to buffer targets through the same `target.buf.push(data)` pattern. Adding `onChunk` to the buffer target type means all three paths automatically get streaming — no per-path changes needed beyond calling `target.onChunk?.(data)` after the push.

## Design

### TypeScript SDK

Add an optional second parameter to `Sandbox.run()`:

```typescript
interface StreamCallbacks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

// Non-streaming (unchanged)
const result = await sandbox.run('make build');

// Streaming
const result = await sandbox.run('make build', {
  onStdout: (chunk) => process.stdout.write(chunk),
  onStderr: (chunk) => process.stderr.write(chunk),
});
// result.stdout and result.stderr still contain the full output
```

`Sandbox.run()` currently takes only a command string. We add an optional second argument. The `ShellLike` interface is not changed — streaming is a `Sandbox`-level concern, not a `ShellInstance` concern.

**Implementation:** Before each `run()`, `Sandbox` sets `onChunk` on the stdout/stderr buffer targets for pid 0 (these targets are reused between runs and reset via `resetOutputBuffers()`). The `onChunk` callback wraps the raw `Uint8Array` → string decode using a `TextDecoder` with `stream: true` (handles multi-byte UTF-8 split across chunks). After `run()` completes, `onChunk` is cleared.

### Python SDK

```python
# Non-streaming (unchanged)
result = sb.commands.run("make build")

# Streaming
result = sb.commands.run("make build", stream=True,
    on_stdout=lambda chunk: print(chunk, end=""),
    on_stderr=lambda chunk: print(chunk, end="", file=sys.stderr))
```

**Wire protocol (JSON-RPC over stdio):**

1. Client sends: `{"jsonrpc": "2.0", "id": 1, "method": "run", "params": {"command": "make build", "stream": true}}`
2. Server sends notifications as output arrives:
   ```json
   {"jsonrpc": "2.0", "method": "output", "params": {"request_id": 1, "stream": "stdout", "data": "compiling foo.rs...\n"}}
   ```
3. Server sends the final response:
   ```json
   {"jsonrpc": "2.0", "id": 1, "result": {"exit_code": 0, "stdout": "...", "stderr": "...", "execution_time_ms": 1234}}
   ```

The `request_id` field in notifications correlates output with the pending request. Note: the Python `RpcClient.call()` method is currently synchronous (blocks on `readline()`). Only one request is in-flight at a time, so `request_id` is for forward-compatibility with future concurrent support.

### Buffer target `onChunk` callback

Add an optional `onChunk` to the `buffer` variant of `FdTarget`:

```typescript
type FdTarget =
  | { type: 'buffer'; buf: Uint8Array[]; total: number; limit: number; truncated: boolean; onChunk?: (data: Uint8Array) => void }
  | // ... other variants unchanged
```

Every place that pushes to a buffer target adds one line:

```typescript
// Existing:
target.buf.push(slice);
// Add after:
target.onChunk?.(slice);
```

This covers all three write paths (shell inline fd_write, WasiHost.fdWrite, and direct buffer pushes) because they all go through the same buffer target object.

### Callback mechanics

- Callbacks fire synchronously within `fd_write` processing — output order is preserved
- A slow callback blocks WASM execution (acceptable — caller controls the callback)
- Callbacks receive decoded UTF-8 strings via `TextDecoder` with `stream: true` (handles multi-byte splits)
- Chunk boundaries match `fd_write` calls — no line buffering
- For pipelines (`echo hello | grep h`), only the final stage writes to the stdout buffer; intermediate stages write to pipe targets. Callbacks fire for the final output, not intermediate stages.

### Worker executor

When `security.hardKill` is enabled, `Sandbox` uses a `WorkerExecutor` that runs in a separate Worker thread. **Streaming is not supported in worker mode.** The callbacks cannot cross the Worker boundary via function references. If `onStdout`/`onStderr` are provided and the sandbox uses worker execution, `Sandbox.run()` ignores the callbacks (the full result is still returned as usual). A console warning is emitted.

This is acceptable because:
- Worker mode is opt-in (only used with `security.hardKill`)
- The full output is still available in the result
- Adding `postMessage`-based streaming across workers can be done later if needed

## Changes

### `packages/orchestrator/src/wasi/fd-target.ts`
- Add optional `onChunk?: (data: Uint8Array) => void` to the `buffer` variant of `FdTarget`
- Update `createBufferTarget()` to accept an optional `onChunk` parameter

### `packages/orchestrator/src/wasi/wasi-host.ts`
- In `fdWrite`, after `target.buf.push(slice)`, add `target.onChunk?.(slice)`

### `packages/orchestrator/src/shell/shell-instance.ts`
- In the inline `fd_write` (pid 0 WASI stubs), after `target.buf.push(slice)`, add `target.onChunk?.(slice)`
- In `spawnAsyncProcess` / `spawnSyncProcess` where output is pushed to buffer targets, add `target.onChunk?.(data)`

### `packages/orchestrator/src/sandbox.ts`
- Add optional second parameter to `run()`: `callbacks?: StreamCallbacks`
- Before each run, if callbacks provided, set `onChunk` on the pid 0 stdout/stderr buffer targets (accessed via `ProcessKernel.getFdTarget(0, 1)` and `getFdTarget(0, 2)`)
- Use `TextDecoder` with `stream: true` to decode chunks
- After run completes, clear `onChunk` from the targets
- If worker executor is active and callbacks provided, emit console warning

### `packages/sdk-server/src/dispatcher.ts`
- Accept `stream` boolean in `run` RPC params
- When streaming, pass `onStdout`/`onStderr` to `sandbox.run()` that write JSON-RPC notifications to stdout

### `packages/sdk-server/src/server.ts`
- Add a `notify(method, params)` helper alongside the existing `respond()` function
- Ensure notification writes are serialized with response writes (single stdout stream)

### `packages/python-sdk/src/codepod/_rpc.py`
- Update the message dispatch loop to handle JSON-RPC notifications (messages with `method` but no `id`)
- Route `output` notifications to a callback registry keyed by `request_id`

### `packages/python-sdk/src/codepod/commands.py` (or equivalent)
- Add `stream`, `on_stdout`, `on_stderr` parameters to `run()`
- Register callbacks with the RPC client before sending the request
- Unregister after response received

## What this does NOT include

- **MCP server streaming** — The MCP server stays request/response. Will benefit from this work later with Streamable HTTP + progress notifications.
- **Worker executor streaming** — Documented limitation. Callbacks ignored in worker mode.
- **Line buffering** — Chunks match `fd_write` call boundaries.
- **Binary output streaming** — Callbacks receive strings. Raw byte callbacks can be added later.
- **Backpressure** — Callbacks are synchronous and blocking.

## Testing

### TypeScript SDK
- `sandbox.run('echo hello', { onStdout })` — callback fires with "hello\n", result.stdout also has "hello\n"
- Multi-chunk: `for i in $(seq 1 5); do echo $i; done` — callbacks fire in order, count matches
- stderr separate from stdout: `echo err >&2` with `onStderr` callback
- No callbacks (existing behavior) — verify nothing changes
- Pipeline: `echo hello | cat` — callback fires for final output
- Concatenation check: all streamed chunks concatenated === result.stdout
- Output truncation: verify callback fires for data up to limit, then stops

### Python SDK
- `stream=True` with `on_stdout` — notifications arrive and callback fires
- `stream=False` (default) — no notifications, same behavior as before
- Notification format: valid JSON-RPC (no `id` field, method is `output`)
- `request_id` in notification matches pending request id

### SDK server
- Notifications flushed immediately (not buffered until response)
- Multiple rapid chunks don't interleave with other messages
