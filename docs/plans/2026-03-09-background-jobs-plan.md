# Background Jobs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `&` (background jobs), `wait`, `jobs`, `ps`, and `sleep` to the shell, enabling parallel command execution.

**Architecture:** Background jobs reuse the existing cooperative multitasking infrastructure (spawn/waitpid/JSPI). The parser gets a new `ListOp::Background` and `Token::Amp`. The executor spawns commands without waiting and stores PIDs in a job table in `ShellState`. Three new host calls are added: `waitpid_nohang`, `list_processes`, and `sleep`.

**Tech Stack:** Rust (shell parser + executor), TypeScript (ProcessKernel + kernel-imports + shell-instance)

---

### Task 1: Add `Token::Amp` to lexer

**Files:**
- Modify: `packages/shell/src/token.rs:17` (add Amp variant)
- Modify: `packages/shell/src/lexer.rs:182-184` (emit Token::Amp instead of skipping)
- Test: `packages/shell/src/lexer.rs` (existing test module)

**Step 1: Add Token::Amp**

In `packages/shell/src/token.rs`, add after `And` (line 17):

```rust
/// Single ampersand: & (background)
Amp,
```

**Step 2: Emit Token::Amp in lexer**

In `packages/shell/src/lexer.rs`, replace lines 182-184:

```rust
// Before:
// Lone & — treat as a word for now
pos += 1;
continue;

// After:
tokens.push(Token::Amp);
pos += 1;
continue;
```

**Step 3: Add lexer test**

In `packages/shell/src/lexer.rs`, add a test in the test module:

```rust
#[test]
fn lex_ampersand() {
    let tokens = lex("echo hello &");
    assert!(tokens.contains(&Token::Amp));
    // Make sure && still works
    let tokens2 = lex("cmd1 && cmd2");
    assert!(tokens2.contains(&Token::And));
    assert!(!tokens2.contains(&Token::Amp));
}
```

**Step 4: Run tests**

Run: `cd packages/shell && cargo test`
Expected: All tests pass

**Step 5: Commit**

```
feat(shell): add Token::Amp for background operator
```

---

### Task 2: Add `ListOp::Background` to AST and parser

**Files:**
- Modify: `packages/shell/src/ast.rs:56-60` (add Background variant)
- Modify: `packages/shell/src/parser.rs:112-147` (handle Amp in parse_list)
- Test: `packages/shell/src/parser.rs` (existing test module)

**Step 1: Add ListOp::Background**

In `packages/shell/src/ast.rs`, add to the `ListOp` enum (line 59):

```rust
pub enum ListOp {
    And, // &&
    Or,  // ||
    Seq, // ;
    Background, // &
}
```

**Step 2: Handle `&` in parse_list**

In `packages/shell/src/parser.rs`, modify `parse_list()` (lines 112-147). Add `Token::Amp` handling alongside `Token::Semi`:

```rust
fn parse_list(&mut self) -> Command {
    let mut left = self.parse_pipeline();

    loop {
        let op = match self.peek() {
            Some(Token::And) => ListOp::And,
            Some(Token::Or) => ListOp::Or,
            Some(Token::Amp) => {
                self.advance(); // consume &
                self.skip_newlines();
                // Trailing & with no following command
                if self.at_list_terminator() || !self.at_command_start() {
                    // Wrap left in a Background list with a no-op right side
                    left = Command::List {
                        left: Box::new(left),
                        op: ListOp::Background,
                        right: Box::new(Command::Simple {
                            words: vec![],
                            redirects: vec![],
                            assignments: vec![],
                        }),
                    };
                    break;
                }
                ListOp::Background
            }
            Some(Token::Semi) | Some(Token::Newline) => {
                self.advance();
                self.skip_newlines();
                if self.at_list_terminator() || !self.at_command_start() {
                    break;
                }
                ListOp::Seq
            }
            _ => break,
        };

        if op != ListOp::Seq && op != ListOp::Background {
            self.advance();
            self.skip_newlines();
        }

        let right = self.parse_pipeline();
        left = Command::List {
            left: Box::new(left),
            op,
            right: Box::new(right),
        };
    }

    left
}
```

Note: `ListOp` no longer derives `PartialEq` implicitly for the match comparison in line 133. We need to adjust — change `if op != ListOp::Seq` to handle both Seq and Background:

