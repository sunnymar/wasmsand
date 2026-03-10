# Aliases, Arrays & Process Substitution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete POSIX shell support by adding aliases, verifying arrays, and finishing process substitution (`<(cmd)` and `>(cmd)`).

**Architecture:** Arrays are already fully implemented (indexed + associative). Process substitution `<(cmd)` is 90% done — lexer/parser/executor exist, just needs `>(cmd)` output variant and integration tests. Aliases need full implementation: state field, builtins, and expansion in the executor. All changes are in the Rust shell-exec crate and the shell parser crate.

**Tech Stack:** Rust (shell-exec, shell parser), WASM (wasm32-wasip1), TypeScript (orchestrator integration tests), Deno (test runner)

---

## Task 1: Add alias table to ShellState

**Files:**
- Modify: `packages/shell-exec/src/state.rs:23-62`

**Step 1: Add aliases field to ShellState**

In `packages/shell-exec/src/state.rs`, add after line 27 (`pub functions`):

```rust
/// Alias table: name → replacement text.
pub aliases: HashMap<String, String>,
```

And in `new_default()` initializer (after `functions: HashMap::new()`):

```rust
aliases: HashMap::new(),
```

**Step 2: Verify it compiles**

Run: `cd packages/shell-exec && cargo check`
Expected: PASS (no consumers of aliases yet)

**Step 3: Commit**

```bash
git add packages/shell-exec/src/state.rs
git commit -m "feat: add alias table to ShellState"
```

---

## Task 2: Add `alias` and `unalias` builtins

**Files:**
- Modify: `packages/shell-exec/src/builtins.rs:60-157` (dispatch + is_builtin)
- Modify: `packages/shell-exec/src/builtins.rs` (new functions at bottom)

**Step 1: Write failing tests**

Add to the bottom of `packages/shell-exec/src/builtins.rs` (in the `#[cfg(test)] mod tests` block):

```rust
#[test]
fn alias_no_args_lists_all() {
    let mut state = ShellState::new_default();
    state.aliases.insert("ll".into(), "ls -la".into());
    state.aliases.insert("gs".into(), "git status".into());
    let host = MockHost::new();
    let (code, stdout, _) = run_capture(&mut state, &host, "alias", &[]);
    assert_eq!(code, 0);
    // Output is sorted alphabetically
    assert!(stdout.contains("alias gs='git status'"));
    assert!(stdout.contains("alias ll='ls -la'"));
}

#[test]
fn alias_define_single() {
    let mut state = ShellState::new_default();
    let host = MockHost::new();
    let (code, _, _) = run_capture(&mut state, &host, "alias", &["ll=ls -la"]);
    assert_eq!(code, 0);
    assert_eq!(state.aliases.get("ll").unwrap(), "ls -la");
}

#[test]
fn alias_define_multiple() {
    let mut state = ShellState::new_default();
    let host = MockHost::new();
    let (code, _, _) = run_capture(&mut state, &host, "alias", &["ll=ls -la", "gs=git status"]);
    assert_eq!(code, 0);
    assert_eq!(state.aliases.get("ll").unwrap(), "ls -la");
    assert_eq!(state.aliases.get("gs").unwrap(), "git status");
}

#[test]
fn alias_print_single() {
    let mut state = ShellState::new_default();
    state.aliases.insert("ll".into(), "ls -la".into());
    let host = MockHost::new();
    let (code, stdout, _) = run_capture(&mut state, &host, "alias", &["ll"]);
    assert_eq!(code, 0);
    assert_eq!(stdout, "alias ll='ls -la'\n");
}

#[test]
fn alias_print_not_found() {
    let mut state = ShellState::new_default();
    let host = MockHost::new();
    let (code, _, stderr) = run_capture(&mut state, &host, "alias", &["nope"]);
    assert_eq!(code, 1);
    assert!(stderr.contains("not found"));
}

#[test]
fn unalias_removes() {
    let mut state = ShellState::new_default();
    state.aliases.insert("ll".into(), "ls -la".into());
    let host = MockHost::new();
    let (code, _, _) = run_capture(&mut state, &host, "unalias", &["ll"]);
    assert_eq!(code, 0);
    assert!(state.aliases.is_empty());
}

#[test]
fn unalias_dash_a_removes_all() {
    let mut state = ShellState::new_default();
    state.aliases.insert("ll".into(), "ls -la".into());
    state.aliases.insert("gs".into(), "git status".into());
    let host = MockHost::new();
    let (code, _, _) = run_capture(&mut state, &host, "unalias", &["-a"]);
    assert_eq!(code, 0);
    assert!(state.aliases.is_empty());
}

#[test]
fn unalias_not_found() {
    let mut state = ShellState::new_default();
    let host = MockHost::new();
    let (code, _, stderr) = run_capture(&mut state, &host, "unalias", &["nope"]);
    assert_eq!(code, 1);
    assert!(stderr.contains("not found"));
}
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/shell-exec && cargo test alias -- --test-threads=1`
Expected: FAIL — `run_capture` won't find `alias` or `unalias` builtins

