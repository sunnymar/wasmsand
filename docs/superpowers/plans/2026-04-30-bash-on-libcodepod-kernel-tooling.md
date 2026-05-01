# Bash on libcodepod Kernel Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the bash/libcodepod migration after Slice 0 by moving bash off codepod-specific Rust host APIs and onto POSIX/libc/libcodepod wiring.

**Architecture:** Bash must become a normal Rust/POSIX consumer. `packages/bash-rs` may keep thin target-specific entrypoints, but executor/source behavior moves from `HostInterface`/`WasmHost` to `std`, `libc`, and small POSIX helper modules. Codepod-specific imports remain in `libcodepod.a`, `codepod-host`, and kernel TypeScript import implementations.

**Tech Stack:** Rust (`bash-rs`, `guest-compat`, `codepod-host`, `host-call`), C (`libcodepod.a` shims), Deno/TypeScript kernel and tests, WASI Preview 1, JSPI/asyncify loader support.

---

## Scope

This plan covers the remaining kernel/tooling work from `docs/superpowers/specs/2026-04-29-bash-on-libcodepod-design.md`:

- Slice 1: redirection and fd helpers
- Slice 2: pipes
- Slice 3: spawn and wait
- Slice 4: filesystem
- Slice 5: sockets/signals/toolchain gaps
- Slice 6: `codepod-host` / `host-call` / extension registration
- Slice 7: cleanup and acceptance

Explicitly deferred:

- `pkg` package format, install phases, and runtime VFS package manager behavior.
- virtual `pip` package install behavior. The target is future real-ish `pip` with repository configuration.
- native Python package failures for PIL/matplotlib/package registry.

Do not add compatibility shims for old `shell-exec` names or `S_TOOL`. Internal legacy can be removed.

## File Structure

| Path | Responsibility |
| --- | --- |
| `packages/bash-rs/src/fs.rs` | Temporary filesystem adapter. Shrinks and then disappears when bash uses `std::fs` directly. |
| `packages/bash-rs/src/process.rs` | Temporary POSIX process/fd facade. Becomes the only process helper during transition, then stops accepting `HostInterface`. |
| `packages/bash-rs/src/executor.rs` | Shell execution, redirection, pipeline, and dispatch. Remove host trait plumbing here slice by slice. |
| `packages/bash-rs/src/builtins.rs` | Builtins that touch fs/process/fd state. Migrate to POSIX helpers with executor. |
| `packages/bash-rs/src/host.rs` | Current codepod-specific bridge. Delete in Slice 7. |
| `packages/bash-rs/src/main.rs` | Keep native CLI vs wasm resident entrypoints thin. No executor logic here. |
| `packages/guest-compat/src/codepod_*.c` | C ABI shims behind POSIX symbols. Extend/fix here when bash POSIX calls expose missing semantics. |
| `packages/guest-compat/include/**/*.h` | Public shim headers for cpcc/libcodepod. Keep symbol declarations honest. |
| `packages/guest-compat/toolchain/cpcc/src/*.rs` | Toolchain link/wrap/export logic for `libcodepod.a`. |
| `packages/codepod-host/src/lib.rs` | Rust wrapper around raw codepod userland imports that are not POSIX, especially extension invocation. |
| `packages/host-call/src/main.rs` | `/bin/host-call` command protocol and argv0 extension dispatch. |
| `packages/orchestrator/src/host-imports/kernel-imports.ts` | Generic kernel import implementations used by libcodepod/codepod-host. |
| `packages/orchestrator/src/host-imports/shell-imports.ts` | Bash-only imports. Must shrink to empty and then be deleted or kept as an empty compatibility object only while loader wiring requires it. |
| `packages/orchestrator/src/process/{kernel,manager,loader}.ts` | Generic process/fd/socket loader path. Must not special-case bash or extensions. |
| `packages/orchestrator/src/sandbox.ts` | Boot/install wiring for `/bin/bash`, `/bin/host-call`, and `/usr/extensions` symlinks. |
| `packages/orchestrator/src/network/{socket-backend,bridge}.ts` | Backend abstraction for POSIX socket shims. |
| `packages/orchestrator/src/__tests__/*.test.ts` | Integration coverage for shell, security, extensions, sockets, and guest compatibility. |

## Global Rules

