# Shell & Commands Reference

## Available tools

| Category | Tools |
|----------|-------|
| File operations | cat, cp, mv, rm, mkdir, rmdir, ls, touch, ln, chmod, truncate, split, cmp, patch |
| Text processing | grep, sort, uniq, wc, head, tail, cut, tr, tac, tee, rev |
| Text formatting | fmt, fold, nl, expand, unexpand, paste, column, numfmt |
| Advanced text | sed, awk, diff, comm, join, csplit |
| Search & inspection | find, rg, xargs, strings, file, tree, stat |
| Data formats | jq |
| Archiving | tar, gzip, gunzip, zip, unzip |
| Disk usage | du, df |
| Path utilities | basename, dirname, readlink, realpath |
| Environment | env, printenv, export, unset, uname, whoami, id, hostname, nproc |
| Math & data | bc, dc, sqlite3 (in-memory) |
| Encoding & hashing | base64, md5sum, sha256sum, cksum, xxd, od |
| Scripting | echo, printf, test, expr, seq, sleep, yes, true, false, mktemp, timeout |
| Shell builtins | cd, pwd, which, date, source/`.`, exit, history, eval, getopts, set, read |
| Shell commands | sh, bash (execute scripts and `sh -c` one-liners) |
| Package management | pkg (install/list/remove WASI binaries), pip (list/show/install for extensions) |
| Networking | curl, wget (requires network access to be enabled) |
| Python | python3 (RustPython, standard library) |

All tools are compiled to WebAssembly and run inside the WASM sandbox with the same isolation guarantees.

## Shell features

### Operators and I/O

Pipes (`|`), redirects (`>`, `>>`, `<`, `2>`, `2>&1`), here-documents (`<<EOF`), boolean operators (`&&`, `||`), semicolons, subshells (`(...)`)

### Quoting and expansion

Single/double quotes, escape sequences, tilde expansion (`~`), variable expansion (`$VAR`, `${VAR:-default}`, `${VAR:+alt}`, `${VAR:=val}`, `${VAR:?err}`), string manipulation (`${VAR#prefix}`, `${VAR%suffix}`, `${VAR/old/new}`), command substitution (`$(...)`), arithmetic expansion (`$(( ))`), brace expansion (`{a,b,c}`, `{1..5}`), globbing (`*`, `?`)

### Control flow

`if`/`elif`/`else`/`fi`, `for`/`do`/`done`, `while`/`do`/`done`, `case`/`esac`, `break`, `continue`, `set -e` (errexit), `set -u` (nounset)

### Functions and sourcing

Function definitions (`name() { ...; }`), `source`/`.` for loading files, `read` for stdin parsing

### Special variables

`$?` (last exit code), `$@` and `$*` (all positional parameters), `$#` (argument count), `$1`–`$9` (positional parameters)

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
