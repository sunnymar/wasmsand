# RustPython WASI Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Pydantic Monty with RustPython compiled to `wasm32-wasip1`, making Python execution a standard WASI process like cat/grep/ls.

**Architecture:** RustPython becomes a WASI CLI binary (`rustpython.wasm`) registered as a tool in ProcessManager. PythonRunner simplifies from a Monty external-function orchestrator to a thin wrapper around `ProcessManager.spawn()`. All Python I/O goes through existing WASI syscalls (fd_read, fd_write, path_open, args_get, environ_get) backed by VFS.

**Tech Stack:** RustPython (Rust → wasm32-wasip1), vitest, existing WasiHost/ProcessManager/VFS infrastructure.

---

### Task 1: Build RustPython WASI Binary

**Files:**
- Create: `packages/python/Cargo.toml`
- Create: `packages/python/src/main.rs`
- Modify: `Cargo.toml` (workspace members)
- Create: `packages/python/build.sh`

**Context:** RustPython is an external dependency, not vendored. We create a thin crate that depends on it and builds the WASI binary. The crate is minimal — it just pulls in RustPython's CLI entrypoint.

**Step 1: Create the Rust crate**

`packages/python/Cargo.toml`:
```toml
[package]
name = "wasmsand-python"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "python3"
path = "src/main.rs"

[dependencies]
rustpython = { git = "https://github.com/RustPython/RustPython", default-features = false, features = [
  "freeze-stdlib",
  "stdlib",
  "compiler",
  "importlib",
  "stdio",
  "encodings",
] }
```

Note: We omit `threading` (not available on WASI), `ssl-rustls` (not needed), and `host_env` (may or may not be needed — test without it first since frozen stdlib handles imports; add if `os.environ` or filesystem imports are needed).

`packages/python/src/main.rs`:
```rust
fn main() {
    // RustPython's run() handles all CLI arg parsing: -c, -m, script paths, stdin
    let exit_code = rustpython::run(|_vm| {});
    std::process::exit(exit_code);
}
```

**Step 2: Add to workspace**

Add `"packages/python"` to the `members` array in root `Cargo.toml`.

**Step 3: Build the WASI binary**

`packages/python/build.sh`:
```bash
#!/bin/bash
set -euo pipefail

rustup target add wasm32-wasip1 2>/dev/null || true

RUSTFLAGS="-C lto=yes" cargo build \
  --release \
  --target wasm32-wasip1 \
  -p wasmsand-python

cp target/wasm32-wasip1/release/python3.wasm \
   packages/orchestrator/src/platform/__tests__/fixtures/python3.wasm

echo "Built python3.wasm ($(du -h packages/orchestrator/src/platform/__tests__/fixtures/python3.wasm | cut -f1))"
```

Run: `bash packages/python/build.sh`

Expected: `python3.wasm` appears in fixtures, ~10-15MB.

**Step 4: Verify the binary works standalone**

Run: `wasmtime run --dir . packages/orchestrator/src/platform/__tests__/fixtures/python3.wasm -- -c "print('hello from rustpython')"`

Expected: `hello from rustpython`

If wasmtime is not installed, skip this step — the integration tests in Task 3 will verify.

**Step 5: Inspect WASI imports**

Run: `wasm-tools print --skeleton packages/orchestrator/src/platform/__tests__/fixtures/python3.wasm | grep import`

Compare against `wasi-host.ts` getImports() to identify any missing syscalls. Note any that need real implementations (currently stubbed).

**Step 6: Commit**

```bash
git add packages/python/ Cargo.toml packages/orchestrator/src/platform/__tests__/fixtures/python3.wasm
git commit -m "feat: add RustPython WASI binary (python3.wasm)"
```

---

### Task 2: Rewrite PythonRunner to Use ProcessManager

**Files:**
- Rewrite: `packages/orchestrator/src/python/python-runner.ts`
- Modify: `packages/orchestrator/src/shell/shell-runner.ts`
- Modify: `packages/orchestrator/package.json`

