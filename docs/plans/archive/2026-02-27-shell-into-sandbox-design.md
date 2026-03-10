# Move Shell Executor Into the WASM Sandbox

**Date:** 2026-02-27
**Status:** Design approved, pending implementation

## Problem

The shell executor runs in TypeScript outside the WASM sandbox. This is ~4,000
lines of code (shell-runner.ts, shell-builtins.ts, shell-utils.ts) that parses
untrusted input and has full access to the host environment. A bug in this code
could become a sandbox escape. Moving it inside the WASM boundary provides
defense in depth — even if the executor has a vulnerability, WebAssembly's
memory isolation contains the blast radius.

Additionally, the current codebase uses "magic file descriptors" (fd 1023 for
Python networking, fd 1022 for extensions) to smuggle JSON-based RPCs through
WASI's fd_read/fd_write syscalls. This is convention-based security — any WASM
module that guesses the fd number can access these capabilities. Replacing magic
fds with explicit host imports enforces capabilities structurally.

## Approach

**Synchronous host imports with SAB + Atomics.** The Rust shell WASM module
gets custom host-provided imports (the `codepod` namespace) for operations that
require host resources: process spawning, filesystem access, networking, etc.
When the shell needs to block (e.g., waiting for a child process), the host uses
SharedArrayBuffer + Atomics to provide synchronous blocking semantics. This
pattern already exists in the codebase for the network bridge and VFS proxy.

### Why This Approach

- Shells are inherently synchronous — forcing async adds enormous complexity.
- SAB + Atomics is already used in the project (not a new dependency).
- Rust code stays sequential — straightforward port of the TS logic.
- Best performance — direct function calls, no serialization overhead per host call.
- In Node.js (primary runtime), `Atomics.wait()` works on the main thread.

## Architecture

### Before

```
Command string → [WASM: Rust parser] → JSON AST → [TS: executor] → host calls
                  inside sandbox                    OUTSIDE sandbox
```

### After

```
Command string → [WASM: Rust shell (parse + execute + builtins)]
                  inside sandbox
                       ↕ host imports (codepod.*)
                  [TS host: VFS, process mgmt, security enforcement]
```

### What Stays in TypeScript (the Host)

- VFS ownership and all filesystem operations
- Process spawning (loading/instantiating WASM modules for coreutils, python)
- Network gateway
- Security enforcement (allowlists, resource limits, timeouts)
- SAB + Atomics plumbing for synchronous blocking
- Shell instance lifecycle management

### What Moves Into Rust/WASM

- The entire shell executor (~2,500 lines of shell-runner.ts)
- All shell builtins (~1,200 lines of shell-builtins.ts)
- Variable expansion, globbing, brace expansion (~200 lines of shell-utils.ts)
- Shell state (env vars, functions, arrays, cwd, trap handlers, flags)

## Unified Host Import ABI

All custom imports live under the `codepod` WASM import namespace, alongside
the standard `wasi_snapshot_preview1` namespace. This replaces both the magic
fd protocol and provides the new shell-to-host interface.

### Memory Passing Convention

WASM imports pass `(ptr, len)` pairs for strings and byte buffers. For
variable-length host responses, Rust passes a pre-allocated output buffer
`(out_ptr, out_cap)`. The host writes into it and returns actual byte length.
If the buffer is too small, the host returns the required size; Rust
reallocates and retries.

The Rust side exports `__alloc(size) → ptr` and `__dealloc(ptr, size)` for
host-initiated allocations when needed.

### Import Catalog

**Process lifecycle:**

| Import | Signature | Purpose |
|--------|-----------|---------|
| `host_spawn` | `(cmd, args, env, stdin, cwd, out) → len` | Spawn WASM child, block until done |
| `host_has_tool` | `(name) → bool` | Check tool availability |
| `host_check_cancel` | `() → status` | Poll for timeout/cancel (0=ok, 1=timeout, 2=cancelled) |
| `host_time_ms` | `() → i64` | Monotonic clock |

**Filesystem (for shell builtins, redirects, sourcing scripts):**

| Import | Purpose |
|--------|---------|
| `host_stat` | Stat a path → {type, size, mode, mtime} |
| `host_read_file` | Read file contents |
| `host_write_file` | Write bytes (overwrite, append, or create) |
| `host_readdir` | List directory entries |
| `host_mkdir` | Create directory (recursive) |
| `host_remove` | Remove file or directory |
| `host_chmod` | Change file permissions |
| `host_symlink` | Create symbolic link |
| `host_readlink` | Read symlink target |
| `host_glob` | Resolve glob pattern against VFS |
| `host_rename` | Rename/move |

**Networking (Python only):**

| Import | Purpose |
|--------|---------|
| `host_network_fetch` | Synchronous HTTP fetch |

**Extensions (Python only):**

| Import | Purpose |
|--------|---------|
| `host_extension_invoke` | Call host extension method |
| `host_is_extension` | Check if name is a registered extension |

**Shell session (shell only):**

| Import | Purpose |
|--------|---------|
| `host_read_command` | Block waiting for next command from host |
| `host_write_result` | Send RunResult back to host |

### Capability Matrix

