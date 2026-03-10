# fd-only I/O Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate dual-path output. All I/O flows through fds. RunResult carries only exit code.

**Architecture:** MockHost uses real OS pipe/dup2 so `print!()` output is captured in tests. Builtins return exit code only. Command substitution and redirections use pipe-based capture. RunResult/SpawnResult lose stdout/stderr fields.

**Tech Stack:** Rust (libc for MockHost fd ops), TypeScript (kernel drainSync for WasmHost read_fd)

**Design doc:** `docs/plans/2026-03-07-fd-only-io-design.md`

---

## Phase 1: MockHost fd infrastructure

### Task 1: Add libc pipe/dup/dup2/close to MockHost

**Files:**
- Modify: `packages/shell-exec/src/test_support.rs`
- Modify: `packages/shell-exec/Cargo.toml` (add `libc` dev-dependency)

**Step 1: Add libc dependency**

In `Cargo.toml`, add under `[dev-dependencies]`:
```toml
libc = "0.2"
```

**Step 2: Implement real fd operations in MockHost**

Replace the stub implementations:

```rust
fn pipe(&self) -> Result<(i32, i32), HostError> {
    let mut fds = [0 as libc::c_int; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(HostError::IoError("pipe failed".into()));
    }
    Ok((fds[0] as i32, fds[1] as i32))
}

fn dup(&self, fd: i32) -> Result<i32, HostError> {
    let r = unsafe { libc::dup(fd as libc::c_int) };
    if r < 0 {
        return Err(HostError::IoError(format!("dup({fd}) failed")));
    }
    Ok(r as i32)
}

fn dup2(&self, src_fd: i32, dst_fd: i32) -> Result<(), HostError> {
    if unsafe { libc::dup2(src_fd as libc::c_int, dst_fd as libc::c_int) } < 0 {
        return Err(HostError::IoError(format!("dup2({src_fd}, {dst_fd}) failed")));
    }
    Ok(())
}

fn close_fd(&self, fd: i32) -> Result<(), HostError> {
    unsafe { libc::close(fd as libc::c_int); }
    Ok(())
}
```

**Step 3: Test pipe/read round-trip**

Add a test in `test_support.rs` or a new test file:

```rust
#[test]
fn mock_host_pipe_roundtrip() {
    let host = MockHost::new();
    let (r, w) = host.pipe().unwrap();
    // Write via OS write
    let data = b"hello pipe";
    let n = unsafe { libc::write(w as libc::c_int, data.as_ptr() as *const libc::c_void, data.len()) };
    assert_eq!(n as usize, data.len());
    host.close_fd(w).unwrap();
    // Read via OS read
    let mut buf = [0u8; 64];
    let n = unsafe { libc::read(r as libc::c_int, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
    assert_eq!(&buf[..n as usize], b"hello pipe");
    host.close_fd(r).unwrap();
}
```

**Step 4: Run tests**

Run: `cargo test mock_host_pipe_roundtrip -p codepod-shell-exec`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shell-exec/Cargo.toml packages/shell-exec/src/test_support.rs
git commit -m "feat: MockHost uses real OS pipe/dup2 via libc"
```

---

### Task 2: Add read_fd to HostInterface

**Files:**
- Modify: `packages/shell-exec/src/host.rs` (trait + WasmHost)
- Modify: `packages/shell-exec/src/test_support.rs` (MockHost)
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts`
- Modify: `packages/orchestrator/src/process/kernel.ts`

**Step 1: Add read_fd to HostInterface trait**

In `host.rs`, add to the trait:
```rust
/// Read all available data from a file descriptor (drains pipe).
fn read_fd(&self, fd: i32) -> Result<Vec<u8>, HostError>;
```

**Step 2: MockHost implementation**

```rust
fn read_fd(&self, fd: i32) -> Result<Vec<u8>, HostError> {
    let mut result = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = unsafe {
            libc::read(fd as libc::c_int, buf.as_mut_ptr() as *mut libc::c_void, buf.len())
        };
        if n <= 0 { break; }
        result.extend_from_slice(&buf[..n as usize]);
    }
    Ok(result)
}
```

**Step 3: WasmHost implementation**

Add extern declaration:
```rust
fn host_read_fd(fd: i32, out_ptr: *mut u8, out_cap: u32) -> i32;
```

