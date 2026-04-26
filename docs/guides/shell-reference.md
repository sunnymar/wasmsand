# Shell & Commands Reference

## Architecture

The sandbox runs three kinds of commands:

**Executables** are standalone WASM binaries spawned as isolated processes by the kernel. The default userland is **BusyBox 1.37.0** compiled to WASI — a single multicall binary that provides ~96 standard POSIX utilities (`cat`, `ls`, `awk`, `sed`, `find`, `tar`, …). A handful of utilities (`column`, `csplit`, `file`, `fmt`, `iconv`, `join`, `jq`, `numfmt`, `rg`, `sha224sum`, `sha384sum`, `zip`) keep their Rust standalones because BusyBox doesn't ship them or we want different behavior. Custom executables (Python, sqlite3, pdf-tools, etc.) and your own additions sit alongside BusyBox. See [Creating Executables](./creating-commands.md).

**Shell builtins** run inside the shell process itself. They must be in-process because they modify shell state (variables, working directory, control flow). Builtins write output to fd 1 and read input from fd 0, just like executables.

**Virtual commands** also run inside the shell process but call host APIs (networking, package management) that aren't available through WASI. Currently: `curl`, `wget`, `pkg`, `pip`.

All three share the same I/O model: stdin is fd 0, stdout is fd 1, stderr is fd 2. Pipes connect fd 1 of one stage to fd 0 of the next. Redirects (`>`, `2>&1`, `<`, heredocs) are implemented by the shell via `dup2` on the standard fds before the command runs.

## Executables

| Category | Commands |
|----------|----------|
| File operations | cat, cp, mv, rm, mkdir, rmdir, ls, touch, ln, link, unlink, chmod, chown, chgrp, truncate, split, cmp, patch |
| Text processing | grep, sort, uniq, wc, head, tail, cut, tr, tac, tee, rev |
| Text formatting | fmt‡, fold, nl, expand, unexpand, paste, column†, numfmt‡ |
| Advanced text | sed, awk, diff, comm, join‡, csplit‡ |
| Search & inspection | find, rg†, xargs, strings, file‡, tree, stat |
| Data formats | jq‡ |
| Archiving | tar, gzip, gunzip, zcat, zip†, unzip |
| Disk usage | du, df |
| Path utilities | basename, dirname, readlink, realpath |
| Environment | env, printenv, uname, whoami, id, hostname, nproc, arch, uptime, who, users, logname, groups, hostid |
| Math & data | bc, dc, factor, expr, sqlite3 (in-memory) |
| Encoding & hashing | base32, base64, md5sum, sha1sum, sha256sum, sha512sum, sha224sum‡, sha384sum‡, cksum, sum, xxd, hexdump, od |
| Scripting | echo, printf, test, seq, sleep, yes, true, false, mktemp, timeout, nice, nohup, tsort, shuf |
| Python | python3, python (RustPython, standard library) |

`†` = Rust standalone (not provided by BusyBox). `‡` = upstream C port via cpcc (`packages/c-ports/`). Everything else resolves to `/usr/bin/busybox` via VFS symlinks created at sandbox init.

`python` is a symlink to `python3` — both work interchangeably.

Note: `echo`, `printf`, `test`, and `sleep` exist as both executables and shell builtins. The shell builtin takes precedence; the executable is used when invoked via `command echo` or `/usr/bin/echo`. When the BusyBox executable is invoked, semantics follow BusyBox (e.g., `awk` numeric literal `01234` is decimal, not octal — see `awk-busybox.test.ts` for the full conformance matrix).

### BusyBox as the default userland

BusyBox is built with `cpcc` (the codepod clang wrapper from the guest-compat toolchain) and linked against `libcodepod_guest_compat.a` for libc shims (`uname`, `getpid`, `setjmp`/`longjmp`, hardlink-aware `link`, …). The build artifact is a single `busybox.wasm` binary; at sandbox creation, the orchestrator's `ProcessManager.registerMulticallTool('busybox', …, BUSYBOX_APPLETS)` creates one VFS symlink per applet under `/usr/bin/`, all pointing to `/usr/bin/busybox`. BusyBox dispatches on `argv[0]`, so `cat foo.txt` runs the same wasm as `busybox cat foo.txt`.