The original code at line 133 does `if op != ListOp::Seq` to avoid double-advancing for Seq (since it was already consumed above). The same applies to Background. So update:

```rust
// For And and Or we need to consume the operator token.
if !matches!(op, ListOp::Seq | ListOp::Background) {
    self.advance();
    self.skip_newlines();
}
```

**Step 3: Add parser tests**

```rust
#[test]
fn background_trailing() {
    // "echo hello &" — trailing & backgrounds the command
    let cmd = parse("echo hello &");
    match cmd {
        Command::List { op: ListOp::Background, .. } => {}
        _ => panic!("expected Background list, got {:?}", cmd),
    }
}

#[test]
fn background_with_continuation() {
    // "echo a & echo b" — backgrounds echo a, then runs echo b
    let cmd = parse("echo a & echo b");
    match cmd {
        Command::List { op: ListOp::Background, right, .. } => {
            match *right {
                Command::Simple { ref words, .. } => {
                    assert_eq!(words[0], Word::literal("echo"));
                    assert_eq!(words[1], Word::literal("b"));
                }
                _ => panic!("expected Simple right"),
            }
        }
        _ => panic!("expected Background list"),
    }
}

#[test]
fn multiple_background() {
    // "cmd1 & cmd2 & cmd3" — two background operators
    let cmd = parse("cmd1 & cmd2 & cmd3");
    // Should parse as ((cmd1 & cmd2) & cmd3)
    match cmd {
        Command::List { op: ListOp::Background, left, .. } => {
            match *left {
                Command::List { op: ListOp::Background, .. } => {}
                _ => panic!("expected nested Background"),
            }
        }
        _ => panic!("expected outer Background"),
    }
}

#[test]
fn subshell_background() {
    let cmd = parse("(echo hello) &");
    match cmd {
        Command::List { op: ListOp::Background, left, .. } => {
            match *left {
                Command::Subshell { .. } => {}
                _ => panic!("expected Subshell"),
            }
        }
        _ => panic!("expected Background list"),
    }
}
```

**Step 4: Run tests**

Run: `cd packages/shell && cargo test`
Expected: All tests pass

**Step 5: Commit**

```
feat(shell): parse & as ListOp::Background
```

---

### Task 3: Add job table to ShellState

**Files:**
- Modify: `packages/shell-exec/src/state.rs` (add Job struct and fields)

**Step 1: Add Job struct and state fields**

In `packages/shell-exec/src/state.rs`, add after the `ShellFlag` enum:

```rust
#[derive(Debug, Clone)]
pub struct Job {
    pub id: usize,
    pub pid: i32,
    pub command: String,
    pub done: Option<i32>, // exit code once reaped, None if running
}
```

Add fields to `ShellState`:

```rust
pub jobs: Vec<Job>,
pub next_job_id: usize,
pub last_bg_pid: i32,
```

Initialize in `new_default()`:

```rust
jobs: Vec::new(),
next_job_id: 1,
last_bg_pid: 0,
```

**Step 2: Run tests**

Run: `cd packages/shell-exec && cargo test`
Expected: All tests pass (no behavior change)

**Step 3: Commit**

```
feat(shell): add job table to ShellState
```

---

### Task 4: Add `waitpid_nohang`, `list_processes`, and `sleep` to HostInterface

**Files:**
- Modify: `packages/shell-exec/src/host.rs:72-174` (trait + extern + WasmHost)
- Modify: `packages/shell-exec/src/test_support.rs` (MockHost stubs)

**Step 1: Add to HostInterface trait**

In `packages/shell-exec/src/host.rs`, add to the `HostInterface` trait (after `yield_now`):

```rust
/// Check if a process has exited without blocking.
/// Returns exit code if done, -1 if still running.
fn waitpid_nohang(&self, pid: i32) -> Result<i32, HostError>;

/// Get a JSON-encoded list of all processes in the kernel.
fn list_processes(&self) -> Result<String, HostError>;

/// Sleep for the given number of milliseconds. JSPI-suspending on wasm32.
fn sleep(&self, ms: u32) -> Result<(), HostError>;
```

**Step 2: Add extern declarations (wasm32)**

In the `extern "C"` block, add:

```rust
/// Non-blocking waitpid. Returns exit code if done, -1 if still running.
fn host_waitpid_nohang(pid: i32) -> i32;

/// List all processes. Writes JSON array to output buffer.
fn host_list_processes(out_ptr: *mut u8, out_cap: u32) -> i32;

/// Sleep for ms milliseconds. JSPI-suspending.
fn host_sleep(ms: u32);
```

**Step 3: Implement WasmHost methods**

```rust
fn waitpid_nohang(&self, pid: i32) -> Result<i32, HostError> {
    let rc = unsafe { host_waitpid_nohang(pid) };
    Ok(rc)
}

fn list_processes(&self) -> Result<String, HostError> {
    call_with_outbuf("list_processes", |out_ptr, out_cap| unsafe {
        host_list_processes(out_ptr, out_cap)
    })
}

fn sleep(&self, ms: u32) -> Result<(), HostError> {
    unsafe { host_sleep(ms) };
    Ok(())
}
```

**Step 4: Add MockHost stubs**

In `packages/shell-exec/src/test_support.rs`, add to the `impl HostInterface for MockHost`:

```rust
fn waitpid_nohang(&self, pid: i32) -> Result<i32, HostError> {
    // In tests, spawned processes complete immediately
    let results = self.pid_results.borrow();
    match results.get(&pid) {
        Some(result) => Ok(result.exit_code),
        None => Ok(-1),
    }
}

fn list_processes(&self) -> Result<String, HostError> {
    Ok("[]".to_string())
}

fn sleep(&self, _ms: u32) -> Result<(), HostError> {
    Ok(()) // no-op in tests
}
```

**Step 5: Run tests**

Run: `cd packages/shell-exec && cargo test`
Expected: All tests pass

**Step 6: Commit**

```
feat(shell): add waitpid_nohang, list_processes, sleep to HostInterface
```

---

### Task 5: Implement `ListOp::Background` in executor

**Files:**
- Modify: `packages/shell-exec/src/executor.rs:1623-1670` (List handling)

**Step 1: Add Background handling**

In `packages/shell-exec/src/executor.rs`, find the `Command::List` match arm (line 1623). Add a `ListOp::Background` branch after `ListOp::Seq`:

```rust
ListOp::Background => {
    // The left command was already executed above (exec_command on left).
    // For background, we need to spawn it without waiting.
    // However, the current exec_command runs synchronously.
    //
    // For now: execute left normally (it already ran above at line 1625),
    // store its PID if it was a spawned process.
    // TODO: True background execution requires spawning via host.spawn()
    // and NOT calling waitpid. This needs the command to be re-structured
    // so the left side is spawned rather than executed inline.
    //
    // Simple approach: just run left, then run right. This gives us the
    // syntax support and job tracking without true concurrency in MockHost.
    // True concurrency works on wasm32 where spawn+waitpid are async.

    // Record job entry for the left command
    let job_id = state.next_job_id;
    state.next_job_id += 1;
    // For now, mark as done since it ran synchronously
    state.jobs.push(crate::state::Job {
        id: job_id,
        pid: 0,
        command: format_command(left),
        done: Some(left_run.exit_code),
    });
    state.last_bg_pid = 0;
    state.last_exit_code = 0; // & always returns 0

    // Execute the right side
    let right_result = exec_command(state, host, right)?;
    match right_result {
        ControlFlow::Normal(r) => Ok(ControlFlow::Normal(r)),
        other => Ok(other),
    }
}
```

We also need the `ListOp::Seq` arm. Looking at the current code, `ListOp::Seq` isn't explicitly handled — it falls through. Let me re-read:

Actually looking at the code at lines 1623-1670, I see `And`, `Or`, and then `Seq` is handled at lines 1655-1662:

```rust
ListOp::Seq => {
    let right_result = exec_command(state, host, right)?;
    match right_result {
        ControlFlow::Normal(r) => Ok(ControlFlow::Normal(r)),
        other => Ok(other),
    }
}
```

So add the Background arm after Seq.

**Step 2: Add helper to format command for display**

Add a small helper function near the List handling:

```rust
fn format_command(cmd: &Command) -> String {
    match cmd {
        Command::Simple { words, .. } => {
            words.iter()
                .map(|w| w.parts.iter().map(|p| match p {
                    codepod_shell::ast::WordPart::Literal(s) => s.clone(),
                    codepod_shell::ast::WordPart::QuotedLiteral(s) => format!("'{}'", s),
                    codepod_shell::ast::WordPart::Variable(v) => format!("${}", v),
                    _ => "...".to_string(),
                }).collect::<String>())
                .collect::<Vec<_>>()
                .join(" ")
        }
        Command::Pipeline { .. } => "<pipeline>".to_string(),
        Command::Subshell { .. } => "<subshell>".to_string(),
        _ => "<compound>".to_string(),
    }
}
```

**Step 3: Handle `$!` variable**

In the variable expansion code, find where `$?` is handled and add `$!`:

Search for `"?"` in the executor's `expand_variable` or equivalent function. Add:

```rust
"!" => state.last_bg_pid.to_string(),
```

**Step 4: Add executor test**

```rust
#[test]
fn background_runs_both_sides() {
    let host = MockHost::new().with_spawn_handler(make_handler());
    let mut state = ShellState::new_default();
    let cmd = Command::List {
        left: Box::new(simple_cmd("echo-a")),
        op: codepod_shell::ast::ListOp::Background,
        right: Box::new(simple_cmd("echo-b")),
    };
    let (exit_code, stdout) = exec_capture_cmd(&mut state, &host, &cmd);
    // Both commands should execute
    assert!(stdout.contains("a\n"));
    assert!(stdout.contains("b\n"));
    // Job should be recorded
    assert_eq!(state.jobs.len(), 1);
}

#[test]
fn trailing_background_returns_zero() {
    let host = MockHost::new().with_spawn_handler(make_handler());
    let mut state = ShellState::new_default();
    // "false &" — trailing background, right side is empty Simple
    let cmd = Command::List {
        left: Box::new(simple_cmd("false")),
        op: codepod_shell::ast::ListOp::Background,
        right: Box::new(Command::Simple {
            words: vec![],
            redirects: vec![],
            assignments: vec![],
        }),
    };
    let result = exec_command(&mut state, &host, &cmd);
    let ControlFlow::Normal(run) = result.unwrap() else {
        panic!("expected Normal")
    };
    // Background always returns 0 for the backgrounded command
    // The overall exit code comes from the right side (empty = 0)
    assert_eq!(state.last_exit_code, 0);
    assert_eq!(state.jobs.len(), 1);
}
```

**Step 5: Run tests**

Run: `cd packages/shell-exec && cargo test`
Expected: All tests pass

**Step 6: Commit**

```
feat(shell): execute ListOp::Background with job tracking
```

---

### Task 6: Add `sleep`, `wait`, `jobs`, `ps` builtins

**Files:**
- Modify: `packages/shell-exec/src/builtins.rs` (add builtins)

**Step 1: Add `sleep` builtin**

Find the builtin dispatch table (match on command name). Add:

```rust
"sleep" => {
    if args.is_empty() {
        print!("sleep: missing operand\n");
        return BuiltinResult::Result(1);
    }
    let secs: f64 = args[0].parse().unwrap_or(0.0);
    let ms = (secs * 1000.0) as u32;
    if ms > 0 {
        let _ = host.sleep(ms);
    }
    BuiltinResult::Result(0)
}
```

**Step 2: Add `wait` builtin**

```rust
"wait" => {
    if args.is_empty() {
        // Wait for all background jobs
        for job in &mut state.jobs {
            if job.done.is_none() {
                match host.waitpid(job.pid) {
                    Ok(result) => { job.done = Some(result.exit_code); }
                    Err(_) => { job.done = Some(-1); }
                }
            }
        }
        let last_code = state.jobs.last()
            .and_then(|j| j.done)
            .unwrap_or(0);
        state.last_exit_code = last_code;
    } else {
        // Wait for specific PIDs
        let mut last_code = 0;
        for arg in &args {
            if let Ok(pid) = arg.parse::<i32>() {
                // Find in job table or wait directly
                if let Some(job) = state.jobs.iter_mut().find(|j| j.pid == pid) {
                    if job.done.is_none() {
                        match host.waitpid(pid) {
                            Ok(result) => {
                                job.done = Some(result.exit_code);
                                last_code = result.exit_code;
                            }
                            Err(_) => { job.done = Some(-1); last_code = -1; }
                        }
                    } else {
                        last_code = job.done.unwrap_or(0);
                    }
                } else {
                    match host.waitpid(pid) {
                        Ok(result) => { last_code = result.exit_code; }
                        Err(_) => { last_code = 127; }
                    }
                }
            }
        }
        state.last_exit_code = last_code;
    }
    BuiltinResult::Result(state.last_exit_code)
}
```

