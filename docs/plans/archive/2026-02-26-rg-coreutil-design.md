# Design: `rg` (ripgrep-like) Coreutil

**Date:** 2026-02-26
**Status:** Approved

## Summary

Add an `rg` binary to `packages/coreutils` — a ripgrep-like recursive code search tool optimized for LLM usage in the codepod sandbox. Uses the `regex` crate (first coreutil to do so, paving the way for grep/sed/awk migration later).

## Architecture

Single-file Rust binary at `packages/coreutils/src/bin/rg.rs`, following the existing coreutil pattern (hand-rolled arg parsing, no framework deps). Adds `regex` crate to `packages/coreutils/Cargo.toml`.

Tool registration is automatic — `scanTools` picks up any `.wasm` file in the fixtures/wasm directory.

## Features

### Defaults (no flags needed)
- Recursive directory search
- Line numbers shown
- Smart case (lowercase pattern → case-insensitive; mixed case → case-sensitive)
- Respects `.gitignore` / `.ignore` files
- Skips binary files
- Skips hidden files/dirs (dotfiles)

### Flags
| Flag | Long | Description |
|------|------|-------------|
| `-i` | `--ignore-case` | Force case-insensitive |
| `-s` | `--case-sensitive` | Force case-sensitive |
| `-S` | `--smart-case` | Smart case (default) |
| `-t TYPE` | `--type TYPE` | Filter by file type (e.g., `-t py`) |
| `-T TYPE` | `--type-not TYPE` | Exclude file type |
| `-g GLOB` | `--glob GLOB` | Include/exclude by glob (`!` prefix to negate) |
| `-A N` | `--after-context N` | Show N lines after match |
| `-B N` | `--before-context N` | Show N lines before match |
| `-C N` | `--context N` | Show N lines before and after |
| `-l` | `--files-with-matches` | Print only filenames |
| `-c` | `--count` | Print match count per file |
| `-v` | `--invert-match` | Invert match |
| `-F` | `--fixed-strings` | Treat pattern as literal |
| `-w` | `--word-regexp` | Match whole words only |
| `-n` | `--line-number` | Show line numbers (default on) |
| `-N` | `--no-line-number` | Suppress line numbers |
| `.` | `--hidden` | Include hidden files/dirs |
| | `--no-ignore` | Don't respect gitignore |
| | `--type-list` | List known file types |
| | `--max-count N` | Stop after N matches per file |
| | `--max-depth N` | Limit directory recursion depth |

### File Type Map (built-in)
Hardcoded table covering common types: `py`, `rs`, `js`, `ts`, `tsx`, `jsx`, `json`, `yaml`/`yml`, `toml`, `md`, `html`, `css`, `go`, `java`, `c`, `cpp`, `h`, `sh`, `sql`, `xml`, `rb`, `php`, `swift`, `kt`.

### Gitignore Support
Minimal parser: reads `.gitignore` and `.ignore` files at each directory level. Supports:
- Comment lines (`#`)
- Negation (`!pattern`)
- Directory-only patterns (`dir/`)
- Glob patterns (`*`, `?`, `**`)
- Rooted patterns (`/pattern`)

### Binary File Detection
Checks first 8KB of each file for null bytes. If found, skip and optionally print "Binary file matches".

## Output Format

```
path/to/file.rs:42:    let x = foo();
path/to/file.rs:43-    let y = bar();  // context line
--
other/file.py:10:def hello():
```

- Match lines use `:` separator
- Context lines use `-` separator
- `--` separates groups of matches

## Dependencies

- `regex` crate added to `packages/coreutils/Cargo.toml` (with `default-features = false` for minimal size)

## Testing

Comprehensive test suite in `packages/orchestrator/src/shell/__tests__/conformance/rg.test.ts` covering:
1. Basic pattern matching (literal, regex)
2. Recursive search across directory trees
3. Smart case behavior
4. File type filtering (`-t`, `-T`)
5. Glob filtering (`-g`)
6. Context lines (`-A`, `-B`, `-C`)
7. Output modes (`-l`, `-c`)
8. Invert match (`-v`)
9. Fixed strings (`-F`)
10. Word boundary (`-w`)
11. Gitignore / .ignore respect
12. Binary file skipping
13. Hidden file handling (`--hidden`)
14. Max depth / max count limits
15. Stdin piping
16. Multiple patterns / multiple paths
17. Exit codes (0 = match, 1 = no match, 2 = error)

## Non-goals
- No color output (WASM sandbox has no TTY detection)
- No PCRE2 (Rust `regex` crate flavor is sufficient)
- No parallel search (single-threaded WASI)
- No memory-mapped I/O (not available in WASI)