- [x] Do not preserve old `codepod-shell-exec*` runtime names. Runtime artifact is `bash.wasm`.
- [x] Do not preserve `S_TOOL` or mode-bit extension routing.
- [x] Do not grow `packages/bash-rs/src/host.rs`; each slice should remove or bypass code from it.
- [x] Do not fix `pkg` or `pip` in this plan except to keep existing tests from blocking unrelated verification. If needed, mark those tests skipped with a comment referencing the future package-format plan.
- [x] Every slice ends with `git diff --check` and a focused test command.

## Slice 1: POSIX File Redirection

**Goal:** Move bash redirection code off host file helpers and onto POSIX file descriptors for native and wasm.

**Files:**
- Modify: `packages/bash-rs/src/executor.rs`
- Modify: `packages/bash-rs/src/process.rs`
- Modify: `packages/bash-rs/src/fs.rs`
- Modify when wasm build exposes missing POSIX file symbols: `packages/guest-compat/src/codepod_fs.c`
- Test: `packages/bash-rs/src/executor.rs`
- Test: `packages/orchestrator/src/__tests__/security.test.ts`
- Test: `packages/orchestrator/src/__tests__/extensions.test.ts`

- [x] **Step 1: Add native+wasm redirection regression tests in Rust**

Add tests to `packages/bash-rs/src/executor.rs` under the existing test module:

```rust
#[test]
fn redirection_overwrite_uses_fd_path() {
    let mut state = ShellState::new_default();
    let host = MockHost::new();
    let code = exec_capture_cmd(&mut state, &host, "echo hello > /tmp/out.txt").0;
    assert_eq!(code, 0);
    assert_eq!(host.read_file_str("/tmp/out.txt").unwrap(), "hello\n");
}

#[test]
fn redirection_append_uses_fd_path() {
    let mut state = ShellState::new_default();
    let host = MockHost::new();
    let _ = exec_capture_cmd(&mut state, &host, "echo one > /tmp/out.txt");
    let code = exec_capture_cmd(&mut state, &host, "echo two >> /tmp/out.txt").0;
    assert_eq!(code, 0);
    assert_eq!(host.read_file_str("/tmp/out.txt").unwrap(), "one\ntwo\n");
}
```

Run:

```bash
source scripts/dev-init.sh && cargo test -q -p codepod-bash redirection_ -- --test-threads=1
```

Expected: tests pass before deeper refactor; they pin behavior.

- [x] **Step 2: Introduce POSIX redirection helpers**

In `packages/bash-rs/src/process.rs`, add a small redirection API that uses `libc` on non-test targets and existing host-backed helpers only in tests:

```rust
#[derive(Debug, Clone, Copy)]
pub enum OpenRedirectMode {
    Read,
    Truncate,
    Append,
}

#[cfg(not(test))]
pub fn open_redirect(path: &str, mode: OpenRedirectMode) -> Result<i32, String> {
    use std::ffi::CString;
    let c_path = CString::new(path).map_err(|_| format!("{path}: contains NUL byte"))?;
    let flags = match mode {
        OpenRedirectMode::Read => libc::O_RDONLY,
        OpenRedirectMode::Truncate => libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
        OpenRedirectMode::Append => libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND,
    };
    let fd = unsafe { libc::open(c_path.as_ptr(), flags, 0o666) };
    if fd < 0 {
        return Err(format!("{path}: {}", std::io::Error::last_os_error()));
    }
    Ok(fd)
}

#[cfg(test)]
pub fn open_redirect(_path: &str, _mode: OpenRedirectMode) -> Result<i32, String> {
    Err("test redirection still uses MockHost file store".to_string())
}
```

Run:

```bash
source scripts/dev-init.sh && cargo check -q -p codepod-bash
```

Expected: command exits 0.

- [x] **Step 3: Move wasm support into libcodepod if `open` is missing**

Run:

```bash
source scripts/dev-init.sh && CPCC_ARCHIVE="$PWD/packages/guest-compat/build/libcodepod.a" CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS='-C link-arg=-Wl,--export=__run_command -C link-arg=-Wl,--export=__alloc -C link-arg=-Wl,--export=__dealloc' ./target/debug/cargo-codepod codepod build --release -p codepod-bash
```

