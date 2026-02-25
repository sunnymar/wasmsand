# Sandbox Bug Fix Batch

**Date:** 2026-02-25
**Status:** Approved

## Overview

16 bugs discovered during MCP sandbox customer testing. Fixes span shell executor/parser (9), coreutils (3), Python socket shim (1), sqlite3 WASM build (1), plus 2 shell redirect issues.

## Layer 1: Shell (packages/shell/src/ + packages/orchestrator/src/shell/shell-runner.ts)

### 1. Pipe → while/for loop: empty output
**Symptom:** `seq 1 3 | while read n; do echo $n; done` → empty
**Cause:** Compound commands (while, for) in pipeline subshell don't wire stdout to pipe.
**Fix:** In pipeline execution, compound commands must inherit the pipe's stdout fd.

### 2. Word splitting on unquoted `$(...)`
**Symptom:** `for w in $(echo "a b c"); do echo $w; done` → prints `a b c` as one item
**Cause:** `expandWord()` returns a single string; no IFS splitting on unquoted substitution results.
**Fix:** After command/variable substitution in unquoted context, split on IFS (default whitespace). Return multiple words from expansion when splitting occurs.

### 3. `echo -e` doesn't interpret escapes
**Symptom:** `echo -e "a\nb"` → `-e a\nb`
**Cause:** `builtinEcho()` doesn't parse `-e` flag.
**Fix:** Parse `-e`/`-n` flags. When `-e`, interpret `\n`, `\t`, `\r`, `\\`, `\0`, `\xHH`.

### 4. Heredoc + output redirect: `cat <<EOF > file` broken
**Symptom:** `cat <<EOF > /tmp/out\nhello\nEOF` → `cat: cat: No such file or directory`
**Cause:** When heredoc and output redirect coexist on same command, redirect setup interferes with heredoc stdin delivery.
**Fix:** Apply output redirect independently of heredoc stdin. Heredoc sets stdin, `> file` sets stdout — both should work together.

### 5. Process substitution `<(cmd)` crashes
**Symptom:** `cat <(echo hi)` → EISDIR crash
**Cause:** Not implemented. Parser may be misinterpreting `<(` as redirect to `(`.
**Fix:** Add to lexer/parser as a WordPart variant. Executor writes command output to a temp file, substitutes the path. Minimum viable: support `<(cmd)` (not `>(cmd)`).

### 6. `$RANDOM` empty
**Symptom:** `echo $RANDOM` → empty
**Fix:** In `expandWordPart()`, recognize `RANDOM` as special variable, return `Math.floor(Math.random() * 32768)`.

### 7. `${var^^}` and `${var:0:5}` empty
**Symptom:** `x=hello; echo ${x^^}` → empty; `echo ${x:0:3}` → empty
**Cause:** ParamExpansion switch in `expandWordPart()` doesn't handle case modification or substring operators.
**Fix:** Add `^^` (uppercase), `,,` (lowercase), `^` (first char upper), `,` (first char lower), and `:offset:length` (substring) to the expansion logic. Parser needs to recognize these operators.

### 8. `trap` not found
**Symptom:** `trap "echo done" EXIT` → "Tool not found: trap"
**Fix:** Add `trap` as shell builtin. Store signal handlers in shell state. Support at minimum `EXIT` (run handler on shell exit) and `ERR`. Ignore other signals in sandbox context.

### 9. `2>&1` in pipeline empty
**Symptom:** `ls /bad 2>&1 | head` → empty
**Cause:** Fd duplication (`2>&1`) not propagated before pipeline wiring.
**Fix:** Apply fd redirections (including dup2-style `n>&m`) before connecting pipeline fds.

### 10. Arrays
**Symptom:** `arr=(a b c); echo ${arr[1]}` → empty
**Cause:** No array support in parser or executor.
**Fix:** Add array assignment syntax `name=(word...)`, indexed access `${name[n]}`, `${name[@]}`, `${#name[@]}`. Store arrays separately from scalar variables in shell state.

## Layer 2: Coreutils (packages/coreutils/src/bin/)

### 11. `cut -d:` treats `-d:` as filename
**File:** `cut.rs`
**Cause:** Arg parser checks `args[i] == "-d"` (exact match), doesn't handle attached form.
**Fix:** Check if arg starts with `-d` and len > 2 → delimiter is `arg.chars().nth(2)`.

### 12. `xargs -I{}` no replacement
**File:** `xargs.rs`
**Cause:** Only `-n` is parsed, `-I` ignored.
**Fix:** Parse `-I` option (next arg is replace string). For each input line, substitute replace string in command template, execute.

### 13. `find -exec {} +` no batch mode
**File:** `find.rs`
**Cause:** `-exec` only handles `\;` terminator (one exec per match).
**Fix:** Detect `+` terminator. Accumulate all matching paths. Execute command once with all paths appended.

## Layer 3: Python Socket Shim (packages/orchestrator/src/network/socket-shim.ts)

### 14. Missing `AF_UNSPEC` breaks asyncio
**Cause:** Socket shim defines AF_INET, AF_INET6, SOCK_STREAM, SOCK_DGRAM, IPPROTO_TCP only.
**Fix:** Add: `AF_UNSPEC=0`, `SOL_TCP=6`, `IPPROTO_UDP=17`, `SOL_SOCKET=1`, `SO_REUSEADDR=2`, `SO_ERROR=4`, `has_ipv6=True`, `error=OSError`, `timeout=OSError`, `gaierror=OSError`, `herror=OSError`. Also add `getfqdn()`, `gethostname()`, `inet_aton()`, `inet_ntoa()` stubs.

## Layer 4: SQLite3 (packages/sqlite/)

### 15. On-disk databases: "disk I/O error"
**Cause:** SQLite uses `fcntl(F_SETLK)` for file locking; WASI doesn't support it. Single-threaded embedded sandbox doesn't need locking.
**Fix:** Recompile with `-DSQLITE_OMIT_WAL -DSQLITE_THREADSAFE=0` and a no-op locking VFS shim. No host changes needed.

## Layer 5: Minor

### 16. `$SHELL` empty
**Fix:** Set `SHELL=/bin/sh` in default environment during sandbox init.

## Testing

Every fix gets a conformance test:

- **Shell tests** in `conformance/shell.test.ts`: unskip array tests, add tests for while-read-pipe, word-splitting, echo -e, heredoc+redirect, process-sub, $RANDOM, ${var^^}, ${var:0:5}, trap EXIT, 2>&1, arrays
- **Coreutils tests**: `cut -d:`, `xargs -I{}`, `find -exec +` in respective conformance files
- **Python test**: `import asyncio` succeeds, `socket.AF_UNSPEC` exists
- **SQLite3 test**: `sqlite3 /tmp/test.db "CREATE TABLE t(id INTEGER); INSERT INTO t VALUES(1); SELECT * FROM t;"` returns `1`
- **MCP integration**: manual verification of all 16 fixes through sandbox MCP tools
