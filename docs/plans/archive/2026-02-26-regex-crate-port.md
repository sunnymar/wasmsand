# Port Text Utilities to `regex` Crate

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace custom regex engines in grep, sed, awk, and csplit with the `regex` crate to improve correctness, reduce code, and unify regex behavior.

**Architecture:** Each utility has its own standalone BRE/ERE regex engine (400-500 lines each). Replace with `regex::Regex` from the already-added `regex` crate. For BRE-mode utilities (grep, sed), add a `bre_to_ere()` translation function. For ERE-mode utilities (awk), the `regex` crate syntax works directly.

**Tech Stack:** Rust (`regex` crate, already in Cargo.toml), wasm32-wasip1 target, bun test.

---

### Task 1: Port grep.rs to regex crate

**Files:**
- Modify: `packages/coreutils/src/bin/grep.rs`

**Step 1: Replace the custom regex engine**

Delete the entire custom regex engine (lines 22-476): `Re` enum, `Quantifier` enum, `parse_char_class`, `compile_regex`, `compile_tokens`, `parse_quantifier`, `match_char`, `match_tokens`, `match_repetition`, `regex_matches`.

Replace with:

```rust
use regex::RegexBuilder;

/// Convert a BRE (Basic Regular Expression) pattern to ERE syntax for the regex crate.
fn bre_to_ere(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut result = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            match chars[i + 1] {
                '(' | ')' | '+' | '?' | '{' | '}' | '|' => {
                    // BRE escaped special → ERE unescaped special
                    result.push(chars[i + 1]);
                    i += 2;
                }
                '1'..='9' => {
                    // Backreference - not supported by regex crate, keep escaped
                    result.push('\\');
                    result.push(chars[i + 1]);
                    i += 2;
                }
                _ => {
                    // Keep other escapes as-is
                    result.push('\\');
                    result.push(chars[i + 1]);
                    i += 2;
                }
            }
        } else {
            match chars[i] {
                // These are literal in BRE, special in ERE → escape them
                '(' | ')' | '+' | '?' | '{' | '}' | '|' => {
                    result.push('\\');
                    result.push(chars[i]);
                    i += 1;
                }
                _ => {
                    result.push(chars[i]);
                    i += 1;
                }
            }
        }
    }
    result
}
```

**Step 2: Update the `matches` function**

Replace:
```rust
fn matches(line: &str, compiled: &[(Re, Quantifier)], ignore_case: bool) -> bool {
```

With a function that takes `&regex::Regex`:
```rust
fn matches(line: &str, re: &regex::Regex) -> bool {
    re.is_match(line)
}
```

**Step 3: Update main() and grep functions**

Change `compile_regex` calls to use `regex::RegexBuilder`:
```rust
let pattern_str = if opts.extended {
    pattern.clone()
} else {
    bre_to_ere(pattern)
};
let re = RegexBuilder::new(&pattern_str)
    .case_insensitive(opts.ignore_case)
    .build()
    .unwrap_or_else(|e| {
        eprintln!("grep: Invalid regular expression: {}", e);
        process::exit(2);
    });
```

Update `grep_reader` and `grep_path` to pass `&regex::Regex` instead of `&[(Re, Quantifier)]`.

**Step 4: Verify compilation**

Run: `cargo build --target wasm32-wasip1 --release -p codepod-coreutils --bin grep`

**Step 5: Copy fixture and run tests**

Run:
```bash
cp target/wasm32-wasip1/release/grep.wasm packages/orchestrator/src/platform/__tests__/fixtures/
cd packages/orchestrator && bun test src/shell/__tests__/conformance/shell.test.ts
```

**Step 6: Commit**

```
refactor(grep): replace custom regex engine with regex crate
```

---

### Task 2: Port sed.rs to regex crate

**Files:**
- Modify: `packages/coreutils/src/bin/sed.rs`

This is the most complex port because sed needs:
- BRE pattern compilation via `regex::Regex` with group captures
- `&` and `\1`-`\9` backreference support in replacement strings
- Case-insensitive matching via `RegexBuilder`
- Finding all non-overlapping matches for global substitution

**Step 1: Delete the custom BRE engine**

Remove: `BreToken`, `AnchorKind`, `RepeatKind`, `parse_bre`, `parse_bre_inner`, `maybe_quantifier`, `parse_char_class`, `expand_posix_class`, `MatchResult`, `match_tokens`, `match_single_token`, `bre_find`, `bre_matches`, `bre_find_all`, `lowercase_bre_tokens`.

**Step 2: Add regex crate imports and BRE-to-ERE converter**

```rust
use regex::{Regex, RegexBuilder};
```

Add the same `bre_to_ere()` function from Task 1 (grep).

**Step 3: Add helper to compile BRE patterns**

