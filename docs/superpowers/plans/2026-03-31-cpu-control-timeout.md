# CPU Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add epoch-based CPU scheduling to the wasmtime sandbox: per-command kill timeouts, nice-based preemptive scheduling of spawned child processes, and pre-command pause/resume — all controlled at sandbox creation time.

**Architecture:** wasmtime's epoch interruption drives scheduling. One background task increments the engine epoch counter every 1ms. Each WASM Store yields to tokio at an interval derived from its `nice` value. Kill timeouts wrap `run_command` with `tokio::time::timeout`. Pause/resume is an `AtomicBool` checked at the start of each `run()` call. No changes to the deno backend.

**Tech Stack:** Rust, wasmtime epoch interruption API, tokio, Python SDK.

**Spec:** `docs/superpowers/specs/2026-03-31-cpu-control-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/sdk-server-wasmtime/src/wasm/mod.rs` | Modify | Add epoch ticker to `WasmEngine::new()`; add `nice_to_quantum()` helper |
| `packages/sdk-server-wasmtime/src/wasm/instance.rs` | Modify | Add `nice: u8` param to `ShellInstance::new()`; configure epoch deadline |
| `packages/sdk-server-wasmtime/src/wasm/spawn.rs` | Modify | Add `nice: Option<u8>` to `SpawnRequest`; pass quantum to child `Store` in `run_child` |
| `packages/sdk-server-wasmtime/src/sandbox.rs` | Modify | Add `nice`, `timeout_ms`, `poisoned`, `paused`, `resume_notify` to `SandboxState`; wire timeout + pause in `run()` |
| `packages/sdk-server-wasmtime/src/dispatcher.rs` | Modify | Pass `nice`/`timeoutMs` from `create` params; add `sandbox.suspend`/`sandbox.resume` handlers |
| `packages/sdk-server-wasmtime/tests/integration.rs` | Modify | Add tests: timeout kill, nice doesn't break execution, suspend/resume |
| `packages/python-sdk/src/codepod/sandbox.py` | Modify | Add `nice` param; add `suspend()`/`resume()` methods |
| `packages/python-sdk/tests/test_cpu_control.py` | Create | Python tests for nice param and suspend/resume |

---

## Task 1: Epoch ticker + nice_to_quantum helper

**Files:**
- Modify: `packages/sdk-server-wasmtime/src/wasm/mod.rs`

The Engine config already has `epoch_interruption(true)`. We need the background ticker that calls `engine.increment_epoch()` every 1ms, plus a helper that converts a `nice` value (0–19) to an epoch quantum (number of epochs between yields).

- [ ] **Step 1: Add the `nice_to_quantum` helper and epoch ticker**

In `packages/sdk-server-wasmtime/src/wasm/mod.rs`, in `WasmEngine::new()`, after the engine is created but before the linker setup, add:

```rust
// Ticker: increment epoch every 1ms so epoch-based yields and limits work.
let ticker_engine = engine.clone();
tokio::spawn(async move {
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(1));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        ticker_engine.increment_epoch();
    }
});
```

Then add a free function (outside `impl WasmEngine`, at the bottom of the public section before `add_fs_imports`):

```rust
/// Convert a POSIX nice value (0–19) to an epoch quantum (epochs between yields).
///
/// nice=0  → 10 epochs (10ms, default)
/// nice=10 → 5 epochs (5ms)
/// nice=19 → 1 epoch  (1ms, lowest priority)
pub fn nice_to_quantum(nice: u8) -> u64 {
    let n = nice.min(19) as u64;
    (10 - n / 2).max(1)
}
```

- [ ] **Step 2: Run existing tests to confirm ticker doesn't break anything**

```bash
source scripts/dev-init.sh && cargo test -p sdk-server-wasmtime 2>&1 | tail -20
```