**Context:** The current PythonRunner manages a Monty instance with external functions. The new PythonRunner delegates to ProcessManager.spawn() — it becomes a thin translation layer that converts "python3" command args into a ProcessManager call. The key insight: ProcessManager already handles args, env, stdin, and stdout capture via WasiHost.

**Step 1: Rewrite python-runner.ts**

Replace the entire file:

```typescript
import type { ProcessManager } from '../process/manager.js';
import type { SpawnOptions, SpawnResult } from '../process/process.js';

/**
 * PythonRunner delegates Python execution to a RustPython WASI binary
 * via ProcessManager. Supports:
 *   python3 -c "code"
 *   python3 script.py [args...]
 *   stdin piping (cat data | python3 -c "...")
 */
export class PythonRunner {
  private mgr: ProcessManager;

  constructor(mgr: ProcessManager) {
    this.mgr = mgr;
  }

  async run(opts: SpawnOptions): Promise<SpawnResult> {
    return this.mgr.spawn('python3', opts);
  }
}
```

That's it. All the complexity (reading files, handling stdin, capturing output) is already in ProcessManager + WasiHost.

**Step 2: Update ShellRunner to pass ProcessManager to PythonRunner**

In `packages/orchestrator/src/shell/shell-runner.ts`:

Change the import:
```typescript
// Before:
import { PythonRunner } from '../python/python-runner.js';
// After: (same import, but constructor changes)
import { PythonRunner } from '../python/python-runner.js';
```

Change the lazy initialization in `execPython()` (around line 592):
```typescript
// Before:
if (!this.pythonRunner) {
  this.pythonRunner = new PythonRunner(this.vfs);
}

// After:
if (!this.pythonRunner) {
  this.pythonRunner = new PythonRunner(this.mgr);
}
```

**Step 3: Remove Monty dependency**

In `packages/orchestrator/package.json`, remove:
```json
"@pydantic/monty": "^0.0.7"
```

Run: `cd packages/orchestrator && npm install`

**Step 4: Register python3 as a tool**

In `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`, the test setup registers tools. We need to add python3:

In the `TOOLS` array (line 18), `python3` is NOT listed because Python was handled specially. Now it needs to be a registered tool. But we should NOT add it to the `TOOLS` array because the `wasmName()` function maps to `${tool}.wasm` and python3 already maps correctly.

Add to test setup after the tool registration loop:
```typescript
mgr.registerTool('python3', resolve(FIXTURES, 'python3.wasm'));
```

Also update ShellRunner: the `PYTHON_COMMANDS` set check in `spawnOrPython()` can be removed — python3 is now just a regular tool. But we still need the shebang handler to route python shebangs to the registered tool instead of a special PythonRunner path.

Actually, the simplest approach: **keep `spawnOrPython` routing to `execPython`, but `execPython` now delegates to ProcessManager**. This preserves shebang handling and the python3-as-command behavior with minimal code churn.

**Step 5: Commit**

```bash
git add packages/orchestrator/src/python/python-runner.ts packages/orchestrator/src/shell/shell-runner.ts packages/orchestrator/package.json
git commit -m "feat: rewrite PythonRunner to delegate to ProcessManager (RustPython WASI)"
```

---

### Task 3: Fix Existing Tests

**Files:**
- Modify: `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`

**Context:** Most Python tests check behavioral output (`print("hello")` → stdout "hello\n"), so they should pass with RustPython. But one test uses Monty's `get_argv()` which doesn't exist in real Python. Also, test setup needs to register python3 as a tool.

**Step 1: Register python3 in test setup**

In both `beforeEach` blocks (the main one around line 36 and the cwd one if separate), add after the tool registration loop:
```typescript
mgr.registerTool('python3', resolve(FIXTURES, 'python3.wasm'));
```

**Step 2: Update the get_argv() test**

Change the test at line 685 from Monty's `get_argv()` to standard Python `sys.argv`:

```typescript
it('passes arguments to python scripts', async () => {
  vfs.writeFile('/tmp/greet.py', new TextEncoder().encode(
    '#!/usr/bin/env python3\nimport sys\nprint(f"Hi {sys.argv[1]}")\n',
  ));
  const result = await runner.run('/tmp/greet.py Alice');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('Hi Alice');
});
```