Implementation using `call_with_outbuf` pattern:
```rust
fn read_fd(&self, fd: i32) -> Result<Vec<u8>, HostError> {
    let result_str = call_with_outbuf("read_fd", |out_ptr, out_cap| unsafe {
        host_read_fd(fd, out_ptr, out_cap)
    })?;
    Ok(result_str.into_bytes())
}
```

**Step 4: TypeScript kernel-imports**

Add `host_read_fd` in `kernel-imports.ts`:
```typescript
host_read_fd(fd: number, outPtr: number, outCap: number): number {
    if (!opts.kernel) {
        return writeJson(memory, outPtr, outCap, { error: 'kernel not available' });
    }
    const target = opts.kernel.getFdTarget(callerPid, fd);
    if (!target || target.type !== 'pipe_read') {
        return writeJson(memory, outPtr, outCap, { error: 'not a readable fd' });
    }
    const data = target.pipe.drainSync();
    const str = new TextDecoder().decode(data);
    return writeString(memory, outPtr, outCap, str);
}
```

**Step 5: Test MockHost read_fd**

```rust
#[test]
fn mock_host_read_fd() {
    let host = MockHost::new();
    let (r, w) = host.pipe().unwrap();
    unsafe { libc::write(w as libc::c_int, b"test data".as_ptr() as *const _, 9); }
    host.close_fd(w).unwrap();
    let data = host.read_fd(r).unwrap();
    assert_eq!(data, b"test data");
    host.close_fd(r).unwrap();
}
```

**Step 6: Run tests, commit**

Run: `cargo test -p codepod-shell-exec`
Expected: all 430+ tests pass

```bash
git commit -m "feat: add read_fd to HostInterface for pipe draining"
```

---

### Task 3: Add fd-capture test helpers + thread safety mutex

**Files:**
- Modify: `packages/shell-exec/src/test_support.rs`
- Modify: `packages/shell-exec/src/builtins.rs` (test module only)

**Step 1: Add static mutex and capture helper**

In `test_support.rs`:
```rust
use std::sync::Mutex;

/// Mutex to serialize dup2 operations on fd 1 across test threads.
pub static FD_MUTEX: Mutex<()> = Mutex::new(());
```

**Step 2: Add capture helper to builtins test module**

In the `#[cfg(test)] mod tests` block of `builtins.rs`, add:

```rust
use std::io::Write;

fn run_capture(
    state: &mut ShellState,
    host: &MockHost,
    cmd: &str,
    args: &[&str],
) -> (i32, String, String) {
    run_capture_stdin(state, host, cmd, args, "")
}

fn run_capture_stdin(
    state: &mut ShellState,
    host: &MockHost,
    cmd: &str,
    args: &[&str],
    stdin: &str,
) -> (i32, String, String) {
    let _lock = crate::test_support::mock::FD_MUTEX.lock().unwrap();

    // Create stdout/stderr capture pipes
    let (out_r, out_w) = host.pipe().unwrap();
    let (err_r, err_w) = host.pipe().unwrap();

    let saved_stdout = state.stdout_fd;
    state.stdout_fd = out_w;
    // TODO: stderr_fd when we add it to state

    let a = make_args(args);
    let result = try_builtin(state, host, cmd, &a, stdin, None);

    // Flush stdout so print!() data reaches the pipe
    std::io::stdout().flush().ok();

    state.stdout_fd = saved_stdout;
    host.close_fd(out_w).unwrap();
    host.close_fd(err_w).unwrap();

    let stdout = String::from_utf8_lossy(&host.read_fd(out_r).unwrap()).to_string();
    let stderr = String::from_utf8_lossy(&host.read_fd(err_r).unwrap()).to_string();
    host.close_fd(out_r).unwrap();
    host.close_fd(err_r).unwrap();

    let exit_code = match result {
        Some(BuiltinResult::Result(r)) => r.exit_code,
        Some(BuiltinResult::Exit(c)) | Some(BuiltinResult::Return(c)) => c,
        None => 127,
    };
    (exit_code, stdout, stderr)
}
```

**Step 3: Verify with one test**

Add a new test that uses the capture helper alongside the old test:

