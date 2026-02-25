# Sandbox Bug Fix Batch — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 16 bugs discovered during MCP sandbox customer testing across shell, coreutils, Python socket shim, and sqlite3.

**Architecture:** Bugs are grouped into 7 tasks by component. Shell fixes touch both the Rust parser (`packages/shell/src/`) and TypeScript executor (`packages/orchestrator/src/shell/shell-runner.ts`). Coreutils fixes are in Rust (`packages/coreutils/src/bin/`). Socket shim fix is in TypeScript. SQLite fix is in the WASI host. After all fixes, rebuild WASM artifacts.

**Tech Stack:** Rust (shell parser, coreutils), TypeScript (shell executor, WASI host, socket shim), WASM (compiled artifacts)

---

### Task 1: Shell — Pipeline stdin for compound commands + `2>&1` in pipes

**Problem:** `seq 1 3 | while read n; do echo $n; done` produces empty output because `execPipeline()` only passes `stdinData` to `Simple` commands. Non-Simple commands (While, For, Subshell, If) fall to `execCommand()` which has no stdin parameter. Also, `2>&1` in pipeline doesn't merge stderr into stdout.

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-runner.ts` (execPipeline ~803-858, execCommand ~452, execWhile ~1013, execFor ~976, execSimple ~505)
- Test: `packages/orchestrator/src/shell/__tests__/conformance/shell.test.ts`

**Step 1: Write failing tests**

Add to `shell.test.ts` conformance tests:

```typescript
// In the appropriate describe block
it('pipe into while read loop', async () => {
  const r = await run(`printf "a\\nb\\nc\\n" | while read line; do echo "got: $line"; done`);
  expect(r.stdout).toBe('got: a\ngot: b\ngot: c\n');
});

it('pipe into for loop via command substitution workaround', async () => {
  const r = await run(`seq 1 3 | while read n; do echo $((n * n)); done`);
  expect(r.stdout).toBe('1\n4\n9\n');
});

