# fd-only I/O for shell builtins

## Problem

Shell builtins currently have dual-path output: they call `print!()` which writes to fd 1 (kernel buffer on wasm32), AND return a `RunResult { exit_code, stdout: String, stderr: String }`. Consumers pick whichever path suits them — shell-instance reads kernel buffer, command substitution reads `RunResult.stdout`, tests assert on `RunResult.stdout`.

This is wrong. Output should flow through fds only. `RunResult` should carry just the exit code — the same thing `waitpid()` returns for spawned processes.

## Principle

Production code uses standard library functions (`print!()`, `eprint!()`). The test infrastructure adapts to capture fd output. Tests never compromise production code.

## Design

### MockHost uses real OS fd operations

MockHost's `pipe()`, `dup()`, `dup2()`, `close_fd()` become thin wrappers around libc. This means `try_builtin`'s existing dup2 wrapper — which redirects fd 1 to `state.stdout_fd` before running builtins — works identically on native and wasm32.

When `state.stdout_fd` is a pipe write fd:
1. `dup2(pipe_write, 1)` redirects OS fd 1 to the pipe
2. `print!()` → `write(1, ...)` → pipe buffer
3. Restore fd 1, close write end, read pipe → captured output

Thread safety: OS fd 1 is process-wide. A static Mutex serializes dup2 operations in tests. Tests take 0.02s total — no performance concern.

### read_fd for pipe draining

Add to HostInterface:

```rust
fn read_fd(&self, fd: i32) -> Result<Vec<u8>, HostError>;
```

- **WasmHost**: `host_read_fd` import → TypeScript calls `drainSync()` on the pipe
- **MockHost**: `libc::read()` in a loop until EOF

### Builtins return just exit code

```rust
enum BuiltinResult {
    Result(i32),   // exit code
    Exit(i32),     // exit builtin
    Return(i32),   // return builtin
}
```

Builtins call `print!()` / `eprint!()` for output and return exit code only. No more `RunResult::success(text)`.

### Command substitution via pipe

`exec_fn` in executor.rs replaces `r.stdout` with pipe-based capture:

1. `pipe()` → `(read_fd, write_fd)`
2. `state.stdout_fd = write_fd`
3. `exec_command(state, host, &inner_cmd)` — builtins print → fd 1 → pipe
4. `close_fd(write_fd)` — EOF
5. `host.read_fd(read_fd)` → captured output
6. `close_fd(read_fd)`, restore `state.stdout_fd`

For external commands inside `$(...)`: spawn gets `stdout_fd = pipe_write`. Child writes to pipe. `waitpid()` returns exit code only. Parent reads pipe.

MockHost's `spawn()` writes mock stdout data to the pipe write fd, so the same capture path works in tests.

### Redirections via dup2

Replace `apply_output_redirects` with fd-level setup before the command runs.

For `cmd > file`:
1. Open file → get file_fd
2. Set `state.stdout_fd = file_fd`
3. Run command — output goes to file via fd
4. Close file_fd, restore

Needs `host.open_file(path, mode) -> Result<i32, HostError>`:
- **WasmHost**: kernel creates VFS-backed fd target, returns fd number
- **MockHost**: creates a temp OS file or memory-backed fd

### Cleanup

- `RunResult` → `{ exit_code, execution_time_ms }` (drop stdout/stderr)
- `ControlFlow::Exit(i32, String, String)` → `ControlFlow::Exit(i32)`
- `SpawnResult` → `{ exit_code }` (drop stdout/stderr)
- `main.rs __run_command` returns `{ exit_code, env }` in JSON
- `shell-instance.ts` removes JSON fallback — kernel buffer is sole truth
- List operators (`&&`, `||`, `;`) stop concatenating stdout strings — both sides write to same fd

### Test helpers

```rust
fn run_builtin_capture(
    state: &mut ShellState,
    host: &MockHost,
    cmd: &str,
    args: &[&str],
) -> (i32, String) {
    let (read_fd, write_fd) = host.pipe().unwrap();
    let saved = state.stdout_fd;
    state.stdout_fd = write_fd;

    let result = try_builtin(state, host, cmd, &make_args(args), "", None);

    state.stdout_fd = saved;
    host.close_fd(write_fd).unwrap();

    let output = host.read_fd(read_fd).unwrap();
    host.close_fd(read_fd).unwrap();

    let code = match result {
        Some(BuiltinResult::Result(c)) => c,
        Some(BuiltinResult::Exit(c)) => c,
        Some(BuiltinResult::Return(c)) => c,
        None => 127,
    };
    (code, String::from_utf8_lossy(&output).to_string())
}
```

## What does NOT change

- Builtins still use `print!()` / `eprint!()` — standard library, no abstraction
- `try_builtin`'s dup2 wrapper stays — it maps fd 1 to `state.stdout_fd`
- Streaming pipeline architecture unchanged — already fd-based
- Kernel fd table, AsyncPipe, FdTarget types unchanged