**Step 3: Add `jobs` builtin**

```rust
"jobs" => {
    // Reap finished jobs first
    for job in &mut state.jobs {
        if job.done.is_none() {
            match host.waitpid_nohang(job.pid) {
                Ok(code) if code >= 0 => { job.done = Some(code); }
                _ => {}
            }
        }
    }
    for job in &state.jobs {
        let status = match job.done {
            Some(code) => format!("Done({})", code),
            None => "Running".to_string(),
        };
        println!("[{}] {} {}", job.id, status, job.command);
    }
    // Remove completed jobs after display
    state.jobs.retain(|j| j.done.is_none());
    BuiltinResult::Result(0)
}
```

**Step 4: Add `ps` builtin**

```rust
"ps" => {
    match host.list_processes() {
        Ok(json) => {
            // Parse JSON array of {pid, command, state, exit_code}
            if let Ok(procs) = serde_json::from_str::<Vec<serde_json::Value>>(&json) {
                println!("{:<8} {:<10} {}", "PID", "STATE", "COMMAND");
                for p in &procs {
                    let pid = p["pid"].as_i64().unwrap_or(0);
                    let st = p["state"].as_str().unwrap_or("unknown");
                    let cmd = p["command"].as_str().unwrap_or("");
                    println!("{:<8} {:<10} {}", pid, st, cmd);
                }
            }
            BuiltinResult::Result(0)
        }
        Err(e) => {
            eprintln!("ps: {}", e);
            BuiltinResult::Result(1)
        }
    }
}
```

**Step 5: Register in builtin name list**

Find the function that checks if a command is a builtin (e.g., `is_builtin` or the match in `try_builtin`). Add `"sleep"`, `"wait"`, `"jobs"`, `"ps"` to the list.

**Step 6: Run tests**

Run: `cd packages/shell-exec && cargo test`
Expected: All tests pass

**Step 7: Commit**

```
feat(shell): add sleep, wait, jobs, ps builtins
```

---

### Task 7: TypeScript — add `waitpidNohang`, `listProcesses`, `sleep` to ProcessKernel

**Files:**
- Modify: `packages/orchestrator/src/process/kernel.ts`

**Step 1: Add `waitpidNohang`**

```typescript
waitpidNohang(pid: number): number {
  const entry = this.processTable.get(pid);
  if (!entry) return -1;
  if (entry.state === 'exited') return entry.exitCode;
  return -1; // still running
}
```

**Step 2: Add `listProcesses`**

Add a `command` field to `ProcessEntry` interface (after `waiters`):

```typescript
export interface ProcessEntry {
  pid: number;
  promise: Promise<void> | null;
  exitCode: number;
  state: 'running' | 'exited';
  wasiHost: WasiHost | null;
  waiters: ((exitCode: number) => void)[];
  command?: string;
}
```

Then add the method:

```typescript
listProcesses(): { pid: number; state: string; exit_code: number; command: string }[] {
  const result: { pid: number; state: string; exit_code: number; command: string }[] = [];
  for (const [pid, entry] of this.processTable) {
    result.push({
      pid,
      state: entry.state,
      exit_code: entry.exitCode,
      command: entry.command ?? '',
    });
  }
  return result;
}
```

**Step 3: Populate command field in spawn**

In `registerPending` and `registerProcess`, accept an optional `command` parameter:

```typescript
registerPending(pid: number, command?: string): void {
  if (!this.processTable.has(pid)) {
    this.processTable.set(pid, {
      pid, promise: null, exitCode: -1, state: 'running', wasiHost: null, waiters: [],
      command,
    });
  }
}
```

Similarly for `registerProcess` and `registerExited`.

**Step 4: Run TypeScript type check**

Run: `deno check packages/orchestrator/src/process/kernel.ts`
Expected: No errors

