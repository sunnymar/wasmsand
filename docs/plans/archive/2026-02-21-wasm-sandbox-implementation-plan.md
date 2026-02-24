# WASM AI Sandbox Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a WASM-based sandbox that gives LLMs access to a bash-like shell, POSIX coreutils, and Python — running in both Node.js and browser.

**Architecture:** Rust shell + coreutils compiled to WASI P1, TypeScript orchestrator providing VFS/WASI host/process management, Pyodide as peer Wasm instance for Python. See `docs/plans/2026-02-21-wasm-sandbox-implementation-design.md` for full design.

**Tech Stack:** Rust (shell, coreutils) targeting wasm32-wasip1, TypeScript (orchestrator), Vitest (testing), tsup (bundling), Pyodide (Python runtime), wasi-sdk (C tools to Wasm)

---

## Phase 1: Project Scaffolding and VFS

The foundation. After this phase: a working VFS with POSIX semantics, tested in isolation.

### Task 1: Monorepo Setup

**Files:**
- Create: `package.json` (root workspace)
- Create: `packages/orchestrator/package.json`
- Create: `packages/orchestrator/tsconfig.json`
- Create: `packages/orchestrator/src/index.ts`
- Create: `packages/shell/Cargo.toml`
- Create: `packages/shell/src/lib.rs`
- Create: `packages/coreutils/Cargo.toml`
- Create: `packages/coreutils/src/lib.rs`
- Create: `Cargo.toml` (workspace root)
- Create: `.gitignore`
- Create: `rust-toolchain.toml`

**Step 1: Initialize root package.json with workspaces**

```json
{
  "name": "wasmsand",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "build": "npm run build:rust && npm run build:ts",
    "build:ts": "tsup --config packages/orchestrator/tsup.config.ts",
    "build:rust": "cargo build --target wasm32-wasip1 --release"
  }
}
```

**Step 2: Initialize orchestrator package**