```rust
#[test]
fn echo_basic_fd_capture() {
    let mut state = ShellState::new_default();
    let host = MockHost::new();
    let (code, stdout, _stderr) = run_capture(&mut state, &host, "echo", &["hello", "world"]);
    assert_eq!(code, 0);
    assert_eq!(stdout, "hello world\n");
}
```

**Step 4: Run tests, commit**

Run: `cargo test -p codepod-shell-exec -- echo_basic`
Expected: both `echo_basic` and `echo_basic_fd_capture` pass

```bash
git commit -m "feat: add fd-capture test helpers with thread safety mutex"
```

---

## Phase 2: Migrate builtins to fd-only output

### Task 4: Simplify BuiltinResult to carry exit code only

**Files:**
- Modify: `packages/shell-exec/src/builtins.rs` (BuiltinResult enum + all builtins)
- Modify: `packages/shell-exec/src/executor.rs` (all BuiltinResult::Result match arms)

This is the largest task. The change is mechanical but touches many lines.

**Step 1: Change BuiltinResult::Result to wrap i32**

```rust
pub enum BuiltinResult {
    /// Normal command result — just the exit code. Output flows through fds.
    Result(i32),
    /// The `exit` builtin was invoked.
    Exit(i32),
    /// The `return` builtin was invoked.
    Return(i32),
}
```

**Step 2: Update all builtins**

Every builtin currently returns `BuiltinResult::Result(RunResult::success(text))` or similar. Change to `BuiltinResult::Result(0)`. The `print!()` calls stay — they ARE the output.

Pattern replacements:
- `BuiltinResult::Result(RunResult::empty())` → `BuiltinResult::Result(0)`
- `BuiltinResult::Result(RunResult::success(...))` → `BuiltinResult::Result(0)`
- `BuiltinResult::Result(RunResult::error(code, msg))` → add `eprint!("{}", msg);` before, then `BuiltinResult::Result(code)`
- `BuiltinResult::Result(RunResult { exit_code, stdout, stderr, .. })` → add `print!("{}", stdout); eprint!("{}", stderr);` before, then `BuiltinResult::Result(exit_code)`

For builtins that don't already have `print!()` calls (e.g. those that only return via RunResult), add the `print!()` / `eprint!()` call before returning.

**Step 3: Update executor.rs match arms**

Every place in executor.rs that matches `BuiltinResult::Result(r)` and uses `r.stdout`, `r.stderr`, `r.exit_code` must change to `BuiltinResult::Result(exit_code)`. The stdout/stderr are now in the fd (kernel buffer or pipe).

Key pattern in executor.rs (appears ~8 times):
```rust
// Before:
crate::builtins::BuiltinResult::Result(r) => {
    state.last_exit_code = r.exit_code;
    (r.stdout, r.stderr, r.exit_code)
}

// After:
crate::builtins::BuiltinResult::Result(exit_code) => {
    state.last_exit_code = exit_code;
    (String::new(), String::new(), exit_code)
}
```

NOTE: The stdout/stderr strings become empty. Output already went through fds. The executor still constructs RunResult with empty strings for now — we'll remove RunResult fields in Phase 4.

**Step 4: Update builtins test helpers**

Remove `expect_result` helper. Update `run_builtin` to return `i32`:

```rust
fn run_builtin(state: &mut ShellState, host: &dyn HostInterface, cmd: &str, args: &[&str]) -> i32 {
    let a = make_args(args);
    match try_builtin(state, host, cmd, &a, "", None).expect("expected builtin") {
        BuiltinResult::Result(c) | BuiltinResult::Exit(c) | BuiltinResult::Return(c) => c,
    }
}
```

**Step 5: Migrate all builtin tests to use run_capture**

Replace every test that asserts on `r.stdout` / `r.stderr` with the `run_capture` helper. There are ~85 tests. The pattern is mechanical:

```rust
// Before:
let r = expect_result(run_builtin(&mut state, &host, "echo", &["hello"]));
assert_eq!(r.stdout, "hello\n");
assert_eq!(r.exit_code, 0);

// After:
let (code, stdout, _) = run_capture(&mut state, &host, "echo", &["hello"]);
assert_eq!(stdout, "hello\n");
assert_eq!(code, 0);
```