The TypeScript host constructs a different import object per module type:

| Module | `codepod.*` imports provided |
|--------|------------------------------|
| Shell | spawn, has_tool, check_cancel, time_ms, all filesystem, read_command, write_result |
| Python | network_fetch, extension_invoke, is_extension |
| Coreutils | None (standard WASI P1 only) |

A coreutil that tries to import `codepod.host_spawn` fails at WASM
instantiation — the capability structurally does not exist.

### What This Eliminates

- Magic fd 1023 (Python socket shim) → `host_network_fetch`
- Magic fd 1022 (Python extension bridge) → `host_extension_invoke`
- JSON-over-fd protocol → typed function calls with `(ptr, len)` args
- Convention-based security → structural capability enforcement

## Shell Execution Model

### Long-Lived Instances

The shell WASM module is instantiated once per session and serves commands for
its lifetime. Shell state persists naturally in WASM linear memory.

```
Host: createShell("sh-1")
  → instantiate shell-exec.wasm with codepod.* imports
  → shell enters main loop

Host: runInShell("sh-1", "cd /tmp")
  → host_read_command() unblocks → "cd /tmp"
  → parse → execute → cd updates PWD in WASM memory
  → host_write_result({exitCode: 0, ...})

Host: runInShell("sh-1", "ls")
  → host_read_command() unblocks → "ls"
  → parse → expand → host_spawn("ls", ...) → blocks until ls.wasm finishes
  → host_write_result({exitCode: 0, stdout: "...", ...})

Host: destroyShell("sh-1")
  → run EXIT trap if set
  → drop WASM instance → linear memory freed
```

### Named Shell Instances

The TypeScript host manages a `Map<string, WebAssembly.Instance>`. Public API:

```typescript
createShell(id?: string): string
runInShell(id: string, cmd: string): Promise<RunResult>
destroyShell(id: string): void
```

A default shell is created on sandbox init. One-off commands are just
"create → run → destroy" (or use the default shell).

### Shell State in Rust

All shell state lives in WASM linear memory:

```rust
struct ShellState {
    env: HashMap<String, String>,
    arrays: HashMap<String, Vec<String>>,
    assoc_arrays: HashMap<String, HashMap<String, String>>,
    functions: HashMap<String, Command>,
    flags: HashSet<ShellFlag>,
    positional_args: Vec<String>,
    last_exit_code: i32,
    function_depth: u32,
    substitution_depth: u32,
    traps: HashMap<String, String>,
    local_var_stack: Vec<HashMap<String, Option<String>>>,
    history: Vec<HistoryEntry>,
    cwd: String,
}
```

The shell does NOT cache any VFS state. Every filesystem operation goes through
a host import, keeping the host as single source of truth and ensuring security
limits are enforced on every call.

### Pipeline Execution

Pipelines run stages sequentially (matching current TS behavior): each stage
completes fully, its stdout is buffered, then fed as stdin to the next. True
concurrent pipelines (streaming between simultaneous WASM instances) can be a
future improvement.

### Subshells

`( cd /tmp; ls )` — snapshot env/cwd before, restore after. No separate WASM
instance needed. Same approach as the current TS code.

### Command Substitution

`$(cmd)` runs in the same shell instance (can see/modify variables). Nesting
depth is capped at 50 (matching current behavior).

### Cancellation

The shell polls `host_check_cancel()` at strategic points: before each command
in a list/pipeline, before each loop iteration, before each command
substitution, before each function call.

### Control Flow

The TS code uses thrown exceptions for Break/Continue/Return/Exit. In Rust,
these become an enum:

```rust
enum ControlFlow {
    Normal(RunResult),
    Break(u32),
    Continue(u32),
    Return(i32),
    Exit(i32, String, String),
    Cancelled(CancelReason),
}
```

Every `exec_*` method returns `Result<ControlFlow, ShellError>`.

## Crate Structure

### New Crate: `packages/shell-exec`

The existing `packages/shell` crate stays unchanged (parser library). A new
crate adds the executor:

```
packages/shell-exec/
  src/
    lib.rs            — public API: ShellState, execute()
    main.rs           — _start entry point (command loop via host imports)
    host.rs           — extern "C" host import declarations + safe wrappers
    executor.rs       — AST walker (exec_command, exec_pipeline, etc.)
    builtins.rs       — cd, export, echo, printf, set, trap, etc.
    expand.rs         — variable expansion, brace expansion, word splitting
    arithmetic.rs     — $(( )) evaluation
    state.rs          — ShellState struct definition
    control.rs        — ControlFlow enum, error types
    test_support.rs   — #[cfg(test)] mock host for unit tests
  Cargo.toml
```

Dependencies: `codepod-shell` (parser), `serde`, `serde_json`. Nothing else.

### New Crate: `packages/python/crates/codepod-host`

Native Python module (`_codepod`) exposing host imports:

```
packages/python/crates/codepod-host/
  src/
    lib.rs    — #[vm::pymodule] _codepod with fetch(), extension_call(), is_extension()
  Cargo.toml
```

Dependencies: `rustpython-vm`, `rustpython-derive`, `serde_json`.