This is identical to how BusyBox works on Alpine, OpenWrt, embedded Linux — the only sandbox-specific bit is that the symlinks live in the in-memory VFS rather than a real disk.

### Tool files and command aliasing

Every registered executable is represented as a file in `/usr/bin/` with a special `S_TOOL` permission flag. The file's content is the path to its `.wasm` binary. Because tools are real files, standard Unix symlinks work as command aliases:

```bash
# python is already a symlink to python3:
ls -la /usr/bin/python   # -> /usr/bin/python3

# Symlinks resolve through the VFS naturally:
python -c "print('hello')"   # runs python3.wasm
```

The `S_TOOL` flag (`0o100000`) is a reserved permission bit that:
- Is set automatically when tools are registered during sandbox initialization
- Cannot be set or cleared by `chmod` — the VFS strips it in user mode
- Is checked during command resolution — only files with `S_TOOL` are treated as tool stubs

This prevents sandbox code from forging tool files. Even if a user could write to `/usr/bin/` (they can't — it's `0o555`), a file without `S_TOOL` would not be recognized as a tool.

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
| `sleep` | Suspend execution for N seconds (supports decimals: `sleep 0.5`) |
| `wait` | Wait for background jobs (`wait` for all, `wait $pid` for specific) |
| `jobs` | List background jobs with status |
| `ps` | List all processes in the sandbox |
| `alias` | Define or list command aliases |
| `unalias` | Remove aliases (`-a` removes all) |

## Virtual commands

| Command | Purpose |
|---------|---------|
| `curl` | HTTP requests (requires network access) |
| `wget` | Download files (requires network access) |
| `pkg` | Install/list/remove WASM executables |
| `pip` | Python package management (list/show/install for extensions) |

## Shell features

### Operators and I/O

Pipes (`|`), redirects (`>`, `>>`, `<`, `2>`, `2>&1`), here-documents (`<<EOF`), here-strings (`<<<`), boolean operators (`&&`, `||`), semicolons, subshells (`(...)`), process substitution (`<(cmd)`, `>(cmd)`), background jobs (`&`)

### Quoting and expansion

Single/double quotes, escape sequences, tilde expansion (`~`), variable expansion (`$VAR`, `${VAR:-default}`, `${VAR:+alt}`, `${VAR:=val}`, `${VAR:?err}`), string manipulation (`${VAR#prefix}`, `${VAR%suffix}`, `${VAR/old/new}`), command substitution (`$(...)`), process substitution (`<(cmd)`, `>(cmd)`), arithmetic expansion (`$(( ))`), brace expansion (`{a,b,c}`, `{1..5}`), array expansion (`${arr[0]}`, `${arr[@]}`, `${#arr[@]}`), globbing (`*`, `?`)

### Control flow

`if`/`elif`/`else`/`fi`, `for`/`do`/`done`, `while`/`do`/`done`, `case`/`esac`, `break`, `continue`, `set -e` (errexit), `set -u` (nounset)

### Functions and sourcing

Function definitions (`name() { ...; }`), `source`/`.` for loading files

### Aliases

```bash
alias ll="ls -la"
alias gs="git status"
ll              # expands to: ls -la
unalias ll      # remove one alias
unalias -a      # remove all aliases
alias           # list all aliases
```

Aliases expand the first word of a command. If the replacement's first word is also an alias, it expands recursively (with loop detection). Aliases do not expand in argument positions.

### Arrays

```bash
# Indexed arrays
arr=(one two three)
echo ${arr[0]}          # one
echo ${arr[@]}          # one two three
echo ${#arr[@]}         # 3
arr+=(four five)        # append
arr[1]=TWO              # set element

# Associative arrays
declare -A map
map[name]=alice
map[age]=30
echo ${map[name]}       # alice

# Slicing
echo ${arr[@]:1:2}      # two three
```