If link fails with missing `open`, `openat`, `fcntl`, or related file symbols, implement the missing POSIX symbol in `packages/guest-compat/src/codepod_fs.c` and declare it in the matching header under `packages/guest-compat/include/`.

Expected after implementation: `target/wasm32-wasip1/release/codepod-bash.wasm` exists.

- [x] **Step 4: Replace executor redirect file writes**

In `packages/bash-rs/src/executor.rs`, change redirect handling so non-test builds open the destination fd and `dup2` it onto fd 1 or fd 2 before command execution. Keep the MockHost path under `#[cfg(test)]`.

Search targets:

```bash
rg -n "read_redirect_file|write_redirect_file|apply_output_redirects|StdoutOverwrite|StdoutAppend|StderrOverwrite|StderrAppend" packages/bash-rs/src/executor.rs
```

Expected after the edit:

```bash
rg -n "write_redirect_file\\(|read_redirect_file\\(" packages/bash-rs/src/executor.rs
```

shows only test-only or deleted paths.

- [x] **Step 5: Verify redirection in native and wasm**

Run:

```bash
source scripts/dev-init.sh && cargo test -q -p codepod-bash redirection_ -- --test-threads=1
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/extensions.test.ts packages/orchestrator/src/__tests__/security.test.ts
git diff --check
```

Expected: all pass.

- [x] **Step 6: Commit Slice 1**

```bash
git add packages/bash-rs/src packages/guest-compat packages/orchestrator/src/__tests__/extensions.test.ts packages/orchestrator/src/__tests__/security.test.ts
git commit -m "refactor(bash): route redirection through POSIX fds"
```

## Slice 2: POSIX Pipes and Dup

**Goal:** Move pipeline fd construction from `HostInterface` to POSIX `pipe`/`pipe2`/`dup`/`dup2`/`close`.

**Files:**
- Modify: `packages/bash-rs/src/process.rs`
- Modify: `packages/bash-rs/src/executor.rs`
- Modify when wasm build exposes missing POSIX pipe symbols: `packages/guest-compat/src/codepod_pipe.c`
- Modify when wasm build exposes missing POSIX dup symbols: `packages/guest-compat/src/codepod_dup.c`
- Test: `packages/bash-rs/src/executor.rs`
- Test: `packages/orchestrator/src/__tests__/security.test.ts`
- Test: `packages/orchestrator/src/__tests__/pipeline-streaming.test.ts`

- [x] **Step 1: Add pipeline regression tests**

Add Rust tests:

```rust
#[test]
fn external_pipeline_preserves_stdout() {
    let mut state = ShellState::new_default();
    let host = MockHost::new()
        .with_spawn_result("seq", 0, "1\n2\n3\n", "")
        .with_spawn_result("cat", 0, "1\n2\n3\n", "");
    let (code, stdout) = exec_capture_cmd(&mut state, &host, "seq 1 3 | cat");
    assert_eq!(code, 0);
    assert_eq!(stdout, "1\n2\n3\n");
}

#[test]
fn generated_pipeline_truncates_under_host_limit() {
    let mut state = ShellState::new_default();
    let host = MockHost::new();
    let (code, stdout) = exec_capture_cmd(&mut state, &host, "yes hello | head -3");
    assert_eq!(code, 0);
    assert_eq!(stdout, "hello\nhello\nhello\n");
}
```

Run:

```bash
source scripts/dev-init.sh && cargo test -q -p codepod-bash pipeline_ -- --test-threads=1
```

Expected: tests pass before refactor or fail for a known reason that the implementation will fix.

- [x] **Step 2: Make fd helpers POSIX-first**

In `packages/bash-rs/src/process.rs`, define:

```rust
#[cfg(not(test))]
pub fn pipe_pair() -> Result<(i32, i32), String> {
    let mut fds = [0 as libc::c_int; 2];
    let rc = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if rc < 0 {
        return Err(format!("pipe: {}", std::io::Error::last_os_error()));
    }
    Ok((fds[0], fds[1]))
}

#[cfg(not(test))]
pub fn dup_fd(fd: i32) -> Result<i32, String> {
    let out = unsafe { libc::dup(fd) };
    if out < 0 {
        return Err(format!("dup({fd}): {}", std::io::Error::last_os_error()));
    }
    Ok(out)
}

#[cfg(not(test))]
pub fn dup2_fd(src: i32, dst: i32) -> Result<(), String> {
    if unsafe { libc::dup2(src, dst) } < 0 {
        return Err(format!("dup2({src}, {dst}): {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(test))]
pub fn close_fd(fd: i32) -> Result<(), String> {
    if unsafe { libc::close(fd) } < 0 {
        return Err(format!("close({fd}): {}", std::io::Error::last_os_error()));
    }
    Ok(())
}
```

