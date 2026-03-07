# Shell & Commands Reference

## Architecture

The sandbox runs three kinds of commands:

**Executables** are standalone WASM binaries spawned as isolated processes by the kernel. They use standard Rust I/O (`stdin()`, `stdout()`, `stderr()`, `std::fs`). The WASI layer maps these to the sandbox's pipes, capture buffers, and virtual filesystem. All coreutils and most tools are executables. See [Creating Executables](./creating-commands.md) for how to add new ones.

**Shell builtins** run inside the shell process itself. They must be in-process because they modify shell state (variables, working directory, control flow). Builtins write output to fd 1 and read input from fd 0, just like executables.

**Virtual commands** also run inside the shell process but call host APIs (networking, package management) that aren't available through WASI. Currently: `curl`, `wget`, `pkg`, `pip`.

All three share the same I/O model: stdin is fd 0, stdout is fd 1, stderr is fd 2. Pipes connect fd 1 of one stage to fd 0 of the next. Redirects (`>`, `2>&1`, `<`, heredocs) are implemented by the shell via `dup2` on the standard fds before the command runs.

## Executables

| Category | Commands |
|----------|----------|
| File operations | cat, cp, mv, rm, mkdir, rmdir, ls, touch, ln, chmod, truncate, split, cmp, patch |
| Text processing | grep, sort, uniq, wc, head, tail, cut, tr, tac, tee, rev |
| Text formatting | fmt, fold, nl, expand, unexpand, paste, column, numfmt |
| Advanced text | sed, awk, diff, comm, join, csplit |
| Search & inspection | find, rg, xargs, strings, file, tree, stat |
| Data formats | jq |
| Archiving | tar, gzip, gunzip, zip, unzip |
| Disk usage | du, df |
| Path utilities | basename, dirname, readlink, realpath |
| Environment | env, printenv, uname, whoami, id, hostname, nproc |
| Math & data | bc, dc, sqlite3 (in-memory) |
| Encoding & hashing | base64, md5sum, sha256sum, cksum, xxd, od |
| Scripting | echo, printf, test, expr, seq, sleep, yes, true, false, mktemp, timeout |
| Python | python3 (RustPython, standard library) |

Executables are compiled to `wasm32-wasip1` and live in `packages/coreutils/src/bin/`. The sandbox auto-discovers `.wasm` files from the configured `wasmDir`.

Note: `echo`, `printf`, and `test` exist as both executables and shell builtins. The shell builtin takes precedence; the executable is used when invoked via `command echo` or `/usr/bin/echo`.

## Shell builtins

| Builtin | Purpose |
|---------|---------|
| `cd` | Change working directory |
| `pwd` | Print working directory |
| `echo` | Print arguments |
| `printf` | Formatted output (supports `%s`, `%d`, `\n`, `\t`, `\0` octal escapes) |
| `read` | Read a line from stdin into variables |
| `export` | Set environment variables |
| `unset` | Remove variables |
| `set` | Set shell options (`-e`, `-u`, `-o pipefail`) and positional parameters |
| `local` | Declare local variables in functions |
| `declare` / `typeset` | Declare variables with attributes |
| `readonly` | Mark variables as read-only |
| `test` / `[` | Conditional expressions |
| `exit` | Exit the shell |
| `return` | Return from a function |
| `source` / `.` | Execute a script in the current shell |
| `eval` | Evaluate a string as a command |
| `exec` | Replace the shell with a command |
| `shift` | Shift positional parameters |
| `type` | Show how a command would be interpreted |
| `command` | Run a command bypassing functions and builtins |
| `which` | Locate a command |
| `let` | Arithmetic evaluation |
| `getopts` | Parse positional parameters |
| `read` | Read stdin into variables (`-r`, `-d`, `-n`, `-a` flags) |
| `mapfile` / `readarray` | Read lines from stdin into an array |
| `trap` | Set signal/exit handlers |
| `history` | Command history |
| `date` | Print current date/time |
| `chmod` | Change file permissions |
| `pushd` / `popd` / `dirs` | Directory stack |
| `break` / `continue` | Loop control |

## Virtual commands

| Command | Purpose |
|---------|---------|
| `curl` | HTTP requests (requires network access) |
| `wget` | Download files (requires network access) |
| `pkg` | Install/list/remove WASM executables |
| `pip` | Python package management (list/show/install for extensions) |

## Shell features

### Operators and I/O

Pipes (`|`), redirects (`>`, `>>`, `<`, `2>`, `2>&1`), here-documents (`<<EOF`), here-strings (`<<<`), boolean operators (`&&`, `||`), semicolons, subshells (`(...)`)

### Quoting and expansion

Single/double quotes, escape sequences, tilde expansion (`~`), variable expansion (`$VAR`, `${VAR:-default}`, `${VAR:+alt}`, `${VAR:=val}`, `${VAR:?err}`), string manipulation (`${VAR#prefix}`, `${VAR%suffix}`, `${VAR/old/new}`), command substitution (`$(...)`), arithmetic expansion (`$(( ))`), brace expansion (`{a,b,c}`, `{1..5}`), globbing (`*`, `?`)

### Control flow

`if`/`elif`/`else`/`fi`, `for`/`do`/`done`, `while`/`do`/`done`, `case`/`esac`, `break`, `continue`, `set -e` (errexit), `set -u` (nounset)

### Functions and sourcing

Function definitions (`name() { ...; }`), `source`/`.` for loading files

### Special variables

`$?` (last exit code), `$@` and `$*` (all positional parameters), `$#` (argument count), `$1`-`$9` (positional parameters)

## I/O model

All output flows through file descriptors. There are no string-based output buffers.

```
stdin  = fd 0    (pipe from previous stage, input redirect, or /dev/null)
stdout = fd 1    (pipe to next stage, capture buffer, or redirect target)
stderr = fd 2    (capture buffer or redirect target)
```

**Pipelines** create OS-level pipes between stages. The shell `dup2`s the pipe fds onto 0/1 before running each stage:

```
echo hello | grep h | wc -l

  echo        grep         wc
  fd1→pipe₁   fd0←pipe₁   fd0←pipe₂
               fd1→pipe₂   fd1→capture
```

**Redirects** work by `dup2`-ing onto the standard fds before the command runs:
- `cmd > file` — shell captures fd 1 output via pipe sink, writes to file
- `cmd < file` — shell writes file content to a pipe, `dup2`s onto fd 0
- `cmd 2>&1` — shell `dup2(fd1, fd2)` so stderr goes where stdout goes
- `cmd <<EOF` — shell writes heredoc content to a pipe on fd 0

**Command substitution** (`$(cmd)`) captures fd 1 output via a pipe.

## Virtual filesystems

The sandbox provides virtual `/dev` and `/proc` filesystems:

| Path | Behavior |
|------|----------|
| `/dev/null` | Discards writes, returns empty on read |
| `/dev/zero` | Returns zero-filled bytes |
| `/dev/random`, `/dev/urandom` | Cryptographically random bytes |
| `/proc/uptime` | Seconds since sandbox creation |
| `/proc/version` | Sandbox version string |
| `/proc/cpuinfo` | Processor information |
| `/proc/meminfo` | Memory information |
| `/proc/diskstats` | VFS storage statistics (JSON) |

These work transparently with coreutils: `cat /dev/null`, `head -c 16 /dev/random | xxd`, `cat /proc/uptime`.
