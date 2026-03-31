# CPU Control for Wasmtime Sandboxes — Design Spec

## Goal

Add epoch-based CPU scheduling to wasmtime sandboxes: per-command kill timeouts, nice-based preemptive scheduling of child processes, and pause/resume of running sandbox execution. All features are wasmtime-only; the deno backend uses cooperative multitasking unchanged.

## Architecture

wasmtime's epoch interruption mechanism drives everything. A background task increments the engine epoch counter every 1ms. Each WASM Store sets an epoch deadline; when the deadline is reached during `call_async`, the future either yields to the tokio executor (preemption) or is killed (timeout). No external scheduler is needed — tokio's work-stealing executor provides the fairness.

## Components

### 1. Epoch Ticker

One tokio task per `WasmEngine`, spawned in `WasmEngine::new()`:

```rust
let engine_clone = engine.clone();
tokio::spawn(async move {
    let mut interval = tokio::time::interval(Duration::from_millis(1));
    loop {
        interval.tick().await;
        engine_clone.increment_epoch();
    }
});
```

The Engine config already has `epoch_interruption(true)` — just the ticker is missing.

### 2. Yield Quantum (Nice)

`nice` controls how often a Store yields to the tokio executor. Lower quantum = more frequent yields = lower effective priority.

| nice | quantum |
|------|---------|
| 0 (default) | 10ms (10 epochs) |
| 10 | 5ms (5 epochs) |
| 19 (lowest) | 1ms (1 epoch) |

Formula: `quantum_epochs = max(1, 10 - nice / 2)`

Each Store is configured with:
```rust
store.epoch_deadline_async_yield_and_update_deadline(quantum_epochs);
```

This causes the Store to yield and reset its own deadline, so it preempts repeatedly at the configured rate.

Child processes spawned via `host_spawn_async` inherit the parent sandbox's nice value by default. `SpawnRequest` gains an optional `nice: Option<u8>` field to override — this is how a real `nice -n 10 cmd` command would be implemented: the shell parses the invocation and passes `nice` in the spawn request.

### 3. Kill Timeout

Per-sandbox `timeout_ms` (already a `create` param, currently unused) wraps each `run_command` call:

```rust
tokio::time::timeout(
    Duration::from_millis(self.timeout_ms),
    self.shell.run_command(cmd),
).await
```

On timeout: returns an error with exit code 124 (same as the coreutils `timeout` command convention). The wasmtime Store is in an indeterminate state after a timeout-cancelled call; the sandbox is marked as poisoned and subsequent calls return an error.

### 4. Pause / Resume

`SandboxState` gains:
```rust
pub paused: Arc<AtomicBool>,
pub resume_notify: Arc<tokio::sync::Notify>,
```

The `run_command` call is wrapped in a `PausableFuture` that:
1. Polls the inner wasmtime future
2. After each epoch yield (every quantum ms), checks `paused`
3. If paused: returns `Poll::Pending` without re-registering a waker — execution stops
4. When `resume()` is called: clears `paused`, calls `resume_notify.notify_one()` — the `PausableFuture` wakes and continues polling

The WASM linear memory and Store state are fully intact during suspension. No serialization.

**Mutex constraint:** The sandbox manager mutex is held for the duration of a running command. While a sandbox is suspended, its mutex is held — other RPCs against the same sandbox are blocked. This is acceptable; suspension is expected to be brief. Future work: release the mutex across suspension boundaries.

### 5. New RPC Methods

Two new dispatcher methods on the wasmtime server:

- `sandbox.suspend` — sets `paused = true`. If no command is running, no-op.
- `sandbox.resume` — clears `paused`, notifies the waker.

### 6. Create Params

`create` RPC gains:
```json
{
  "shellWasmPath": "...",
  "timeoutMs": 30000,
  "nice": 10
}
```

`nice` range: 0–19, default 0. Values outside range are clamped.

## SDK API

```python
sb = Sandbox(
    timeout_ms=30000,   # per-command kill timeout (ms); 0 = no limit
    nice=10,            # scheduling priority 0–19 (wasmtime only)
)

sb.commands.run("slow_cmd.sh")

# Wasmtime only — raises NotImplementedError on deno engine
sb.suspend()
sb.resume()
```

`nice` and `timeout_ms` are sandbox-level, set at creation. No per-command override.

On deno engine: `nice` param is silently ignored (server doesn't implement it). `suspend()`/`resume()` raise `NotImplementedError` on the Python side before sending any RPC.

## Scope: Wasmtime Only

These features are implemented entirely in `packages/sdk-server-wasmtime`. The deno server (`packages/sdk-server`) is unchanged. Cooperative multitasking via `host_yield` remains the only scheduling mechanism for deno-backed sandboxes.

## Files Changed

| File | Change |
|------|--------|
| `packages/sdk-server-wasmtime/src/wasm/mod.rs` | Add epoch ticker to `WasmEngine::new()` |
| `packages/sdk-server-wasmtime/src/wasm/instance.rs` | Wire `nice` quantum and `timeout_ms` into `ShellInstance`; add `PausableFuture` |
| `packages/sdk-server-wasmtime/src/wasm/spawn.rs` | Add `nice` field to `SpawnRequest`; pass quantum to child store |
| `packages/sdk-server-wasmtime/src/sandbox.rs` | Add `nice`, `timeout_ms`, `paused`, `resume_notify` to `SandboxState`; wire `create` params |
| `packages/sdk-server-wasmtime/src/dispatcher.rs` | Add `sandbox.suspend` and `sandbox.resume` handlers; pass `nice`/`timeoutMs` from `create` params |
| `packages/sdk-server-wasmtime/tests/integration.rs` | Add tests: nice inheritance, timeout kill, suspend/resume |
| `packages/python-sdk/src/codepod/sandbox.py` | Add `nice`, `timeout_ms` create params; add `suspend()`/`resume()` methods |
| `packages/python-sdk/tests/test_cpu_control.py` | Python tests for new params and methods |