Registered in `packages/python/src/main.rs` as a non-optional dependency
(always available), following the same pattern as sqlite3/numpy:

```rust
let codepod_def = codepod_host::module_def(&config.ctx);
let config = config.add_native_module(codepod_def);
```

### Workspace Integration

Add `packages/shell-exec` to root `Cargo.toml` workspace members. Add
`codepod-host` to `packages/python/Cargo.toml` as a path dependency.

### Build Integration

`scripts/build-coreutils.sh` adds `-p codepod-shell-exec` to the cargo build
command. `scripts/copy-wasm.sh` copies `codepod-shell-exec.wasm` to the
distribution directory. Expected binary size: 200–400KB.

### Updated Python Shims

`socket.py` changes from `os.write(1023, json)` / `os.read(1023, ...)` to
`import _codepod; _codepod.fetch(url, method, headers, body)`.

`codepod_ext.py` changes from `os.write(1022, json)` / `os.read(1022, ...)` to
`import _codepod; _codepod.extension_call(name, method, kwargs)`.

### TypeScript Host Changes

New directory `packages/orchestrator/src/host-imports/`:

```
host-imports/
  shell-imports.ts    — implements codepod.* for shell instances
  python-imports.ts   — implements codepod.* for python instances
  common.ts           — shared buffer management, SAB blocking helpers
```

`ProcessManager.spawn()` accepts a `hostImports` parameter that gets merged
into the WASI imports when instantiating a module.

### What Gets Deleted

Once migration is complete:

- `shell-runner.ts` (2,527 lines)
- `shell-builtins.ts` (1,228 lines)
- `shell-utils.ts` (202 lines)
- Most of `shell-types.ts` (RunResult interface stays)
- Magic fd handling in `wasi-host.ts` (CONTROL_FD, EXTENSION_FD, ~120 lines)
- `network/socket-shim.ts` (367 lines)
- `extension/codepod-ext-shim.ts` (22 lines)

Total: ~4,500 lines of TypeScript removed.

## Testing Strategy

### Layer 1: Rust Unit Tests

Test executor logic in isolation with a mock host trait. No WASM compilation
needed during development. Covers variable expansion, control flow, builtins,
pipeline wiring, brace expansion, word splitting, error handling.

```rust
pub trait HostInterface {
    fn spawn(&self, cmd: &str, args: &[String], ...) -> SpawnResult;
    fn stat(&self, path: &str) -> Result<StatInfo, HostError>;
    fn read_file(&self, path: &str) -> Result<Vec<u8>, HostError>;
    // ...
}
```

Run with `cargo test -p codepod-shell-exec`.

### Layer 2: WASM Integration Tests

New TypeScript test file that instantiates `codepod-shell-exec.wasm` with real
host imports, VFS, and ProcessManager. Tests the ABI boundary end-to-end.

### Layer 3: Existing Test Suite (Unchanged)

The ~14,800 lines of existing tests continue to run against `Sandbox.create()`
→ `sandbox.run()`. Once we swap the backend, these validate behavioral
equivalence without modification.

### Dual-Runner Conformance

During migration, a conformance harness runs every shell test against both
backends:

```typescript
for (const backend of ['typescript', 'rust-wasm']) {
  describe(`shell conformance [${backend}]`, () => {
    // ... run full conformance suite
  });
}
```

Fix behavioral differences until both pass identically.

## Migration Path

### Phase 1: Build Alongside

- Create `packages/shell-exec/` with Rust executor
- Implement host imports in TypeScript
- Implement `ShellInstance` wrapper class
- Write Layer 1 + Layer 2 tests
- TS shell runner remains the production code path

### Phase 2: Feature Parity Validation

- Dual-runner conformance harness runs both backends
- Fix behavioral differences
- Benchmark: run 100 typical commands, compare wall-clock time
- Track WASM binary size (budget: 400KB)

### Phase 3: Swap Default and Remove TS Shell

- `Sandbox.create()` uses Rust WASM shell by default
- Full test suite passes → migration complete
- Remove TS shell code (~4,500 lines)
- Remove `shellBackend` option

The shell and Python ABI migrations are independent and can proceed in
parallel.

## Migration Seam

Both backends implement a common interface:

```typescript
interface ShellLike {
  run(command: string): Promise<RunResult>;
  setEnv(name: string, value: string): void;
  getEnv(name: string): string | undefined;
  getEnvMap(): Map<string, string>;
  setEnvMap(env: Map<string, string>): void;
  cancel(reason: 'TIMEOUT' | 'CANCELLED'): void;
  setOutputLimits(stdoutBytes?: number, stderrBytes?: number): void;
  setMemoryLimit(bytes: number): void;
  // ...
}
```

`Sandbox` delegates to whichever backend via this interface. The public
`Sandbox` API does not change.

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Subtle behavioral differences | Phase 2 dual-runner conformance tests |
| Performance regression | Benchmark suite comparing wall-clock time |
| WASM binary size bloat | Track in CI; budget 400KB |
| Host import ABI instability | Version field in handshake |
| Rust executor panics | `catch_unwind` at top-level loop; return error result |
| Memory leaks in long-lived WASM | Monitor linear memory growth in tests |