it('2>&1 merges stderr into stdout in pipeline', async () => {
  const r = await run(`ls /nonexistent_path 2>&1 | head -1`);
  expect(r.stdout).toContain('No such file');
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/orchestrator/src/shell/__tests__/conformance/shell.test.ts`

**Step 3: Implement**

The fix requires threading `stdinData` through compound commands:

1. Add an optional `pipeStdin` field to the `ShellRunner` instance (set before executing pipeline stages):

```typescript
// Add field to ShellRunner class
private pipeStdin: Uint8Array | undefined;
```

2. In `execPipeline()`, before the non-Simple branch (line 851), set `this.pipeStdin = stdinData`:

```typescript
} else {
  // For non-simple commands in a pipeline, make pipe stdin available
  const savedPipeStdin = this.pipeStdin;
  this.pipeStdin = stdinData;
  try {
    lastResult = await this.execCommand(cmd);
  } finally {
    this.pipeStdin = savedPipeStdin;
  }
}
```

3. In `execSimple()`, when checking for stdin data from redirects (line 547), also fall back to `this.pipeStdin`:

```typescript
// After the redirect loop for stdinData, add:
if (stdinData === undefined && this.pipeStdin !== undefined) {
  stdinData = this.pipeStdin;
}
```

4. For `2>&1` in pipelines: In `execPipeline()`, the Simple command branch (line 823-848) handles word expansion + spawning but doesn't process redirects. Need to check for `StderrToStdout` redirect and merge stderr into stdout before passing to next stage:

```typescript
// After getting lastResult in the Simple pipeline branch:
// Check for StderrToStdout redirect
if (simple.redirects.some(r => r.redirect_type === 'StderrToStdout')) {
  lastResult = { ...lastResult, stdout: lastResult.stdout + lastResult.stderr, stderr: '' };
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/orchestrator/src/shell/__tests__/conformance/shell.test.ts`

**Step 5: Commit**

```bash
git add packages/orchestrator/src/shell/shell-runner.ts packages/orchestrator/src/shell/__tests__/conformance/shell.test.ts
git commit -m "fix(shell): pipe stdin into compound commands and 2>&1 in pipelines"
```

---

### Task 2: Shell — Word splitting, `echo -e`, `$RANDOM`

**Problem:** (a) `for w in $(echo "a b c")` treats result as one word — no IFS splitting on unquoted command substitution. (b) `echo -e "a\nb"` prints literal `-e`. (c) `$RANDOM` is empty.

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-runner.ts` (expandWordPart ~1071, execSimple ~521-537, builtinEcho ~1927)
- Test: `packages/orchestrator/src/shell/__tests__/conformance/shell.test.ts`

**Step 1: Write failing tests**

```typescript
it('word splitting on unquoted command substitution', async () => {
  const r = await run(`for w in $(echo "a b c"); do echo "item: $w"; done`);
  expect(r.stdout).toBe('item: a\nitem: b\nitem: c\n');
});

it('echo -e interprets escape sequences', async () => {
  const r = await run(`echo -e "hello\\nworld"`);
  expect(r.stdout).toBe('hello\nworld\n');
});

it('echo -e interprets tab', async () => {
  const r = await run(`echo -e "a\\tb"`);
  expect(r.stdout).toBe('a\tb\n');
});

it('echo -en suppresses newline and interprets escapes', async () => {
  const r = await run(`echo -en "hi\\n"`);
  expect(r.stdout).toBe('hi\n');
});

it('$RANDOM produces a number', async () => {
  const r = await run(`echo $RANDOM`);
  const n = parseInt(r.stdout.trim());
  expect(n).toBeGreaterThanOrEqual(0);
  expect(n).toBeLessThan(32768);
});
```

**Step 2: Run tests to verify they fail**

**Step 3: Implement**

**(a) Word splitting:** In `execSimple()` after expanding words (line 524), add IFS-splitting for unquoted words. The challenge is that `expandWord()` returns a single string. The cleanest approach is:

- Track which words came from unquoted substitutions by checking if the Word has a CommandSub or Variable part and is NOT inside quotes (no QuotedLiteral wrapping it)
- After expansion, split those results on whitespace (IFS default)
- Insert the split words into the `rawWords` array

In `execSimple()`, replace the simple `Promise.all` expansion with a loop that splits:

```typescript
const rawWords: string[] = [];
for (const w of simple.words) {
  const expanded = await this.expandWord(w);
  // Split on IFS if the word contains unquoted substitution
  if (this.wordNeedsSplitting(w)) {
    const split = expanded.split(/[ \t\n]+/).filter(s => s !== '');
    rawWords.push(...(split.length > 0 ? split : ['']));
  } else {
    rawWords.push(expanded);
  }
}
```

Add helper:
```typescript
private wordNeedsSplitting(word: Word): boolean {
  // A word needs splitting if it has a CommandSub or Variable part
  // that is NOT wrapped in quotes (i.e., the word has no QuotedLiteral parts
  // and isn't a purely quoted word)
  return word.parts.some(p => 'CommandSub' in p || 'Variable' in p) &&
    !word.parts.some(p => 'QuotedLiteral' in p);
}
```

Also apply same splitting in `execFor()` (line 981) and in `execPipeline()` Simple branch (line 825).

**(b) echo -e:** Update `builtinEcho()`:

```typescript
private builtinEcho(args: string[]): RunResult {
  let trailingNewline = true;
  let interpretEscapes = false;
  let startIdx = 0;
  // Parse flags
  while (startIdx < args.length && args[startIdx].startsWith('-')) {
    const flag = args[startIdx];
    if (/^-[neE]+$/.test(flag)) {
      if (flag.includes('n')) trailingNewline = false;
      if (flag.includes('e')) interpretEscapes = true;
      if (flag.includes('E')) interpretEscapes = false;
      startIdx++;
    } else {
      break;
    }
  }
  let output = args.slice(startIdx).join(' ');
  if (interpretEscapes) {
    output = output
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\\\/g, '\\')
      .replace(/\\0([0-7]{0,3})/g, (_, oct) => String.fromCharCode(parseInt(oct || '0', 8)))
      .replace(/\\x([0-9a-fA-F]{1,2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  output += trailingNewline ? '\n' : '';
  return { exitCode: 0, stdout: output, stderr: '', executionTimeMs: 0 };
}
```

**(c) $RANDOM:** In `expandWordPart()`, before the generic variable lookup (line 1092):

```typescript
if ('Variable' in part) {
  if (part.Variable === 'RANDOM') return String(Math.floor(Math.random() * 32768));
  // ... existing code
}
```

**Step 4: Run tests**

**Step 5: Commit**

```bash
git commit -m "fix(shell): word splitting on command substitution, echo -e, \$RANDOM"
```

---

### Task 3: Shell — ParamExpansion operators (`${var^^}`, `${var:0:5}`) and heredoc+redirect

**Problem:** (a) `${x^^}` (uppercase), `${x,,}` (lowercase), `${x:0:5}` (substring) return empty. Parser's `parse_braced_var()` doesn't recognize these operators. (b) `cat <<EOF > file` is broken — heredoc + output redirect on same command.

**Files:**
- Modify: `packages/shell/src/lexer.rs` (parse_braced_var ~771-784)
- Modify: `packages/orchestrator/src/shell/shell-runner.ts` (expandWordPart ParamExpansion switch ~1111-1160, execSimple redirect handling)
- Test: `packages/orchestrator/src/shell/__tests__/conformance/shell.test.ts`

**Step 1: Write failing tests**

```typescript
it('${var^^} uppercases', async () => {
  const r = await run(`x=hello; echo \${x^^}`);
  expect(r.stdout).toBe('HELLO\n');
});

it('${var,,} lowercases', async () => {
  const r = await run(`x=HELLO; echo \${x,,}`);
  expect(r.stdout).toBe('hello\n');
});

it('${var:offset:length} substring', async () => {
  const r = await run(`x=hello; echo \${x:1:3}`);
  expect(r.stdout).toBe('ell\n');
});

it('${var:offset} substring to end', async () => {
  const r = await run(`x=hello; echo \${x:2}`);
  expect(r.stdout).toBe('llo\n');
});

it('cat <<EOF > file writes to file', async () => {
  const r = await run(`cat > /tmp/htest.txt <<EOF\nhello heredoc\nEOF\ncat /tmp/htest.txt`);
  expect(r.stdout).toBe('hello heredoc\n');
});

it('cat <<EOF > file with redirect after heredoc', async () => {
  const r = await run(`cat <<EOF > /tmp/htest2.txt\nline one\nline two\nEOF\ncat /tmp/htest2.txt`);
  expect(r.stdout).toBe('line one\nline two\n');
});
```

**Step 2: Run tests to verify they fail**

**Step 3: Implement**

**(a) Parser — `parse_braced_var()`:** In `lexer.rs`, extend `parse_braced_var()` to recognize `^^`, `,,`, `^`, `,`, and `:offset:length`:

```rust
fn parse_braced_var(content: &str) -> WordPart {
    // Check for case modification operators: ^^, ,,, ^, ,
    for op in &["^^", ",,", "^", ","] {
        if content.ends_with(op) {
            let var = &content[..content.len() - op.len()];
            return WordPart::ParamExpansion {
                var: var.to_string(),
                op: op.to_string(),
                default: String::new(),
            };
        }
    }

    // Check for substring: ${var:offset} or ${var:offset:length}
    // Must distinguish from ${var:-default} (already handled)
    // Substring has a bare colon followed by a digit or negative sign
    if let Some(colon_idx) = content.find(':') {
        let after_colon = &content[colon_idx + 1..];
        // If next char after : is a digit or '-' followed by digit, it's substring
        // But skip if it matches existing operators (:-  :=  :+  :?)
        if !after_colon.starts_with('-') || after_colon.len() > 1 && after_colon.as_bytes()[1].is_ascii_digit() {
            let first = after_colon.chars().next().unwrap_or(' ');
            if first.is_ascii_digit() || (first == '-' && after_colon.len() > 1) {
                return WordPart::ParamExpansion {
                    var: content[..colon_idx].to_string(),
                    op: ":".to_string(),
                    default: after_colon.to_string(),
                };
            }
        }
    }

    // Existing operators
    for op in &[":-", ":=", ":+", ":?", "##", "#", "%%", "%", "//", "/"] {
        if let Some(idx) = content.find(op) {
            return WordPart::ParamExpansion {
                var: content[..idx].to_string(),
                op: op.to_string(),
                default: content[idx + op.len()..].to_string(),
            };
        }
    }
    WordPart::Variable(content.to_string())
}
```

**(a) Executor — expandWordPart():** Add cases to the ParamExpansion switch:

```typescript
case '^^': return (val ?? '').toUpperCase();
case ',,': return (val ?? '').toLowerCase();
case '^': {
  const s = val ?? '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
case ',': {
  const s = val ?? '';
  return s.charAt(0).toLowerCase() + s.slice(1);
}
case ':': {
  // Substring: operand is "offset" or "offset:length"
  const s = val ?? '';
  const colonIdx = operand.indexOf(':');
  if (colonIdx >= 0) {
    const offset = parseInt(operand.slice(0, colonIdx), 10) || 0;
    const length = parseInt(operand.slice(colonIdx + 1), 10);
    return s.slice(offset, offset + length);
  } else {
    const offset = parseInt(operand, 10) || 0;
    return s.slice(offset);
  }
}
```

**(b) Heredoc + redirect:** The issue is in `execSimple()`. The heredoc sets `stdinData` (line 547-557) and the redirect writes stdout to file (line 726-785). But the current code runs the command first, then applies redirects. For `cat` with heredoc stdin, `cat` should read from heredoc and its output should then be redirected.

The bug is that `cat > /tmp/file <<EOF` has the `>` redirect parsed but `cat` sees `>` and `/tmp/file` as arguments (treated as filenames to cat). Check how the parser handles this — the Rust parser should parse `> /tmp/file` as a redirect, not as word arguments. Investigate and fix in the parser if needed, or in `execSimple()` redirect ordering.

**Step 4: Run tests**

**Step 5: Commit**

```bash
git commit -m "fix(shell): add param expansion operators ^^/,,/substring and heredoc+redirect"
```

---

### Task 4: Shell — `trap`, process substitution `<(cmd)`, arrays, `$SHELL`

**Problem:** (a) `trap` not found. (b) `<(cmd)` crashes with EISDIR. (c) Arrays `arr=(a b c)` not supported. (d) `$SHELL` empty.

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-runner.ts` (builtins, expandWordPart, execSimple)
- Modify: `packages/shell/src/lexer.rs` (process substitution, arrays)
- Modify: `packages/shell/src/parser.rs` (arrays)
- Modify: `packages/shell/src/ast.rs` (array AST node if needed)
- Test: `packages/orchestrator/src/shell/__tests__/conformance/shell.test.ts`

**Step 1: Write failing tests**

```typescript
it('trap EXIT runs handler on exit', async () => {
  const r = await run(`trap "echo cleanup" EXIT; echo running`);
  expect(r.stdout).toBe('running\ncleanup\n');
});

it('process substitution <(cmd)', async () => {
  const r = await run(`cat <(echo hello)`);
  expect(r.stdout).toBe('hello\n');
});

it('diff with process substitution', async () => {
  const r = await run(`diff <(printf "a\\nb\\n") <(printf "a\\nc\\n")`);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('b');
  expect(r.stdout).toContain('c');
});

it('array assignment and access', async () => {
  const r = await run(`arr=(one two three); echo \${arr[1]}`);
  expect(r.stdout).toBe('two\n');
});

it('array length', async () => {
  const r = await run(`arr=(a b c d); echo \${#arr[@]}`);
  expect(r.stdout).toBe('4\n');
});

it('array all elements', async () => {
  const r = await run(`arr=(x y z); echo \${arr[@]}`);
  expect(r.stdout).toBe('x y z\n');
});

it('$SHELL is set', async () => {
  const r = await run(`echo $SHELL`);
  expect(r.stdout).toBe('/bin/sh\n');
});
```

**Step 2: Run tests to verify they fail**

**Step 3: Implement**

**(a) trap:** Add as builtin in `execSimple()`. Store handlers in a `Map<string, string>` on the ShellRunner. On shell exit (in `run()` method top-level), execute `EXIT` handler if set:

```typescript
// Field:
private trapHandlers: Map<string, string> = new Map();

// In execSimple builtin dispatch:
} else if (cmdName === 'trap') {
  result = this.builtinTrap(args);
}

private builtinTrap(args: string[]): RunResult {
  if (args.length >= 2) {
    const action = args[0];
    for (const signal of args.slice(1)) {
      if (action === '-' || action === '') {
        this.trapHandlers.delete(signal);
      } else {
        this.trapHandlers.set(signal, action);
      }
    }
  }
  return { ...EMPTY_RESULT };
}
```

In the `run()` method, after top-level command completes, execute EXIT trap:
```typescript
// After command execution, before returning final result:
const exitHandler = this.trapHandlers.get('EXIT');
if (exitHandler) {
  const trapResult = await this.run(exitHandler);
  finalStdout += trapResult.stdout;
}
```

**(b) Process substitution `<(cmd)`:** In the Rust lexer, when we see `<(` that is NOT preceded by a digit (i.e., not a redirect like `2<(`), treat it as process substitution. Add a new WordPart variant `ProcessSub(String)`. In the executor, write command output to a temp file and substitute the path:

Lexer change: When `<` followed by `(`, emit `WordPart::ProcessSub(content)` using `read_balanced_parens()`.

Executor change in `expandWordPart()`:
```typescript
if ('ProcessSub' in part) {
  const result = await this.run(part.ProcessSub);
  const tmpPath = `/tmp/.procsub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  this.vfs.writeFile(tmpPath, new TextEncoder().encode(result.stdout));
  return tmpPath;
}
```

**(c) Arrays:** Store arrays as a separate Map on ShellRunner: `private arrays: Map<string, string[]>`.

Parser: Recognize `name=(word word word)` as a new Assignment variant or a special command. The simplest approach is to handle it in the executor's `execSimple()` — when an assignment value starts with `(` and ends with `)`, parse as array.

Executor: In `expandWordPart()` for ParamExpansion, check if the variable is an array and handle `${arr[n]}`, `${arr[@]}`, `${#arr[@]}`.

**(d) $SHELL:** In ShellRunner constructor or init, set `SHELL=/bin/sh` in the env if not already set:

```typescript
if (!this.env.has('SHELL')) {
  this.env.set('SHELL', '/bin/sh');
}
```

**Step 4: Run tests**

**Step 5: Commit**

```bash
git commit -m "fix(shell): add trap, process substitution, arrays, \$SHELL"
```

---

### Task 5: Coreutils — `cut -d:`, `xargs -I{}`, `find -exec {} +`

**Problem:** (a) `cut -d:` treats `-d:` as filename. (b) `xargs -I{}` doesn't replace. (c) `find -exec {} +` has no batch mode and only special-cases echo/cat.

**Files:**
- Modify: `packages/coreutils/src/bin/cut.rs` (arg parsing ~127-139)
- Modify: `packages/coreutils/src/bin/xargs.rs` (add -I support)
- Modify: `packages/coreutils/src/bin/find.rs` (exec handling ~204-237, Expr enum, parse_expr)
- Test: `packages/orchestrator/src/shell/__tests__/conformance/coreutils.test.ts` (or appropriate test file)

**Step 1: Write failing tests**

Add to conformance tests:

```typescript
it('cut -d: with attached delimiter', async () => {
  const r = await run(`echo "a:b:c" | cut -d: -f2`);
  expect(r.stdout).toBe('b\n');
});

it('cut -d with tab literal', async () => {
  const r = await run(`printf "a\\tb\\tc" | cut -f2`);
  expect(r.stdout).toBe('b\n');
});

it('xargs -I{} replaces placeholder', async () => {
  const r = await run(`printf "a\\nb\\nc\\n" | xargs -I{} echo "item: {}"`);
  expect(r.stdout).toBe('item: a\nitem: b\nitem: c\n');
});

it('find -exec wc -l {} +', async () => {
  const r = await run(`printf "x\\n" > /tmp/fe1.txt && printf "y\\nz\\n" > /tmp/fe2.txt && find /tmp/fe1.txt /tmp/fe2.txt -exec wc -l {} +`);
  // wc -l with multiple files should show counts + total
  expect(r.stdout).toContain('1');
  expect(r.stdout).toContain('2');
});
```

**Step 2: Run tests to verify they fail**

**Step 3: Implement**

**(a) cut.rs — `-d:` attached form:**

In the arg parsing loop (~line 128), add handling for `-d` prefix:

```rust
} else if args[i] == "-d" {
    i += 1;
    if i >= args.len() {
        eprintln!("cut: option requires an argument -- 'd'");
        process::exit(1);
    }
    let d: Vec<char> = args[i].chars().collect();
    if d.is_empty() {
        eprintln!("cut: delimiter must be a single character");
        process::exit(1);
    }
    delimiter = d[0];
} else if args[i].starts_with("-d") {
    // Attached form: -d: or -d,
    let d: Vec<char> = args[i][2..].chars().collect();
    if d.is_empty() {
        eprintln!("cut: delimiter must be a single character");
        process::exit(1);
    }
    delimiter = d[0];
}
```

**(b) xargs.rs — `-I{}` support:**

Rewrite to handle `-I` flag:

```rust
fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    let mut max_args: Option<usize> = None;
    let mut replace_str: Option<String> = None;
    let mut cmd_start = 0;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-n" && i + 1 < args.len() {
            max_args = args[i + 1].parse().ok();
            i += 2;
            cmd_start = i;
        } else if args[i] == "-I" && i + 1 < args.len() {
            replace_str = Some(args[i + 1].clone());
            i += 2;
            cmd_start = i;
        } else if args[i].starts_with("-I") {
            replace_str = Some(args[i][2..].to_string());
            i += 1;
            cmd_start = i;
        } else {
            break;
        }
    }

    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap_or(0);

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    let cmd_parts: Vec<&str> = if cmd_start < args.len() {
        args[cmd_start..].iter().map(|s| s.as_str()).collect()
    } else {
        vec!["echo"]
    };

    if let Some(ref repl) = replace_str {
        // -I mode: one execution per input line, replace token in command
        for line in input.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }
            let parts: Vec<String> = cmd_parts.iter()
                .map(|p| p.replace(repl.as_str(), line))
                .collect();
            let _ = writeln!(out, "{}", parts.join(" "));
        }
    } else {
        // Original behavior
        let items: Vec<&str> = input.split_whitespace().collect();
        if items.is_empty() { return; }
        // ... existing chunk logic
    }
}
```

Note: xargs in the sandbox actually just prints the command (doesn't exec subprocesses from WASM). The output format matches what the shell pipe does. If the sandbox's xargs needs to actually execute commands, it would need to output a special format that the shell runner interprets. Check how other coreutils handle this — if they just print, we print the expanded command line.

**(c) find.rs — general `-exec` + batch mode:**

The current `Expr::Exec` only special-cases echo/cat. Replace with a general approach:

1. Add `ExecBatch(Vec<String>)` variant to `Expr` enum
2. In `parse_expr()` where `-exec` is parsed, distinguish `;` vs `+` terminator
3. For `;` mode: use general subprocess execution (print command + args as the shell would)
4. For `+` mode: accumulate paths, execute once after walk completes

Since WASM coreutils can't spawn subprocesses directly, the `-exec` with `;` should print the expanded command output (for echo/cat which are common), and for `+` mode, accumulate all paths and do a single execution.

A practical approach: make `-exec` actually invoke the command by writing to stdout in a format the shell can use, OR implement the common cases (echo, cat, wc, rm, grep) inline and fall back to printing the path for others.

**Step 4: Run tests**

**Step 5: Commit**

```bash
git commit -m "fix(coreutils): cut -d attached delimiter, xargs -I, find -exec general + batch"
```

---

### Task 6: Python socket shim — missing constants for asyncio

**Problem:** `import asyncio` fails because `socket.AF_UNSPEC` is missing. The shim also lacks other constants asyncio probes.

**Files:**
- Modify: `packages/orchestrator/src/network/socket-shim.ts` (~line 23-37)
- Test: `packages/orchestrator/src/network/__tests__/socket-shim.test.ts`

**Step 1: Write failing test**

In `socket-shim.test.ts` (or add new):

```typescript
it('socket shim exports AF_UNSPEC', async () => {
  const r = await run(`python3 -c "import socket; print(socket.AF_UNSPEC)"`);
  expect(r.stdout.trim()).toBe('0');
});

it('asyncio can be imported', async () => {
  const r = await run(`python3 -c "import asyncio; print('ok')"`);
  expect(r.stdout.trim()).toBe('ok');
});
```

**Step 2: Run tests to verify they fail**

**Step 3: Implement**

Add missing constants to the socket shim source string (after existing constants around line 28):

```python
AF_UNSPEC = 0
AF_INET = 2
AF_INET6 = 10
SOCK_STREAM = 1
SOCK_DGRAM = 2
SOCK_RAW = 3
IPPROTO_TCP = 6
IPPROTO_UDP = 17
IPPROTO_IP = 0
SOL_SOCKET = 1
SOL_TCP = 6
SO_KEEPALIVE = 9
SO_REUSEADDR = 2
SO_ERROR = 4
TCP_NODELAY = 1
SHUT_RDWR = 2
MSG_DONTWAIT = 64
MSG_PEEK = 2
AI_PASSIVE = 1
AI_CANONNAME = 2
AI_NUMERICHOST = 4
AI_NUMERICSERV = 1024
NI_NUMERICHOST = 1
NI_NUMERICSERV = 2
EAI_NONAME = -2
SOMAXCONN = 128
has_ipv6 = True
_GLOBAL_DEFAULT_TIMEOUT = object()
timeout = OSError
error = OSError
herror = OSError
gaierror = OSError
```

Also add `inet_aton` and `inet_ntoa` stubs:

```python
def inet_aton(ip_string):
    parts = ip_string.split('.')
    return bytes(int(p) for p in parts)

def inet_ntoa(packed_ip):
    return '.'.join(str(b) for b in packed_ip)

def getnameinfo(sockaddr, flags):
    host, port = sockaddr[:2]
    return (str(host), str(port))
```

Update `getaddrinfo` to respect family parameter:

```python
def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    if isinstance(port, str):
        port = int(port) if port else 0
    results = []
    if family == 0 or family == AF_INET:
        results.append((AF_INET, SOCK_STREAM, IPPROTO_TCP, '', (host, port or 80)))
    if family == 0 or family == AF_INET6:
        results.append((AF_INET6, SOCK_STREAM, IPPROTO_TCP, '', (host, port or 80)))
    return results if results else [(AF_INET, SOCK_STREAM, IPPROTO_TCP, '', (host, port or 80))]
```

**Step 4: Run tests**

**Step 5: Commit**

```bash
git commit -m "fix(socket-shim): add AF_UNSPEC and missing constants for asyncio compatibility"
```

---

### Task 7: SQLite3 on-disk — WASI stubs returning ENOSYS

**Problem:** `sqlite3 /tmp/test.db "SELECT 1"` fails with "disk I/O error" because WASI stubs for `fd_filestat_set_times`, `fd_sync`, `fd_datasync`, `fd_filestat_set_size` return `ENOSYS`. SQLite interprets this as I/O failure. The sandbox is single-threaded embedded — these can safely no-op.

**Files:**
- Modify: `packages/orchestrator/src/wasi/wasi-host.ts` (~line 328-338)
- Test: `packages/orchestrator/src/wasi/__tests__/wasi-host.test.ts` or `packages/orchestrator/src/shell/__tests__/conformance/coreutils.test.ts`

**Step 1: Write failing test**

```typescript
it('sqlite3 on-disk database works', async () => {
  const r = await run(`sqlite3 /tmp/test.db "CREATE TABLE t(id INTEGER, name TEXT); INSERT INTO t VALUES(1,'alice'); INSERT INTO t VALUES(2,'bob'); SELECT name FROM t ORDER BY id;"`);
  expect(r.stdout).toBe('alice\nbob\n');
});
```

**Step 2: Run tests to verify it fails**

**Step 3: Implement**

In `wasi-host.ts`, replace the generic `stub` bindings for file-operation stubs with success returns. Change from:

```typescript
fd_datasync: this.stub.bind(this),
fd_sync: this.stub.bind(this),
fd_fdstat_set_flags: this.stub.bind(this),
fd_fdstat_set_rights: this.stub.bind(this),
fd_filestat_set_size: this.stub.bind(this),
fd_filestat_set_times: this.stub.bind(this),
```

To individual no-op methods that return `WASI_ESUCCESS`:

```typescript
fd_datasync: this.fdNoOp.bind(this),
fd_sync: this.fdNoOp.bind(this),
fd_fdstat_set_flags: this.fdNoOp.bind(this),
fd_fdstat_set_rights: this.fdNoOp.bind(this),
fd_filestat_set_size: this.fdNoOp.bind(this),
fd_filestat_set_times: this.fdNoOp.bind(this),
```

Add method:
```typescript
private fdNoOp(): number {
  return WASI_ESUCCESS;
}
```

Keep these as stubs (they genuinely aren't supported):
```typescript
fd_pread: this.stub.bind(this),
fd_pwrite: this.stub.bind(this),
fd_renumber: this.stub.bind(this),
path_filestat_set_times: this.stub.bind(this),  // also change to fdNoOp
path_link: this.stub.bind(this),
poll_oneoff: this.stub.bind(this),
proc_raise: this.stub.bind(this),
sock_accept: this.stub.bind(this),
```

Actually, `path_filestat_set_times` should also return success (touch command, etc.), so change that to `fdNoOp` too.

**Step 4: Run tests**

**Step 5: Commit**

```bash
git commit -m "fix(wasi): return success for fd_sync/fd_datasync/fd_filestat_set_times stubs

SQLite3 on-disk databases require these WASI calls to succeed. Since
the sandbox is single-threaded and embedded, no-op is safe."
```

---

### Task 8: Rebuild WASM, run full test suite, final commit

**Step 1: Rebuild shell and coreutils WASM**

```bash
cd packages/shell && cargo build --target wasm32-wasip1 --release
cd packages/coreutils && cargo build --target wasm32-wasip1 --release
# Copy fixtures
cp target/wasm32-wasip1/release/*.wasm packages/orchestrator/src/platform/__tests__/fixtures/
```

**Step 2: Rebuild TypeScript dist**

```bash
bun run build:ts
```

**Step 3: Run full test suite**

```bash
bun test
```

Expected: All 1096+ tests pass, plus new tests.

**Step 4: Final commit with rebuilt WASM**

```bash
git add -A
git commit -m "chore: rebuild WASM fixtures after shell and coreutils bug fixes"
git push
```

**Step 5: Manual MCP verification**

Test through MCP sandbox:
- `seq 1 3 | while read n; do echo $n; done` → `1\n2\n3`
- `for w in $(echo "a b c"); do echo $w; done` → `a\nb\nc`
- `echo -e "a\nb"` → `a\nb`
- `echo $RANDOM` → a number
- `x=hello; echo ${x^^}` → `HELLO`
- `x=hello; echo ${x:1:3}` → `ell`
- `echo "a:b:c" | cut -d: -f2` → `b`
- `printf "a\nb\n" | xargs -I{} echo "got: {}"` → `got: a\ngot: b`
- `python3 -c "import asyncio; print('ok')"` → `ok`
- `sqlite3 /tmp/t.db "CREATE TABLE t(x); INSERT INTO t VALUES(1); SELECT * FROM t;"` → `1`
- `trap "echo bye" EXIT; echo hi` → `hi\nbye`
- `cat <(echo hello)` → `hello`
- `arr=(a b c); echo ${arr[1]}` → `b`
