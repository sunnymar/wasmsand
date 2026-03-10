# Background Jobs (`&`) Design

## Goal

Add `&` (background job) support to the shell, enabling parallel command
execution. This is the foundation for parallel tool use — an LLM can run
multiple host-bridged tools concurrently via `tool1 & tool2 & wait`.

## Architecture

Background jobs reuse the existing cooperative multitasking infrastructure
built for streaming pipelines. The shell already has `host.spawn()` (returns
PID immediately) and `host.waitpid()` (blocks via JSPI). Background jobs
simply defer the `waitpid()` call and store the PID in a job table.

All job tracking lives in Rust (`ShellState`). Only two new host calls are
added to the TypeScript boundary.

## Components

### 1. Parser (`packages/shell/`)

**AST** — Add `ListOp::Background` alongside existing `And`, `Or`, `Seq`:

```rust
enum ListOp { And, Or, Seq, Background }
```

**Lexer** — Recognize `&` as `Token::Amp` (distinct from `&&` which is
`Token::And`).

**Parser** — `parse_list()` treats `&` like `;` but produces
`ListOp::Background`. `cmd1 & cmd2 & cmd3` parses as:

```
List(List(cmd1, Background, cmd2), Background, cmd3)
```

A trailing `&` (e.g., `sleep 10 &`) backgrounds the preceding command; the
list continues with the next command if present.

### 2. Executor (`packages/shell-exec/`)

**`ListOp::Background` handling** — When the executor encounters a
`Background` operator:

1. Spawn the left-hand command via `host.spawn()` — returns PID immediately
2. Store `Job { id, pid, command }` in `ShellState::jobs`
3. Set `$!` to the PID
4. Continue executing the next command (right-hand side) without waiting

For compound commands (`{ cmd1; cmd2; } &`), the executor wraps the entire
block in a single spawn call.

**Job reaping** — After each top-level command completes, iterate
`ShellState::jobs` and call `host.waitpid_nohang()` on each. For finished
jobs, print `[N]+ Done  command` and remove from the table.

### 3. Job Table (`ShellState`)

```rust
struct Job {
    id: usize,         // [1], [2], etc.
    pid: i32,          // kernel PID
    command: String,   // display string
    done: Option<i32>, // exit code once reaped, None if still running
}

// In ShellState:
jobs: Vec<Job>,
next_job_id: usize,
last_bg_pid: i32,     // $!
```

### 4. Builtins

**`wait [pid...]`** — If PIDs given, wait for those specific processes via
`host.waitpid()` (blocking). If no args, wait for all background jobs.
Sets `$?` to exit code of last waited process.

**`jobs`** — Calls `waitpid_nohang()` on each job to update status, then
prints job table:

```
[1]+ Running  sleep 10 &
[2]- Done     echo hello &
```

**`ps`** — Calls `host.list_processes()` to get the kernel's full process
table, displays PID/command/status in standard format.

**`sleep N`** — Calls `host.sleep(ms)` to suspend the current WASM instance
for N seconds (supports decimals: `sleep 0.5`). Implemented via JSPI —
the host does `await new Promise(r => setTimeout(r, ms))`, allowing other
background jobs to run cooperatively during the sleep.

### 5. New Host Calls

Two new additions to `HostInterface`:

```rust
fn waitpid_nohang(&self, pid: i32) -> Result<i32, HostError>;
fn list_processes(&self) -> Result<String, HostError>;
fn sleep(&self, ms: u32) -> Result<(), HostError>;
```

**`waitpid_nohang`** — Returns exit code if process has finished, -1 if
still running. No blocking.

**`list_processes`** — Returns JSON-encoded snapshot of the kernel's process
table (PID, command, status). Used by `ps` builtin.

### 6. TypeScript Side

**`ProcessKernel`** (`packages/orchestrator/src/process/kernel.ts`):

```typescript
waitpidNohang(pid: number): number
// Check processTable — if entry exists and has exitCode, return it. Else -1.

listProcesses(): ProcessInfo[]
// Serialize processTable entries to [{pid, command, status}].
```

**`kernel-imports.ts`** — Wire `host_waitpid_nohang` and
`host_list_processes` into the WASM import object.

**`shell-instance.ts`** — Register both as `WebAssembly.Suspending`
imports (though `waitpid_nohang` is sync, consistency is simpler).

## Special Variables

- `$!` — PID of most recently backgrounded process
- `$?` — set by `wait` to the exit code of the last waited process

## Security

No new capabilities are exposed. `waitpid_nohang` and `list_processes`
are read-only queries on existing kernel state. Background processes run
in the same WASM sandbox with the same isolation guarantees.

The process list returned by `list_processes` is scoped to the sandbox's
own kernel — no cross-sandbox information leakage.

## Test Cases

| Test | Expected |
|------|----------|
| `echo a & echo b & wait` | Both outputs appear, wait blocks until done |
| `sleep 1 & jobs` | Shows `[1]+ Running sleep 1 &` |
| `echo done & wait; echo $?` | `$?` is 0 |
| `false & wait $!; echo $?` | `$?` is 1 |
| `ps` | Shows process list with PIDs |
| `cmd1 & cmd2 &` | Two background jobs, shell returns immediately |
| `{ echo a; echo b; } &` | Compound command runs as single background job |
| `(cd /tmp; echo $PWD) &; wait; echo $PWD` | Subshell preserves parent env |
| `sleep 0.5 & jobs; wait` | Sleep runs in background, jobs shows it running |

## Files

| File | Change |
|------|--------|
| `packages/shell/src/ast.rs` | Add `ListOp::Background` |
| `packages/shell/src/lexer.rs` | Add `Token::Amp`, lex `&` vs `&&` |
| `packages/shell/src/parser.rs` | Handle `&` in `parse_list()` |
| `packages/shell-exec/src/executor.rs` | Background spawn, job reaping |
| `packages/shell-exec/src/builtins.rs` | `wait`, `jobs`, `ps`, `sleep` builtins |
| `packages/shell-exec/src/state.rs` | Job table, `$!` variable |
| `packages/shell-exec/src/host.rs` | `waitpid_nohang`, `list_processes`, `sleep` |
| `packages/shell-exec/src/test_support.rs` | MockHost stubs |
| `packages/orchestrator/src/process/kernel.ts` | `waitpidNohang`, `listProcesses` |
| `packages/orchestrator/src/host-imports/kernel-imports.ts` | New host imports |
| `packages/orchestrator/src/shell/shell-instance.ts` | Wire WASM imports |