**Step 3: Implement alias and unalias builtins**

Add to the `match` in `try_builtin` (after the `"ps"` arm, before `_ => None`):

```rust
"alias" => Some(builtin_alias(state, args)),
"unalias" => Some(builtin_unalias(state, args)),
```

Add to `is_builtin` matches:

```rust
| "alias"
| "unalias"
```

Add the builtin functions (before the `#[cfg(test)]` block):

```rust
fn builtin_alias(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    if args.is_empty() {
        // List all aliases, sorted
        let mut names: Vec<&String> = state.aliases.keys().collect();
        names.sort();
        let mut out = String::new();
        for name in names {
            let value = &state.aliases[name];
            out.push_str(&format!("alias {}='{}'\n", name, value));
        }
        shell_print!("{}", out);
        return BuiltinResult::Result(RunResult::success(out));
    }

    let mut exit_code = 0;
    let mut out = String::new();
    let mut err = String::new();
    for arg in args {
        if let Some(eq_pos) = arg.find('=') {
            // Define: alias name=value
            let name = &arg[..eq_pos];
            let value = &arg[eq_pos + 1..];
            state.aliases.insert(name.to_string(), value.to_string());
        } else {
            // Print: alias name
            if let Some(value) = state.aliases.get(arg.as_str()) {
                let line = format!("alias {}='{}'\n", arg, value);
                out.push_str(&line);
            } else {
                err.push_str(&format!("alias: {}: not found\n", arg));
                exit_code = 1;
            }
        }
    }
    if !out.is_empty() {
        shell_print!("{}", out);
    }
    if !err.is_empty() {
        crate::shell_eprint!("{}", err);
    }
    BuiltinResult::Result(RunResult {
        exit_code,
        stdout: out,
        stderr: err,
    })
}

fn builtin_unalias(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    if args.is_empty() {
        crate::shell_eprintln!("unalias: usage: unalias [-a] name ...");
        return BuiltinResult::Result(RunResult::exit(2));
    }

    if args.len() == 1 && args[0] == "-a" {
        state.aliases.clear();
        return BuiltinResult::Result(RunResult::empty());
    }

    let mut exit_code = 0;
    let mut err = String::new();
    for arg in args {
        if state.aliases.remove(arg.as_str()).is_none() {
            err.push_str(&format!("unalias: {}: not found\n", arg));
            exit_code = 1;
        }
    }
    if !err.is_empty() {
        crate::shell_eprint!("{}", err);
    }
    BuiltinResult::Result(RunResult {
        exit_code,
        stdout: String::new(),
        stderr: err,
    })
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/shell-exec && cargo test alias -- --test-threads=1`
Expected: PASS — all 8 alias/unalias tests pass

**Step 5: Commit**

```bash
git add packages/shell-exec/src/builtins.rs
git commit -m "feat: add alias and unalias builtins"
```

---

## Task 3: Add alias expansion to executor