Keep test versions backed by `MockHost`.

- [x] **Step 3: Replace executor fd helper bodies**

In `packages/bash-rs/src/executor.rs`, change `fd_pipe`, `fd_dup`, `fd_dup2`, and `fd_close` to call the new `process.rs` functions. The function signatures may still accept `host` during transition, but non-test builds must not call `host.pipe`, `host.dup`, `host.dup2`, or `host.close_fd`.

Verify:

```bash
rg -n "host\\.(pipe|dup|dup2|close_fd)" packages/bash-rs/src/executor.rs packages/bash-rs/src/process.rs
```

Expected: only `#[cfg(test)]` code or no matches.

- [x] **Step 4: Verify with canaries and Deno**

Run:

```bash
source scripts/dev-init.sh && cargo test -q -p codepod-bash pipeline_ -- --test-threads=1
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/pipeline-streaming.test.ts packages/orchestrator/src/__tests__/security.test.ts
source scripts/dev-init.sh && ./target/debug/cargo-codepod codepod conform dup2
git diff --check
```

Expected: all pass. If `cargo-codepod conform dup2` fails because of an unrelated current canary, capture the failing symbol and fix `packages/guest-compat/src/codepod_dup.c` before moving on.

- [x] **Step 5: Commit Slice 2**

```bash
git add packages/bash-rs/src packages/guest-compat packages/orchestrator/src/__tests__
git commit -m "refactor(bash): build pipelines with POSIX pipe fds"
```

## Slice 3: POSIX Spawn and Wait

**Goal:** Move bash external command dispatch from `HostInterface::spawn`/`waitpid` to `posix_spawn[p]` and `waitpid`.

**Files:**
- Modify: `packages/bash-rs/src/process.rs`
- Modify: `packages/bash-rs/src/executor.rs`
- Modify when wasm build exposes missing POSIX spawn symbols: `packages/guest-compat/src/codepod_spawn.c`
- Modify when spawn declarations are incomplete: `packages/guest-compat/include/spawn.h`
- Modify when guest-compat requires additional host imports: `packages/orchestrator/src/host-imports/kernel-imports.ts`
- Test: `packages/orchestrator/src/__tests__/subprocess.test.ts`
- Test: `packages/orchestrator/src/__tests__/extensions.test.ts`
- Test: `packages/orchestrator/src/__tests__/security.test.ts`

- [x] **Step 1: Add spawn file-action regression tests**

Add tests in `packages/bash-rs/src/executor.rs`:

```rust
#[test]
fn spawned_command_receives_redirected_stdout_fd() {
    let mut state = ShellState::new_default();
    let host = MockHost::new().with_spawn_result("echo-tool", 0, "spawned\n", "");
    let (code, stdout) = exec_capture_cmd(&mut state, &host, "echo-tool > /tmp/out.txt");
    assert_eq!(code, 0);
    assert_eq!(stdout, "");
    assert_eq!(host.read_file_str("/tmp/out.txt").unwrap(), "spawned\n");
}

#[test]
fn spawned_pipeline_waits_for_last_exit_code() {
    let mut state = ShellState::new_default();
    let host = MockHost::new()
        .with_spawn_result("left", 7, "", "")
        .with_spawn_result("right", 0, "", "");
    let (code, _) = exec_capture_cmd(&mut state, &host, "left | right");
    assert_eq!(code, 0);
}
```

- [x] **Step 2: Make `SpawnSpec` POSIX-native**

In `packages/bash-rs/src/process.rs`, keep `SpawnSpec`, but ensure the non-test implementation only uses `libc::posix_spawnp`, `posix_spawn_file_actions_adddup2`, `posix_spawn_file_actions_addchdir_np`, and `waitpid`. It must not call `HostInterface` on wasm.

Verification:

```bash
rg -n "host\\.spawn|host\\.waitpid|host\\.waitpid_nohang|HostInterface" packages/bash-rs/src/process.rs
```

Expected: no non-test use. Test-only use is allowed until Slice 7 test cleanup.

- [x] **Step 3: Fix libcodepod spawn gaps exposed by bash**

Build bash wasm through `cargo-codepod`:

```bash
source scripts/dev-init.sh && CPCC_ARCHIVE="$PWD/packages/guest-compat/build/libcodepod.a" CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS='-C link-arg=-Wl,--export=__run_command -C link-arg=-Wl,--export=__alloc -C link-arg=-Wl,--export=__dealloc' ./target/debug/cargo-codepod codepod build --release -p codepod-bash
```

If bash fails to spawn with an error mentioning file actions, implement the missing case in `packages/guest-compat/src/codepod_spawn.c`. Required behavior:

- `posix_spawn_file_actions_adddup2(actions, src, dst)` records all requested fd remaps, not only stdio.
- `posix_spawn_file_actions_addchdir_np(actions, cwd)` is applied to the spawn request.
- `posix_spawnp` preserves argv[0], argv args, env, cwd, stdin fd, stdout fd, stderr fd.
- `waitpid(pid, &status, 0)` blocks until exit and encodes status so `WEXITSTATUS` works.

- [x] **Step 4: Verify Python subprocess and extension recursion**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/subprocess.test.ts packages/orchestrator/src/__tests__/extensions.test.ts packages/sdk-server/src/bash-dispatch.test.ts
```

Expected: subprocess calls still complete without re-entering PID 1, and extension commands still dispatch via generic spawn.

- [x] **Step 5: Commit Slice 3**

```bash
git add packages/bash-rs/src packages/guest-compat packages/orchestrator/src packages/sdk-server/src/bash-dispatch.test.ts
git commit -m "refactor(bash): spawn external commands through POSIX"
```

## Slice 4: POSIX Filesystem Calls

**Goal:** Replace bash source filesystem calls with `std::fs`/standard Unix fs APIs and shrink `shell-imports.ts`.

**Files:**
- Modify: `packages/bash-rs/src/fs.rs`
- Modify: `packages/bash-rs/src/builtins.rs`
- Modify: `packages/bash-rs/src/executor.rs`
- Modify: `packages/bash-rs/src/expand.rs`
- Modify: `packages/orchestrator/src/host-imports/shell-imports.ts`
- Modify when wasm build exposes missing POSIX filesystem symbols: `packages/guest-compat/src/codepod_fs.c`
- Test: `packages/orchestrator/src/__tests__/extensions.test.ts`
- Test: `packages/orchestrator/src/__tests__/file-conformance.test.ts`

- [x] **Step 1: Make `fs.rs` standard-library first**

In `packages/bash-rs/src/fs.rs`, non-test functions must use:

- `std::fs::metadata`
- `std::fs::read`
- `std::fs::write`
- `std::fs::read_dir`
- `std::fs::create_dir`
- `std::fs::remove_file`
- `std::fs::remove_dir_all`
- `std::fs::rename`
- `std::os::unix::fs::{PermissionsExt, symlink}`
- `std::fs::read_link`

Verification:

```bash
rg -n "host\\.(stat|read_file|write_file|readdir|mkdir|remove|chmod|rename|symlink|readlink|glob)" packages/bash-rs/src/fs.rs
```

Expected: only `#[cfg(test)]` sections reference `host`.

- [x] **Step 2: Replace direct host fs calls elsewhere**

Run:

```bash
rg -n "host\\.(stat|read_file|write_file|readdir|mkdir|remove|chmod|rename|symlink|readlink|glob)" packages/bash-rs/src
```

Change matches in `builtins.rs`, `executor.rs`, and `expand.rs` to call `crate::fs::*` or standard library helpers. Do not add new host trait methods.

Expected after edit: no non-test direct host fs calls.

- [x] **Step 3: Empty shell imports**

Once bash wasm no longer imports `host_stat`, `host_read_file`, `host_write_file`, or `host_readdir`, reduce `packages/orchestrator/src/host-imports/shell-imports.ts` to:

```ts
export interface ShellImportsOptions {
  memory: WebAssembly.Memory;
}

export function createShellImports(_opts: ShellImportsOptions): Record<string, WebAssembly.ImportValue> {
  return {};
}
```