Tests that only check exit_code can use `run_builtin` directly:
```rust
let code = run_builtin(&mut state, &host, "cd", &["/tmp"]);
assert_eq!(code, 0);
```

**Step 6: Run tests, commit**

Run: `cargo test -p codepod-shell-exec`
Expected: all tests pass

```bash
git commit -m "feat: builtins return exit code only, output via fds"
```

---

## Phase 3: Command substitution via pipe

### Task 5: Pipe-based command substitution

**Files:**
- Modify: `packages/shell-exec/src/executor.rs` (exec_fn closure, ~line 499)

**Step 1: Change exec_fn to use pipe capture**

```rust
let exec_fn = |state: &mut ShellState, cmd_str: &str| -> String {
    // Create pipe to capture output
    let pipe = host.pipe().ok();
    let saved_stdout = state.stdout_fd;
    if let Some((_, write_fd)) = pipe {
        state.stdout_fd = write_fd;
    }

    let inner_cmd = codepod_shell::parser::parse(cmd_str);
    let result = match exec_command(state, host, &inner_cmd) {
        Ok(ControlFlow::Normal(r)) => r.exit_code,
        Ok(ControlFlow::Exit(code, _, _)) => code,
        _ => 1,
    };
    let _ = result; // exit code not used by substitution

    // Flush and capture
    state.stdout_fd = saved_stdout;
    if let Some((read_fd, write_fd)) = pipe {
        host.close_fd(write_fd).ok();
        let data = host.read_fd(read_fd).unwrap_or_default();
        host.close_fd(read_fd).ok();
        String::from_utf8_lossy(&data).to_string()
    } else {
        String::new()
    }
};
```

**Step 2: Remove the pipe-sink hack from try_builtin**

In `builtins.rs`, remove the `needs_sink` / `pipe_sink` logic that was added to prevent kernel buffer pollution during command substitution. The pipe-based exec_fn handles it now — stdout_fd points to the pipe, so try_builtin's dup2 wrapper routes fd 1 to the pipe. No sink needed.

**Step 3: Run tests, commit**

Run: `cargo test -p codepod-shell-exec`
Then build wasm, copy fixture, run conformance tests.

```bash
git commit -m "feat: command substitution captures output via pipe"
```

---

### Task 6: MockHost spawn writes to pipe

**Files:**
- Modify: `packages/shell-exec/src/test_support.rs`

For command substitution tests involving external commands (e.g. `$(cat file)`), MockHost's `spawn()` must write mock stdout to the stdout_fd pipe.

**Step 1: Update MockHost::spawn**

```rust
fn spawn(
    &self,
    program: &str,
    args: &[&str],
    _env: &[(&str, &str)],
    _cwd: &str,
    stdin_data: &str,
    _stdin_fd: i32,
    stdout_fd: i32,
    _stderr_fd: i32,
) -> Result<i32, HostError> {
    // ... existing recording logic ...

    let result = /* resolve from handler/map as before */;

    // Write mock stdout to the pipe fd (if it's a pipe)
    if !result.stdout.is_empty() {
        let data = result.stdout.as_bytes();
        unsafe {
            libc::write(stdout_fd as libc::c_int, data.as_ptr() as *const _, data.len());
        }
    }

    // Allocate PID and store for waitpid
    // ... existing PID logic ...
    Ok(pid)
}
```

**Step 2: Run tests, commit**

Run: `cargo test -p codepod-shell-exec`

```bash
git commit -m "feat: MockHost spawn writes stdout to pipe fd"
```

---

## Phase 4: Executor and type cleanup

### Task 7: Remove RunResult stdout/stderr fields

**Files:**
- Modify: `packages/shell-exec/src/control.rs`
- Modify: `packages/shell-exec/src/executor.rs` (all RunResult construction/usage)
- Modify: `packages/shell-exec/src/main.rs`
- Modify: `packages/shell-exec/src/host.rs` (SpawnResult)

**Step 1: Simplify RunResult**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub exit_code: i32,
    pub execution_time_ms: u64,
}