```rust
fn compile_bre(pattern: &str) -> Regex {
    let ere = bre_to_ere(pattern);
    Regex::new(&ere).unwrap_or_else(|_| {
        // Fallback: try escaping the whole pattern as literal
        Regex::new(&regex::escape(pattern)).unwrap()
    })
}

fn compile_bre_case_insensitive(pattern: &str) -> Regex {
    let ere = bre_to_ere(pattern);
    RegexBuilder::new(&ere)
        .case_insensitive(true)
        .build()
        .unwrap_or_else(|_| {
            RegexBuilder::new(&regex::escape(pattern))
                .case_insensitive(true)
                .build()
                .unwrap()
        })
}
```

**Step 4: Update data structures**

Change `Address::Pattern(Vec<BreToken>)` → `Address::Pattern(Regex)`.

Change `SedCmd::Substitute { pattern: Vec<BreToken>, ... }` → `SedCmd::Substitute { pattern: Regex, ... }`.

Remove `ignore_case` from `Substitute` since it's now baked into the compiled `Regex`.

**Step 5: Update parsing**

In `parse_substitute`, compile the BRE pattern immediately:
```rust
let re = if ignore_case {
    compile_bre_case_insensitive(&pat)
} else {
    compile_bre(&pat)
};
```

In `parse_address`, compile `/pattern/` addresses:
```rust
Address::Pattern(compile_bre(&pat_str))
```

**Step 6: Update build_replacement**

Change signature to work with `regex::Captures`:
```rust
fn build_replacement(text: &str, caps: &regex::Captures, replacement: &str) -> String {
    let matched = caps.get(0).unwrap();
    let mut result = String::new();
    let rchars: Vec<char> = replacement.chars().collect();
    let mut i = 0;
    while i < rchars.len() {
        if rchars[i] == '&' {
            result.push_str(matched.as_str());
            i += 1;
        } else if rchars[i] == '\\' && i + 1 < rchars.len() {
            let next = rchars[i + 1];
            if next.is_ascii_digit() && next != '0' {
                let gid = (next as usize) - ('0' as usize);
                if let Some(m) = caps.get(gid) {
                    result.push_str(m.as_str());
                }
                i += 2;
            } else if next == 'n' {
                result.push('\n');
                i += 2;
            } else {
                result.push(next);
                i += 2;
            }
        } else {
            result.push(rchars[i]);
            i += 1;
        }
    }
    result
}
```

**Step 7: Update apply_substitute**

Use `Regex::captures()` for single match, `Regex::captures_iter()` or manual loop for global:
```rust
fn apply_substitute(
    line: &str,
    re: &Regex,
    replacement: &str,
    global: bool,
    nth: usize,
) -> (String, bool) {
    if global {
        let mut result = String::new();
        let mut last_end = 0;
        let mut found = false;
        for caps in re.captures_iter(line) {
            found = true;
            let m = caps.get(0).unwrap();
            result.push_str(&line[last_end..m.start()]);
            result.push_str(&build_replacement(line, &caps, replacement));
            last_end = m.end();
        }
        if !found { return (line.to_string(), false); }
        result.push_str(&line[last_end..]);
        (result, true)
    } else if nth > 0 {
        let caps_vec: Vec<_> = re.captures_iter(line).collect();
        if caps_vec.len() < nth {
            return (line.to_string(), false);
        }
        let caps = &caps_vec[nth - 1];
        let m = caps.get(0).unwrap();
        let mut result = String::new();
        result.push_str(&line[..m.start()]);
        result.push_str(&build_replacement(line, caps, replacement));
        result.push_str(&line[m.end()..]);
        (result, true)
    } else {
        if let Some(caps) = re.captures(line) {
            let m = caps.get(0).unwrap();
            let mut result = String::new();
            result.push_str(&line[..m.start()]);
            result.push_str(&build_replacement(line, &caps, replacement));
            result.push_str(&line[m.end()..]);
            (result, true)
        } else {
            (line.to_string(), false)
        }
    }
}
```

**Step 8: Update address matching in execution**

Replace `bre_matches(line, tokens)` calls with `re.is_match(line)`.

**Step 9: Verify compilation**

Run: `cargo build --target wasm32-wasip1 --release -p codepod-coreutils --bin sed`

**Step 10: Copy fixture and run tests**

Run:
```bash
cp target/wasm32-wasip1/release/sed.wasm packages/orchestrator/src/platform/__tests__/fixtures/
cd packages/orchestrator && bun test src/shell/__tests__/conformance/sed.test.ts
```

**Step 11: Commit**

```
refactor(sed): replace custom BRE engine with regex crate
```

---

### Task 3: Port awk.rs to regex crate

**Files:**
- Modify: `packages/coreutils/src/bin/awk.rs`

awk uses ERE-like syntax, so the `regex` crate works directly with no translation.

**Step 1: Delete the custom regex engine**

Remove (lines ~1634-1999): `regex_find`, `split_alternatives`, `Re` enum, `Quantifier` enum, `compile_pattern`, `re_match_elem`, `re_match_at`, `re_match_items`, `regex_find_single`, `regex_matches`, `is_regex_pattern`, `regex_split`, `regex_replace`.

**Step 2: Add regex crate import**

```rust
use regex::Regex;
```

**Step 3: Implement replacement functions using regex crate**