Run:

```bash
source scripts/dev-init.sh && deno check packages/orchestrator/src/host-imports/shell-imports.ts packages/orchestrator/src/shell/shell-instance.ts
```

Expected: check passes.

- [x] **Step 4: Verify file behavior**

Run:

```bash
source scripts/dev-init.sh && cargo test -q -p codepod-bash -- --test-threads=1
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/extensions.test.ts packages/orchestrator/src/__tests__/file-conformance.test.ts
git diff --check
```

Expected: all pass. If `file-conformance` has unrelated known-open failures, document the exact failures in the commit body.

- [x] **Step 5: Commit Slice 4**

```bash
git add packages/bash-rs/src packages/orchestrator/src/host-imports/shell-imports.ts packages/guest-compat
git commit -m "refactor(bash): use standard filesystem APIs"
```

## Slice 5: Sockets, Signals, and Toolchain Gaps

**Goal:** Complete the kernel/toolchain pieces that bash and POSIX guests need, without trying to make `std::net` work yet.

**Files:**
- Modify: `packages/guest-compat/include/sys/socket.h`
- Modify: `packages/guest-compat/include/netdb.h`
- Modify: `packages/guest-compat/src/codepod_socket.c`
- Modify: `packages/guest-compat/src/codepod_netdb.c`
- Modify: `packages/guest-compat/src/codepod_signal.c`
- Modify: `packages/guest-compat/toolchain/cpcc/src/lib.rs`
- Modify: `packages/orchestrator/src/network/socket-backend.ts`
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts`
- Test: `packages/orchestrator/src/host-imports/__tests__/socket-fds.test.ts`
- Test: `packages/orchestrator/src/__tests__/network-fetch.test.ts`
- Test: `packages/orchestrator/src/__tests__/guest-compat.test.ts`

- [x] **Step 1: Define socket handle contract in TypeScript**

In `packages/orchestrator/src/network/socket-backend.ts`, keep the backend shape generic:

```ts
export type SocketHandle = number;

export interface SocketBackend {
  connect(req: { host: string; port: number; tls: boolean }): { ok: true; socket: SocketHandle } | { ok: false; error: string };
  send(socket: SocketHandle, dataB64: string): { ok: true; data?: string } | { ok: false; error: string };
  recv(socket: SocketHandle, maxBytes: number): { ok: true; data?: string } | { ok: false; error: string };
  close(socket: SocketHandle): { ok: true; data?: string } | { ok: false; error: string };
}
```

Do not expose `socket_id` outside the bridge adapter. If the existing bridge still speaks `socket_id`, translate at `createNetworkBridgeSocketBackend`.

- [x] **Step 2: Add POSIX socket import tests**

In `packages/orchestrator/src/host-imports/__tests__/socket-fds.test.ts`, add tests for fd allocation and close semantics:

```ts
Deno.test('socket fd target closes through ProcessKernel refcounting', () => {
  const kernel = new ProcessKernel();
  const closed: number[] = [];
  kernel.setFdTarget(0, 44, { type: 'socket', socket: 7, refs: 1, close: (socket) => closed.push(socket as number) });
  assertEquals(kernel.closeFd(0, 44), true);
  assertEquals(closed, [7]);
});
```

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/host-imports/__tests__/socket-fds.test.ts packages/orchestrator/src/process/__tests__/kernel.test.ts
```

Expected: tests pass.

- [x] **Step 3: Complete POSIX socket C shims**

In `packages/guest-compat/src/codepod_socket.c`, implement or verify these names:

- `socket`
- `connect`
- `bind`
- `listen`
- `accept`
- `send`
- `recv`
- `shutdown`
- `setsockopt`
- `getsockopt`
- `close` interaction with socket fds

In `packages/guest-compat/src/codepod_netdb.c`, implement or verify:

- `getaddrinfo`
- `freeaddrinfo`
- `gai_strerror`

Run:

```bash
source scripts/dev-init.sh && ./target/debug/cargo-codepod codepod conform socket
```

Expected: socket canary passes or reports one concrete missing POSIX semantic. Fix that semantic before moving on.

- [x] **Step 4: Keep std::net out of scope**

Do not patch Rust std. Add or keep a comment in the spec and any test skip:

```text
POSIX socket symbols are supported for C/Rust FFI guests. Stock std::net on wasm32-wasip1 remains out of scope until custom-std/upstream-std work.
```

- [x] **Step 5: Verify network tests**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/network-fetch.test.ts packages/orchestrator/src/network/__tests__/bridge.test.ts packages/orchestrator/src/host-imports/__tests__/socket-fds.test.ts
git diff --check
```

Expected: all pass.

- [x] **Step 6: Commit Slice 5**

```bash
git add packages/guest-compat packages/orchestrator/src/network packages/orchestrator/src/host-imports packages/orchestrator/src/__tests__
git commit -m "feat(kernel): complete POSIX socket shim path"
```

## Slice 6: codepod-host, host-call, and Extension Registration

**Goal:** Make extension dispatch a normal executable path: `/usr/extensions/<name>` symlink to `/bin/host-call`, generic spawn executes `host-call`, and only `codepod-host` owns `host_extension_invoke`.

**Files:**
- Modify: `packages/codepod-host/src/lib.rs`
- Modify: `packages/host-call/src/main.rs`
- Modify: `packages/orchestrator/src/sandbox.ts`
- Modify: `packages/orchestrator/src/process/manager.ts`
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts`
- Test: `packages/orchestrator/src/extension/__tests__/host-call.test.ts`
- Test: `packages/orchestrator/src/__tests__/extensions.test.ts`

- [x] **Step 1: Lock `codepod-host` ownership**

In `packages/codepod-host/src/lib.rs`, ensure the raw import is only here:

```rust
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "codepod")]
extern "C" {
    fn host_extension_invoke(
        req_ptr: *const u8,
        req_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;
}
```

Verify:

```bash
rg -n "host_extension_invoke" packages/bash-rs packages/host-call packages/codepod-host
```

Expected: `packages/codepod-host` declares/calls it; `packages/host-call` may reference `codepod_host::extension_invoke`; `packages/bash-rs` has no matches.

- [x] **Step 2: Verify host-call argv0 behavior**

Run:

```bash
source scripts/dev-init.sh && cargo test -q -p host-call
```

Expected: tests pass and include `/usr/extensions/<name>` -> extension name parsing.

- [x] **Step 3: Remove extension mode-bit routing**

Search:

```bash
rg -n "S_TOOL|mode-bit|extension.*mode|host command|hostCmd|registerHostCommand|getHostCommand" packages/orchestrator/src
```

Delete extension special dispatch from `ProcessManager`/kernel paths. Extension commands must resolve through:

1. PATH lookup sees `/usr/extensions/<name>`
2. symlink resolves to `/bin/host-call`
3. generic spawn loads `host-call.wasm`
4. `host-call` derives extension name from argv0
5. `codepod-host` calls `host_extension_invoke`

- [x] **Step 4: Verify extension registration**

In `packages/orchestrator/src/sandbox.ts`, extension setup must create symlinks only:

```ts
vfs.mkdirp('/usr/extensions');
vfs.symlink('/bin/host-call', `/usr/extensions/${ext.name}`);
```

It must not create protected executable stubs that encode extension metadata.

- [x] **Step 5: Run extension tests**

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/extension/__tests__/host-call.test.ts packages/orchestrator/src/__tests__/extensions.test.ts
git diff --check
```

Expected: all pass.

- [x] **Step 6: Commit Slice 6**

```bash
git add packages/codepod-host packages/host-call packages/orchestrator/src
git commit -m "refactor(extensions): dispatch through host-call executable"
```

## Slice 7: Cleanup and Acceptance

**Goal:** Delete bash-owned codepod APIs and prove bash source purity.

**Files:**
- Delete: `packages/bash-rs/src/host.rs`
- Modify: `packages/bash-rs/src/lib.rs`
- Modify: `packages/bash-rs/src/main.rs`
- Modify: `packages/bash-rs/src/{executor,builtins,fs,process,virtual_commands}.rs`
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts`
- Modify: `packages/orchestrator/src/host-imports/shell-imports.ts`
- Modify: `docs/superpowers/specs/2026-04-29-bash-on-libcodepod-design.md`

- [x] **Step 1: Delete `HostInterface` usage from bash source**

Run:

```bash
rg -n "HostInterface|WasmHost|crate::host|mod host|host::" packages/bash-rs/src
```