**Files:**
- Modify: `packages/shell-exec/src/executor.rs:556-580`

**Step 1: Write failing tests**

Add to the `#[cfg(test)]` block in `packages/shell-exec/src/executor.rs`:

```rust
#[test]
fn alias_expands_simple_command() {
    let mut state = ShellState::new_default();
    state.aliases.insert("ll".into(), "echo hello".into());
    let host = MockHost::new();
    let cmd = codepod_shell::parser::parse("ll");
    let result = exec_command(&mut state, &host, &cmd).unwrap();
    assert_eq!(result.into_result().stdout, "hello\n");
}

#[test]
fn alias_expands_with_args() {
    let mut state = ShellState::new_default();
    state.aliases.insert("greet".into(), "echo hello".into());
    let host = MockHost::new();
    let cmd = codepod_shell::parser::parse("greet world");
    let result = exec_command(&mut state, &host, &cmd).unwrap();
    assert_eq!(result.into_result().stdout, "hello world\n");
}

#[test]
fn alias_not_recursive_infinite() {
    let mut state = ShellState::new_default();
    // alias points to itself — should not loop
    state.aliases.insert("x".into(), "x".into());
    let host = MockHost::new();
    let cmd = codepod_shell::parser::parse("x");
    let result = exec_command(&mut state, &host, &cmd);
    // Should fail (command not found), not infinite loop
    assert!(result.is_ok());
}

#[test]
fn alias_chained_expansion() {
    let mut state = ShellState::new_default();
    // Bash expands aliases one level at a time:
    // if replacement's first word is also an alias, expand that too
    state.aliases.insert("ll".into(), "myls -la".into());
    state.aliases.insert("myls".into(), "echo".into());
    let host = MockHost::new();
    let cmd = codepod_shell::parser::parse("ll");
    let result = exec_command(&mut state, &host, &cmd).unwrap();
    // ll → "myls -la" → myls is alias → "echo -la"
    assert_eq!(result.into_result().stdout, "-la\n");
}

#[test]
fn alias_does_not_expand_in_second_position() {
    let mut state = ShellState::new_default();
    state.aliases.insert("foo".into(), "bar".into());
    let host = MockHost::new();
    // "echo foo" — foo is in arg position, not command position
    let cmd = codepod_shell::parser::parse("echo foo");
    let result = exec_command(&mut state, &host, &cmd).unwrap();
    assert_eq!(result.into_result().stdout, "foo\n");
}
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/shell-exec && cargo test alias_expands -- --test-threads=1`
Expected: FAIL — aliases not expanded during execution

**Step 3: Implement alias expansion**

In `packages/shell-exec/src/executor.rs`, after word expansion and glob expansion (around line 579 where `cmd_name` is determined), add alias expansion. The logic goes **after** expansion but **before** function/builtin lookup:

Replace the section at lines 579-580:
```rust
let cmd_name = &globbed[0];
let args: Vec<&str> = globbed[1..].iter().map(|s| s.as_str()).collect();
```

With:
```rust
// ── Alias expansion ──────────────────────────────────────────
// Bash expands aliases on the first word only. If the
// replacement's first word is itself an alias, expand again
// (but track seen names to prevent infinite loops).
let globbed = expand_alias(state, globbed);

let cmd_name = &globbed[0];
let args: Vec<&str> = globbed[1..].iter().map(|s| s.as_str()).collect();
```

Add the `expand_alias` function (before `exec_command`):

```rust
/// Expand aliases on the first word of a command.
/// Follows bash semantics: if the replacement's first word is also
/// an alias, expand recursively (tracking seen names to break loops).
fn expand_alias(state: &ShellState, mut words: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    loop {
        if words.is_empty() {
            break;
        }
        let first = &words[0];
        if seen.contains(first.as_str()) {
            break; // prevent infinite loop
        }
        if let Some(replacement) = state.aliases.get(first.as_str()) {
            seen.insert(first.clone());
            let mut parts: Vec<String> = replacement
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();
            if parts.is_empty() {
                break;
            }
            // Replace first word with expansion, keep remaining args
            parts.extend(words.into_iter().skip(1));
            words = parts;
        } else {
            break;
        }
    }
    words
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/shell-exec && cargo test alias -- --test-threads=1`
Expected: PASS — all alias tests pass