```rust
fn regex_matches(pattern: &str, text: &str) -> bool {
    match Regex::new(pattern) {
        Ok(re) => re.is_match(text),
        Err(_) => false,
    }
}

fn regex_find(pattern: &str, text: &str) -> Option<(usize, usize)> {
    match Regex::new(pattern) {
        Ok(re) => re.find(text).map(|m| (m.start(), m.end())),
        Err(_) => None,
    }
}

fn is_regex_pattern(s: &str) -> bool {
    s.contains('[')
        || s.contains('(')
        || s.contains('*')
        || s.contains('+')
        || s.contains('?')
        || s.contains('.')
        || s.contains('^')
        || s.contains('$')
        || s.contains('|')
        || s.contains('\\')
}

fn regex_split(pattern: &str, text: &str) -> Vec<String> {
    if pattern.is_empty() {
        return vec![text.to_string()];
    }
    match Regex::new(pattern) {
        Ok(re) => {
            let parts: Vec<String> = re.split(text).map(|s| s.to_string()).collect();
            if parts.is_empty() {
                vec![text.to_string()]
            } else {
                parts
            }
        }
        Err(_) => vec![text.to_string()],
    }
}

fn regex_replace(s: &str, pattern: &str, repl: &str, global: bool) -> (String, usize) {
    if pattern.is_empty() {
        return (s.to_string(), 0);
    }
    match Regex::new(pattern) {
        Ok(re) => {
            let mut result = String::new();
            let mut count = 0;
            let mut last_end = 0;
            for m in re.find_iter(s) {
                result.push_str(&s[last_end..m.start()]);
                // Handle & in replacement (refers to matched text)
                let expanded = repl.replace('&', m.as_str());
                result.push_str(&expanded);
                last_end = m.end();
                count += 1;
                if !global {
                    result.push_str(&s[last_end..]);
                    return (result, count);
                }
            }
            if count == 0 {
                return (s.to_string(), 0);
            }
            result.push_str(&s[last_end..]);
            (result, count)
        }
        Err(_) => (s.to_string(), 0),
    }
}
```

**Step 4: Verify compilation**

Run: `cargo build --target wasm32-wasip1 --release -p codepod-coreutils --bin awk`

**Step 5: Copy fixture and run tests**

Run:
```bash
cp target/wasm32-wasip1/release/awk.wasm packages/orchestrator/src/platform/__tests__/fixtures/
cd packages/orchestrator && bun test src/shell/__tests__/conformance/awk.test.ts
```

**Step 6: Commit**

```
refactor(awk): replace custom regex engine with regex crate
```

---

### Task 4: Port csplit.rs to regex crate

**Files:**
- Modify: `packages/coreutils/src/bin/csplit.rs`

**Step 1: Delete the custom regex functions**

Remove: `regex_match`, `match_at`, `char_matches` (~80 lines).

**Step 2: Add regex crate and replace matches_line**

```rust
use regex::Regex;

fn matches_line(pattern: &str, line: &str) -> bool {
    match Regex::new(pattern) {
        Ok(re) => re.is_match(line),
        Err(_) => false,
    }
}
```

**Step 3: Verify compilation**

Run: `cargo build --target wasm32-wasip1 --release -p codepod-coreutils --bin csplit`

**Step 4: Copy fixture and run tests**

Run:
```bash
cp target/wasm32-wasip1/release/csplit.wasm packages/orchestrator/src/platform/__tests__/fixtures/
cd packages/orchestrator && bun test src/shell/__tests__/conformance/shell.test.ts
```

**Step 5: Commit**

```
refactor(csplit): replace custom regex with regex crate
```

---

### Task 5: Full build, copy all fixtures, run full test suite

**Step 1: Full build**

Run: `cargo build --target wasm32-wasip1 --release`

**Step 2: Copy all 4 updated WASM binaries**

Run:
```bash
for bin in grep sed awk csplit; do
  cp target/wasm32-wasip1/release/$bin.wasm packages/orchestrator/src/platform/__tests__/fixtures/
done
```

**Step 3: Run full test suite**

Run: `cd packages/orchestrator && bun test`

Expected: All tests pass (no regressions).

**Step 4: Commit (if any fixture updates needed)**

```
chore: rebuild wasm fixtures after regex crate port
```

---

## Verification

1. `cargo build --target wasm32-wasip1 --release` — compiles without warnings
2. All conformance tests pass:
   - `bun test src/shell/__tests__/conformance/sed.test.ts`
   - `bun test src/shell/__tests__/conformance/awk.test.ts`
   - `bun test src/shell/__tests__/conformance/shell.test.ts` (covers grep, csplit)
3. `bun test` — full test suite passes (no regressions)

## Code Reduction Estimate

| Utility | Lines removed | Lines added | Net |
|---------|-------------:|------------:|----:|
| grep.rs | ~460 | ~60 | -400 |
| sed.rs | ~500 | ~80 | -420 |
| awk.rs | ~400 | ~60 | -340 |
| csplit.rs | ~80 | ~10 | -70 |
| **Total** | **~1440** | **~210** | **-1230** |