### Process substitution

```bash
# Input process substitution: <(cmd) runs cmd, provides output as a file path
diff <(sort file1.txt) <(sort file2.txt)
cat <(echo hello)

# Output process substitution: >(cmd) provides a file path that feeds into cmd
echo hello > >(cat)
```

`<(cmd)` executes `cmd` and replaces the expression with a temporary file path containing the command's stdout. `>(cmd)` creates a temporary file path; after the main command writes to it, the contents are fed as stdin to `cmd`.

### Background jobs

The `&` operator runs a command in the background, returning control to the shell immediately:

```bash
# Run two commands in parallel
echo a > /tmp/out1 & echo b > /tmp/out2 & wait

# Background a long-running process
sleep 10 &
jobs          # [1] Running sleep 10 &
wait          # blocks until all background jobs finish

# Wait for a specific job
cmd1 & cmd2 &
wait $!       # wait for cmd2 (most recent background PID)
```

Background jobs use cooperative multitasking via JSPI — multiple WASM instances run concurrently within the same process, yielding at I/O boundaries. This enables parallel tool execution (e.g., an LLM running `tool1 & tool2 & wait`).

### Special variables

`$?` (last exit code), `$!` (PID of most recent background job), `$@` and `$*` (all positional parameters), `$#` (argument count), `$1`-`$9` (positional parameters)

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

The sandbox provides virtual `/dev` and `/proc` filesystems backed by host providers. Each provider declares an `fsType` (`devtmpfs`, `proc`) that the VFS surfaces through `statfs`-style queries.

### /dev — streaming devices

| Path | Behavior |
|------|----------|
| `/dev/null` | Discards writes, returns empty on read |
| `/dev/zero` | Returns zero-filled bytes |
| `/dev/random`, `/dev/urandom` | Cryptographically random bytes (via `crypto.getRandomValues`) |
| `/dev/full` | Reads zeros; writes always fail with `ENOSPC` |

`/dev` providers are **streaming** — `read()` and `write()` go directly through the provider on every syscall, so producers like `head -c 16 /dev/urandom | xxd` get fresh entropy each call instead of a frozen materialized buffer.

### /proc — per-PID process info

The `ProcProvider` synthesizes `/proc` entries lazily, mirroring Linux:

| Path | Behavior |
|------|----------|
| `/proc/uptime` | Seconds since sandbox creation |
| `/proc/version` | `codepod-<version>` build string |
| `/proc/cpuinfo` | Processor information |
| `/proc/meminfo` | Memory information |
| `/proc/diskstats` | VFS storage statistics (JSON) |
| `/proc/mounts` | Active mount table (sourced from the VFS) |
| `/proc/self` | Magic symlink resolved per-caller (Linux convention) — `readlink /proc/self` returns the calling process's pid; `cat /proc/self/comm` reports the caller's applet name |
| `/proc/<pid>/stat` | Linux-format stat line (state, ppid, utime, …) |
| `/proc/<pid>/status` | Human-readable status (Name, State, Pid, PPid, Uid, Gid) |
| `/proc/<pid>/cmdline` | NUL-separated argv |
| `/proc/<pid>/comm` | Process name (e.g. `bash` for PID 1) |

PID 1 is the **initial** shell that the sandbox starts at boot, presented as `/bin/bash` — Unix init. Nested processes (`bash` invoked from inside the sandbox, or Python re-spawning a shell, or `bash → python → bash`) get sequential pids and have a real `ppid` chain back through their parent shells. So `cat /proc/1/comm` always reports the boot shell, while `cat /proc/self/comm` always reports the applet running the `cat`.

These work transparently with all utilities: `cat /dev/null`, `head -c 16 /dev/random | xxd`, `cat /proc/uptime`, `ls /proc/self/fd/`.