Expected before cleanup: matches exist.

Delete `packages/bash-rs/src/host.rs`. Update `packages/bash-rs/src/lib.rs` to remove `pub mod host;`. Update function signatures to remove `host: &dyn HostInterface` where tests no longer need it.

- [x] **Step 2: Add source purity check**

Add a script or package test command in docs and CI:

```bash
rg -n "host_[a-zA-Z0-9_]+|HostInterface|WasmHost|codepod::|codepod_host" packages/bash-rs/src
```

Expected: no matches in bash source.

If a false positive appears in a comment, rewrite the comment.

- [x] **Step 3: Check final wasm import provenance**

Build bash wasm:

```bash
source scripts/dev-init.sh && CPCC_ARCHIVE="$PWD/packages/guest-compat/build/libcodepod.a" CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS='-C link-arg=-Wl,--export=__run_command -C link-arg=-Wl,--export=__alloc -C link-arg=-Wl,--export=__dealloc' ./target/debug/cargo-codepod codepod build --release -p codepod-bash
```

Then inspect imports:

```bash
wasm-tools print target/wasm32-wasip1/release/codepod-bash.wasm | rg 'import "codepod"'
```

Expected: any `host_*` imports are contributed by linked platform support (`libcodepod.a`/runtime support), not by `packages/bash-rs/src`.

- [x] **Step 4: Remove obsolete shell imports**

If bash no longer imports `bash_read_command`, `bash_write_result`, or shell-specific host fs names, delete `packages/orchestrator/src/host-imports/shell-imports.ts` and remove loader references. If the loader still requires an import object, keep this exact empty implementation:

```ts
export function createShellImports(): Record<string, WebAssembly.ImportValue> {
  return {};
}
```

Verify:

```bash
source scripts/dev-init.sh && deno check packages/orchestrator/src/shell/shell-instance.ts packages/orchestrator/src/host-imports/kernel-imports.ts
```

- [x] **Step 5: Run acceptance suite**

Run:

```bash
source scripts/dev-init.sh && cargo test -q -p codepod-bash -p codepod-host -p host-call -- --test-threads=1
source scripts/dev-init.sh && cargo check -q -p codepod-bash -p codepod-host -p host-call
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/security.test.ts packages/orchestrator/src/__tests__/extensions.test.ts packages/orchestrator/src/__tests__/subprocess.test.ts packages/orchestrator/src/extension/__tests__/host-call.test.ts packages/sdk-server/src/bash-dispatch.test.ts
source scripts/dev-init.sh && deno check packages/orchestrator/src/sandbox.ts packages/orchestrator/src/process/manager.ts packages/orchestrator/src/host-imports/kernel-imports.ts
git diff --check
```

Expected: all pass. Package/pip integration tests are not part of this acceptance suite until the package-format plan exists.

- [x] **Step 6: Update spec status**

In `docs/superpowers/specs/2026-04-29-bash-on-libcodepod-design.md`, update `## Status` from draft to implemented for the completed slices, and add:

```markdown
Deferred follow-up: package format and runtime `pkg`/real-ish `pip` integration are tracked separately. This bash/libcodepod migration intentionally stops at kernel/tooling/source-purity acceptance.
```

- [x] **Step 7: Commit Slice 7**

```bash
git add packages/bash-rs packages/orchestrator docs/superpowers/specs/2026-04-29-bash-on-libcodepod-design.md
git commit -m "refactor(bash): remove codepod host bridge from bash source"
```

## Final Review Checklist

- [x] `packages/bash-rs/src/host.rs` does not exist.
- [x] `rg -n "HostInterface|WasmHost|host_[a-zA-Z0-9_]+" packages/bash-rs/src` returns no matches.
- [x] `/bin/bash` is installed from `bash.wasm`.
- [x] `/bin/host-call` is installed from `host-call.wasm`.
- [x] `/usr/extensions/<name>` entries are symlinks to `/bin/host-call`.
- [x] `S_TOOL` and mode-bit extension routing are absent.
- [x] `libcodepod.a` is the archive name used by scripts/tooling.
- [x] `pkg`/`pip` failures are documented as deferred and not hidden as passing.
- [x] Native Rust bash build works.
- [x] Wasm bash fixture builds and passes focused kernel tests.