**Step 3: Run tests**

Run: `cd packages/orchestrator && npx vitest run`

Expected: All tests pass. If any fail due to RustPython behavioral differences (different error message format, trailing whitespace, etc.), fix the assertions.

**Step 4: Commit**

```bash
git add packages/orchestrator/src/shell/__tests__/coreutils.test.ts
git commit -m "test: update Python tests for RustPython WASI backend"
```

---

### Task 4: Add RustPython Stdlib Tests

**Files:**
- Modify: `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`

**Context:** The whole point of switching to RustPython is stdlib support. Add tests that verify LLMs can use `json`, `re`, `math`, `collections`, `sys`, `os.environ`, and file I/O via standard Python `open()`.

**Step 1: Write the failing tests**

Add a new `describe('python stdlib')` block:

```typescript
describe('python stdlib', () => {
  it('import json', async () => {
    const result = await runner.run('python3 -c "import json; print(json.dumps({\'a\': 1}))"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('{"a": 1}');
  });

  it('import re', async () => {
    const result = await runner.run('python3 -c "import re; print(re.findall(r\'\\d+\', \'abc123def456\'))"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("['123', '456']");
  });

  it('import math', async () => {
    const result = await runner.run('python3 -c "import math; print(math.sqrt(144))"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('12.0');
  });

  it('import collections', async () => {
    const result = await runner.run('python3 -c "from collections import Counter; print(Counter(\'abracadabra\').most_common(1))"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("'a'");
    expect(result.stdout).toContain('5');
  });

  it('sys.argv with -c', async () => {
    const result = await runner.run('python3 -c "import sys; print(sys.argv)"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('-c');
  });

  it('os.environ reads shell env', async () => {
    runner.setEnv('MY_VAR', 'hello123');
    const result = await runner.run('python3 -c "import os; print(os.environ.get(\'MY_VAR\', \'missing\'))"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello123');
  });

  it('class definitions work', async () => {
    const script = [
      'class Point:',
      '    def __init__(self, x, y):',
      '        self.x = x',
      '        self.y = y',
      '    def __repr__(self):',
      '        return f"Point({self.x}, {self.y})"',
      'print(Point(3, 4))',
    ].join('\n');
    vfs.writeFile('/tmp/classes.py', new TextEncoder().encode(script));
    const result = await runner.run('python3 /tmp/classes.py');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('Point(3, 4)');
  });

  it('file I/O via open()', async () => {
    vfs.writeFile('/tmp/data.txt', new TextEncoder().encode('hello world'));
    const script = 'f = open("/tmp/data.txt"); print(f.read()); f.close()';
    const result = await runner.run(`python3 -c "${script}"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello world');
  });

  it('write file via open()', async () => {
    const script = 'f = open("/tmp/out.txt", "w"); f.write("written by python"); f.close()';
    await runner.run(`python3 -c "${script}"`);
    const content = new TextDecoder().decode(vfs.readFile('/tmp/out.txt'));
    expect(content).toBe('written by python');
  });

  it('stdin piping works', async () => {
    vfs.writeFile('/tmp/input.txt', new TextEncoder().encode('line1\nline2\nline3\n'));
    const result = await runner.run('cat /tmp/input.txt | python3 -c "import sys; print(len(sys.stdin.read().splitlines()))"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('3');
  });

  it('json parse pipeline', async () => {
    vfs.writeFile('/tmp/data.json', new TextEncoder().encode('{"name": "Alice", "age": 30}'));
    const result = await runner.run('cat /tmp/data.json | python3 -c "import sys, json; d = json.load(sys.stdin); print(d[\'name\'])"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('Alice');
  });

  it('ModuleNotFoundError for unavailable modules', async () => {
    const result = await runner.run('python3 -c "import numpy"');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('ModuleNotFoundError');
  });

  it('syntax error gives traceback', async () => {
    const result = await runner.run('python3 -c "def f(:"');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('SyntaxError');
  });
});
```

**Step 2: Run tests**

Run: `cd packages/orchestrator && npx vitest run`

Expected: All new tests pass (they should — this is what RustPython supports).

**Step 3: Commit**

```bash
git add packages/orchestrator/src/shell/__tests__/coreutils.test.ts
git commit -m "test: add Python stdlib integration tests (json, re, math, classes, file I/O)"
```

---

### Task 5: Handle WasiHost Gaps (if any)

**Files:**
- Possibly modify: `packages/orchestrator/src/wasi/wasi-host.ts`

**Context:** From Task 1 Step 5, we'll know if RustPython imports any WASI functions that are currently stubbed but need real implementations. Common candidates:

- `fd_fdstat_set_flags` — RustPython may call this to set O_APPEND on stdout. Current stub returns ENOSYS. If tests fail with this, implement it.
- `fd_seek` on stdout/stderr — RustPython may try to seek on fds 1/2 to check if they're TTYs. Already implemented but verify it handles non-seekable fds gracefully.
- `path_readlink` — if RustPython resolves symlinks during import. Currently stubbed.
- `fd_filestat_set_times` — if RustPython sets timestamps on created files. Currently stubbed.

**Step 1: Check test failures from Task 3/4**

If all tests pass, skip this task entirely. The current WasiHost implementation covers the ~23 most common WASI syscalls with real implementations, and the stubs return ENOSYS which RustPython may gracefully handle.

**Step 2: For each failing syscall, implement it**

Each implementation follows the same pattern — look at how `fdFilestatGet` or `pathOpen` are implemented in `wasi-host.ts`, then implement the missing function following the WASI Preview 1 spec. The VFS already supports the underlying operations.

**Step 3: Run tests again**

Run: `cd packages/orchestrator && npx vitest run`

Expected: All tests pass.

**Step 4: Commit (if changes were needed)**

```bash
git add packages/orchestrator/src/wasi/wasi-host.ts
git commit -m "fix: implement WASI syscalls needed by RustPython"
```

---

### Task 6: Cleanup and Final Verification

**Files:**
- Delete: External function bridge code in old python-runner.ts (already done in Task 2)
- Modify: `packages/orchestrator/package.json` (already done in Task 2)
- Possibly modify: `packages/orchestrator/src/shell/shell-runner.ts` (cleanup dead code)

**Step 1: Remove dead code**

Check `shell-runner.ts` for any Monty-specific code paths that are now dead:
- The `PYTHON_COMMANDS` set can stay (it's used for routing)
- The `PYTHON_INTERPRETERS` set can stay (used for shebang dispatch)
- Remove any comments referencing Monty or external functions

**Step 2: Run full test suite**

Run: `cd packages/orchestrator && npx vitest run`

Expected: All tests pass (should be ~110+ tests now including the new stdlib ones).

**Step 3: Verify binary size**

Run: `du -h packages/orchestrator/src/platform/__tests__/fixtures/python3.wasm`

Document the actual size for reference.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: cleanup Monty references, finalize RustPython integration"
```

---

## Notes for the Implementer

1. **RustPython build may take 5-10 minutes** the first time (compiling the full stdlib + compiler). Subsequent builds are faster due to cargo caching.

2. **The `host_env` feature** controls whether RustPython can access filesystem-based imports and `os.environ` at runtime. Start without it (frozen stdlib handles all imports). If `os.environ` tests fail, add the feature.

3. **Binary size**: ~12MB is expected and acceptable. The WebAssembly.Module is compiled once and cached by ProcessManager.

4. **RustPython version pinning**: Use a specific git commit hash instead of `main` branch for reproducible builds. Find a recent stable commit from RustPython's CI that passes all checks.

5. **If RustPython's `run()` function doesn't exist** as shown in main.rs, check their `src/lib.rs` for the actual entrypoint. It may be `rustpython::run()` or require `InterpreterBuilder` — adapt accordingly.

6. **The shebang handler** in `shell-runner.ts` dispatches `#!/usr/bin/env python3` to `execPython()`. With the new PythonRunner, `execPython` calls `ProcessManager.spawn('python3', ...)`. RustPython will open the script file via WASI `path_open` — it reads from VFS automatically.