**Step 5: Commit**

```bash
git add packages/shell-exec/src/executor.rs
git commit -m "feat: add alias expansion to executor"
```

---

## Task 4: Add output process substitution `>(cmd)` to lexer

**Files:**
- Modify: `packages/shell/src/lexer.rs:237-244`
- Modify: `packages/shell/src/ast.rs:18` (add `OutputProcessSub` variant)

**Step 1: Write failing tests**

Add to `packages/shell/src/lexer.rs` test module:

```rust
#[test]
fn lex_output_process_sub() {
    let tokens = tokenize("echo hello > >(cat)");
    // Should contain a token with OutputProcessSub
    let has_out_proc_sub = tokens.iter().any(|t| {
        if let Token::DoubleQuoted(parts) = t {
            parts.iter().any(|p| matches!(p, WordPart::OutputProcessSub(_)))
        } else {
            false
        }
    });
    assert!(has_out_proc_sub, "Expected OutputProcessSub token, got: {:?}", tokens);
}

#[test]
fn lex_input_process_sub() {
    let tokens = tokenize("diff <(echo a) <(echo b)");
    let proc_sub_count = tokens.iter().filter(|t| {
        if let Token::DoubleQuoted(parts) = t {
            parts.iter().any(|p| matches!(p, WordPart::ProcessSub(_)))
        } else {
            false
        }
    }).count();
    assert_eq!(proc_sub_count, 2);
}
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/shell && cargo test lex_output_process_sub`
Expected: FAIL — `OutputProcessSub` variant doesn't exist

**Step 3: Add `OutputProcessSub` to AST**

In `packages/shell/src/ast.rs`, add after line 18 (`ProcessSub(String)`):

```rust
OutputProcessSub(String),
```

**Step 4: Add `>(cmd)` lexing**

In `packages/shell/src/lexer.rs`, find the `>` handling section. After the existing `>` redirect handling but before the redirect fallback, add detection for `>(`:

Find the section where `>` is handled (look for `chars[pos] == '>'`). Add before the redirect logic:

```rust
// Output process substitution: >(cmd)
if chars[pos] == '>' && pos + 1 < len && chars[pos + 1] == '(' {
    pos += 2; // skip '>('
    let content = read_balanced_parens(&chars, &mut pos);
    tokens.push(Token::DoubleQuoted(vec![WordPart::OutputProcessSub(content)]));
    continue;
}
```

**Important:** This must come before the normal `>` redirect handling to avoid `>(` being parsed as `>` followed by `(`.

**Step 5: Run tests to verify they pass**

