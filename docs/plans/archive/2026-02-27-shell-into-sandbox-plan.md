# Shell-Into-Sandbox Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the TypeScript shell executor into the WASM sandbox as Rust, with a unified host import ABI that eliminates magic file descriptors.

**Architecture:** A new Rust crate (`shell-exec`) implements the full shell executor (parsing, expansion, builtins, control flow) compiled to `wasm32-wasip1`. It communicates with the TypeScript host via typed `codepod.*` WASM imports for filesystem, process spawning, and session control. A second new crate (`codepod-host`) provides the same ABI to Python. The TypeScript host remains the authority for VFS, process management, and security enforcement.

**Tech Stack:** Rust (wasm32-wasip1), TypeScript (Bun test runner, tsup bundler), serde_json for ABI serialization, RustPython `#[pymodule]` for Python native module.

**Design doc:** `docs/plans/2026-02-27-shell-into-sandbox-design.md`

---

## Phase 1: Foundation — Crate Scaffold, Host ABI, and Minimal Round-Trip

The goal of Phase 1 is to get a Rust shell WASM binary that can receive a command
from the TypeScript host, parse it, call `host_spawn` for a simple command, and
return the result. No builtins, no expansion, no control flow yet — just the
plumbing.

### Task 1: Create shell-exec crate scaffold

**Files:**
- Create: `packages/shell-exec/Cargo.toml`
- Create: `packages/shell-exec/src/lib.rs`
- Create: `packages/shell-exec/src/main.rs`
- Create: `packages/shell-exec/src/host.rs`
- Create: `packages/shell-exec/src/state.rs`
- Create: `packages/shell-exec/src/control.rs`
- Modify: `Cargo.toml:2-12` (add workspace member)

**Step 1: Create Cargo.toml**

```toml
# packages/shell-exec/Cargo.toml
[package]
name = "codepod-shell-exec"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "codepod-shell-exec"
path = "src/main.rs"

[lib]
name = "codepod_shell_exec"
path = "src/lib.rs"

[dependencies]
codepod-shell = { path = "../shell" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

**Step 2: Create src/control.rs — ControlFlow enum and error types**

```rust
// packages/shell-exec/src/control.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub execution_time_ms: u64,
}

impl RunResult {
    pub fn empty() -> Self {
        Self { exit_code: 0, stdout: String::new(), stderr: String::new(), execution_time_ms: 0 }
    }

    pub fn success(stdout: String) -> Self {
        Self { exit_code: 0, stdout, stderr: String::new(), execution_time_ms: 0 }
    }

    pub fn error(code: i32, stderr: String) -> Self {
        Self { exit_code: code, stdout: String::new(), stderr, execution_time_ms: 0 }
    }
}

#[derive(Debug)]
pub enum ControlFlow {
    Normal(RunResult),
    Break(u32),
    Continue(u32),
    Return(i32),
    Exit(i32, String, String),
    Cancelled(CancelReason),
}

#[derive(Debug, Clone, Copy)]
pub enum CancelReason {
    Timeout,
    Cancelled,
}

#[derive(Debug)]
pub enum ShellError {
    ParseError(String),
    HostError(String),
    SubstitutionTooDeep,
    FunctionTooDeep,
}

impl std::fmt::Display for ShellError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ParseError(msg) => write!(f, "parse error: {msg}"),
            Self::HostError(msg) => write!(f, "host error: {msg}"),
            Self::SubstitutionTooDeep => write!(f, "maximum command substitution depth exceeded"),
            Self::FunctionTooDeep => write!(f, "maximum function call depth exceeded"),
        }
    }
}
```

**Step 3: Create src/state.rs — ShellState struct**

```rust
// packages/shell-exec/src/state.rs
use std::collections::{HashMap, HashSet};
use codepod_shell::ast::Command;

pub const MAX_SUBSTITUTION_DEPTH: u32 = 50;
pub const MAX_FUNCTION_DEPTH: u32 = 100;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ShellFlag {
    Errexit,   // set -e
    Nounset,   // set -u
    Pipefail,  // set -o pipefail
}

pub struct ShellState {
    pub env: HashMap<String, String>,
    pub arrays: HashMap<String, Vec<String>>,
    pub assoc_arrays: HashMap<String, HashMap<String, String>>,
    pub functions: HashMap<String, Command>,
    pub flags: HashSet<ShellFlag>,
    pub positional_args: Vec<String>,
    pub last_exit_code: i32,
    pub function_depth: u32,
    pub substitution_depth: u32,
    pub traps: HashMap<String, String>,
    pub local_var_stack: Vec<HashMap<String, Option<String>>>,
    pub history: Vec<String>,
    pub cwd: String,
}

impl ShellState {
    pub fn new_default() -> Self {
        let mut env = HashMap::new();
        env.insert("HOME".into(), "/home/user".into());
        env.insert("PWD".into(), "/home/user".into());
        env.insert("USER".into(), "user".into());
        env.insert("PATH".into(), "/bin:/usr/bin".into());
        env.insert("PYTHONPATH".into(), "/usr/lib/python".into());
        env.insert("SHELL".into(), "/bin/sh".into());
        Self {
            env,
            arrays: HashMap::new(),
            assoc_arrays: HashMap::new(),
            functions: HashMap::new(),
            flags: HashSet::new(),
            positional_args: Vec::new(),
            last_exit_code: 0,
            function_depth: 0,
            substitution_depth: 0,
            traps: HashMap::new(),
            local_var_stack: Vec::new(),
            history: Vec::new(),
            cwd: "/home/user".into(),
        }
    }