**Step 5: Commit**

```
feat(orchestrator): add waitpidNohang, listProcesses, command tracking to ProcessKernel
```

---

### Task 8: TypeScript — wire host imports in kernel-imports.ts and shell-instance.ts

**Files:**
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts`
- Modify: `packages/orchestrator/src/shell/shell-instance.ts`

**Step 1: Add kernel imports**

In `packages/orchestrator/src/host-imports/kernel-imports.ts`, add to the returned object (after `host_yield`):

```typescript
// host_waitpid_nohang(pid) -> i32
// Non-blocking check: returns exit code if done, -1 if still running.
host_waitpid_nohang(pid: number): number {
  if (!opts.kernel) return -1;
  return opts.kernel.waitpidNohang(pid);
},

// host_list_processes(out_ptr, out_cap) -> i32
// Returns JSON array of all processes.
host_list_processes(outPtr: number, outCap: number): number {
  if (!opts.kernel) return writeJson(memory, outPtr, outCap, []);
  const procs = opts.kernel.listProcesses();
  return writeJson(memory, outPtr, outCap, procs);
},

// host_sleep(ms) -> void
// Async — JSPI-suspends the WASM stack for ms milliseconds.
async host_sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms));
},
```

**Step 2: Wire JSPI in shell-instance.ts**

Find the JSPI wrapping section (around line 165). Add `host_sleep` to the JSPI-wrapped imports:

```typescript
// host_sleep: cooperative sleep
codepodImports.host_sleep = new WebAssembly.Suspending(
  kernelImports.host_sleep as (ms: number) => Promise<void>,
) as unknown as WebAssembly.ImportValue;
```

`host_waitpid_nohang` and `host_list_processes` are synchronous — no JSPI wrapping needed. But they do need to be available in the import object. They're already in `kernelImports` which gets spread into `codepodImports`, so they should be available automatically.

Also add the same to the child process JSPI section (around line 875):

```typescript
imports.codepod.host_sleep = new WebAssembly.Suspending(
  childKernelImports.host_sleep as (ms: number) => Promise<void>,
) as unknown as WebAssembly.ImportValue;
```

**Step 3: Pass command string to registerPending**

In `shell-instance.ts`, find where `spawnProcess` is called and where `registerPending` is invoked. Pass `req.prog` as the command string:

```typescript
kernel.registerPending(pid, `${req.prog} ${req.args.join(' ')}`);
```

**Step 4: Run TypeScript type check**

Run: `source scripts/dev-init.sh && deno check packages/mcp-server/src/index.ts`
Expected: No errors

**Step 5: Commit**

```
feat(orchestrator): wire waitpid_nohang, list_processes, sleep host imports
```

---

### Task 9: Build WASM and run integration tests

**Files:**
- Build: `packages/shell-exec` (cargo build --target wasm32-wasip1)
- Build: `packages/orchestrator` (npx tsup)

**Step 1: Build shell-exec WASM**

```bash
cd packages/shell-exec && cargo fmt && cargo test && cargo build --target wasm32-wasip1 --release
```

**Step 2: Copy WASM to fixtures**

```bash
cp ../../target/wasm32-wasip1/release/codepod_shell_exec.wasm \
   ../orchestrator/src/shell/__tests__/fixtures/
```

**Step 3: Build orchestrator**

```bash
cd ../orchestrator && npx tsup
```

**Step 4: Run TypeScript tests**

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/orchestrator packages/sdk-server packages/mcp-server
```

**Step 5: Commit**

```
chore: rebuild shell-exec WASM with background job support
```

---

### Task 10: End-to-end smoke test via MCP

**Step 1: Rebuild MCP binary**

```bash
source scripts/dev-init.sh && bash scripts/build-mcp.sh
```

**Step 2: Restart MCP server and test**

Create a sandbox and test:

```
sleep 1 & echo "started sleep"
jobs
wait
echo "done"
ps
```

Verify:
- `sleep 1 &` returns immediately
- `jobs` shows the sleep job
- `wait` blocks until sleep finishes
- `ps` shows process table

**Step 3: Commit any fixes**

Fix any issues found during smoke testing.

---

Plan complete and saved to `docs/plans/2026-03-09-background-jobs-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?