```json
{
  "name": "@wasmsand/orchestrator",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "test": "vitest run",
    "build": "tsup"
  },
  "devDependencies": {
    "typescript": "^5.7",
    "vitest": "^3.0",
    "tsup": "^8.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

**Step 3: Initialize Rust workspace**

Root `Cargo.toml`:
```toml
[workspace]
members = ["packages/shell", "packages/coreutils"]
resolver = "2"
```

`packages/shell/Cargo.toml`:
```toml
[package]
name = "wasmsand-shell"
version = "0.1.0"
edition = "2021"
```

`packages/coreutils/Cargo.toml`:
```toml
[package]
name = "wasmsand-coreutils"
version = "0.1.0"
edition = "2021"
```

`rust-toolchain.toml`:
```toml
[toolchain]
channel = "stable"
targets = ["wasm32-wasip1"]
```

**Step 4: Create .gitignore**

```
node_modules/
dist/
target/
*.wasm
!packages/orchestrator/assets/*.wasm
```

**Step 5: Install dependencies and verify build**

Run: `npm install && cargo check --target wasm32-wasip1`
Expected: Clean install, no errors

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold monorepo with TS orchestrator + Rust workspace"
```

---

### Task 2: VFS Core — Inodes, Directories, Files

**Files:**
- Create: `packages/orchestrator/src/vfs/inode.ts`
- Create: `packages/orchestrator/src/vfs/vfs.ts`
- Test: `packages/orchestrator/src/vfs/__tests__/vfs.test.ts`

**Step 1: Write failing tests for VFS basics**

```typescript
// vfs.test.ts
import { describe, it, expect } from 'vitest';
import { VFS } from '../vfs.js';

describe('VFS', () => {
  it('creates with default directory structure', () => {
    const vfs = new VFS();
    expect(vfs.stat('/')).toMatchObject({ type: 'dir' });
    expect(vfs.stat('/home/user')).toMatchObject({ type: 'dir' });
    expect(vfs.stat('/tmp')).toMatchObject({ type: 'dir' });
    expect(vfs.stat('/bin')).toMatchObject({ type: 'dir' });
    expect(vfs.stat('/usr/bin')).toMatchObject({ type: 'dir' });
  });

  it('creates and reads files', () => {
    const vfs = new VFS();
    const data = new TextEncoder().encode('hello world');
    vfs.writeFile('/home/user/test.txt', data);
    const read = vfs.readFile('/home/user/test.txt');
    expect(new TextDecoder().decode(read)).toBe('hello world');
  });

  it('creates directories', () => {
    const vfs = new VFS();
    vfs.mkdir('/home/user/src');
    expect(vfs.stat('/home/user/src')).toMatchObject({ type: 'dir' });
  });

  it('lists directory contents', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/a.txt', new Uint8Array());
    vfs.writeFile('/home/user/b.txt', new Uint8Array());
    vfs.mkdir('/home/user/sub');
    const entries = vfs.readdir('/home/user');
    expect(entries.map(e => e.name).sort()).toEqual(['a.txt', 'b.txt', 'sub']);
  });

  it('removes files', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/test.txt', new Uint8Array());
    vfs.unlink('/home/user/test.txt');
    expect(() => vfs.stat('/home/user/test.txt')).toThrow();
  });

  it('renames files', () => {
    const vfs = new VFS();
    const data = new TextEncoder().encode('content');
    vfs.writeFile('/home/user/old.txt', data);
    vfs.rename('/home/user/old.txt', '/home/user/new.txt');
    expect(new TextDecoder().decode(vfs.readFile('/home/user/new.txt'))).toBe('content');
    expect(() => vfs.stat('/home/user/old.txt')).toThrow();
  });

  it('handles nested paths with mkdirp', () => {
    const vfs = new VFS();
    vfs.mkdirp('/home/user/a/b/c');
    expect(vfs.stat('/home/user/a/b/c')).toMatchObject({ type: 'dir' });
  });

  it('returns correct stat metadata', () => {
    const vfs = new VFS();
    const data = new TextEncoder().encode('12345');
    vfs.writeFile('/home/user/test.txt', data);
    const s = vfs.stat('/home/user/test.txt');
    expect(s.size).toBe(5);
    expect(s.type).toBe('file');
    expect(s.mtime).toBeInstanceOf(Date);
  });

  it('throws ENOENT for missing paths', () => {
    const vfs = new VFS();
    expect(() => vfs.stat('/nonexistent')).toThrow(/ENOENT/);
    expect(() => vfs.readFile('/nonexistent')).toThrow(/ENOENT/);
  });

  it('throws EEXIST for duplicate mkdir', () => {
    const vfs = new VFS();
    vfs.mkdir('/home/user/dir');
    expect(() => vfs.mkdir('/home/user/dir')).toThrow(/EEXIST/);
  });

  it('throws ENOTDIR when path component is a file', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/file.txt', new Uint8Array());
    expect(() => vfs.mkdir('/home/user/file.txt/sub')).toThrow(/ENOTDIR/);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/orchestrator && npx vitest run src/vfs/__tests__/vfs.test.ts`
Expected: FAIL — modules don't exist

**Step 3: Implement inode.ts**

Inode types (file, dir, symlink), metadata (permissions, timestamps, size), content storage. Files store `Uint8Array`, directories store `Map<string, Inode>`.

**Step 4: Implement vfs.ts**

VFS class with methods: `stat`, `readFile`, `writeFile`, `mkdir`, `mkdirp`, `readdir`, `unlink`, `rmdir`, `rename`, `symlink`, `readlink`. Internal path resolution walks the inode tree. Throws typed errors (ENOENT, EEXIST, ENOTDIR, EISDIR, ENOTEMPTY).

**Step 5: Run tests to verify they pass**

Run: `cd packages/orchestrator && npx vitest run src/vfs/__tests__/vfs.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add packages/orchestrator/src/vfs/
git commit -m "feat: implement in-memory VFS with POSIX semantics"
```

---

### Task 3: VFS — File Descriptors and Pipes

**Files:**
- Create: `packages/orchestrator/src/vfs/fd-table.ts`
- Create: `packages/orchestrator/src/vfs/pipe.ts`
- Modify: `packages/orchestrator/src/vfs/vfs.ts`
- Test: `packages/orchestrator/src/vfs/__tests__/fd.test.ts`

**Step 1: Write failing tests**

```typescript
// fd.test.ts
import { describe, it, expect } from 'vitest';
import { VFS } from '../vfs.js';
import { FdTable } from '../fd-table.js';
import { createPipe } from '../pipe.js';

describe('FdTable', () => {
  it('opens a file and returns an fd', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('hello'));
    const fdt = new FdTable(vfs);
    const fd = fdt.open('/home/user/test.txt', 'r');
    expect(fd).toBeGreaterThanOrEqual(3); // 0,1,2 reserved for stdio
  });

  it('reads from an fd', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('hello'));
    const fdt = new FdTable(vfs);
    const fd = fdt.open('/home/user/test.txt', 'r');
    const buf = new Uint8Array(5);
    const n = fdt.read(fd, buf);
    expect(n).toBe(5);
    expect(new TextDecoder().decode(buf)).toBe('hello');
  });

  it('writes to an fd', () => {
    const vfs = new VFS();
    const fdt = new FdTable(vfs);
    const fd = fdt.open('/home/user/out.txt', 'w');
    fdt.write(fd, new TextEncoder().encode('written'));
    fdt.close(fd);
    expect(new TextDecoder().decode(vfs.readFile('/home/user/out.txt'))).toBe('written');
  });

  it('seeks in a file', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('abcdef'));
    const fdt = new FdTable(vfs);
    const fd = fdt.open('/home/user/test.txt', 'r');
    fdt.seek(fd, 3, 'set');
    const buf = new Uint8Array(3);
    fdt.read(fd, buf);
    expect(new TextDecoder().decode(buf)).toBe('def');
  });

  it('duplicates fds', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('hello'));
    const fdt = new FdTable(vfs);
    const fd1 = fdt.open('/home/user/test.txt', 'r');
    const fd2 = fdt.dup(fd1);
    expect(fd2).not.toBe(fd1);
    const buf = new Uint8Array(5);
    fdt.read(fd2, buf);
    expect(new TextDecoder().decode(buf)).toBe('hello');
  });

  it('clones fd table for fork', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('hello'));
    const fdt = new FdTable(vfs);
    const fd = fdt.open('/home/user/test.txt', 'r');
    const clone = fdt.clone();
    expect(clone.isOpen(fd)).toBe(true);
  });
});

describe('Pipe', () => {
  it('writes to pipe and reads from it', () => {
    const [readEnd, writeEnd] = createPipe();
    writeEnd.write(new TextEncoder().encode('piped'));
    writeEnd.close();
    const buf = new Uint8Array(5);
    const n = readEnd.read(buf);
    expect(n).toBe(5);
    expect(new TextDecoder().decode(buf)).toBe('piped');
  });

  it('returns 0 bytes when pipe is closed and empty', () => {
    const [readEnd, writeEnd] = createPipe();
    writeEnd.close();
    const buf = new Uint8Array(10);
    const n = readEnd.read(buf);
    expect(n).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/orchestrator && npx vitest run src/vfs/__tests__/fd.test.ts`

**Step 3: Implement fd-table.ts**

FdTable class: open/close/read/write/seek/tell/dup/clone. Manages a map of fd numbers to open file entries (inode ref + offset + flags). Fds 0/1/2 reserved for stdio.

**Step 4: Implement pipe.ts**

Ring buffer-backed pipe with read end and write end. `createPipe()` returns `[PipeReadEnd, PipeWriteEnd]`. Read blocks (returns 0) when empty and write end closed. Write grows buffer as needed up to a configurable limit.

**Step 5: Run tests, verify pass**

Run: `cd packages/orchestrator && npx vitest run src/vfs/__tests__/fd.test.ts`

**Step 6: Commit**

```bash
git add packages/orchestrator/src/vfs/
git commit -m "feat: add file descriptor table and pipe implementation"
```

---

### Task 4: VFS — COW Snapshots

**Files:**
- Create: `packages/orchestrator/src/vfs/snapshot.ts`
- Test: `packages/orchestrator/src/vfs/__tests__/snapshot.test.ts`

**Step 1: Write failing tests**

```typescript
describe('VFS Snapshot', () => {
  it('creates a snapshot and restores it', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('before'));
    const snapId = vfs.snapshot();
    vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('after'));
    vfs.restore(snapId);
    expect(new TextDecoder().decode(vfs.readFile('/home/user/test.txt'))).toBe('before');
  });

  it('COW fork: parent and child see independent copies', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/shared.txt', new TextEncoder().encode('original'));
    const child = vfs.cowClone();
    child.writeFile('/home/user/shared.txt', new TextEncoder().encode('child'));
    expect(new TextDecoder().decode(vfs.readFile('/home/user/shared.txt'))).toBe('original');
    expect(new TextDecoder().decode(child.readFile('/home/user/shared.txt'))).toBe('child');
  });

  it('COW fork: new files in child not visible in parent', () => {
    const vfs = new VFS();
    const child = vfs.cowClone();
    child.writeFile('/home/user/new.txt', new TextEncoder().encode('new'));
    expect(() => vfs.stat('/home/user/new.txt')).toThrow(/ENOENT/);
  });
});
```

**Step 2: Run tests to verify they fail**

**Step 3: Implement snapshot.ts**

COW clone of the inode tree: shallow copy of directory structure, file content shared via reference counting. Writes to cloned VFS trigger a copy of just that file's content. `snapshot()` returns a frozen clone, `restore()` replaces the tree with the snapshot.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add packages/orchestrator/src/vfs/
git commit -m "feat: add COW snapshots for VFS (fork simulation support)"
```

---

## Phase 2: WASI Host and Process Manager

After this phase: can load and run a simple .wasm binary with WASI imports backed by our VFS.

### Task 5: WASI Host — Core Syscalls

**Files:**
- Create: `packages/orchestrator/src/wasi/wasi-host.ts`
- Create: `packages/orchestrator/src/wasi/errors.ts`
- Create: `packages/orchestrator/src/wasi/types.ts`
- Test: `packages/orchestrator/src/wasi/__tests__/wasi-host.test.ts`

**Step 1: Write failing tests**

Test the WASI host by creating it with a VFS, then calling the syscall functions directly (they're just JS functions that read/write Wasm memory).

Write tests for:
- `args_get` / `args_sizes_get` — populate args
- `environ_get` / `environ_sizes_get` — populate env
- `fd_write` to fd 1 (stdout) — captures output
- `fd_read` from fd 0 (stdin) — reads from provided input
- `fd_close` — closes a descriptor
- `clock_time_get` — returns a timestamp
- `random_get` — fills buffer with random bytes
- `proc_exit` — sets exit code

Use a mock `WebAssembly.Memory` (an `ArrayBuffer` + `DataView`) to simulate Wasm linear memory for testing.

**Step 2: Run tests to verify they fail**

**Step 3: Implement types.ts**

WASI error codes enum (ESUCCESS, EBADF, EINVAL, ENOENT, etc.), rights flags, fd flags, file types, whence values. Follow WASI P1 spec exactly.

**Step 4: Implement errors.ts**

Map our VFS error types (ENOENT, EEXIST, etc.) to WASI errno values.

**Step 5: Implement wasi-host.ts**

`WasiHost` class. Constructor takes: VFS, args, env, options. Provides `getImports()` method returning the `wasi_snapshot_preview1` import object.

Implement in priority order:
1. `args_get`, `args_sizes_get`, `environ_get`, `environ_sizes_get`
2. `fd_write`, `fd_read`, `fd_close`, `fd_seek`, `fd_tell`
3. `fd_prestat_get`, `fd_prestat_dir_name` (for preopened dirs)
4. `path_open`, `path_unlink_file`, `path_create_directory`, `path_remove_directory`
5. `path_filestat_get`, `fd_filestat_get`, `fd_fdstat_get`
6. `fd_readdir`
7. `path_rename`, `path_symlink`, `path_readlink`
8. `clock_time_get`, `random_get`, `proc_exit`, `sched_yield`
9. Stubs for rarely-used functions (fd_advise, fd_allocate, fd_datasync, fd_sync, poll_oneoff)

Each function reads pointers/lengths from Wasm memory via `DataView`, dispatches to VFS/FdTable, writes results back.

**Step 6: Run tests, verify pass**

**Step 7: Commit**

```bash
git add packages/orchestrator/src/wasi/
git commit -m "feat: implement WASI P1 host backed by VFS"
```

---

### Task 6: Platform Adapter and Wasm Loader

**Files:**
- Create: `packages/orchestrator/src/platform/adapter.ts` (interface)
- Create: `packages/orchestrator/src/platform/node-adapter.ts`
- Create: `packages/orchestrator/src/platform/browser-adapter.ts`
- Test: `packages/orchestrator/src/platform/__tests__/node-adapter.test.ts`

**Step 1: Write failing tests**

Test the Node adapter: load a minimal .wasm file (a hand-crafted or Rust-compiled hello-world targeting wasm32-wasip1), instantiate it with WASI imports, run it, capture stdout.

**Step 2: Create a minimal test .wasm binary**

Write a tiny Rust program:
```rust
fn main() {
    println!("hello from wasm");
}
```
Compile: `cargo build --target wasm32-wasip1 --release`
Copy the .wasm to test fixtures.

**Step 3: Implement adapter.ts interface**

```typescript
export interface PlatformAdapter {
  loadModule(path: string): Promise<WebAssembly.Module>;
  instantiate(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports
  ): Promise<WebAssembly.Instance>;
  fetch(url: string, opts?: RequestInit): Promise<Response>;
}
```

**Step 4: Implement node-adapter.ts**

Uses `fs.readFile` + `WebAssembly.compile` for loading. Standard `WebAssembly.instantiate` for instantiation.

**Step 5: Implement browser-adapter.ts**

Uses `fetch` + `WebAssembly.compileStreaming` for loading. Same `WebAssembly.instantiate` for instantiation.

**Step 6: Run test with Node adapter**

Run: `cd packages/orchestrator && npx vitest run src/platform/__tests__/node-adapter.test.ts`
Expected: "hello from wasm" captured in stdout

**Step 7: Commit**

```bash
git add packages/orchestrator/src/platform/
git commit -m "feat: add platform adapters for Node.js and browser"
```

---

### Task 7: Process Manager

**Files:**
- Create: `packages/orchestrator/src/process/process.ts`
- Create: `packages/orchestrator/src/process/manager.ts`
- Test: `packages/orchestrator/src/process/__tests__/process.test.ts`

**Step 1: Write failing tests**

```typescript
describe('ProcessManager', () => {
  it('spawns a process and captures stdout', async () => {
    // Use the hello-world .wasm from Task 6
    const mgr = new ProcessManager(vfs, adapter);
    const result = await mgr.spawn('hello', { args: [], env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello from wasm');
  });

  it('passes args and env to the process', async () => {
    // Use a .wasm that prints args and env
    const mgr = new ProcessManager(vfs, adapter);
    const result = await mgr.spawn('echo-args', {
      args: ['one', 'two'],
      env: { FOO: 'bar' }
    });
    expect(result.stdout).toContain('one');
    expect(result.stdout).toContain('two');
  });

  it('wires stdin from a pipe', async () => {
    const mgr = new ProcessManager(vfs, adapter);
    const [readEnd, writeEnd] = createPipe();
    writeEnd.write(new TextEncoder().encode('piped input'));
    writeEnd.close();
    const result = await mgr.spawn('cat', {
      args: [],
      env: {},
      stdin: readEnd
    });
    expect(result.stdout).toBe('piped input');
  });
});
```

**Step 2: Run tests to verify they fail**

**Step 3: Implement process.ts**

`Process` class: wraps a Wasm instance + its WasiHost + its FdTable. Methods: `run()` (calls `_start` export), `getExitCode()`, `getStdout()`, `getStderr()`.

**Step 4: Implement manager.ts**

`ProcessManager` class: maintains process table (pid to Process), command registry (name to .wasm path), module cache. Methods:
- `spawn(command, opts)` — load .wasm, create WasiHost+FdTable, instantiate, run, return result
- `registerTool(name, wasmPath)` — register a command
- `resolveTool(name)` — look up .wasm path for a command

**Step 5: Run tests, verify pass**

**Step 6: Commit**

```bash
git add packages/orchestrator/src/process/
git commit -m "feat: add process manager for spawning Wasm binaries"
```

---

### Task 8: Pipeline Execution

**Files:**
- Create: `packages/orchestrator/src/process/pipeline.ts`
- Test: `packages/orchestrator/src/process/__tests__/pipeline.test.ts`

**Step 1: Write failing tests**

Test pipeline execution with real .wasm binaries (or mocks): wire 2-3 commands via pipes, verify output flows through.

```typescript
describe('Pipeline', () => {
  it('runs a single command', async () => {
    const result = await pipeline.run([{ cmd: 'echo', args: ['hello'] }]);
    expect(result.stdout).toBe('hello\n');
  });

  it('pipes stdout of one command to stdin of next', async () => {
    // echo "hello world" | wc -c
    const result = await pipeline.run([
      { cmd: 'echo', args: ['hello world'] },
      { cmd: 'wc', args: ['-c'] }
    ]);
    expect(result.stdout.trim()).toBe('12');
  });

  it('returns exit code of last command', async () => {
    const result = await pipeline.run([
      { cmd: 'echo', args: ['test'] },
      { cmd: 'false', args: [] }
    ]);
    expect(result.exitCode).not.toBe(0);
  });
});
```

**Step 2: Implement pipeline.ts**

`Pipeline` class. Takes a list of pipeline stages. For each adjacent pair, creates a VFS pipe connecting stdout of stage N to stdin of stage N+1. Runs stages sequentially (v1). Returns combined result with last stage's exit code and the final stdout.

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git add packages/orchestrator/src/process/
git commit -m "feat: add pipeline execution with pipe wiring"
```

---

## Phase 3: Shell

After this phase: can parse and run shell commands like `echo hello | cat > file.txt && grep hello file.txt`.

### Task 9: Shell Lexer (Rust)

**Files:**
- Create: `packages/shell/src/lexer.rs`
- Create: `packages/shell/src/token.rs`
- Test: `packages/shell/tests/lexer_test.rs`

**Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_simple_command() {
        let tokens = lex("echo hello world");
        assert_eq!(tokens, vec![
            Token::Word("echo".into()),
            Token::Word("hello".into()),
            Token::Word("world".into()),
        ]);
    }

    #[test]
    fn tokenizes_pipe() {
        let tokens = lex("cat file | grep pattern");
        assert_eq!(tokens, vec![
            Token::Word("cat".into()),
            Token::Word("file".into()),
            Token::Pipe,
            Token::Word("grep".into()),
            Token::Word("pattern".into()),
        ]);
    }

    #[test]
    fn tokenizes_redirects() {
        let tokens = lex("echo hello > file.txt 2>&1");
        // Verify redirect tokens: >, 2>&1
    }

    #[test]
    fn tokenizes_operators() {
        let tokens = lex("cmd1 && cmd2 || cmd3 ; cmd4");
        // Verify: And, Or, Semi tokens
    }

    #[test]
    fn handles_single_quotes() {
        let tokens = lex("echo 'hello world'");
        assert_eq!(tokens, vec![
            Token::Word("echo".into()),
            Token::Word("hello world".into()),
        ]);
    }

    #[test]
    fn handles_double_quotes_with_vars() {
        let tokens = lex(r#"echo "hello $NAME""#);
        // Verify: Word("echo"), DoubleQuoted with parts
    }

    #[test]
    fn handles_command_substitution() {
        let tokens = lex("echo $(date)");
        // Verify: Word("echo"), CommandSub("date")
    }
}
```

**Step 2: Run tests**

Run: `cargo test -p wasmsand-shell`

**Step 3: Implement token.rs**

Token enum: Word, Pipe, And, Or, Semi, LParen, RParen, Redirect(RedirectType), Newline, Assignment, CommandSub, Backtick, If/Then/Elif/Else/Fi/For/While/Do/Done, etc.

**Step 4: Implement lexer.rs**

Character-by-character lexer. Handles quoting rules (single quotes are literal, double quotes allow variable expansion and command substitution, backslash escapes). Tracks nesting for `$(...)`.

**Step 5: Run tests, verify pass**

**Step 6: Commit**

```bash
git add packages/shell/
git commit -m "feat: implement shell lexer with quoting and operator support"
```

---

### Task 10: Shell Parser (Rust)

**Files:**
- Create: `packages/shell/src/parser.rs`
- Create: `packages/shell/src/ast.rs`
- Test: `packages/shell/tests/parser_test.rs`

**Step 1: Write failing tests**

Test parsing of:
- Simple commands: `echo hello`
- Pipelines: `cat file | grep pattern | wc -l`
- Redirects: `echo hello > file.txt`, `cmd 2>&1`
- Compound: `cmd1 && cmd2 || cmd3`
- Control flow: `if cmd; then cmd; else cmd; fi`
- For loops: `for x in a b c; do echo $x; done`
- Command substitution: `echo $(date)`
- Variable assignment: `FOO=bar`
- Subshells: `(cmd1; cmd2)`

**Step 2: Implement ast.rs**

AST node types:
```rust
enum Command {
    Simple { words: Vec<Word>, redirects: Vec<Redirect>, assignments: Vec<Assignment> },
    Pipeline { commands: Vec<Command>, negated: bool },
    List { left: Box<Command>, op: ListOp, right: Box<Command> },
    If { condition: Box<Command>, then_body: Box<Command>, else_body: Option<Box<Command>> },
    For { var: String, words: Vec<Word>, body: Box<Command> },
    While { condition: Box<Command>, body: Box<Command> },
    Subshell { body: Box<Command> },
    Group { body: Box<Command> },
}
```

**Step 3: Implement parser.rs**

Recursive descent parser. Consumes token stream, produces AST. Follows bash grammar precedence: list > pipeline > command.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add packages/shell/
git commit -m "feat: implement shell parser producing AST"
```

---

### Task 11: Shell Execution Protocol (Rust)

**Files:**
- Create: `packages/shell/src/executor.rs`
- Create: `packages/shell/src/protocol.rs`
- Modify: `packages/shell/src/main.rs`
- Test: `packages/shell/tests/executor_test.rs`

**Step 1: Write failing tests**

Test that the executor takes an AST and produces the correct protocol messages (serialized JSON). Also test that it handles incoming result messages and uses exit codes for control flow.

**Step 2: Implement protocol.rs**

Define the shell-to-host protocol:
```rust
// Shell to Host
enum Request {
    Run { pipeline: Vec<Stage>, redirects: Vec<Redirect> },
    ReadVar { name: String },          // for $VAR resolution from env
    Glob { pattern: String },           // host resolves globs against VFS
    Done { code: i32 },
}

// Host to Shell
enum Response {
    RunResult { exit_code: i32 },
    VarValue { value: Option<String> },
    GlobResult { paths: Vec<String> },
}
```

**Step 3: Implement executor.rs**

Walks the AST, evaluates control flow (&&, ||, if/for/while), expands variables, sends run requests to host for each pipeline, reads responses, continues based on exit codes.

**Step 4: Implement main.rs**

The Wasm binary's entry point. Reads command string from stdin (or a dedicated fd), parses, runs via protocol over fd 3 (host communication channel).

**Step 5: Compile to wasm32-wasip1**

Run: `cargo build -p wasmsand-shell --target wasm32-wasip1 --release`
Verify: produces `target/wasm32-wasip1/release/wasmsand-shell.wasm`

**Step 6: Run tests, verify pass**

**Step 7: Commit**

```bash
git add packages/shell/
git commit -m "feat: implement shell executor with host protocol"
```

---

### Task 12: Shell Integration in Orchestrator

**Files:**
- Create: `packages/orchestrator/src/shell/shell-runner.ts`
- Test: `packages/orchestrator/src/shell/__tests__/shell-runner.test.ts`

**Step 1: Write failing tests**

```typescript
describe('ShellRunner', () => {
  it('runs a simple command', async () => {
    const sandbox = await createTestSandbox();
    const result = await sandbox.run('echo hello');
    expect(result.stdout).toBe('hello\n');
    expect(result.exitCode).toBe(0);
  });

  it('runs a pipeline', async () => {
    const sandbox = await createTestSandbox();
    await sandbox.writeFile('/home/user/data.txt',
      new TextEncoder().encode('foo\nbar\nbaz\n'));
    const result = await sandbox.run('cat /home/user/data.txt | grep bar');
    expect(result.stdout).toBe('bar\n');
  });

  it('handles redirects', async () => {
    const sandbox = await createTestSandbox();
    await sandbox.run('echo hello > /home/user/out.txt');
    const content = await sandbox.readFile('/home/user/out.txt');
    expect(new TextDecoder().decode(content)).toBe('hello\n');
  });

  it('handles && and ||', async () => {
    const sandbox = await createTestSandbox();
    const result = await sandbox.run('true && echo yes || echo no');
    expect(result.stdout).toBe('yes\n');
  });

  it('handles environment variables', async () => {
    const sandbox = await createTestSandbox();
    const result = await sandbox.run('FOO=bar && echo $FOO');
    expect(result.stdout).toBe('bar\n');
  });
});
```

**Step 2: Implement shell-runner.ts**

`ShellRunner` class. Loads the shell .wasm, sends the command string to it, handles the protocol:
- Receives `Run` requests: dispatches to ProcessManager pipeline
- Receives `Glob` requests: resolves against VFS
- Receives `ReadVar` requests: looks up in env
- Sends results back to shell
- Returns final RunResult when shell exits

**Step 3: Run integration tests**

These require the shell .wasm + at least `echo`, `cat`, `grep`, `true`, `false` .wasm binaries. Use simple Rust implementations compiled to wasm32-wasip1 for the test fixtures.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add packages/orchestrator/src/shell/
git commit -m "feat: integrate shell with orchestrator via protocol"
```

---

## Phase 4: Coreutils

After this phase: real POSIX tools available in the sandbox.

### Task 13: Compile uutils Subset to WASI

**Files:**
- Create: `packages/coreutils/uutils/Cargo.toml`
- Create: `packages/coreutils/uutils/src/bin/` (one file per tool)
- Create: `scripts/build-coreutils.sh`

**Step 1: Set up uutils as a dependency**

Create thin wrapper binaries for each tool that depend on the `uu_*` crates from uutils. Each produces one .wasm binary.

Tools to compile: cat, cp, mv, rm, mkdir, ls, touch, ln, chmod, grep, sort, uniq, wc, head, tail, cut, tr, tee, diff, comm, echo, printf, date, env, which, true, false, basename, dirname, realpath.

**Step 2: Build script**

`scripts/build-coreutils.sh` that compiles each tool to wasm32-wasip1.

**Step 3: Test compilation**

Run: `./scripts/build-coreutils.sh`
Expected: .wasm files in `target/wasm32-wasip1/release/`

**Step 4: Integration test**

Write a test that loads `cat.wasm`, runs it with a file in the VFS, verifies output.

**Step 5: Commit**

```bash
git add packages/coreutils/ scripts/
git commit -m "feat: compile uutils subset to WASI P1"
```

---

### Task 14: Compile awk, sed, find to WASI

**Files:**
- Create: `packages/coreutils/awk/` (frawk wrapper or gawk build)
- Create: `packages/coreutils/sed/` (GNU sed build via wasi-sdk)
- Create: `packages/coreutils/find/` (GNU findutils build via wasi-sdk)
- Modify: `scripts/build-coreutils.sh`

**Step 1: Evaluate frawk for awk**

Test compiling frawk to wasm32-wasip1. If it compiles cleanly, wrap it. If not, set up gawk compilation via wasi-sdk.

**Step 2: Set up wasi-sdk for C tools**

Download wasi-sdk. Write build commands for GNU sed and GNU findutils (configure + make with wasi-sdk CC/sysroot).

**Step 3: Build and test each tool**

Verify: `echo "hello world" | awk '{print $2}'` returns `world`
Verify: `echo "hello" | sed 's/hello/goodbye/'` returns `goodbye`
Verify: `find /home/user -name '*.txt'` returns correct paths

**Step 4: Register tools in ProcessManager**

Add all compiled tools to the command registry.

**Step 5: Integration tests**

Test awk, sed, find through the shell runner end-to-end.

**Step 6: Commit**

```bash
git add packages/coreutils/
git commit -m "feat: add awk (frawk), sed, find compiled to WASI"
```

---

### Task 15: Network Tools (curl/wget) and jq

**Files:**
- Create: `packages/coreutils/curl/` (Rust implementation using WASI sockets)
- Create: `packages/coreutils/jq/` (Rust jq implementation)

**Step 1: Implement a minimal curl in Rust**

Targets WASI sockets. Makes HTTP requests. The orchestrator intercepts socket syscalls and proxies through the capability bridge.

**Step 2: Implement jq in Rust**

Use `jaq` crate (Rust jq clone). Compile to wasm32-wasip1.

**Step 3: Test curl through capability bridge**

Configure allowlist, verify curl can reach allowed domains and is blocked for others.

**Step 4: Test jq**

Verify: `echo '{"name":"test","value":42}' | jq '.name'` returns `"test"`

**Step 5: Commit**

```bash
git add packages/coreutils/
git commit -m "feat: add curl, wget, jq tools"
```

---

## Phase 5: Python Integration

After this phase: `python3 script.py` works in the sandbox with numpy/pandas/matplotlib.

### Task 16: Pyodide Loader

**Files:**
- Create: `packages/orchestrator/src/python/pyodide-loader.ts`
- Test: `packages/orchestrator/src/python/__tests__/pyodide-loader.test.ts`

**Step 1: Write failing tests**

```typescript
describe('PyodideLoader', () => {
  it('loads Pyodide runtime', async () => {
    const py = await PyodideLoader.load();
    expect(py).toBeDefined();
  });

  it('runs a simple Python expression', async () => {
    const py = await PyodideLoader.load();
    const result = await py.run('print("hello from python")');
    expect(result.stdout).toBe('hello from python\n');
  });
});
```

**Step 2: Implement pyodide-loader.ts**

Wraps Pyodide initialization. Handles loading from CDN (browser) or local package (Node). Configures stdout/stderr capture.

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git add packages/orchestrator/src/python/
git commit -m "feat: add Pyodide loader with stdout capture"
```

---

### Task 17: Pyodide VFS Bridge

**Files:**
- Create: `packages/orchestrator/src/python/vfs-bridge.ts`
- Test: `packages/orchestrator/src/python/__tests__/vfs-bridge.test.ts`

**Step 1: Write failing tests**

```typescript
describe('Pyodide VFS Bridge', () => {
  it('Python can read files from VFS', async () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('hello'));
    const py = await loadPyodideWithVFS(vfs);
    const result = await py.run(`
with open('/home/user/data.txt') as f:
    print(f.read())
`);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('Python can write files visible in VFS', async () => {
    const vfs = new VFS();
    const py = await loadPyodideWithVFS(vfs);
    await py.run(`
with open('/home/user/output.txt', 'w') as f:
    f.write('from python')
`);
    expect(new TextDecoder().decode(vfs.readFile('/home/user/output.txt'))).toBe('from python');
  });

  it('Python listdir works', async () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/a.txt', new Uint8Array());
    vfs.writeFile('/home/user/b.txt', new Uint8Array());
    const py = await loadPyodideWithVFS(vfs);
    const result = await py.run(`
import os
print(sorted(os.listdir('/home/user')))
`);
    expect(result.stdout.trim()).toContain('a.txt');
    expect(result.stdout.trim()).toContain('b.txt');
  });
});
```

**Step 2: Implement vfs-bridge.ts**

Create a custom Emscripten FS backend that proxies all operations (open, read, write, close, stat, readdir, mkdir, unlink, rename) to our VFS. Mount it at `/` in Pyodide's filesystem, replacing the default MEMFS.

Key: Pyodide's FS operations are synchronous, and our VFS is synchronous (in-memory), so this is straightforward — no async bridging needed.

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git add packages/orchestrator/src/python/
git commit -m "feat: bridge Pyodide filesystem to VFS"
```

---

### Task 18: Pyodide Subprocess Bridge

**Files:**
- Create: `packages/orchestrator/src/python/subprocess-bridge.ts`
- Test: `packages/orchestrator/src/python/__tests__/subprocess-bridge.test.ts`

**Step 1: Write failing tests**

Test that Python's subprocess module routes commands back to the sandbox shell and returns correct results (stdout, stderr, exit code).

**Step 2: Implement subprocess-bridge.ts**

Monkey-patch Python's `subprocess` module in Pyodide. `subprocess.run()`, `subprocess.Popen()` all route back to the orchestrator's shell runner. The bridge:
1. Intercepts the subprocess call
2. Calls back to JS (via Pyodide's JS interop)
3. JS runs the command through ShellRunner
4. Returns stdout/stderr/exit_code to Python

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git add packages/orchestrator/src/python/
git commit -m "feat: bridge Python subprocess to sandbox shell"
```

---

### Task 19: Python Shell Integration

**Files:**
- Create: `packages/orchestrator/src/python/python-runner.ts`
- Modify: `packages/orchestrator/src/shell/shell-runner.ts`
- Test: `packages/orchestrator/src/python/__tests__/python-runner.test.ts`

**Step 1: Write failing tests**

```typescript
describe('Python via shell', () => {
  it('runs python3 script.py', async () => {
    const sandbox = await createTestSandbox();
    await sandbox.writeFile('/home/user/hello.py',
      new TextEncoder().encode('print("hello from python")'));
    const result = await sandbox.run('python3 /home/user/hello.py');
    expect(result.stdout).toBe('hello from python\n');
  });

  it('runs python3 -c "..."', async () => {
    const sandbox = await createTestSandbox();
    const result = await sandbox.run("python3 -c \"import json; print(json.dumps({'a': 1}))\"");
    expect(result.stdout.trim()).toBe('{"a": 1}');
  });

  it('python in a pipeline', async () => {
    const sandbox = await createTestSandbox();
    await sandbox.writeFile('/home/user/data.csv',
      new TextEncoder().encode('name,age\nalice,30\nbob,25\n'));
    const result = await sandbox.run(
      'cat /home/user/data.csv | python3 -c "import sys; lines=sys.stdin.readlines(); print(len(lines))"'
    );
    expect(result.stdout.trim()).toBe('3');
  });
});
```

**Step 2: Implement python-runner.ts**

`PythonRunner` wraps Pyodide with VFS bridge and subprocess bridge. Handles:
- `python3 script.py` — reads script from VFS, runs in Pyodide
- `python3 -c "code"` — runs code directly
- stdin piping — feeds stdin data to `sys.stdin`
- stdout/stderr capture

**Step 3: Modify shell-runner.ts**

When shell dispatches `python3`, route to PythonRunner instead of looking for a `python3.wasm`. The orchestrator recognizes `python3` as a special command.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add packages/orchestrator/src/python/ packages/orchestrator/src/shell/
git commit -m "feat: integrate Python execution via shell"
```

---

## Phase 6: Sandbox API and Polish

After this phase: the public API works end-to-end.

### Task 20: Public Sandbox API

**Files:**
- Create: `packages/orchestrator/src/sandbox.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Test: `packages/orchestrator/src/__tests__/sandbox.test.ts`

**Step 1: Write failing tests**

```typescript
describe('Sandbox', () => {
  it('creates a sandbox and runs a command', async () => {
    const sandbox = await Sandbox.create();
    const result = await sandbox.run('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello\n');
    sandbox.destroy();
  });

  it('file I/O through API', async () => {
    const sandbox = await Sandbox.create();
    await sandbox.writeFile('/home/user/test.txt', new TextEncoder().encode('content'));
    const data = await sandbox.readFile('/home/user/test.txt');
    expect(new TextDecoder().decode(data)).toBe('content');
    sandbox.destroy();
  });

  it('state persists across commands', async () => {
    const sandbox = await Sandbox.create();
    await sandbox.run('echo hello > /home/user/file.txt');
    const result = await sandbox.run('cat /home/user/file.txt');
    expect(result.stdout).toBe('hello\n');
    sandbox.destroy();
  });

  it('enforces timeout', async () => {
    const sandbox = await Sandbox.create({ timeoutMs: 100 });
    const result = await sandbox.run('python3 -c "while True: pass"');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('timeout');
  });

  it('tool discovery via ls /usr/bin', async () => {
    const sandbox = await Sandbox.create();
    const result = await sandbox.run('ls /usr/bin');
    expect(result.stdout).toContain('grep');
    expect(result.stdout).toContain('python3');
    expect(result.stdout).toContain('awk');
  });

  it('snapshot and restore', async () => {
    const sandbox = await Sandbox.create();
    await sandbox.run('echo before > /home/user/state.txt');
    const snap = await sandbox.snapshot();
    await sandbox.run('echo after > /home/user/state.txt');
    await sandbox.restore(snap);
    const result = await sandbox.run('cat /home/user/state.txt');
    expect(result.stdout).toBe('before\n');
    sandbox.destroy();
  });
});
```

**Step 2: Implement sandbox.ts**

The `Sandbox` class ties everything together:
- `create()` — initializes VFS (with default layout + tool entries in /bin, /usr/bin), loads platform adapter, creates ProcessManager, loads shell .wasm, optionally pre-loads Pyodide
- `run(command)` — delegates to ShellRunner, returns RunResult
- `readFile` / `writeFile` / `listDir` — delegates to VFS
- `allowNetwork` — configures capability bridge
- `mount` — adds host FS mount point
- `snapshot` / `restore` — delegates to VFS snapshots
- `destroy` — cleans up all resources

**Step 3: Export from index.ts**

```typescript
export { Sandbox, type RunResult, type SandboxOptions } from './sandbox.js';
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add packages/orchestrator/src/
git commit -m "feat: implement public Sandbox API"
```

---

### Task 21: Resource Limits

**Files:**
- Create: `packages/orchestrator/src/limits/resource-limiter.ts`
- Modify: `packages/orchestrator/src/process/manager.ts`
- Modify: `packages/orchestrator/src/vfs/vfs.ts`
- Test: `packages/orchestrator/src/limits/__tests__/resource-limiter.test.ts`

**Step 1: Write failing tests**

Test: memory limit kills a Wasm instance that tries to grow past the ceiling. VFS size limit rejects writes past the threshold. Process count limit rejects fork/spawn past the max. Timeout kills long-running commands.

**Step 2: Implement resource-limiter.ts**

Tracks: total VFS bytes used, number of active processes, per-command wall clock. Intercepts `memory.grow` callbacks, VFS writes, process spawns.

**Step 3: Integrate into ProcessManager and VFS**

ProcessManager checks limits before spawning. VFS checks size limit on write. Both throw/return appropriate errors.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add packages/orchestrator/src/
git commit -m "feat: add resource limits (memory, VFS size, process count, timeout)"
```

---

### Task 22: Capability Bridge — Network

**Files:**
- Create: `packages/orchestrator/src/capabilities/network.ts`
- Modify: `packages/orchestrator/src/wasi/wasi-host.ts`
- Test: `packages/orchestrator/src/capabilities/__tests__/network.test.ts`

**Step 1: Write failing tests**

Test: socket syscalls are intercepted. Allowed domains succeed. Blocked domains fail with EACCES. Request count limit works.

**Step 2: Implement network.ts**

`NetworkCapability` class. Manages domain allowlist. Intercepts WASI socket syscalls and HTTP-level requests from curl. Proxies allowed requests through the platform adapter's `fetch()`.

**Step 3: Wire into WASI host**

Socket-related WASI imports delegate to NetworkCapability.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add packages/orchestrator/src/
git commit -m "feat: add network capability bridge with domain allowlist"
```

---

### Task 23: Build and Package

**Files:**
- Create: `packages/orchestrator/tsup.config.ts`
- Create: `scripts/build-all.sh`
- Modify: `package.json`

**Step 1: Configure tsup**

Dual ESM + CJS output. External dependencies (Pyodide). Tree-shakeable browser entry point.

```typescript
import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: true,
    clean: true,
    external: ['pyodide'],
  },
]);
```

**Step 2: Build script**

`scripts/build-all.sh`:
1. Compile Rust tools to wasm32-wasip1 (shell + coreutils)
2. Copy .wasm files to `packages/orchestrator/assets/`
3. Build TS orchestrator with tsup

**Step 3: Test the built package**

Write a smoke test that imports from the built dist and runs a command.

**Step 4: Verify browser bundle size**

Check that the total size (TS bundle + .wasm assets, before Pyodide) is reasonable.

**Step 5: Commit**

```bash
git add packages/ scripts/
git commit -m "feat: add build pipeline and packaging"
```

---

## Phase 7: End-to-End Testing

### Task 24: Integration Test Suite

**Files:**
- Create: `packages/orchestrator/src/__tests__/e2e/` (test directory)

Write comprehensive end-to-end tests that exercise the full sandbox:

```typescript
describe('E2E: Data analysis workflow', () => {
  it('processes CSV with shell tools', async () => {
    const sandbox = await Sandbox.create();
    await sandbox.writeFile('/home/user/data.csv',
      new TextEncoder().encode('name,score\nalice,95\nbob,87\ncharlie,92\n'));
    const result = await sandbox.run(
      'cat /home/user/data.csv | tail -n +2 | sort -t, -k2 -nr | head -1'
    );
    expect(result.stdout).toContain('alice');
  });

  it('processes data with Python', async () => {
    const sandbox = await Sandbox.create();
    await sandbox.writeFile('/home/user/data.csv',
      new TextEncoder().encode('name,score\nalice,95\nbob,87\ncharlie,92\n'));
    const result = await sandbox.run(`python3 -c "
import pandas as pd
df = pd.read_csv('/home/user/data.csv')
print(df['score'].mean())
"`);
    expect(parseFloat(result.stdout.trim())).toBeCloseTo(91.33, 1);
  });

  it('generates a plot with matplotlib', async () => {
    const sandbox = await Sandbox.create();
    await sandbox.run(`python3 -c "
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.plot([1,2,3], [1,4,9])
plt.savefig('/home/user/plot.png')
"`);
    const png = await sandbox.readFile('/home/user/plot.png');
    expect(png.length).toBeGreaterThan(0);
    // PNG magic bytes
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
  });

  it('uses jq for JSON processing', async () => {
    const sandbox = await Sandbox.create();
    await sandbox.writeFile('/home/user/data.json',
      new TextEncoder().encode('{"users":[{"name":"alice"},{"name":"bob"}]}'));
    const result = await sandbox.run('cat /home/user/data.json | jq ".users[].name"');
    expect(result.stdout).toContain('alice');
    expect(result.stdout).toContain('bob');
  });

  it('complex pipeline with awk and sed', async () => {
    const sandbox = await Sandbox.create();
    await sandbox.writeFile('/home/user/log.txt',
      new TextEncoder().encode(
        'ERROR: disk full\nINFO: started\nERROR: timeout\nINFO: stopped\n'
      ));
    const result = await sandbox.run(
      "grep ERROR /home/user/log.txt | sed 's/ERROR: //' | sort"
    );
    expect(result.stdout).toBe('disk full\ntimeout\n');
  });

  it('find with pattern matching', async () => {
    const sandbox = await Sandbox.create();
    await sandbox.run('mkdir -p /home/user/src');
    await sandbox.writeFile('/home/user/src/a.py', new TextEncoder().encode('# file a'));
    await sandbox.writeFile('/home/user/src/b.py', new TextEncoder().encode('# file b'));
    await sandbox.writeFile('/home/user/src/c.txt', new TextEncoder().encode('not python'));
    const result = await sandbox.run('find /home/user/src -name "*.py" | sort');
    expect(result.stdout).toBe('/home/user/src/a.py\n/home/user/src/b.py\n');
  });

  it('session state persists across commands', async () => {
    const sandbox = await Sandbox.create();
    await sandbox.run('export MYVAR=hello');
    await sandbox.run('echo $MYVAR > /home/user/env.txt');
    const result = await sandbox.run('cat /home/user/env.txt');
    expect(result.stdout.trim()).toBe('hello');
  });
});
```

**Commit:**

```bash
git add packages/orchestrator/src/__tests__/
git commit -m "test: add end-to-end integration test suite"
```

---

## Summary of Phases

| Phase | Deliverable | Key Milestone |
|-------|-------------|---------------|
| 1 | VFS | In-memory filesystem with POSIX semantics, COW snapshots, pipes |
| 2 | WASI Host + Process Manager | Can load and run .wasm binaries with VFS-backed syscalls |
| 3 | Shell | Bash-subset parser + executor, integrated with orchestrator |
| 4 | Coreutils | Real awk/sed/find/grep/etc. compiled to WASI, available in sandbox |
| 5 | Python | Pyodide integrated with shared VFS and subprocess bridge |
| 6 | API + Polish | Public Sandbox API, resource limits, capability bridge, packaging |
| 7 | E2E Tests | Full workflow tests proving the sandbox works for LLM use cases |

Each phase builds on the previous one and produces something testable. Phase 2 is the first time you can run a Wasm binary. Phase 3 adds the shell. Phase 4 makes it useful. Phase 5 adds Python. Phase 6 wraps it up.