    /// Resolve a relative path against cwd. Absolute paths pass through.
    pub fn resolve_path(&self, path: &str) -> String {
        if path.starts_with('/') {
            return path.to_string();
        }
        if self.cwd == "/" {
            format!("/{path}")
        } else {
            format!("{}/{path}", self.cwd)
        }
    }
}
```

**Step 4: Create src/host.rs — extern declarations and safe wrappers**

```rust
// packages/shell-exec/src/host.rs
//! Host import declarations and safe Rust wrappers.
//!
//! In production (wasm32-wasip1), these call real host-provided imports.
//! In tests, the HostInterface trait provides a mockable boundary.

use crate::control::RunResult;
use serde::{Deserialize, Serialize};

// ── Types exchanged with the host ──

#[derive(Debug, Serialize, Deserialize)]
pub struct SpawnRequest {
    pub cmd: String,
    pub args: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
    pub cwd: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SpawnResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub execution_time_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StatInfo {
    #[serde(rename = "type")]
    pub file_type: String, // "file", "dir", "symlink"
    pub size: u64,
    pub mode: u32,
}

#[derive(Debug)]
pub enum HostError {
    NotFound(String),
    PermissionDenied(String),
    IoError(String),
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(p) => write!(f, "{p}: no such file or directory"),
            Self::PermissionDenied(p) => write!(f, "{p}: permission denied"),
            Self::IoError(msg) => write!(f, "{msg}"),
        }
    }
}

// ── Trait for mockable host interface ──

