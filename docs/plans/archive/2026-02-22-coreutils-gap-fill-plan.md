# Coreutils Gap-Fill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fill coreutils gaps vs. busybox so LLM-generated shell scripts work out of the box. Add `test`/`[` and `pwd` as shell builtins, plus 17 new Rust coreutil binaries.

**Architecture:** Shell builtins are added to `shell-runner.ts` alongside existing `which` and `chmod`. Rust coreutils follow the existing pattern in `packages/coreutils/src/bin/` — each is a standalone `fn main()` that reads args, processes stdin/files, writes to stdout/stderr. All build to `wasm32-wasip1` via the existing workspace.

**Tech Stack:** Rust (wasm32-wasip1), TypeScript (shell builtins), vitest.

---

### Task 1: Add `test`/`[` and `pwd` Shell Builtins

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-runner.ts`
- Modify: `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`

**Context:** `test` and `[` evaluate conditional expressions (file tests, string comparisons, integer comparisons). `pwd` prints the current working directory. These are added as TypeScript builtins in ShellRunner, like `which` and `chmod`. The `[` command is identical to `test` except it requires a trailing `]` argument.

**Step 1: Write failing tests**

Add to `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`, inside a new `describe('test / [ builtin')` block:

```typescript
describe('test / [ builtin', () => {
  it('test -f on existing file', async () => {
    vfs.writeFile('/tmp/exists.txt', new TextEncoder().encode('hi'));
    const result = await runner.run('test -f /tmp/exists.txt && echo yes');
    expect(result.stdout.trim()).toBe('yes');
  });

  it('test -f on missing file', async () => {
    const result = await runner.run('test -f /tmp/nope.txt && echo yes || echo no');
    expect(result.stdout.trim()).toBe('no');
  });

  it('test -d on directory', async () => {
    const result = await runner.run('test -d /tmp && echo yes');
    expect(result.stdout.trim()).toBe('yes');
  });

  it('test -e on existing path', async () => {
    vfs.writeFile('/tmp/e.txt', new TextEncoder().encode(''));
    const result = await runner.run('test -e /tmp/e.txt && echo yes');
    expect(result.stdout.trim()).toBe('yes');
  });

  it('test -z on empty string', async () => {
    const result = await runner.run('test -z "" && echo yes');
    expect(result.stdout.trim()).toBe('yes');
  });

  it('test -n on non-empty string', async () => {
    const result = await runner.run('test -n "hello" && echo yes');
    expect(result.stdout.trim()).toBe('yes');
  });

  it('test string equality', async () => {
    const result = await runner.run('test "abc" = "abc" && echo yes');
    expect(result.stdout.trim()).toBe('yes');
  });

  it('test string inequality', async () => {
    const result = await runner.run('test "abc" != "xyz" && echo yes');
    expect(result.stdout.trim()).toBe('yes');
  });

  it('test integer -eq', async () => {
    const result = await runner.run('test 5 -eq 5 && echo yes');
    expect(result.stdout.trim()).toBe('yes');
  });

  it('test integer -gt', async () => {
    const result = await runner.run('test 10 -gt 5 && echo yes');
    expect(result.stdout.trim()).toBe('yes');
  });

  it('test integer -lt', async () => {
    const result = await runner.run('test 3 -lt 7 && echo yes');
    expect(result.stdout.trim()).toBe('yes');
  });

  it('test ! negation', async () => {
    const result = await runner.run('test ! -f /tmp/nope && echo yes');
    expect(result.stdout.trim()).toBe('yes');
  });

  it('[ ] bracket syntax', async () => {
    vfs.writeFile('/tmp/b.txt', new TextEncoder().encode('hi'));
    const result = await runner.run('[ -f /tmp/b.txt ] && echo yes');
    expect(result.stdout.trim()).toBe('yes');
  });

  it('[ ] missing closing bracket fails', async () => {
    const result = await runner.run('[ -f /tmp/b.txt && echo yes || echo no');
    expect(result.stdout.trim()).toBe('no');
  });
});

describe('pwd builtin', () => {
  it('prints default cwd', async () => {
    const result = await runner.run('pwd');
    expect(result.stdout.trim()).toBe('/');
  });

  it('prints cwd after cd', async () => {
    vfs.mkdir('/tmp/mydir');
    const result = await runner.run('cd /tmp/mydir && pwd');
    expect(result.stdout.trim()).toBe('/tmp/mydir');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/orchestrator && npx vitest run -t "test / \\[ builtin|pwd builtin"`

Expected: Failures — `test`, `[`, and `pwd` are not recognized commands.

**Step 3: Implement the builtins**

In `packages/orchestrator/src/shell/shell-runner.ts`:

Update the `SHELL_BUILTINS` set:
```typescript
const SHELL_BUILTINS = new Set(['which', 'chmod', 'test', '[', 'pwd']);
```

Add after the `builtinChmod` method:

```typescript
/** Builtin: pwd — print working directory. */
private builtinPwd(): RunResult {
  const cwd = this.env.get('PWD') || '/';
  return { exitCode: 0, stdout: cwd + '\n', stderr: '', executionTimeMs: 0 };
}

/** Builtin: test / [ — evaluate conditional expressions. */
private builtinTest(args: string[], isBracket: boolean): RunResult {
  // If [ syntax, require and strip trailing ]
  if (isBracket) {
    if (args.length === 0 || args[args.length - 1] !== ']') {
      return { exitCode: 2, stdout: '', stderr: '[: missing \']\'\n', executionTimeMs: 0 };
    }
    args = args.slice(0, -1);
  }

  const result = this.evalTest(args);
  return { exitCode: result ? 0 : 1, stdout: '', stderr: '', executionTimeMs: 0 };
}

private evalTest(args: string[]): boolean {
  if (args.length === 0) return false;

  // Handle ! negation
  if (args[0] === '!' && args.length > 1) {
    return !this.evalTest(args.slice(1));
  }

  // Unary operators
  if (args.length === 2) {
    const [op, val] = args;
    switch (op) {
      case '-f': {
        try { const s = this.vfs.stat(this.resolvePath(val)); return s.isFile; }
        catch { return false; }
      }
      case '-d': {
        try { const s = this.vfs.stat(this.resolvePath(val)); return s.isDirectory; }
        catch { return false; }
      }
      case '-e': {
        try { this.vfs.stat(this.resolvePath(val)); return true; }
        catch { return false; }
      }
      case '-s': {
        try { const s = this.vfs.stat(this.resolvePath(val)); return s.size > 0; }
        catch { return false; }
      }
      case '-r': case '-w': case '-x': {
        try { this.vfs.stat(this.resolvePath(val)); return true; }
        catch { return false; }
      }
      case '-z': return val.length === 0;
      case '-n': return val.length > 0;
      default: break;
    }
  }

  // Single arg: true if non-empty string
  if (args.length === 1) {
    return args[0].length > 0;
  }

  // Binary operators
  if (args.length === 3) {
    const [left, op, right] = args;
    switch (op) {
      case '=': case '==': return left === right;
      case '!=': return left !== right;
      case '-eq': return parseInt(left) === parseInt(right);
      case '-ne': return parseInt(left) !== parseInt(right);
      case '-lt': return parseInt(left) < parseInt(right);
      case '-le': return parseInt(left) <= parseInt(right);
      case '-gt': return parseInt(left) > parseInt(right);
      case '-ge': return parseInt(left) >= parseInt(right);
      default: return false;
    }
  }

  return false;
}
```

Add the routing in `execSimpleCommand` after the `chmod` check (around line 293):

```typescript
if (cmdName === 'test') {
  return this.builtinTest(args, false);
}
if (cmdName === '[') {
  return this.builtinTest(args, true);
}
if (cmdName === 'pwd') {
  return this.builtinPwd();
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/orchestrator && npx vitest run`

Expected: All tests pass including the new `test`/`[` and `pwd` tests.

**Step 5: Commit**

```bash
git add packages/orchestrator/src/shell/shell-runner.ts packages/orchestrator/src/shell/__tests__/coreutils.test.ts
git commit -m "feat: add test/[ and pwd shell builtins"
```

---

### Task 2: Add Trivial Coreutils (uname, whoami, id, printenv, yes, rmdir, sleep, seq)

**Files:**
- Create: `packages/coreutils/src/bin/uname.rs`
- Create: `packages/coreutils/src/bin/whoami.rs`
- Create: `packages/coreutils/src/bin/id.rs`
- Create: `packages/coreutils/src/bin/printenv.rs`
- Create: `packages/coreutils/src/bin/yes.rs`
- Create: `packages/coreutils/src/bin/rmdir.rs`
- Create: `packages/coreutils/src/bin/sleep.rs`
- Create: `packages/coreutils/src/bin/seq.rs`
- Modify: `packages/coreutils/Cargo.toml` (add 8 [[bin]] entries)
- Modify: `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`

**Context:** Each of these is a tiny Rust binary following the same pattern as existing coreutils. They read args via `std::env::args()`, write to `std::io::stdout()`, and exit with a status code.

**Step 1: Write failing tests**

Add to `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`:

```typescript
describe('new coreutils', () => {
  it('uname returns wasmsand', async () => {
    const result = await runner.run('uname');
    expect(result.stdout.trim()).toBe('wasmsand');
  });

  it('uname -a returns full info', async () => {
    const result = await runner.run('uname -a');
    expect(result.stdout).toContain('wasmsand');
  });

  it('whoami returns user', async () => {
    const result = await runner.run('whoami');
    expect(result.stdout.trim()).toBe('user');
  });

  it('id returns uid info', async () => {
    const result = await runner.run('id');
    expect(result.stdout).toContain('uid=1000');
    expect(result.stdout).toContain('user');
  });

  it('printenv shows all env vars', async () => {
    runner.setEnv('FOO', 'bar');
    const result = await runner.run('printenv FOO');
    expect(result.stdout.trim()).toBe('bar');
  });

  it('printenv missing var exits 1', async () => {
    const result = await runner.run('printenv NONEXISTENT');
    expect(result.exitCode).toBe(1);
  });

  it('yes outputs repeated lines', async () => {
    const result = await runner.run('yes hello | head -3');
    expect(result.stdout).toBe('hello\nhello\nhello\n');
  });

  it('rmdir removes empty directory', async () => {
    await runner.run('mkdir /tmp/emptydir');
    const result = await runner.run('rmdir /tmp/emptydir');
    expect(result.exitCode).toBe(0);
    const ls = await runner.run('ls /tmp');
    expect(ls.stdout).not.toContain('emptydir');
  });

  it('rmdir fails on non-empty directory', async () => {
    await runner.run('mkdir /tmp/notempty');
    await runner.run('touch /tmp/notempty/file');
    const result = await runner.run('rmdir /tmp/notempty');
    expect(result.exitCode).not.toBe(0);
  });

  it('sleep exits 0', async () => {
    const result = await runner.run('sleep 0');
    expect(result.exitCode).toBe(0);
  });

  it('seq generates range', async () => {
    const result = await runner.run('seq 1 5');
    expect(result.stdout).toBe('1\n2\n3\n4\n5\n');
  });

  it('seq single arg', async () => {
    const result = await runner.run('seq 3');
    expect(result.stdout).toBe('1\n2\n3\n');
  });

  it('seq with step', async () => {
    const result = await runner.run('seq 2 2 8');
    expect(result.stdout).toBe('2\n4\n6\n8\n');
  });
});
```

**Step 2: Implement the Rust binaries**

`packages/coreutils/src/bin/uname.rs`:
```rust
use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "-a") {
        println!("wasmsand wasmsand 0.1.0 wasm32-wasip1");
    } else {
        println!("wasmsand");
    }
}
```

`packages/coreutils/src/bin/whoami.rs`:
```rust
fn main() {
    println!("user");
}
```

`packages/coreutils/src/bin/id.rs`:
```rust
fn main() {
    println!("uid=1000(user) gid=1000(user) groups=1000(user)");
}
```

`packages/coreutils/src/bin/printenv.rs`:
```rust
use std::env;
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        for (key, val) in env::vars() {
            println!("{key}={val}");
        }
    } else {
        for name in &args {
            match env::var(name) {
                Ok(val) => println!("{val}"),
                Err(_) => process::exit(1),
            }
        }
    }
}
```

`packages/coreutils/src/bin/yes.rs`:
```rust
use std::env;
use std::io::{self, Write, BufWriter};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let line = if args.is_empty() { "y".to_string() } else { args.join(" ") };
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    loop {
        if writeln!(out, "{line}").is_err() {
            break;
        }
    }
}
```

`packages/coreutils/src/bin/rmdir.rs`:
```rust
use std::env;
use std::fs;
use std::process;

fn main() {
    let mut exit_code = 0;
    for arg in env::args().skip(1) {
        if let Err(e) = fs::remove_dir(&arg) {
            eprintln!("rmdir: failed to remove '{arg}': {e}");
            exit_code = 1;
        }
    }
    process::exit(exit_code);
}
```

`packages/coreutils/src/bin/sleep.rs`:
```rust
fn main() {
    // No-op in WASI sandbox — sleep is a stub that exits immediately.
    // Accepts and ignores all arguments for compatibility.
}
```

`packages/coreutils/src/bin/seq.rs`:
```rust
use std::env;
use std::io::{self, Write, BufWriter};
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let (first, step, last) = match args.len() {
        1 => (1i64, 1i64, args[0].parse::<i64>().unwrap_or_else(|_| { eprintln!("seq: invalid argument"); process::exit(1); })),
        2 => {
            let a = args[0].parse::<i64>().unwrap_or_else(|_| { eprintln!("seq: invalid argument"); process::exit(1); });
            let b = args[1].parse::<i64>().unwrap_or_else(|_| { eprintln!("seq: invalid argument"); process::exit(1); });
            (a, 1, b)
        }
        3 => {
            let a = args[0].parse::<i64>().unwrap_or_else(|_| { eprintln!("seq: invalid argument"); process::exit(1); });
            let s = args[1].parse::<i64>().unwrap_or_else(|_| { eprintln!("seq: invalid argument"); process::exit(1); });
            let b = args[2].parse::<i64>().unwrap_or_else(|_| { eprintln!("seq: invalid argument"); process::exit(1); });
            (a, s, b)
        }
        _ => { eprintln!("seq: usage: seq [FIRST [STEP]] LAST"); process::exit(1); }
    };

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let mut i = first;
    if step > 0 {
        while i <= last {
            let _ = writeln!(out, "{i}");
            i += step;
        }
    } else if step < 0 {
        while i >= last {
            let _ = writeln!(out, "{i}");
            i += step;
        }
    }
}
```

**Step 3: Add [[bin]] entries to Cargo.toml**

Append to `packages/coreutils/Cargo.toml`:

```toml
[[bin]]
name = "uname"
path = "src/bin/uname.rs"

[[bin]]
name = "whoami"
path = "src/bin/whoami.rs"

[[bin]]
name = "id"
path = "src/bin/id.rs"

[[bin]]
name = "printenv"
path = "src/bin/printenv.rs"

[[bin]]
name = "yes"
path = "src/bin/yes.rs"

[[bin]]
name = "rmdir"
path = "src/bin/rmdir.rs"

[[bin]]
name = "sleep"
path = "src/bin/sleep.rs"

[[bin]]
name = "seq"
path = "src/bin/seq.rs"
```

**Step 4: Build the WASM binaries**

Run: `cargo build --release --target wasm32-wasip1 -p wasmsand-coreutils`

Expected: All binaries compile. New .wasm files appear in `target/wasm32-wasip1/release/`.

**Step 5: Copy new binaries to test fixtures**

```bash
for tool in uname whoami id printenv yes rmdir sleep seq; do
  cp target/wasm32-wasip1/release/${tool}.wasm packages/orchestrator/src/platform/__tests__/fixtures/
done
```

**Step 6: Register new tools in test setup**

In `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`, add to the `TOOLS` array:

```typescript
const TOOLS = [
  'cat', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep',
  'ls', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'tee', 'tr', 'cut',
  'basename', 'dirname', 'env', 'printf',
  'find', 'sed', 'awk', 'jq',
  'true', 'false',
  'uname', 'whoami', 'id', 'printenv', 'yes', 'rmdir', 'sleep', 'seq',
];
```

**Step 7: Run tests**

Run: `cd packages/orchestrator && npx vitest run`

Expected: All tests pass including the new coreutils tests.

**Step 8: Commit**

```bash
git add packages/coreutils/ packages/orchestrator/src/platform/__tests__/fixtures/*.wasm packages/orchestrator/src/shell/__tests__/coreutils.test.ts
git commit -m "feat: add uname, whoami, id, printenv, yes, rmdir, sleep, seq coreutils"
```

---

### Task 3: Add File/Path Coreutils (ln, readlink, realpath, mktemp, tac)

**Files:**
- Create: `packages/coreutils/src/bin/ln.rs`
- Create: `packages/coreutils/src/bin/readlink.rs`
- Create: `packages/coreutils/src/bin/realpath.rs`
- Create: `packages/coreutils/src/bin/mktemp.rs`
- Create: `packages/coreutils/src/bin/tac.rs`
- Modify: `packages/coreutils/Cargo.toml` (add 5 [[bin]] entries)
- Modify: `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`

**Step 1: Write failing tests**

```typescript
describe('file/path coreutils', () => {
  it('ln creates a copy (no symlink support)', async () => {
    await runner.run('echo "content" > /tmp/orig.txt');
    const result = await runner.run('ln /tmp/orig.txt /tmp/link.txt');
    expect(result.exitCode).toBe(0);
    const cat = await runner.run('cat /tmp/link.txt');
    expect(cat.stdout).toContain('content');
  });

  it('readlink on non-link returns path', async () => {
    await runner.run('echo hi > /tmp/rfile.txt');
    const result = await runner.run('readlink -f /tmp/rfile.txt');
    expect(result.stdout.trim()).toBe('/tmp/rfile.txt');
  });

  it('realpath resolves absolute path', async () => {
    const result = await runner.run('realpath /tmp/../tmp/file.txt');
    expect(result.stdout.trim()).toBe('/tmp/file.txt');
  });

  it('mktemp creates a temp file', async () => {
    const result = await runner.run('mktemp');
    expect(result.exitCode).toBe(0);
    const path = result.stdout.trim();
    expect(path).toMatch(/^\/tmp\//);
    const cat = await runner.run(`test -e ${path} && echo exists`);
    expect(cat.stdout.trim()).toBe('exists');
  });

  it('tac reverses lines', async () => {
    await runner.run('printf "a\\nb\\nc\\n" > /tmp/lines.txt');
    const result = await runner.run('tac /tmp/lines.txt');
    expect(result.stdout).toBe('c\nb\na\n');
  });

  it('tac from stdin', async () => {
    const result = await runner.run('printf "1\\n2\\n3\\n" | tac');
    expect(result.stdout).toBe('3\n2\n1\n');
  });
});
```

**Step 2: Implement the Rust binaries**

`packages/coreutils/src/bin/ln.rs`:
```rust
use std::env;
use std::fs;
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    // Skip flags like -s, -f (symlinks not supported in VFS, just copy)
    let paths: Vec<&str> = args.iter().filter(|a| !a.starts_with('-')).map(|s| s.as_str()).collect();
    if paths.len() != 2 {
        eprintln!("ln: usage: ln SOURCE DEST");
        process::exit(1);
    }
    match fs::copy(paths[0], paths[1]) {
        Ok(_) => {}
        Err(e) => {
            eprintln!("ln: {}: {e}", paths[0]);
            process::exit(1);
        }
    }
}
```

`packages/coreutils/src/bin/readlink.rs`:
```rust
use std::env;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    // No real symlinks in VFS — just print the path (-f canonicalizes)
    let paths: Vec<&str> = args.iter().filter(|a| !a.starts_with('-')).map(|s| s.as_str()).collect();
    for path in paths {
        println!("{path}");
    }
}
```

`packages/coreutils/src/bin/realpath.rs`:
```rust
use std::env;

fn main() {
    for arg in env::args().skip(1) {
        if arg.starts_with('-') { continue; }
        // Simple path normalization: resolve . and ..
        let mut parts: Vec<&str> = Vec::new();
        for component in arg.split('/') {
            match component {
                "" | "." => {}
                ".." => { parts.pop(); }
                s => parts.push(s),
            }
        }
        println!("/{}", parts.join("/"));
    }
}
```

`packages/coreutils/src/bin/mktemp.rs`:
```rust
use std::fs;

fn main() {
    // Generate a pseudo-random temp filename
    // In WASI we don't have /dev/urandom easily, use a simple counter approach
    let mut name = String::from("/tmp/tmp.");
    // Use the address of a stack variable as entropy (not cryptographic, just unique)
    let val: usize = 0;
    let addr = &val as *const usize as usize;
    for i in 0..8 {
        let c = (((addr >> (i * 4)) & 0xF) as u8).wrapping_add(b'a');
        name.push(c as char);
    }
    // Create the file
    if let Err(e) = fs::write(&name, "") {
        eprintln!("mktemp: {e}");
        std::process::exit(1);
    }
    println!("{name}");
}
```

`packages/coreutils/src/bin/tac.rs`:
```rust
use std::env;
use std::fs;
use std::io::{self, Read, Write};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let input = if args.is_empty() || args[0] == "-" {
        let mut buf = String::new();
        io::stdin().read_to_string(&mut buf).unwrap_or(0);
        buf
    } else {
        let mut combined = String::new();
        for path in &args {
            match fs::read_to_string(path) {
                Ok(s) => combined.push_str(&s),
                Err(e) => {
                    eprintln!("tac: {path}: {e}");
                    std::process::exit(1);
                }
            }
        }
        combined
    };

    let mut lines: Vec<&str> = input.split('\n').collect();
    // Remove trailing empty element from final newline
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines.reverse();

    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in lines {
        let _ = writeln!(out, "{line}");
    }
}
```

**Step 3: Add [[bin]] entries to Cargo.toml**

Append to `packages/coreutils/Cargo.toml`:

```toml
[[bin]]
name = "ln"
path = "src/bin/ln.rs"

[[bin]]
name = "readlink"
path = "src/bin/readlink.rs"

[[bin]]
name = "realpath"
path = "src/bin/realpath.rs"

[[bin]]
name = "mktemp"
path = "src/bin/mktemp.rs"

[[bin]]
name = "tac"
path = "src/bin/tac.rs"
```

**Step 4: Build, copy fixtures, register tools, run tests**

```bash
cargo build --release --target wasm32-wasip1 -p wasmsand-coreutils
for tool in ln readlink realpath mktemp tac; do
  cp target/wasm32-wasip1/release/${tool}.wasm packages/orchestrator/src/platform/__tests__/fixtures/
done
```

Add `'ln', 'readlink', 'realpath', 'mktemp', 'tac'` to the `TOOLS` array in the test file.

Run: `cd packages/orchestrator && npx vitest run`

Expected: All tests pass.

**Step 5: Commit**

```bash
git add packages/coreutils/ packages/orchestrator/src/platform/__tests__/fixtures/*.wasm packages/orchestrator/src/shell/__tests__/coreutils.test.ts
git commit -m "feat: add ln, readlink, realpath, mktemp, tac coreutils"
```

---

### Task 4: Add xargs and expr Coreutils

**Files:**
- Create: `packages/coreutils/src/bin/xargs.rs`
- Create: `packages/coreutils/src/bin/expr.rs`
- Modify: `packages/coreutils/Cargo.toml`
- Modify: `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`

**Context:** `xargs` is more complex than the others — it reads stdin, splits into arguments, and builds command lines. In a WASI sandbox, xargs executes by printing the command that would be run (since it can't fork). Actually, a simpler approach: xargs just passes stdin lines as arguments to the command. Since the shell handles execution, xargs in a pipeline like `find . | xargs grep foo` can work by outputting the arguments and letting the shell handle it. BUT the standard behavior is that xargs itself runs the command. In WASI, we can't fork/exec. So xargs should read stdin lines and print them as space-separated arguments appended to the command — essentially `xargs echo` is the default.

Actually, the simplest useful xargs: read lines from stdin, concatenate them space-separated, and print to stdout. When a command is given (`xargs CMD`), print `CMD arg1 arg2 ...` — but since WASI can't exec, just concatenate args and print. The shell can then use command substitution: `grep -l pattern $(find . -name "*.txt" | xargs)`.

Wait — simpler: `xargs` with no command defaults to `echo`. So `find . | xargs` just prints all found paths on one line. `xargs -I{} CMD {}` replaces `{}` with each line. For MVP, support: `xargs` (echo mode) and `xargs CMD` (append args to cmd and print).

Actually for WASI: xargs just concatenates stdin lines and passes them as args to the given command. Since we can't exec, we output the concatenated result. The pipeline `find /tmp -name "*.txt" | xargs cat` won't work because xargs can't invoke cat. This is a fundamental WASI limitation.

Simplest useful approach: **xargs reads stdin lines and outputs them space-separated** (default echo behavior). For `xargs -I{}`, output each line with the replacement. This covers the most common LLM patterns.

**Step 1: Write failing tests**

```typescript
describe('xargs and expr', () => {
  it('xargs concatenates stdin lines', async () => {
    const result = await runner.run('printf "a\\nb\\nc\\n" | xargs');
    expect(result.stdout.trim()).toBe('a b c');
  });

  it('xargs with echo', async () => {
    const result = await runner.run('printf "hello\\nworld\\n" | xargs echo');
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('xargs -n1 one per line', async () => {
    const result = await runner.run('printf "a\\nb\\nc\\n" | xargs -n1');
    expect(result.stdout).toBe('a\nb\nc\n');
  });

  it('expr arithmetic', async () => {
    const result = await runner.run('expr 3 + 4');
    expect(result.stdout.trim()).toBe('7');
  });

  it('expr multiplication', async () => {
    const result = await runner.run('expr 6 \\* 3');
    expect(result.stdout.trim()).toBe('18');
  });

  it('expr string length', async () => {
    const result = await runner.run('expr length "hello"');
    expect(result.stdout.trim()).toBe('5');
  });

  it('expr comparison', async () => {
    const result = await runner.run('expr 5 \\> 3');
    expect(result.stdout.trim()).toBe('1');
  });
});
```

**Step 2: Implement xargs**

`packages/coreutils/src/bin/xargs.rs`:
```rust
use std::env;
use std::io::{self, Read, Write, BufWriter};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    // Parse flags
    let mut max_args: Option<usize> = None;
    let mut cmd_start = 0;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-n" && i + 1 < args.len() {
            max_args = args[i + 1].parse().ok();
            i += 2;
            cmd_start = i;
        } else {
            break;
        }
    }

    // Read all stdin
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap_or(0);

    let items: Vec<&str> = input.split_whitespace().collect();
    if items.is_empty() { return; }

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    // Command prefix (args after flags, or "echo" by default)
    let cmd_parts: Vec<&str> = if cmd_start < args.len() {
        args[cmd_start..].iter().map(|s| s.as_str()).collect()
    } else {
        vec![]
    };

    match max_args {
        Some(n) => {
            for chunk in items.chunks(n) {
                if !cmd_parts.is_empty() {
                    let _ = write!(out, "{}", cmd_parts.join(" "));
                    if !chunk.is_empty() {
                        let _ = write!(out, " ");
                    }
                }
                let _ = writeln!(out, "{}", chunk.join(" "));
            }
        }
        None => {
            if !cmd_parts.is_empty() {
                let _ = write!(out, "{} ", cmd_parts.join(" "));
            }
            let _ = writeln!(out, "{}", items.join(" "));
        }
    }
}
```

**Step 3: Implement expr**

`packages/coreutils/src/bin/expr.rs`:
```rust
use std::env;
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("expr: missing operand");
        process::exit(2);
    }

    // Handle "length STRING"
    if args.len() == 2 && args[0] == "length" {
        println!("{}", args[1].len());
        return;
    }

    // Handle binary operations: expr A OP B
    if args.len() == 3 {
        let left = &args[0];
        let op = &args[1];
        let right = &args[2];

        // Try integer operations
        if let (Ok(l), Ok(r)) = (left.parse::<i64>(), right.parse::<i64>()) {
            let result = match op.as_str() {
                "+" => l + r,
                "-" => l - r,
                "*" => l * r,
                "/" => {
                    if r == 0 { eprintln!("expr: division by zero"); process::exit(2); }
                    l / r
                }
                "%" => {
                    if r == 0 { eprintln!("expr: division by zero"); process::exit(2); }
                    l % r
                }
                "<" => if l < r { 1 } else { 0 },
                "<=" => if l <= r { 1 } else { 0 },
                ">" => if l > r { 1 } else { 0 },
                ">=" => if l >= r { 1 } else { 0 },
                "=" => if l == r { 1 } else { 0 },
                "!=" => if l != r { 1 } else { 0 },
                _ => { eprintln!("expr: unknown operator: {op}"); process::exit(2); }
            };
            println!("{result}");
            if result == 0 { process::exit(1); }
            return;
        }

        // String comparison
        let result = match op.as_str() {
            "=" => if left == right { 1 } else { 0 },
            "!=" => if left != right { 1 } else { 0 },
            _ => { eprintln!("expr: non-integer argument"); process::exit(2); }
        };
        println!("{result}");
        if result == 0 { process::exit(1); }
        return;
    }

    // Single arg: print it (non-zero string = true)
    if args.len() == 1 {
        println!("{}", args[0]);
        if args[0].is_empty() || args[0] == "0" {
            process::exit(1);
        }
        return;
    }

    eprintln!("expr: syntax error");
    process::exit(2);
}
```

**Step 4: Add [[bin]] entries, build, copy, register, test**

Append to `packages/coreutils/Cargo.toml`:
```toml
[[bin]]
name = "xargs"
path = "src/bin/xargs.rs"

[[bin]]
name = "expr"
path = "src/bin/expr.rs"
```

Build, copy, add `'xargs', 'expr'` to `TOOLS`, run tests.

**Step 5: Commit**

```bash
git add packages/coreutils/ packages/orchestrator/src/platform/__tests__/fixtures/*.wasm packages/orchestrator/src/shell/__tests__/coreutils.test.ts
git commit -m "feat: add xargs and expr coreutils"
```

---

### Task 5: Add diff Coreutil

**Files:**
- Create: `packages/coreutils/src/bin/diff.rs`
- Modify: `packages/coreutils/Cargo.toml`
- Modify: `packages/orchestrator/src/shell/__tests__/coreutils.test.ts`

**Context:** `diff` compares two files line by line. A minimal implementation outputs unified-style diff or simple line-by-line differences. For MVP, output lines that differ with `<` and `>` prefixes (normal diff format).

**Step 1: Write failing tests**

```typescript
describe('diff', () => {
  it('identical files show no output', async () => {
    await runner.run('echo "hello" > /tmp/a.txt');
    await runner.run('echo "hello" > /tmp/b.txt');
    const result = await runner.run('diff /tmp/a.txt /tmp/b.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('different files show differences', async () => {
    await runner.run('printf "a\\nb\\nc\\n" > /tmp/d1.txt');
    await runner.run('printf "a\\nB\\nc\\n" > /tmp/d2.txt');
    const result = await runner.run('diff /tmp/d1.txt /tmp/d2.txt');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('< b');
    expect(result.stdout).toContain('> B');
  });
});
```

**Step 2: Implement diff**

`packages/coreutils/src/bin/diff.rs`:
```rust
use std::env;
use std::fs;
use std::io::{self, Write};
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let paths: Vec<&str> = args.iter().filter(|a| !a.starts_with('-')).map(|s| s.as_str()).collect();
    if paths.len() != 2 {
        eprintln!("diff: usage: diff FILE1 FILE2");
        process::exit(2);
    }

    let content1 = match fs::read_to_string(paths[0]) {
        Ok(s) => s,
        Err(e) => { eprintln!("diff: {}: {e}", paths[0]); process::exit(2); }
    };
    let content2 = match fs::read_to_string(paths[1]) {
        Ok(s) => s,
        Err(e) => { eprintln!("diff: {}: {e}", paths[1]); process::exit(2); }
    };

    let lines1: Vec<&str> = content1.lines().collect();
    let lines2: Vec<&str> = content2.lines().collect();

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut differs = false;
    let max = lines1.len().max(lines2.len());

    for i in 0..max {
        let l1 = lines1.get(i).copied().unwrap_or("");
        let l2 = lines2.get(i).copied().unwrap_or("");
        if l1 != l2 {
            differs = true;
            let _ = writeln!(out, "{}c{}", i + 1, i + 1);
            let _ = writeln!(out, "< {l1}");
            let _ = writeln!(out, "---");
            let _ = writeln!(out, "> {l2}");
        }
    }

    process::exit(if differs { 1 } else { 0 });
}
```

**Step 3: Add [[bin]] entry, build, copy, register, test, commit**

```toml
[[bin]]
name = "diff"
path = "src/bin/diff.rs"
```

Add `'diff'` to `TOOLS`. Build, copy, test.

```bash
git add packages/coreutils/ packages/orchestrator/src/platform/__tests__/fixtures/diff.wasm packages/orchestrator/src/shell/__tests__/coreutils.test.ts
git commit -m "feat: add diff coreutil"
```

---

### Task 6: Rebuild All and Final Verification

**Files:** None new.

**Context:** Rebuild everything, copy all wasm binaries to fixtures, run the full test suite.

**Step 1: Full rebuild**

```bash
cargo build --release --target wasm32-wasip1 -p wasmsand-coreutils
```

**Step 2: Copy all new binaries to fixtures**

```bash
for tool in uname whoami id printenv yes rmdir sleep seq ln readlink realpath mktemp tac xargs expr diff; do
  cp target/wasm32-wasip1/release/${tool}.wasm packages/orchestrator/src/platform/__tests__/fixtures/
done
```

**Step 3: Run full test suite**

Run: `cd packages/orchestrator && npx vitest run`

Expected: All tests pass (previous 246 + new tests for builtins and coreutils).

**Step 4: Commit if any final fixes needed**

```bash
git add -A
git commit -m "chore: final build and verification for coreutils gap-fill"
```