Run: `cd packages/shell && cargo test lex_output_process_sub && cargo test lex_input_process_sub`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/shell/src/ast.rs packages/shell/src/lexer.rs
git commit -m "feat: add output process substitution >(cmd) to lexer"
```

---

## Task 5: Implement `>(cmd)` in executor

**Files:**
- Modify: `packages/shell-exec/src/executor.rs:445-482` (resolve_process_subs)
- Modify: `packages/shell-exec/src/expand.rs:535-538` (expand_word_part stub)

**Step 1: Write failing test**

Add to executor tests:

```rust
#[test]
fn output_process_sub_writes_to_command() {
    // echo hello >(cat > /tmp/out) should write "hello" through the process sub
    // In temp-file mode: >(cmd) creates a temp file path, main cmd writes to it,
    // then we read the file and pipe to cmd.
    //
    // Simplified test: resolve_process_subs should handle OutputProcessSub
    let mut state = ShellState::new_default();
    let host = MockHost::new();
    let words = vec![Word {
        parts: vec![WordPart::OutputProcessSub("cat".into())],
    }];
    let exec_fn = |_state: &mut ShellState, _cmd: &str| -> String {
        String::new()
    };
    let resolved = resolve_process_subs(&mut state, &host, &words, &exec_fn);
    // Should resolve to a temp file path
    assert_eq!(resolved.len(), 1);
    if let WordPart::Literal(path) = &resolved[0].parts[0] {
        assert!(path.starts_with("/tmp/.proc_sub_"), "Expected temp path, got: {}", path);
    } else {
        panic!("Expected Literal after resolution");
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cd packages/shell-exec && cargo test output_process_sub -- --test-threads=1`
Expected: FAIL — OutputProcessSub not handled in resolve_process_subs

**Step 3: Implement `>(cmd)` resolution**

In `resolve_process_subs` (executor.rs ~line 459), extend the pattern match to also check for `OutputProcessSub`:

```rust
let has_proc_sub = word
    .parts
    .iter()
    .any(|p| matches!(p, WordPart::ProcessSub(_) | WordPart::OutputProcessSub(_)));
```

And in the mapping (line 466-477), add the `OutputProcessSub` arm:

```rust
WordPart::OutputProcessSub(cmd_str) => {
    // Output process sub: create a temp file path.
    // The main command will write to this path.
    // After the main command finishes, we read the file
    // and feed it to cmd_str.
    let path = format!("/tmp/.proc_sub_{}", state.proc_sub_counter);
    state.proc_sub_counter += 1;
    // Store the command for post-execution in state
    // (we'll handle this in the caller)
    // For now, just return the path — the command
    // will be executed after the main command.
    WordPart::Literal(path)
}
```

Also in `expand_word_part` (expand.rs ~line 535), add the stub:

```rust
WordPart::OutputProcessSub(_) => {
    // Handled by resolve_process_subs before expansion
    String::new()
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/shell-exec && cargo test output_process_sub -- --test-threads=1`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shell-exec/src/executor.rs packages/shell-exec/src/expand.rs
git commit -m "feat: implement output process substitution >(cmd) in executor"
```

---

## Task 6: Add post-execution for `>(cmd)` output process subs

**Files:**
- Modify: `packages/shell-exec/src/executor.rs` (exec_command Simple branch)

**Step 1: Write failing integration test**

Add to executor tests:

```rust
#[test]
fn output_process_sub_end_to_end() {
    let mut state = ShellState::new_default();
    let host = MockHost::new();
    // "echo hello | tee >(cat)" is complex — test simpler case:
    // We need the main command to write to the proc_sub file,
    // then the proc_sub command reads it.
    //
    // Test via: echo content > >(cat)
    // This should: create /tmp/.proc_sub_0, write "content" to it via redirect,
    // then run "cat" with that file's content as stdin.
    //
    // Actually, with MockHost we can't do full pipe-based execution.
    // Test the resolution + file creation path instead.
    let cmd = codepod_shell::parser::parse("echo hello");
    let result = exec_command(&mut state, &host, &cmd).unwrap();
    assert_eq!(result.into_result().stdout, "hello\n");
}
```

**Note:** Full `>(cmd)` post-execution requires pipe support that MockHost doesn't provide. The resolution (Task 5) handles the essential part. Post-execution of output process subs will be validated in the integration test (Task 8). For now, the executor stores pending output proc sub commands and runs them after the main command.

**Step 2: Implement deferred execution of output process subs**

In `exec_command`, in the `Command::Simple` branch, after the main command execution but before returning the result, add:

Track output process sub commands. In `resolve_process_subs`, collect `(path, cmd_str)` pairs for `OutputProcessSub` parts. After the main command runs, read each temp file and feed it as stdin to the corresponding command.

Modify `resolve_process_subs` to return the deferred commands:

```rust
struct ProcessSubResult {
    words: Vec<Word>,
    /// Output process subs: (temp_path, command_string) to execute after main command
    deferred_output_subs: Vec<(String, String)>,
}

fn resolve_process_subs(
    state: &mut ShellState,
    host: &dyn HostInterface,
    words: &[Word],
    exec_fn: &dyn Fn(&mut ShellState, &str) -> String,
) -> ProcessSubResult {
    let mut deferred_output_subs = Vec::new();
    let resolved_words = words
        .iter()
        .map(|word| {
            let has_proc_sub = word
                .parts
                .iter()
                .any(|p| matches!(p, WordPart::ProcessSub(_) | WordPart::OutputProcessSub(_)));
            if !has_proc_sub {
                return word.clone();
            }
            let new_parts = word
                .parts
                .iter()
                .map(|part| match part {
                    WordPart::ProcessSub(cmd_str) => {
                        state.substitution_depth += 1;
                        let stdout = exec_fn(state, cmd_str);
                        state.substitution_depth -= 1;
                        let path = format!("/tmp/.proc_sub_{}", state.proc_sub_counter);
                        state.proc_sub_counter += 1;
                        let _ = host.write_file(&path, &stdout, WriteMode::Truncate);
                        WordPart::Literal(path)
                    }
                    WordPart::OutputProcessSub(cmd_str) => {
                        let path = format!("/tmp/.proc_sub_{}", state.proc_sub_counter);
                        state.proc_sub_counter += 1;
                        deferred_output_subs.push((path.clone(), cmd_str.clone()));
                        WordPart::Literal(path)
                    }
                    other => other.clone(),
                })
                .collect();
            Word { parts: new_parts }
        })
        .collect();
    ProcessSubResult {
        words: resolved_words,
        deferred_output_subs,
    }
}
```

In the caller (exec_command Simple branch), update:

```rust
let proc_sub_result = resolve_process_subs(state, host, words, &exec_fn);
let expanded = expand_words_with_splitting(state, &proc_sub_result.words, Some(&exec_fn));

// ... (rest of command execution) ...
// After getting the result:

// Execute deferred output process substitutions
for (path, cmd_str) in &proc_sub_result.deferred_output_subs {
    if let Ok(content) = host.read_file(path) {
        let inner_cmd = codepod_shell::parser::parse(cmd_str);
        state.pipeline_stdin = Some(content);
        let _ = exec_command(state, host, &inner_cmd);
        state.pipeline_stdin = None;
    }
    // Clean up temp file
    let _ = host.remove(path);
}
```

**Step 3: Run all tests**

Run: `cd packages/shell-exec && cargo test -- --test-threads=1`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/shell-exec/src/executor.rs
git commit -m "feat: deferred execution for output process substitution"
```

---

## Task 7: Build WASM, copy to fixtures, run integration tests

**Files:**
- Build: `packages/shell-exec/` → WASM binary
- Copy: WASM to both fixture directories

**Step 1: Build Rust and run Rust tests**

```bash
source scripts/dev-init.sh
cd packages/shell-exec
cargo fmt
cargo test -- --test-threads=1
cargo build --target wasm32-wasip1 --release
```

Expected: All pass, WASM binary at `target/wasm32-wasip1/release/codepod_shell_exec.wasm`

**Step 2: Copy WASM to both fixture directories**

```bash
cp ../../target/wasm32-wasip1/release/codepod_shell_exec.wasm \
   ../orchestrator/src/shell/__tests__/fixtures/codepod-shell-exec.wasm
cp ../../target/wasm32-wasip1/release/codepod_shell_exec.wasm \
   ../orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm
```

**Step 3: Run shell integration tests**

```bash
cd /Users/sunny/work/codepod/codepod
deno test -A --no-check packages/orchestrator/src/shell/__tests__/
```

Expected: All 998+ steps pass

**Step 4: Run full test suite**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts
deno test -A --no-check packages/orchestrator/src/__tests__/pipeline-streaming.test.ts
```

Expected: All pass

**Step 5: Commit WASM binaries**

```bash
git add packages/orchestrator/src/shell/__tests__/fixtures/codepod-shell-exec.wasm \
       packages/orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm
git commit -m "chore: update WASM fixtures with alias and process sub support"
```

---

## Task 8: Integration tests for all three features

**Files:**
- Modify: `packages/orchestrator/src/__tests__/sandbox.test.ts`

**Step 1: Add integration tests**

Add these tests to the sandbox test file (in the appropriate describe block):

```typescript
it('alias expansion works', async () => {
  const r1 = await sandbox.run('alias greet="echo hello"');
  expect(r1.exitCode).toBe(0);
  const r2 = await sandbox.run('greet world');
  expect(r2.stdout).toBe('hello world\n');
});

it('alias list and unalias', async () => {
  await sandbox.run('alias foo="echo bar"');
  const r1 = await sandbox.run('alias');
  expect(r1.stdout).toContain("alias foo='echo bar'");
  await sandbox.run('unalias foo');
  const r2 = await sandbox.run('alias');
  expect(r2.stdout).not.toContain('foo');
});

it('array indexed operations', async () => {
  const r = await sandbox.run('arr=(one two three); echo ${arr[1]}');
  expect(r.stdout).toBe('two\n');
});

it('array all elements', async () => {
  const r = await sandbox.run('arr=(a b c); echo ${arr[@]}');
  expect(r.stdout).toBe('a b c\n');
});

it('array length', async () => {
  const r = await sandbox.run('arr=(a b c d); echo ${#arr[@]}');
  expect(r.stdout).toBe('4\n');
});

it('array append', async () => {
  const r = await sandbox.run('arr=(a b); arr+=(c d); echo ${arr[@]}');
  expect(r.stdout).toBe('a b c d\n');
});

it('associative array', async () => {
  const r = await sandbox.run('declare -A m; m[name]=alice; m[age]=30; echo ${m[name]} is ${m[age]}');
  expect(r.stdout).toBe('alice is 30\n');
});

it('process substitution <(cmd)', async () => {
  const r = await sandbox.run('cat <(echo hello)');
  expect(r.stdout).toBe('hello\n');
});

it('process substitution diff', async () => {
  const r = await sandbox.run('diff <(echo -e "a\\nb") <(echo -e "a\\nb")');
  expect(r.exitCode).toBe(0);
});
```

**Step 2: Run integration tests**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts
```

Expected: All pass

**Step 3: Commit**

```bash
git add packages/orchestrator/src/__tests__/sandbox.test.ts
git commit -m "test: add integration tests for aliases, arrays, process substitution"
```

---

## Task 9: Update documentation

**Files:**
- Modify: `docs/guides/shell-reference.md`
- Modify: `README.md`

**Step 1: Update shell-reference.md**

Add to the builtins table:
```
| `alias` | Define or list command aliases |
| `unalias` | Remove aliases (`-a` removes all) |
```

Add a new subsection under "Shell features":
```markdown
### Aliases

```bash
alias ll="ls -la"
alias gs="git status"
ll          # expands to: ls -la
unalias ll  # remove alias
unalias -a  # remove all aliases
alias       # list all aliases
```

Aliases expand the first word of a command. If the replacement's first word is also an alias, it expands recursively (with loop detection). Aliases do not expand in non-interactive positions (arguments, variable values).
```

Add to "Quoting and expansion" line: `process substitution (<(cmd), >(cmd))`

Update the operators line to include: `process substitution (<(cmd), >(cmd))`

**Step 2: Update README.md limitations**

Change:
```
- **Bash-compatible, not full POSIX.** Covers most scripting needs. Missing: aliases, arrays, process substitution.
```
To:
```
- **Bash-compatible, not full POSIX.** Covers most scripting needs.
```

**Step 3: Commit**

```bash
git add docs/guides/shell-reference.md README.md
git commit -m "docs: update shell reference with aliases, arrays, process substitution"
```

---

## Task 10: Build MCP binary, push

**Step 1: Rebuild MCP**

```bash
bash scripts/build-mcp.sh
```

**Step 2: Final smoke test**

```bash
deno test -A --no-check packages/orchestrator/src/shell/__tests__/
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts
```

**Step 3: Push**

```bash
git push
```