impl RunResult {
    pub fn empty() -> Self { Self { exit_code: 0, execution_time_ms: 0 } }
    pub fn exit(code: i32) -> Self { Self { exit_code: code, execution_time_ms: 0 } }
}
```

**Step 2: Simplify SpawnResult**

```rust
pub struct SpawnResult {
    pub exit_code: i32,
}
```

**Step 3: Simplify ControlFlow::Exit**

```rust
pub enum ControlFlow {
    Normal(RunResult),
    Break(u32),
    Continue(u32),
    Return(i32),
    Exit(i32),  // was Exit(i32, String, String)
    Cancelled(CancelReason),
}
```

**Step 4: Update executor.rs**

This is the largest mechanical change. Every place that constructs or destructures RunResult, SpawnResult, or ControlFlow::Exit must be updated:

- Remove all `stdout:` and `stderr:` fields from RunResult construction
- Remove all `r.stdout` / `r.stderr` reads
- Remove `apply_output_redirects` calls (output now flows through fds)
- Remove `stdin_data = last_result.stdout.clone()` in sequential pipeline (use streaming)
- Remove List (`&&`, `||`, `;`) stdout concatenation — just return last exit code

**Step 5: Update main.rs**

The `WasmOutput` struct drops `result.stdout` and `result.stderr` from JSON:
```rust
#[derive(serde::Serialize)]
struct WasmOutput {
    exit_code: i32,
    env: std::collections::HashMap<String, String>,
}
```

**Step 6: Update executor tests**

~183 tests need updating. Tests that check `run.stdout` need pipe-based capture similar to builtin tests. Add an executor capture helper:

```rust
fn exec_capture(state: &mut ShellState, host: &MockHost, cmd_str: &str) -> (i32, String, String) {
    let _lock = crate::test_support::mock::FD_MUTEX.lock().unwrap();
    let (out_r, out_w) = host.pipe().unwrap();
    let saved = state.stdout_fd;
    state.stdout_fd = out_w;

    let cmd = codepod_shell::parser::parse(cmd_str);
    let result = exec_command(state, host, &cmd);

    std::io::stdout().flush().ok();
    state.stdout_fd = saved;
    host.close_fd(out_w).unwrap();

    let stdout = String::from_utf8_lossy(&host.read_fd(out_r).unwrap()).to_string();
    host.close_fd(out_r).unwrap();

    let exit_code = match result {
        Ok(ControlFlow::Normal(r)) => r.exit_code,
        Ok(ControlFlow::Exit(code)) => code,
        _ => 1,
    };
    (exit_code, stdout, String::new())
}
```

**Step 7: Run tests, commit**

Run: `cargo test -p codepod-shell-exec`

```bash
git commit -m "feat: remove stdout/stderr from RunResult, SpawnResult, ControlFlow"
```

---

### Task 8: Update shell-instance.ts

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-instance.ts`

**Step 1: Parse simplified JSON**

The WASM binary now returns `{ exit_code, env }`. Update the `run()` method:

```typescript
const result = JSON.parse(resultJson);
let exitCode = result.exit_code ?? 0;
```

**Step 2: Remove JSON fallback**

Remove these lines (kernel buffer is sole truth):
```typescript
// REMOVE:
if (!stderr && result.stderr) stderr = result.stderr;
if (!stdout && result.stdout) stdout = result.stdout;
```

**Step 3: Build and test**

```bash
cargo build --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/codepod-shell-exec.wasm packages/orchestrator/src/shell/__tests__/fixtures/
npx tsup
deno test -A --no-check packages/orchestrator/src/shell/__tests__/conformance/shell.test.ts
```

**Step 4: Commit**

```bash
git commit -m "feat: shell-instance reads output from kernel buffer only"
```

---

### Task 9: Remove apply_output_redirects (future)

This task is deferred — it requires `host.open_file()` returning fd numbers, which needs kernel VFS fd target support. For now, redirections can continue using the string-based approach with an adapter that reads from the pipe. Document this as a follow-up.

---

## Verification checklist

After all tasks:
- [ ] `cargo test -p codepod-shell-exec` — all Rust tests pass
- [ ] `cargo build --target wasm32-wasip1 --release` — wasm builds
- [ ] `npx tsup` — TypeScript builds
- [ ] Pipeline streaming tests pass
- [ ] Sandbox tests pass
- [ ] Shell conformance tests — no new regressions vs baseline
- [ ] No RunResult.stdout or RunResult.stderr references remain in production code