pub trait HostInterface {
    fn spawn(&self, cmd: &str, args: &[String], env: &std::collections::HashMap<String, String>,
             stdin: &[u8], cwd: &str) -> SpawnResult;
    fn has_tool(&self, name: &str) -> bool;
    fn check_cancel(&self) -> CancelStatus;
    fn time_ms(&self) -> u64;
    fn stat(&self, path: &str) -> Result<StatInfo, HostError>;
    fn read_file(&self, path: &str) -> Result<Vec<u8>, HostError>;
    fn write_file(&self, path: &str, data: &[u8], mode: WriteMode) -> Result<(), HostError>;
    fn readdir(&self, path: &str) -> Result<Vec<String>, HostError>;
    fn mkdir(&self, path: &str) -> Result<(), HostError>;
    fn remove(&self, path: &str, recursive: bool) -> Result<(), HostError>;
    fn chmod(&self, path: &str, mode: u32) -> Result<(), HostError>;
    fn glob(&self, pattern: &str, cwd: &str) -> Result<Vec<String>, HostError>;
    fn rename(&self, from: &str, to: &str) -> Result<(), HostError>;
    fn symlink(&self, target: &str, link: &str) -> Result<(), HostError>;
    fn readlink(&self, path: &str) -> Result<String, HostError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelStatus { Ok, Timeout, Cancelled }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode { Overwrite, Append, CreateOnly }

// ── WASM host import bridge (production) ──

#[cfg(target_arch = "wasm32")]
mod wasm_imports {
    #[link(wasm_import_module = "codepod")]
    extern "C" {
        pub fn host_spawn(
            cmd_ptr: *const u8, cmd_len: u32,
            args_ptr: *const u8, args_len: u32,
            env_ptr: *const u8, env_len: u32,
            stdin_ptr: *const u8, stdin_len: u32,
            cwd_ptr: *const u8, cwd_len: u32,
            out_ptr: *mut u8, out_cap: u32,
        ) -> i32;
        pub fn host_has_tool(name_ptr: *const u8, name_len: u32) -> i32;
        pub fn host_check_cancel() -> i32;
        pub fn host_time_ms() -> i64;
        pub fn host_stat(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
        pub fn host_read_file(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
        pub fn host_write_file(
            path_ptr: *const u8, path_len: u32,
            data_ptr: *const u8, data_len: u32,
            mode: i32,
        ) -> i32;
        pub fn host_readdir(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
        pub fn host_mkdir(path_ptr: *const u8, path_len: u32) -> i32;
        pub fn host_remove(path_ptr: *const u8, path_len: u32, recursive: i32) -> i32;
        pub fn host_chmod(path_ptr: *const u8, path_len: u32, mode: i32) -> i32;
        pub fn host_glob(
            pattern_ptr: *const u8, pattern_len: u32,
            cwd_ptr: *const u8, cwd_len: u32,
            out_ptr: *mut u8, out_cap: u32,
        ) -> i32;
        pub fn host_rename(from_ptr: *const u8, from_len: u32, to_ptr: *const u8, to_len: u32) -> i32;
        pub fn host_symlink(target_ptr: *const u8, target_len: u32, link_ptr: *const u8, link_len: u32) -> i32;
        pub fn host_readlink(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
        pub fn host_read_command(out_ptr: *mut u8, out_cap: u32) -> i32;
        pub fn host_write_result(result_ptr: *const u8, result_len: u32);
    }
}

/// Helper: call a host import that writes into an output buffer.
/// Handles the retry-on-too-small protocol.
#[cfg(target_arch = "wasm32")]
fn call_with_outbuf(f: impl Fn(*mut u8, u32) -> i32) -> Vec<u8> {
    let mut buf = vec![0u8; 4096];
    loop {
        let needed = f(buf.as_mut_ptr(), buf.len() as u32);
        if needed < 0 {
            return Vec::new(); // error
        }
        let needed = needed as usize;
        if needed <= buf.len() {
            buf.truncate(needed);
            return buf;
        }
        buf.resize(needed, 0);
    }
}

/// Production host interface that calls real WASM imports.
#[cfg(target_arch = "wasm32")]
pub struct WasmHost;

// WasmHost impl of HostInterface omitted here for brevity —
// each method serializes args, calls the raw extern, deserializes response.
// Pattern is the same for every method: encode args → call_with_outbuf → decode.
```

**Step 5: Create src/lib.rs — public API**

```rust
// packages/shell-exec/src/lib.rs
pub mod control;
pub mod host;
pub mod state;
```

**Step 6: Create src/main.rs — entry point stub**

```rust
// packages/shell-exec/src/main.rs
fn main() {
    // Placeholder — will be filled in Task 3
    // For now, just ensure the crate compiles.
}
```

**Step 7: Add to workspace**

In `Cargo.toml` (root), add `"packages/shell-exec"` to the workspace members list
after `"packages/shell"`.

**Step 8: Verify it compiles**

Run: `cargo build -p codepod-shell-exec --target wasm32-wasip1 --release`
Expected: Compiles successfully. Binary at `target/wasm32-wasip1/release/codepod-shell-exec.wasm`.

**Step 9: Run Rust tests**

Run: `cargo test -p codepod-shell-exec`
Expected: 0 tests run, but compilation succeeds on the host target too.

**Step 10: Commit**

```bash
git add packages/shell-exec/ Cargo.toml
git commit -m "feat: scaffold shell-exec crate with state, control flow, and host ABI types"
```

---

### Task 2: Implement WasmHost (production host interface bridge)

**Files:**
- Modify: `packages/shell-exec/src/host.rs` (add full WasmHost impl)

This task fills in the `WasmHost` struct that bridges the `HostInterface` trait
to the real `extern "C"` WASM imports. Each method follows the same pattern:
serialize args → call raw import → deserialize response.

**Step 1: Implement WasmHost**

Add the full `impl HostInterface for WasmHost` block at the bottom of `host.rs`,
gated behind `#[cfg(target_arch = "wasm32")]`. Implement every method in the trait.

Key patterns for each method:
- String args: pass `(s.as_ptr(), s.len() as u32)` directly.
- JSON-encoded args (like args/env for spawn): `serde_json::to_string(&args)`, then pass as string.
- Stdin bytes: pass `(data.as_ptr(), data.len() as u32)`.
- Output buffer: use `call_with_outbuf()`, then `serde_json::from_slice()`.
- Error returns: negative return value → `HostError`. Convention: -1 = NotFound, -2 = PermissionDenied, -3 = IoError.

**Step 2: Implement session functions (read_command, write_result)**

These are standalone functions (not on the trait) since they're session-level:

```rust
#[cfg(target_arch = "wasm32")]
pub fn read_command() -> String {
    let buf = call_with_outbuf(|ptr, cap| unsafe { wasm_imports::host_read_command(ptr, cap) });
    String::from_utf8_lossy(&buf).into_owned()
}

#[cfg(target_arch = "wasm32")]
pub fn write_result(result: &crate::control::RunResult) {
    let json = serde_json::to_vec(result).unwrap();
    unsafe { wasm_imports::host_write_result(json.as_ptr(), json.len() as u32) };
}
```

**Step 3: Add `__alloc` / `__dealloc` exports**

Add to `main.rs`:

```rust
#[no_mangle]
pub extern "C" fn __alloc(size: u32) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(size as usize, 1).unwrap();
    unsafe { std::alloc::alloc(layout) }
}

#[no_mangle]
pub extern "C" fn __dealloc(ptr: *mut u8, size: u32) {
    let layout = std::alloc::Layout::from_size_align(size as usize, 1).unwrap();
    unsafe { std::alloc::dealloc(ptr, layout) }
}
```

**Step 4: Verify WASM compilation**

Run: `cargo build -p codepod-shell-exec --target wasm32-wasip1 --release`
Expected: Compiles. The binary will have unresolved `codepod.*` imports (expected —
they'll be provided by the TS host at instantiation time).

**Step 5: Commit**

```bash
git add packages/shell-exec/
git commit -m "feat: implement WasmHost bridge for codepod.* imports"
```

---

### Task 3: Implement MockHost and first executor test

**Files:**
- Create: `packages/shell-exec/src/test_support.rs`
- Create: `packages/shell-exec/src/executor.rs`
- Modify: `packages/shell-exec/src/lib.rs` (add modules)

**Step 1: Create test_support.rs with MockHost**

```rust
// packages/shell-exec/src/test_support.rs
#[cfg(test)]
pub mod mock {
    use crate::host::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// A mock host backed by in-memory filesystem and tool registry.
    pub struct MockHost {
        pub files: Mutex<HashMap<String, Vec<u8>>>,
        pub dirs: Mutex<std::collections::HashSet<String>>,
        pub tools: std::collections::HashSet<String>,
        /// Pre-configured spawn results keyed by command name.
        pub spawn_results: Mutex<HashMap<String, SpawnResult>>,
    }

    impl MockHost {
        pub fn new() -> Self {
            let mut dirs = std::collections::HashSet::new();
            dirs.insert("/".into());
            dirs.insert("/home".into());
            dirs.insert("/home/user".into());
            dirs.insert("/tmp".into());
            Self {
                files: Mutex::new(HashMap::new()),
                dirs: Mutex::new(dirs),
                tools: std::collections::HashSet::new(),
                spawn_results: Mutex::new(HashMap::new()),
            }
        }

        pub fn with_tool(mut self, name: &str) -> Self {
            self.tools.insert(name.into());
            self
        }

        pub fn with_spawn_result(self, cmd: &str, result: SpawnResult) -> Self {
            self.spawn_results.lock().unwrap().insert(cmd.into(), result);
            self
        }

        pub fn with_file(self, path: &str, content: &[u8]) -> Self {
            self.files.lock().unwrap().insert(path.into(), content.to_vec());
            self
        }
    }

    impl HostInterface for MockHost {
        fn spawn(&self, cmd: &str, _args: &[String], _env: &HashMap<String, String>,
                 _stdin: &[u8], _cwd: &str) -> SpawnResult {
            self.spawn_results.lock().unwrap()
                .get(cmd)
                .cloned()
                .unwrap_or(SpawnResult {
                    exit_code: 127,
                    stdout: String::new(),
                    stderr: format!("{cmd}: command not found\n"),
                    execution_time_ms: 0,
                })
        }

        fn has_tool(&self, name: &str) -> bool { self.tools.contains(name) }
        fn check_cancel(&self) -> CancelStatus { CancelStatus::Ok }
        fn time_ms(&self) -> u64 { 0 }

        fn stat(&self, path: &str) -> Result<StatInfo, HostError> {
            if self.dirs.lock().unwrap().contains(path) {
                Ok(StatInfo { file_type: "dir".into(), size: 0, mode: 0o755 })
            } else if self.files.lock().unwrap().contains_key(path) {
                let size = self.files.lock().unwrap().get(path).map(|f| f.len() as u64).unwrap_or(0);
                Ok(StatInfo { file_type: "file".into(), size, mode: 0o644 })
            } else {
                Err(HostError::NotFound(path.into()))
            }
        }

        fn read_file(&self, path: &str) -> Result<Vec<u8>, HostError> {
            self.files.lock().unwrap().get(path).cloned().ok_or(HostError::NotFound(path.into()))
        }

        fn write_file(&self, path: &str, data: &[u8], _mode: WriteMode) -> Result<(), HostError> {
            self.files.lock().unwrap().insert(path.into(), data.to_vec());
            Ok(())
        }

        fn readdir(&self, path: &str) -> Result<Vec<String>, HostError> {
            let prefix = if path.ends_with('/') { path.to_string() } else { format!("{path}/") };
            let mut entries = Vec::new();
            for k in self.files.lock().unwrap().keys() {
                if let Some(rest) = k.strip_prefix(&prefix) {
                    if !rest.contains('/') { entries.push(rest.to_string()); }
                }
            }
            for d in self.dirs.lock().unwrap().iter() {
                if let Some(rest) = d.strip_prefix(&prefix) {
                    if !rest.is_empty() && !rest.contains('/') { entries.push(rest.to_string()); }
                }
            }
            Ok(entries)
        }

        fn mkdir(&self, path: &str) -> Result<(), HostError> {
            self.dirs.lock().unwrap().insert(path.into());
            Ok(())
        }

        fn remove(&self, path: &str, _recursive: bool) -> Result<(), HostError> {
            self.files.lock().unwrap().remove(path);
            self.dirs.lock().unwrap().remove(path);
            Ok(())
        }

        fn chmod(&self, _path: &str, _mode: u32) -> Result<(), HostError> { Ok(()) }

        fn glob(&self, _pattern: &str, _cwd: &str) -> Result<Vec<String>, HostError> {
            Ok(Vec::new()) // stub — glob tests will enhance this
        }

        fn rename(&self, from: &str, to: &str) -> Result<(), HostError> {
            let data = self.files.lock().unwrap().remove(from);
            if let Some(data) = data {
                self.files.lock().unwrap().insert(to.into(), data);
            }
            Ok(())
        }

        fn symlink(&self, _target: &str, _link: &str) -> Result<(), HostError> { Ok(()) }
        fn readlink(&self, _path: &str) -> Result<String, HostError> { Err(HostError::NotFound("".into())) }
    }
}
```

**Step 2: Create executor.rs with exec_command stub + first simple command path**

```rust
// packages/shell-exec/src/executor.rs
use codepod_shell::ast::Command;
use crate::control::{ControlFlow, RunResult, ShellError};
use crate::host::HostInterface;
use crate::state::ShellState;

pub fn exec_command(
    state: &mut ShellState,
    host: &dyn HostInterface,
    cmd: &Command,
) -> Result<ControlFlow, ShellError> {
    match cmd {
        Command::Simple { words, redirects: _, assignments: _ } => {
            if words.is_empty() {
                return Ok(ControlFlow::Normal(RunResult::empty()));
            }
            // For now: extract literal words, spawn via host
            let expanded: Vec<String> = words.iter().map(|w| {
                w.parts.iter().map(|p| match p {
                    codepod_shell::ast::WordPart::Literal(s) => s.clone(),
                    codepod_shell::ast::WordPart::QuotedLiteral(s) => s.clone(),
                    _ => String::new(), // expansion comes later
                }).collect::<String>()
            }).collect();

            let cmd_name = &expanded[0];
            let args: Vec<String> = expanded[1..].to_vec();

            let result = host.spawn(cmd_name, &args, &state.env, &[], &state.cwd);
            state.last_exit_code = result.exit_code;

            Ok(ControlFlow::Normal(RunResult {
                exit_code: result.exit_code,
                stdout: result.stdout,
                stderr: result.stderr,
                execution_time_ms: result.execution_time_ms,
            }))
        }
        _ => Ok(ControlFlow::Normal(RunResult::empty())), // other variants come later
    }
}
```

**Step 3: Update lib.rs**

```rust
pub mod control;
pub mod executor;
pub mod host;
pub mod state;
pub mod test_support;
```

**Step 4: Write the first test**

Add to `executor.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::mock::MockHost;
    use crate::host::SpawnResult;

    #[test]
    fn simple_command_spawns_via_host() {
        let host = MockHost::new()
            .with_tool("ls")
            .with_spawn_result("ls", SpawnResult {
                exit_code: 0,
                stdout: "file.txt\n".into(),
                stderr: String::new(),
                execution_time_ms: 5,
            });

        let mut state = ShellState::new_default();

        let cmd = codepod_shell::parser::parse("ls");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else { panic!("expected Normal") };

        assert_eq!(run.exit_code, 0);
        assert_eq!(run.stdout, "file.txt\n");
    }

    #[test]
    fn unknown_command_returns_127() {
        let host = MockHost::new();
        let mut state = ShellState::new_default();

        let cmd = codepod_shell::parser::parse("nonexistent");
        let result = exec_command(&mut state, &host, &cmd);
        let ControlFlow::Normal(run) = result.unwrap() else { panic!("expected Normal") };

        assert_eq!(run.exit_code, 127);
        assert!(run.stderr.contains("command not found"));
    }
}
```

**Step 5: Run tests**

Run: `cargo test -p codepod-shell-exec`
Expected: 2 tests pass.

**Step 6: Commit**

```bash
git add packages/shell-exec/
git commit -m "feat: executor scaffold with MockHost and first simple command test"
```

---

### Task 4: TypeScript host imports — common helpers and shell imports

**Files:**
- Create: `packages/orchestrator/src/host-imports/common.ts`
- Create: `packages/orchestrator/src/host-imports/shell-imports.ts`

**Step 1: Create common.ts — buffer read/write helpers**

Helpers for reading strings from and writing JSON into WASM linear memory. These
are shared by shell-imports.ts and python-imports.ts. Key functions:

- `readString(memory: WebAssembly.Memory, ptr: number, len: number): string`
- `readBytes(memory: WebAssembly.Memory, ptr: number, len: number): Uint8Array`
- `writeJson(memory: WebAssembly.Memory, ptr: number, cap: number, obj: unknown): number`
  — returns bytes written, or required size if `cap` too small.
- `writeString(memory: WebAssembly.Memory, ptr: number, cap: number, s: string): number`
- `writeBytes(memory: WebAssembly.Memory, ptr: number, cap: number, data: Uint8Array): number`
- `writeError(memory: WebAssembly.Memory, ptr: number, cap: number, msg: string): number`
  — returns negative error code.

**Step 2: Create shell-imports.ts — host import implementations**

Implements every `codepod.*` import for shell instances. The function
`createShellImports(vfs, mgr, memory)` returns the import object.

Start with just `host_spawn`, `host_has_tool`, `host_check_cancel`, `host_time_ms`,
`host_read_command`, `host_write_result`. Filesystem imports can be stubs
(return -1 NotFound) for now — they'll be filled in during Phase 2.

Key implementation detail for `host_spawn`: read cmd/args/env/stdin/cwd from WASM
memory, call `mgr.spawn(cmd, { args, env, stdinData, ... })`, serialize the
SpawnResult as JSON, write into the output buffer.

Key implementation detail for `host_read_command` / `host_write_result`: these
use a simple resolve/reject pattern. The ShellInstance class (Task 5) stores a
pending command resolver. When `runInShell()` is called, it writes the command
string and resolves the `host_read_command` blocker. When `host_write_result`
is called by the WASM, it resolves the `runInShell()` promise.

**Step 3: Commit**

```bash
git add packages/orchestrator/src/host-imports/
git commit -m "feat: TypeScript host import helpers and shell import implementations"
```

---

### Task 5: ShellInstance wrapper and first end-to-end test

**Files:**
- Create: `packages/orchestrator/src/shell/shell-instance.ts`
- Create: `packages/orchestrator/src/shell/__tests__/shell-instance.test.ts`

**Step 1: Create ShellInstance class**

This class manages a long-lived shell-exec WASM instance:

```typescript
export class ShellInstance {
  private instance: WebAssembly.Instance;
  private memory: WebAssembly.Memory;
  // Pending command/result resolvers for the command loop
  private pendingCommand: { resolve: (cmd: string) => void } | null = null;
  private pendingResult: { resolve: (result: RunResult) => void } | null = null;

  static async create(vfs, mgr, adapter, wasmPath): Promise<ShellInstance>
  async run(command: string): Promise<RunResult>
  destroy(): void
  setEnv(name: string, value: string): void   // calls into WASM? or queues for next command?
  getEnv(name: string): string | undefined
  // ...
}
```

The key insight: the WASM module runs a `loop { read_command(); execute(); write_result(); }`
in `main()`. We need to run this loop on a separate execution context. Options:

- **Node.js:** Run the WASM `_start` in a microtask. `host_read_command` uses
  `Atomics.wait()` on a SAB. `runInShell()` writes the command to the SAB and
  `Atomics.notify()`.
- **Simpler v1:** Run synchronously in the same thread. `host_read_command`
  throws a special "yield" error when no command is pending. The `run()` method
  catches it, stores the command, and re-enters. This is hacky but avoids SAB
  for the initial prototype.

For v1, use the simpler approach: the WASM binary runs one command per
invocation rather than a persistent loop. Change `main.rs` to:
1. Call `host_read_command()` — host writes command into buffer.
2. Parse and execute.
3. Call `host_write_result()`.
4. Return (exit `_start`).

The host re-instantiates for each command? No — that loses state. Instead,
the host calls a `__run_command` export that does steps 1-3. The `_start`
function just initializes state. We'll add a `static mut STATE` or use
`thread_local!` for the global ShellState.

Actually the cleanest approach: export `__run_command(cmd_ptr, cmd_len, out_ptr, out_cap) -> i32`
as the main entry point. `_start` just initializes. The host calls `__run_command`
for each command. State persists in WASM linear memory between calls.

Update `main.rs` accordingly.

**Step 2: Write integration test**

```typescript
// packages/orchestrator/src/shell/__tests__/shell-instance.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { ShellInstance } from '../shell-instance.js';
// ... setup VFS, ProcessManager, register echo-args tool

describe('ShellInstance', () => {
  it('runs a simple command via host_spawn', async () => {
    const result = await shell.run('echo-args hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello\n');
  });
});
```

**Step 3: Build WASM, copy fixture, run test**

Run: `cargo build -p codepod-shell-exec --target wasm32-wasip1 --release`
Run: `cp target/wasm32-wasip1/release/codepod-shell-exec.wasm packages/orchestrator/src/shell/__tests__/fixtures/`
Run: `cd packages/orchestrator && bun test src/shell/__tests__/shell-instance.test.ts`
Expected: Test passes.

**Step 4: Commit**

```bash
git add packages/orchestrator/src/shell/shell-instance.ts \
        packages/orchestrator/src/shell/__tests__/shell-instance.test.ts \
        packages/shell-exec/src/main.rs
git commit -m "feat: ShellInstance wrapper with first end-to-end command execution"
```

---

## Phase 2: Shell Executor — Port All Features

Port the TypeScript shell logic into Rust, feature by feature, each with tests.
The TS source files are the specification. Work through them in dependency order.

### Task 6: Variable expansion

**Files:**
- Create: `packages/shell-exec/src/expand.rs`
- Modify: `packages/shell-exec/src/executor.rs`
- Modify: `packages/shell-exec/src/lib.rs`

Port `expandWord`, `expandWordPart`, `expandWordsWithSplitting` from
`shell-runner.ts:1305-1440`. Implement:

- `$VAR` and `${VAR}` — simple variable lookup from `state.env`
- `${VAR:-default}`, `${VAR:=value}`, `${VAR:+alternate}`, `${VAR:?error}`
- `${VAR#prefix}`, `${VAR%suffix}`, `${VAR/old/new}`
- `$?` (last exit code), `$#`, `$@`, `$*`, `$0`–`$9`
- Word splitting on IFS
- Tilde expansion (`~` → `$HOME`)

Reference: `packages/orchestrator/src/shell/shell-runner.ts:1305-1440`

Test each expansion type with the MockHost. Port the corresponding tests from
`packages/orchestrator/src/shell/__tests__/conformance/shell.test.ts` (the
"Parameter Expansion" section, ~10 tests).

**Commit:** `git commit -m "feat(shell-exec): variable and parameter expansion"`

---

### Task 7: Arithmetic evaluation

**Files:**
- Create: `packages/shell-exec/src/arithmetic.rs`

Port `safeEvalArithmetic` from `shell-utils.ts` and the arithmetic logic from
`shell-runner.ts`. Supports: `+`, `-`, `*`, `/`, `%`, `**`, `==`, `!=`, `<`,
`>`, `<=`, `>=`, `&&`, `||`, `!`, `~`, `&`, `|`, `^`, `<<`, `>>`, ternary
`?:`, assignment `=`, `+=`, `-=`, `++`, `--`, variable references.

Reference: `packages/orchestrator/src/shell/shell-utils.ts:87-200` (approx)

Test with the MockHost. Port arithmetic tests from conformance suite.

**Commit:** `git commit -m "feat(shell-exec): arithmetic evaluation"`

---

### Task 8: Brace expansion and glob expansion

**Files:**
- Modify: `packages/shell-exec/src/expand.rs`

Port brace expansion (`{a,b,c}`, `{1..5}`) and glob integration (call
`host.glob()` for patterns containing `*`, `?`, `[`).

Reference: `packages/orchestrator/src/shell/shell-runner.ts:1442-1530` (approx)

**Commit:** `git commit -m "feat(shell-exec): brace expansion and glob integration"`

---

### Task 9: Command substitution

**Files:**
- Modify: `packages/shell-exec/src/expand.rs`
- Modify: `packages/shell-exec/src/executor.rs`

Implement `$(...)` — parse inner command, execute recursively, capture stdout,
strip trailing newline. Enforce `MAX_SUBSTITUTION_DEPTH` (50).

Reference: `packages/orchestrator/src/shell/shell-runner.ts:1390-1430`

**Commit:** `git commit -m "feat(shell-exec): command substitution"`

---

### Task 10: Redirects

**Files:**
- Modify: `packages/shell-exec/src/executor.rs`

Implement file redirects (`>`, `>>`, `<`, `2>`, `2>&1`, `&>`) and heredocs
(`<<EOF`, `<<-EOF`, `<<<`). Uses `host.write_file()` for output redirects and
`host.read_file()` for input redirects.

Reference: `packages/orchestrator/src/shell/shell-runner.ts:600-750` (the redirect
handling in `execSimple`)

**Commit:** `git commit -m "feat(shell-exec): I/O redirects and heredocs"`

---

### Task 11: Pipelines

**Files:**
- Modify: `packages/shell-exec/src/executor.rs`

Implement `Pipeline` variant: sequential execution, stdout of stage N becomes
stdin of stage N+1. Handle `set -o pipefail`.

Reference: `packages/orchestrator/src/shell/shell-runner.ts:964-1046`

**Commit:** `git commit -m "feat(shell-exec): pipeline execution"`

---

### Task 12: List operators and control flow

**Files:**
- Modify: `packages/shell-exec/src/executor.rs`

Implement `List` (`;`, `&&`, `||`), `If`, `For`, `While`, `CFor`, `Case`,
`Subshell`, `BraceGroup`, `Negate`, `Break`, `Continue`, `Function`,
`DoubleBracket`, `ArithmeticCommand`.

Reference: `packages/orchestrator/src/shell/shell-runner.ts:463-960` and
`shell-runner.ts:1100-1300` (for loops, case, etc.)

This is the largest task. Consider splitting into sub-commits:
- `List` + `If` + `While` + `For`
- `Case` + `CFor` + `Subshell` + `BraceGroup`
- `Function` + `DoubleBracket` + `ArithmeticCommand`

**Commit:** `git commit -m "feat(shell-exec): control flow (if/for/while/case/functions)"`

---

### Task 13: Shell builtins

**Files:**
- Create: `packages/shell-exec/src/builtins.rs`

Port all builtins from `shell-builtins.ts` (1,228 lines). Group by complexity:

**Simple builtins (port first):**
- `echo`, `printf`, `true`, `false`, `pwd`, `cd`, `exit`
- `export`, `unset`, `set`, `local`, `declare`/`typeset`
- `test`/`[`, `read`, `shift`, `type`, `command`, `let`
- `which`, `source`/`.`, `eval`, `return`, `break`, `continue`

**Medium builtins:**
- `history`, `trap`, `getopts`, `mapfile`/`readarray`
- `chmod`, `date`, `pkg`, `pip`

**Complex builtins:**
- `curl`, `wget` (network — these call `host_spawn` to a network-capable tool
  or need their own host import; check current implementation)

Reference: `packages/orchestrator/src/shell/shell-builtins.ts:1-1228`

**Commit:** `git commit -m "feat(shell-exec): shell builtins"`

---

### Task 14: Assignment handling and arrays

**Files:**
- Modify: `packages/shell-exec/src/executor.rs`

Port assignment processing from `execSimple`: simple assignment, `+=` append,
array assignment (`arr=(...)`, `arr[idx]=val`), associative array assignment.

Reference: `packages/orchestrator/src/shell/shell-runner.ts:540-590`

**Commit:** `git commit -m "feat(shell-exec): variable assignments and array support"`

---

### Task 15: Path resolution and command dispatch logic

**Files:**
- Modify: `packages/shell-exec/src/executor.rs`

Port the command dispatch logic: check if command is a builtin, a function,
a Python command, an extension, or an external tool. Handle shebang scripts
(`source` a script whose first line is `#!/bin/sh`). Handle `IMPLICIT_CWD_COMMANDS`,
`PASSTHROUGH_ARGS`, `PATTERN_COMMANDS`, `CREATION_COMMANDS` path resolution rules.

Reference: `packages/orchestrator/src/shell/shell-runner.ts:256-460`

**Commit:** `git commit -m "feat(shell-exec): command dispatch and path resolution"`

---

## Phase 3: TypeScript Integration and Dual-Runner Testing

### Task 16: Implement filesystem host imports in TypeScript

**Files:**
- Modify: `packages/orchestrator/src/host-imports/shell-imports.ts`

Fill in the filesystem import stubs from Task 4 with real VFS-backed
implementations: `host_stat`, `host_read_file`, `host_write_file`, `host_readdir`,
`host_mkdir`, `host_remove`, `host_chmod`, `host_glob`, `host_rename`,
`host_symlink`, `host_readlink`.

Each reads args from WASM memory, calls the corresponding VFS method, writes
the result back. Error handling: catch VfsError, return appropriate negative
error codes.

**Commit:** `git commit -m "feat: filesystem host imports backed by VFS"`

---

### Task 17: ShellLike interface and Sandbox integration

**Files:**
- Create: `packages/orchestrator/src/shell/shell-like.ts`
- Modify: `packages/orchestrator/src/shell/shell-runner.ts` (implement interface)
- Modify: `packages/orchestrator/src/shell/shell-instance.ts` (implement interface)
- Modify: `packages/orchestrator/src/sandbox.ts:90-200` (use ShellLike)

Define the `ShellLike` interface. Make both `ShellRunner` and `ShellInstance`
implement it. Change `Sandbox` to store `ShellLike` instead of `ShellRunner`.
Add `shellBackend?: 'typescript' | 'rust-wasm'` to `SandboxOptions`. Default to
`'typescript'` (existing behavior unchanged).

**Commit:** `git commit -m "feat: ShellLike interface with pluggable backend"`

---

### Task 18: Dual-runner conformance test harness

**Files:**
- Create: `packages/orchestrator/src/shell/__tests__/conformance/dual-runner.test.ts`

Import the existing conformance tests and run them against both backends. This
file creates two `describe` blocks (one per backend) sharing the same test logic.
Start with the tests from `shell-runner.test.ts` and `conformance/shell.test.ts`.

Run: `cd packages/orchestrator && bun test src/shell/__tests__/conformance/dual-runner.test.ts`

Fix any failures by adjusting the Rust executor until both backends pass
identically.

**Commit:** `git commit -m "test: dual-runner conformance harness for TS and Rust backends"`

---

### Task 19: Build script integration

**Files:**
- Modify: `scripts/build-coreutils.sh:12-18` (add `-p codepod-shell-exec`)
- Modify: `scripts/copy-wasm.sh:15` (copy shell-exec binary)

Add the shell-exec WASM binary to the build and copy pipelines so it's
included in the npm package and test fixtures.

**Commit:** `git commit -m "build: include codepod-shell-exec.wasm in build pipeline"`

---

## Phase 4: Python Unified ABI (Parallel Track)

This phase can be worked on independently of Phases 2-3.

### Task 20: Create codepod-host Python native module crate

**Files:**
- Create: `packages/python/crates/codepod-host/Cargo.toml`
- Create: `packages/python/crates/codepod-host/src/lib.rs`
- Modify: `packages/python/Cargo.toml` (add dependency)
- Modify: `packages/python/src/main.rs` (register module)

Create the `_codepod` pymodule with `fetch()`, `extension_call()`, and
`is_extension()` functions. Follow the exact pattern from
`packages/python/crates/sqlite3/src/lib.rs` for the `#[vm::pymodule]` annotation
and `module_def()` export.

Register in `main.rs` as a non-optional dependency (always available).

**Commit:** `git commit -m "feat: _codepod native Python module for unified host ABI"`

---

### Task 21: TypeScript Python host imports

**Files:**
- Create: `packages/orchestrator/src/host-imports/python-imports.ts`
- Modify: `packages/orchestrator/src/process/manager.ts` (accept custom imports)

Implement `host_network_fetch`, `host_extension_invoke`, `host_is_extension`
for Python WASM instances. Modify `ProcessManager.spawn()` to accept and merge
custom host imports when instantiating a module.

**Commit:** `git commit -m "feat: Python host imports (network fetch, extensions)"`

---

### Task 22: Update Python shims

**Files:**
- Modify: `packages/orchestrator/src/network/socket-shim.ts` (rewrite SOCKET_SHIM_SOURCE)
- Modify: `packages/orchestrator/src/extension/codepod-ext-shim.ts` (rewrite CODEPOD_EXT_SOURCE)

Update `socket.py` to use `import _codepod; _codepod.fetch(...)` instead of
`os.write(1023, ...)`. Update `codepod_ext.py` to use `_codepod.extension_call()`.

Run existing Python networking tests to verify:
`cd packages/orchestrator && bun test src/__tests__/python-networking.test.ts`

**Commit:** `git commit -m "feat: update Python shims to use _codepod native module"`

---

### Task 23: Remove magic fd handling

**Files:**
- Modify: `packages/orchestrator/src/wasi/wasi-host.ts` (remove CONTROL_FD, EXTENSION_FD)

Remove the CONTROL_FD (1023) and EXTENSION_FD (1022) constants, the
`handleControlCommand()` and `handleExtensionCommand()` methods, the
`controlResponseBuf` and `extensionResponseBuf` buffers, and the special-case
code in `fd_read` and `fd_write`. The WasiHost becomes a pure WASI P1
implementation.

Run full test suite to verify nothing regresses.

**Commit:** `git commit -m "refactor: remove magic fd protocol from WasiHost"`

---

## Phase 5: Swap Default and Cleanup

### Task 24: Swap default backend to Rust

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts` (change default to `'rust-wasm'`)

Change the default `shellBackend` from `'typescript'` to `'rust-wasm'`. Run the
full test suite:

Run: `cd packages/orchestrator && bun test`
Expected: All ~14,800 lines of tests pass.

If any fail, fix them in the Rust executor before merging.

**Commit:** `git commit -m "feat: default to Rust WASM shell executor"`

---

### Task 25: Remove TypeScript shell executor

**Files:**
- Delete: `packages/orchestrator/src/shell/shell-runner.ts`
- Delete: `packages/orchestrator/src/shell/shell-builtins.ts`
- Delete: `packages/orchestrator/src/shell/shell-utils.ts`
- Modify: `packages/orchestrator/src/shell/shell-types.ts` (keep RunResult, remove AST types)
- Modify: `packages/orchestrator/src/sandbox.ts` (remove ShellRunner import, shellBackend option)
- Delete: `packages/orchestrator/src/shell/__tests__/conformance/dual-runner.test.ts`
- Delete: `packages/orchestrator/src/network/socket-shim.ts` (if not already empty)
- Delete: `packages/orchestrator/src/extension/codepod-ext-shim.ts` (if not already empty)

Run full test suite to confirm.

**Commit:** `git commit -m "refactor: remove TypeScript shell executor (~4,500 lines)"`

---

### Task 26: Final verification and size check

**Step 1: Check WASM binary size**

Run: `ls -lh target/wasm32-wasip1/release/codepod-shell-exec.wasm`
Expected: < 400KB.

**Step 2: Run full test suite**

Run: `cd packages/orchestrator && bun test`
Expected: All tests pass.

**Step 3: Run Rust tests**

Run: `cargo test -p codepod-shell-exec`
Expected: All tests pass.

**Step 4: Build npm package**

Run: `make npm`
Expected: Package builds successfully with the new WASM binary included.

**Step 5: Commit any final fixes and tag**

```bash
git commit -m "chore: shell-into-sandbox migration complete"
```