Expected: all existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk-server-wasmtime/src/wasm/mod.rs
git commit -m "feat(wasmtime): add epoch ticker and nice_to_quantum helper"
```

---

## Task 2: Wire nice into ShellInstance

**Files:**
- Modify: `packages/sdk-server-wasmtime/src/wasm/instance.rs`

`ShellInstance::new` needs a `nice: u8` parameter so it can configure the Store's epoch yield deadline.

- [ ] **Step 1: Add `nice` param to `ShellInstance::new` and set epoch deadline**

In `packages/sdk-server-wasmtime/src/wasm/instance.rs`, change the signature of `ShellInstance::new`:

```rust
pub async fn new(
    engine: &WasmEngine,
    wasm_bytes: &[u8],
    vfs: MemVfs,
    env: &[(String, String)],
    nice: u8,
) -> anyhow::Result<Self> {
```

After the existing `store.set_fuel(u64::MAX / 2)?;` line, add:

```rust
// Configure epoch-based cooperative yielding. The Store yields to the
// tokio executor every `quantum` epochs (1ms each), giving other tasks
// CPU time proportionally based on the nice value.
let quantum = crate::wasm::nice_to_quantum(nice);
store.epoch_deadline_async_yield_and_update_deadline(quantum);
```

- [ ] **Step 2: Fix the two call sites that don't pass `nice` yet**

In `packages/sdk-server-wasmtime/src/sandbox.rs`, `SandboxState::new` calls `ShellInstance::new(...)`. Add `0` (default nice) as the last argument until Task 3 wires the real value:

```rust
let shell = ShellInstance::new(&engine, &wasm_bytes, vfs, &initial_env, 0).await?;
```

In `SandboxState::fork`, same change:

```rust
let shell = ShellInstance::new(&self.engine, &self.wasm_bytes, forked_vfs, &env_vec, 0).await?;
```

- [ ] **Step 3: Run tests**

```bash
source scripts/dev-init.sh && cargo test -p sdk-server-wasmtime 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-server-wasmtime/src/wasm/instance.rs \
        packages/sdk-server-wasmtime/src/sandbox.rs
git commit -m "feat(wasmtime): wire nice quantum into ShellInstance epoch deadline"
```

---

## Task 3: Nice and timeout_ms in SandboxState

**Files:**
- Modify: `packages/sdk-server-wasmtime/src/sandbox.rs`

`SandboxState` needs to store `nice`, `timeout_ms`, `poisoned`, `paused`, and `resume_notify`. These drive timeout enforcement and pre-command pause/resume.

- [ ] **Step 1: Update `SandboxState` struct**

In `packages/sdk-server-wasmtime/src/sandbox.rs`, replace the current struct definition with:

```rust
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use tokio::sync::Notify;

pub struct SandboxState {
    pub engine: Arc<WasmEngine>,
    pub wasm_bytes: Arc<Vec<u8>>,
    pub shell: ShellInstance,
    pub env: HashMap<String, String>,
    /// Scheduling priority 0–19. 0 = default (10ms quantum), 19 = lowest (1ms).
    pub nice: u8,
    /// Per-command wall-clock kill timeout. None = no limit.
    pub timeout_ms: Option<u64>,
    /// Set to true after a command times out. Subsequent run() calls error immediately.
    pub poisoned: bool,
    /// When true, run() waits before executing the next command.
    pub paused: Arc<AtomicBool>,
    pub resume_notify: Arc<Notify>,
}
```

- [ ] **Step 2: Update `SandboxState::new` signature and body**

```rust
impl SandboxState {
    pub async fn new(
        engine: Arc<WasmEngine>,
        wasm_bytes: Arc<Vec<u8>>,
        fs_limit_bytes: Option<usize>,
        initial_env: Vec<(String, String)>,
        nice: u8,
        timeout_ms: Option<u64>,
    ) -> Result<Self> {
        let vfs = MemVfs::new(fs_limit_bytes, None);
        let shell = ShellInstance::new(&engine, &wasm_bytes, vfs, &initial_env, nice).await?;
        let env: HashMap<_, _> = initial_env.into_iter().collect();
        Ok(Self {
            engine,
            wasm_bytes,
            shell,
            env,
            nice,
            timeout_ms,
            poisoned: false,
            paused: Arc::new(AtomicBool::new(false)),
            resume_notify: Arc::new(Notify::new()),
        })
    }
```

- [ ] **Step 3: Update `SandboxState::run` to enforce timeout and pause**

Replace the current `run` body with:

```rust
pub async fn run(&mut self, cmd: &str) -> Result<Value> {
    if self.poisoned {
        anyhow::bail!("sandbox poisoned: previous command timed out");
    }
    // Wait while pre-paused (set externally before this run was called).
    while self.paused.load(Ordering::Acquire) {
        self.resume_notify.notified().await;
    }

    let run_fut = self.shell.run_command(cmd);
    let raw = match self.timeout_ms {
        Some(ms) => {
            match tokio::time::timeout(std::time::Duration::from_millis(ms), run_fut).await {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => return Err(e),
                Err(_elapsed) => {
                    self.poisoned = true;
                    return Ok(serde_json::json!({
                        "exitCode": 124,
                        "stdout": "",
                        "stderr": "timeout\n",
                        "executionTimeMs": ms,
                    }));
                }
            }
        }
        None => run_fut.await?,
    };

    if let Some(env_map) = raw.get("env").and_then(|v| v.as_object()) {
        self.env.clear();
        for (k, v) in env_map {
            if let Some(s) = v.as_str() {
                self.env.insert(k.clone(), s.to_owned());
            }
        }
    }
    let stdout = String::from_utf8_lossy(&self.shell.take_stdout()).into_owned();
    let stderr = String::from_utf8_lossy(&self.shell.take_stderr()).into_owned();
    Ok(serde_json::json!({
        "exitCode": raw["exit_code"].as_i64().unwrap_or(1),
        "stdout": stdout,
        "stderr": stderr,
        "executionTimeMs": raw["execution_time_ms"].as_u64().unwrap_or(0),
    }))
}
```

- [ ] **Step 4: Update `SandboxState::fork` to carry nice/timeout and pass nice to ShellInstance**

```rust
pub async fn fork(&self) -> Result<Self> {
    let forked_vfs = self.shell.vfs().cow_clone();
    let env_vec: Vec<_> = self.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let shell =
        ShellInstance::new(&self.engine, &self.wasm_bytes, forked_vfs, &env_vec, self.nice).await?;
    Ok(Self {
        engine: self.engine.clone(),
        wasm_bytes: self.wasm_bytes.clone(),
        shell,
        env: self.env.clone(),
        nice: self.nice,
        timeout_ms: self.timeout_ms,
        poisoned: false,
        paused: Arc::new(AtomicBool::new(false)),
        resume_notify: Arc::new(Notify::new()),
    })
}
```

- [ ] **Step 5: Update `SandboxManager::create` signature to accept nice**

```rust
pub async fn create(
    &mut self,
    wasm_bytes: Vec<u8>,
    fs_limit_bytes: Option<usize>,
    timeout_ms: Option<u64>,
    nice: u8,
    initial_env: Option<Vec<(String, String)>>,
) -> Result<()> {
    let engine = Arc::new(WasmEngine::new()?);
    let wasm = Arc::new(wasm_bytes);
    let env = initial_env.unwrap_or_default();
    self.root = Some(SandboxState::new(engine, wasm, fs_limit_bytes, env, nice, timeout_ms).await?);
    Ok(())
}
```

- [ ] **Step 6: Fix call sites in existing tests (integration.rs)**

In `packages/sdk-server-wasmtime/tests/integration.rs`, every call to `mgr.create(wasm, None, None, None)` becomes:

```rust
mgr.create(wasm, None, None, 0, None).await.unwrap();
```

Search for all occurrences and update them.

- [ ] **Step 7: Run tests**

```bash
source scripts/dev-init.sh && cargo test -p sdk-server-wasmtime 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk-server-wasmtime/src/sandbox.rs \
        packages/sdk-server-wasmtime/tests/integration.rs
git commit -m "feat(wasmtime): add nice/timeout_ms/pause to SandboxState; enforce in run()"
```

---

## Task 4: Child process nice inheritance in spawn.rs

**Files:**
- Modify: `packages/sdk-server-wasmtime/src/wasm/spawn.rs`

Spawned child WASM instances (pipeline stages, subcommands) should inherit the parent's nice value, or accept an override via the spawn request. This is how `nice -n 10 cmd` works: the shell parses the invocation, sets `nice` in the spawn request, and the child runs at lower priority.

- [ ] **Step 1: Add `nice` field to `SpawnRequest`**

In `packages/sdk-server-wasmtime/src/wasm/spawn.rs`, add to the `SpawnRequest` struct:

```rust
/// Scheduling priority for this child process. 0–19; inherits from parent if absent.
#[serde(default)]
pub nice: u8,
```

- [ ] **Step 2: Thread parent nice into `spawn_child` and `run_child`**

Change `spawn_child` signature to accept `parent_nice: u8`:

```rust
pub fn spawn_child(
    spawn_ctx: Arc<SpawnContext>,
    parent_vfs: MemVfs,
    parent_env: Vec<(String, String)>,
    stdin_data: Vec<u8>,
    stdout_pipe: Option<PipeBuf>,
    stderr_pipe: Option<PipeBuf>,
    req: &SpawnRequest,
    parent_nice: u8,
) -> (i32, oneshot::Receiver<i32>) {
```

Compute child nice before the `tokio::spawn`:

```rust
// Child inherits parent nice unless the spawn request overrides it.
let child_nice = if req.nice > 0 { req.nice } else { parent_nice };
```

Pass `child_nice` to `run_child`:

```rust
tokio::spawn(async move {
    let exit_code =
        run_child(spawn_ctx, parent_vfs, stdin_data, child_env, cmd_str, stdout_pipe, stderr_pipe, child_nice)
            .await
            .unwrap_or(1);
    let _ = tx.send(exit_code);
});
```

- [ ] **Step 3: Wire quantum into `run_child`'s Store**

Add `nice: u8` to `run_child` signature:

```rust
async fn run_child(
    ctx: Arc<SpawnContext>,
    vfs: MemVfs,
    stdin: Vec<u8>,
    env: Vec<(String, String)>,
    cmd: String,
    stdout_pipe: Option<PipeBuf>,
    stderr_pipe: Option<PipeBuf>,
    nice: u8,
) -> anyhow::Result<i32> {
```

After the existing `store.set_fuel(u64::MAX / 4)?;`, add:

```rust
let quantum = crate::wasm::nice_to_quantum(nice);
store.epoch_deadline_async_yield_and_update_deadline(quantum);
```

- [ ] **Step 4: Fix the `host_spawn_async` call site in mod.rs**

In `packages/sdk-server-wasmtime/src/wasm/mod.rs`, the `host_spawn_async` closure calls `spawn::spawn_child(...)`. Update it to pass `c.data().env`'s nice. 

The `StoreData` doesn't currently store `nice`. The simplest fix: add a `nice: u8` field to `StoreData`:

In `StoreData` struct (mod.rs), add:
```rust
/// Scheduling priority for this store's spawned children.
pub nice: u8,
```

In `StoreData::new_with_ctx`, add `nice: u8` param and set `nice` in the `Ok(Self { ... })` block.

In `StoreData::new`, pass `0` for nice (default):
```rust
pub fn new(vfs: MemVfs, stdin: &[u8], env: &[(String, String)]) -> anyhow::Result<Self> {
    Self::new_with_ctx(vfs, stdin, env, None, 0)
}
```

Update `ShellInstance::new` to pass the nice value when creating `StoreData`:
```rust
let data = StoreData::new_with_ctx(vfs, &[], env, Some(spawn_ctx), nice)
    .context("creating store data")?;
```

In the `host_spawn_async` closure, use `c.data().nice`:
```rust
let parent_nice = c.data().nice;
// ...
let (_, rx) =
    spawn::spawn_child(spawn_ctx, parent_vfs, parent_env, stdin_data, stdout_pipe, stderr_pipe, &req, parent_nice);
```

- [ ] **Step 5: Run tests**

```bash
source scripts/dev-init.sh && cargo test -p sdk-server-wasmtime 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-server-wasmtime/src/wasm/mod.rs \
        packages/sdk-server-wasmtime/src/wasm/spawn.rs
git commit -m "feat(wasmtime): child processes inherit nice value from parent sandbox"
```

---

## Task 5: Dispatcher wiring — create params + suspend/resume

**Files:**
- Modify: `packages/sdk-server-wasmtime/src/dispatcher.rs`

Wire `nice` and `timeoutMs` from `create` params into `SandboxManager::create`. Add `sandbox.suspend` and `sandbox.resume` RPC handlers.

- [ ] **Step 1: Add suspend/resume to KNOWN_METHODS**

In `packages/sdk-server-wasmtime/src/dispatcher.rs`, add to the `KNOWN_METHODS` slice:

```rust
"sandbox.suspend",
"sandbox.resume",
```

- [ ] **Step 2: Extract `nice` in `handle_create` and pass to manager**

In `handle_create`, after the line `let timeout_ms = params.get("timeoutMs").and_then(|v| v.as_u64());`, add:

```rust
let nice = params
    .get("nice")
    .and_then(|v| v.as_u64())
    .map(|n| n.min(19) as u8)
    .unwrap_or(0);
```

Update the `self.manager.create(...)` call to pass `nice`:

```rust
if let Err(e) = self
    .manager
    .create(wasm_bytes, fs_limit_bytes, timeout_ms, nice, None)
    .await
```

- [ ] **Step 3: Wire suspend/resume into dispatch_initialized**

In `dispatch_initialized`, add two new arms:

```rust
"sandbox.suspend" => self.handle_sandbox_suspend(id, &params),
"sandbox.resume" => self.handle_sandbox_resume(id, &params),
```

- [ ] **Step 4: Implement `handle_sandbox_suspend` and `handle_sandbox_resume`**

Add these methods to the `impl Dispatcher` block (near the other sandbox handlers):

```rust
fn handle_sandbox_suspend(
    &mut self,
    id: Option<RequestId>,
    params: &Value,
) -> Response {
    let sid = sandbox_id(params);
    let sb = match self.manager.resolve(sid) {
        Ok(s) => s,
        Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
    };
    sb.paused.store(true, std::sync::atomic::Ordering::Release);
    Response::ok(id, json!({ "ok": true }))
}

fn handle_sandbox_resume(
    &mut self,
    id: Option<RequestId>,
    params: &Value,
) -> Response {
    let sid = sandbox_id(params);
    let sb = match self.manager.resolve(sid) {
        Ok(s) => s,
        Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
    };
    sb.paused.store(false, std::sync::atomic::Ordering::Release);
    sb.resume_notify.notify_waiters();
    Response::ok(id, json!({ "ok": true }))
}
```

- [ ] **Step 5: Run tests**

```bash
source scripts/dev-init.sh && cargo test -p sdk-server-wasmtime 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-server-wasmtime/src/dispatcher.rs
git commit -m "feat(wasmtime): wire nice/timeoutMs in create; add sandbox.suspend/resume RPC"
```

---

## Task 6: Integration tests

**Files:**
- Modify: `packages/sdk-server-wasmtime/tests/integration.rs`

Add tests for timeout kill, nice (doesn't break execution), suspend/resume, and poisoned sandbox.

- [ ] **Step 1: Add `test_timeout_kills_command`**

In `packages/sdk-server-wasmtime/tests/integration.rs`, add:

```rust
#[tokio::test]
async fn test_timeout_kills_command() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    // 500ms timeout
    mgr.create(wasm, None, Some(500), 0, None).await.unwrap();
    let result = mgr.root_run("sleep 100").await.unwrap();
    assert_eq!(
        result["exitCode"].as_i64().unwrap(),
        124,
        "expected exit code 124 (timeout)"
    );
    assert!(result["stderr"].as_str().unwrap().contains("timeout"));
}
```

- [ ] **Step 2: Add `test_poisoned_after_timeout`**

```rust
#[tokio::test]
async fn test_poisoned_after_timeout() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, Some(300), 0, None).await.unwrap();
    // First run times out
    let r = mgr.root_run("sleep 100").await.unwrap();
    assert_eq!(r["exitCode"].as_i64().unwrap(), 124);
    // Second run should fail because sandbox is poisoned
    let err = mgr.root_run("echo hello").await;
    assert!(err.is_err(), "expected error on poisoned sandbox");
}
```

- [ ] **Step 3: Add `test_nice_doesnt_break_execution`**

```rust
#[tokio::test]
async fn test_nice_doesnt_break_execution() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    // nice=19: yields every 1ms, but should still run correctly
    mgr.create(wasm, None, None, 19, None).await.unwrap();
    let result = mgr.root_run("echo 'nice works'").await.unwrap();
    assert_eq!(result["exitCode"].as_i64().unwrap(), 0);
    assert!(result["stdout"].as_str().unwrap().contains("nice works"));
}
```

- [ ] **Step 4: Add `test_suspend_resume`**

```rust
#[tokio::test]
async fn test_suspend_resume() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, 0, None).await.unwrap();

    // Pre-pause: suspend before the next run.
    let sb = mgr.root.as_mut().unwrap();
    sb.paused.store(true, std::sync::atomic::Ordering::Release);

    // Resume after a short delay from a background task.
    let notify = sb.resume_notify.clone();
    let paused = sb.paused.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        paused.store(false, std::sync::atomic::Ordering::Release);
        notify.notify_waiters();
    });

    // run() should block until the background task resumes it.
    let result = mgr.root_run("echo 'resumed'").await.unwrap();
    assert_eq!(result["exitCode"].as_i64().unwrap(), 0);
    assert!(result["stdout"].as_str().unwrap().contains("resumed"));
}
```

- [ ] **Step 5: Add `test_timeout_rpc`**

```rust
#[tokio::test]
async fn test_timeout_rpc() {
    use tokio::sync::mpsc;
    let (tx, _rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = sdk_server_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm");

    let (r, _) = disp
        .dispatch(
            Some(sdk_server_wasmtime::rpc::RequestId::Int(1)),
            "create",
            serde_json::json!({
                "shellWasmPath": wasm_path.to_str().unwrap(),
                "timeoutMs": 500,
            }),
        )
        .await;
    assert!(r.result.is_some(), "create failed: {:?}", r.error);

    let (r2, _) = disp
        .dispatch(
            Some(sdk_server_wasmtime::rpc::RequestId::Int(2)),
            "run",
            serde_json::json!({ "command": "sleep 100" }),
        )
        .await;
    assert!(r2.result.is_some(), "run should return result not error");
    assert_eq!(
        r2.result.unwrap()["exitCode"].as_i64().unwrap(),
        124
    );
}
```

- [ ] **Step 6: Run all tests**

```bash
source scripts/dev-init.sh && cargo test -p sdk-server-wasmtime 2>&1 | tail -30
```

Expected: all tests pass. The `test_timeout_kills_command` and `test_timeout_rpc` may take ~500ms each.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-server-wasmtime/tests/integration.rs
git commit -m "test(wasmtime): add timeout, nice, suspend/resume integration tests"
```

---

## Task 7: Python SDK — nice param + suspend/resume methods

**Files:**
- Modify: `packages/python-sdk/src/codepod/sandbox.py`
- Create: `packages/python-sdk/tests/test_cpu_control.py`

Add `nice` to the create params and `suspend()`/`resume()` methods to `Sandbox`. On non-wasmtime engines, `suspend()`/`resume()` raise `NotImplementedError`.

- [ ] **Step 1: Add `nice` param and track engine in `Sandbox.__init__`**

In `packages/python-sdk/src/codepod/sandbox.py`, add `nice: int = 0` and `_engine: str = 'auto'` to `Sandbox.__init__`:

```python
def __init__(
    self,
    *,
    engine: str = 'auto',
    timeout_ms: int = 30_000,
    nice: int = 0,
    fs_limit_bytes: int = 256 * 1024 * 1024,
    mounts: list[tuple[str, MountSpec | VirtualFileSystem]] | None = None,
    python_path: list[str] | None = None,
    extensions: list[Extension] | None = None,
    storage: "dict[str, Callable] | None" = None,
    _sandbox_id: str | None = None,
    _client: RpcClient | None = None,
):
```

In the `_client is not None` early-return branch, keep as-is (forked sandboxes don't get cpu control params).

After `runtime, server_args, wasm_dir, shell_wasm = _resolve_runtime(engine)`, save the resolved engine name:

```python
self._engine = 'wasmtime' if _find_codepod_server() is not None and (engine == 'auto' or engine == 'wasmtime') else 'deno'
```

In the `create_params` block, add `nice` for wasmtime only (the deno server ignores unknown params but it's cleaner):

```python
if self._engine == 'wasmtime' and nice != 0:
    create_params["nice"] = max(0, min(19, nice))
```

- [ ] **Step 2: Add `suspend()` and `resume()` methods**

After the `mount()` method in `Sandbox`, add:

```python
def suspend(self) -> None:
    """Pause the sandbox before the next run() call (wasmtime only).

    Raises:
        NotImplementedError: When the sandbox is not using the wasmtime engine.
    """
    if self._engine != 'wasmtime':
        raise NotImplementedError(
            "suspend() is only available with the wasmtime engine. "
            "Current engine: " + self._engine
        )
    self._client.call("sandbox.suspend", self._with_id({}))

def resume(self) -> None:
    """Resume a previously suspended sandbox (wasmtime only).

    Raises:
        NotImplementedError: When the sandbox is not using the wasmtime engine.
    """
    if self._engine != 'wasmtime':
        raise NotImplementedError(
            "resume() is only available with the wasmtime engine. "
            "Current engine: " + self._engine
        )
    self._client.call("sandbox.resume", self._with_id({}))
```

- [ ] **Step 3: Write the test file**

Create `packages/python-sdk/tests/test_cpu_control.py`:

```python
"""Tests for CPU control features: nice param and suspend/resume methods."""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch

import codepod
from codepod.sandbox import Sandbox


class TestNiceParam:
    def test_nice_included_in_create_params_for_wasmtime(self):
        """nice param is sent in create RPC when using wasmtime engine."""
        captured = {}

        class FakeClient:
            def start(self): pass
            def register_storage_handlers(self, **kwargs): pass
            def call(self, method, params):
                captured[method] = params
                if method == "create":
                    return {"ok": True}
                return {}

        with patch("codepod.sandbox._resolve_runtime", return_value=("/fake/codepod-server", [], None, None)), \
             patch("codepod.sandbox._find_codepod_server", return_value="/fake/codepod-server"), \
             patch("codepod.sandbox.RpcClient", return_value=FakeClient()):
            sb = Sandbox(engine="wasmtime", nice=10)

        assert captured["create"].get("nice") == 10

    def test_nice_clamped_to_19(self):
        """nice values above 19 are clamped."""
        captured = {}

        class FakeClient:
            def start(self): pass
            def register_storage_handlers(self, **kwargs): pass
            def call(self, method, params):
                captured[method] = params
                return {"ok": True}

        with patch("codepod.sandbox._resolve_runtime", return_value=("/fake/codepod-server", [], None, None)), \
             patch("codepod.sandbox._find_codepod_server", return_value="/fake/codepod-server"), \
             patch("codepod.sandbox.RpcClient", return_value=FakeClient()):
            sb = Sandbox(engine="wasmtime", nice=99)

        assert captured["create"].get("nice") == 19

    def test_nice_zero_not_sent(self):
        """nice=0 (default) is not included in create params (saves bandwidth)."""
        captured = {}

        class FakeClient:
            def start(self): pass
            def register_storage_handlers(self, **kwargs): pass
            def call(self, method, params):
                captured[method] = params
                return {"ok": True}

        with patch("codepod.sandbox._resolve_runtime", return_value=("/fake/codepod-server", [], None, None)), \
             patch("codepod.sandbox._find_codepod_server", return_value="/fake/codepod-server"), \
             patch("codepod.sandbox.RpcClient", return_value=FakeClient()):
            sb = Sandbox(engine="wasmtime", nice=0)

        assert "nice" not in captured["create"]


class TestSuspendResume:
    def _make_wasmtime_sandbox(self):
        """Create a Sandbox with mocked wasmtime engine."""
        fake_client = MagicMock()
        fake_client.call.return_value = {"ok": True}

        with patch("codepod.sandbox._resolve_runtime", return_value=("/fake/codepod-server", [], None, None)), \
             patch("codepod.sandbox._find_codepod_server", return_value="/fake/codepod-server"), \
             patch("codepod.sandbox.RpcClient", return_value=fake_client):
            sb = Sandbox(engine="wasmtime")
        sb._client = fake_client
        return sb, fake_client

    def _make_deno_sandbox(self):
        """Create a Sandbox with mocked deno engine."""
        fake_client = MagicMock()
        fake_client.call.return_value = {"ok": True}

        with patch("codepod.sandbox._resolve_runtime", return_value=("/fake/deno", ["run", "server.ts"], "/wasm", "/wasm/shell.wasm")), \
             patch("codepod.sandbox._find_codepod_server", return_value=None), \
             patch("codepod.sandbox.RpcClient", return_value=fake_client):
            sb = Sandbox(engine="deno")
        sb._client = fake_client
        return sb, fake_client

    def test_suspend_calls_rpc_on_wasmtime(self):
        sb, client = self._make_wasmtime_sandbox()
        sb.suspend()
        client.call.assert_called_with("sandbox.suspend", {})

    def test_resume_calls_rpc_on_wasmtime(self):
        sb, client = self._make_wasmtime_sandbox()
        sb.resume()
        client.call.assert_called_with("sandbox.resume", {})

    def test_suspend_raises_on_deno(self):
        sb, _ = self._make_deno_sandbox()
        with pytest.raises(NotImplementedError, match="wasmtime"):
            sb.suspend()

    def test_resume_raises_on_deno(self):
        sb, _ = self._make_deno_sandbox()
        with pytest.raises(NotImplementedError, match="wasmtime"):
            sb.resume()
```

- [ ] **Step 4: Run Python SDK tests**

```bash
cd packages/python-sdk && pip install -e . -q && pytest tests/test_cpu_control.py -v
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/python-sdk/src/codepod/sandbox.py \
        packages/python-sdk/tests/test_cpu_control.py
git commit -m "feat(python-sdk): add nice param, suspend() and resume() methods"
```

---

## Self-Review

**Spec coverage:**
- ✅ Epoch ticker (Task 1)
- ✅ Nice yield quantum 0–19 (Task 2)
- ✅ Nice inherited by child processes (Task 4)
- ✅ timeout_ms kill (Task 3)
- ✅ Pause/resume (Task 3 + 5)
- ✅ sandbox.suspend / sandbox.resume RPC (Task 5)
- ✅ create params: nice, timeoutMs (Task 5)
- ✅ Python SDK: nice, suspend(), resume() (Task 7)
- ✅ deno engine: NotImplementedError on suspend/resume (Task 7)

**Type consistency:**
- `nice_to_quantum(nice: u8) -> u64` defined in Task 1, used in Tasks 2 and 4 ✓
- `SandboxState::new` signature defined in Task 3, `SandboxManager::create` updated in Task 3, dispatcher updated in Task 5 ✓
- `StoreData.nice` added in Task 4 (needed for host_spawn_async) ✓
- `mgr.create(wasm, None, None, 0, None)` — existing tests updated in Task 3 ✓
- `spawn_child(..., parent_nice: u8)` defined in Task 4 ✓

**Note on suspend/resume scope:** The `suspended` flag is checked only at the _start_ of each `run()` call. Mid-command suspension (pausing a command already in flight) requires the dispatcher to handle concurrent RPCs — not implemented here. This is intentional per spec: "suspension is expected to be brief." The current implementation is useful for pre-pausing before the next command.
