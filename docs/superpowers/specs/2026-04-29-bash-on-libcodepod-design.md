# Bash on libcodepod

## Status

Implemented for the kernel/tooling/source-purity milestone. Successor
to the kernel/userland separation work
(`2026-04-27-kernel-userland-separation-design.md`), which left bash
running as a "userland-shaped" wasm but still calling codepod-specific
host imports through `WasmHost`/`HostInterface`.

Completed slices:

- Slice 0: `shell-exec` renamed to `bash-rs`; wasm artifact installed
  as `bash.wasm`.
- Slices 1-5: redirection, pipes, spawn/wait, filesystem, sockets,
  signals, and setjmp/longjmp now exercise the POSIX/libcodepod path.
- Slice 6: `/bin/host-call` plus `codepod-host` own extension dispatch;
  `/usr/extensions/<name>` resolves through normal symlink/spawn
  execution.
- Slice 7: `packages/bash-rs/src/host.rs`, `WasmHost`, and
  `HostInterface` are gone from bash source. The source-purity grep is
  enforced by `scripts/check-bash-source-purity.sh`.

Deferred follow-up: package format and runtime `pkg`/real-ish `pip`
integration are tracked separately. This bash/libcodepod migration
intentionally stops at kernel/tooling/source-purity acceptance.

This design retires that coupling. Bash becomes a vanilla Rust
program. The toolchain — not the source — is what makes it run on
codepod.

## Outcome

Target end state — `packages/shell-exec/` is renamed to
`packages/bash-rs/` (crate `codepod-bash`; installed as `/bin/bash` in
the sandbox). It is a normal Rust crate that the same source tree
builds two ways:

- `cargo build` on Mac (or Linux): produces a native binary, runs at
  the terminal as a tiny shell. Useful as the inner dev loop —
  debugger, panic backtraces, fast iteration.
- `cargo build --target wasm32-wasip1` linked against `libcodepod.a`:
  produces a `.wasm` that runs inside codepod. Identical source.

The bash source contains zero codepod-specific symbols. No
`use cp_std`, no `host_*` imports, no `#[cfg(codepod)]`. POSIX-standard
names only: `libc::*`, `nix::*`, `std::os::fd::*`, `std::fs`, `std::io`.
Where wasi-libc is missing a POSIX symbol, `libcodepod.a` provides it,
backed by codepod's existing `host_*` imports.

`packages/bash-rs/src/host.rs` is deleted. `WasmHost` and
`HostInterface` go with it.

`extension_invoke` stays as a kernel primitive but moves out of bash's
field of view. It is reached via `/bin/host-call`, a small wasm binary
that uses the shared Rust `codepod-host` crate. `codepod-host` owns the
raw codepod-specific ABI, including `extension_invoke`; `host-call`
owns only the extension CLI protocol. Extensions are registered as
symlinks (`/usr/extensions/<name> -> /bin/host-call`) and dispatched by
busybox-style `argv[0]` inspection. Bash never sees extensions
specially.

`libcodepod_guest_compat.a` is renamed `libcodepod.a`. The "guest"
qualifier was carried over from the third-party-port framing, which is
no longer the relevant distinction. Everything that runs in the sandbox
links the same archive.

The product requirement is **build/run purity for bash** as a wiring
proof: if the toolchain is correct, bash works as a stock Rust app.
Every place where bash needs codepod-specific source modifications is a
real signal — either a host-ABI gap or a libc-shim gap, surfaced by a
falsifiable purity test.

**Explicitly deferred** (out of scope here): porting upstream GNU bash
(C). That is a longer-running compatibility validation of the cpcc +
`libcodepod.a` path against an unsuitable-for-WASM consumer. It motivates
keeping the cpcc surface honest but is not blocked by, nor blocking,
this design.

## Problem

After the kernel/userland separation:

- `packages/bash-rs/src/main.rs` builds as a wasm module that the
  kernel loads and calls via the `__run_command` ABI.
- `packages/bash-rs/src/host.rs` declares ~30 `extern "C"` functions
  in the `codepod` namespace (`host_spawn_async`, `host_pipe`,
  `host_dup2`, `host_waitpid`, `host_read_fd`, `host_write_fd`,
  `host_stat`, `host_glob`, `host_run_command`,
  `host_extension_invoke`, ...).
- `WasmHost` (~400 lines) wraps each as a typed Rust call, marshaling
  JSON in and out. `HostInterface` exposes them as a trait the executor
  consumes.
- The executor (`packages/bash-rs/src/executor.rs`) issues pipe /
  dup / spawn / waitpid sequences against this trait.

Three problems with that shape:

**1. Bash leaks codepod-awareness.** The source references
`host_spawn`, `host_pipe`, `host_dup2`. It cannot build with stock
cargo on a non-codepod target without a stub of the same trait. That
defeats the "is the wiring correct" test — bash is structurally
codepod-only, so we can never tell whether codepod's POSIX layer is
honest or whether bash is just papering over its own gaps.

**2. The cpcc + libcodepod.a path is not exercised by us.** Today only
third-party ports (grex, busybox testsuite, coreutils testsuite) link
against `libcodepod_guest_compat.a`. Bash — the most heavily-exercised
guest in the system — bypasses it. Bugs in the shim, in cpcc's flag
selection, or in the host-side semantics of e.g. `posix_spawn` go
undetected by our most representative consumer until a third-party
port stumbles on them.

**3. Extensions are ambiguously routed.** Today the kernel maps
extension files to extension calls via a special mode bit and
intercepts the spawn dispatch. The mechanism is hacky (mode bits in
the VFS), bash-aware (the kernel must know whether an exec target is
"a real binary" or "an extension call"), and forces the kernel into a
routing decision that doesn't compose cleanly with PATH lookup, shebang
handling, or argv preservation.

## Goals

1. Bash source builds with stock cargo on Mac/Linux and runs natively.
2. Bash source builds with `--target wasm32-wasip1` + `libcodepod.a`
   and runs inside codepod. Same shell library and executor source, no
   codepod-specific `#[cfg]` switches. Thin target-specific entrypoints
   are allowed for native CLI startup vs wasm resident-mode exports.
3. `packages/bash-rs/src/host.rs`, `WasmHost`, and `HostInterface`
   are deleted. The executor reaches POSIX through `libc`/`nix`/`std`
   only.
4. `libcodepod_guest_compat.a` is renamed `libcodepod.a`. cpcc and all
   downstream consumers track the rename.
5. Extensions are dispatched via `/usr/extensions/<name>` symlinks to
   `/bin/host-call`. `host-call` uses the Rust `codepod-host` wrapper;
   `codepod-host` is the only userland library that declares the raw
   `extension_invoke` import. Bash has no extension-specific code.
6. Existing bash behavior (parser, builtins, redirection, pipelines,
   job control, traps) is preserved end-to-end. The bash-rs test suite
   passes.

## Non-goals

- **fork(2).** Not in WASM, not in our model. Most Rust apps don't
  reach for it; bash internally uses spawn+pipe+dup2 patterns. Real
  fork semantics (`$$`, copy-on-write env, fd inheritance edge cases)
  are emulated where possible and accepted as imperfect where not.
- **`std::process::Command` on wasi.** Stock std stubs it to
  `Err(Unsupported)`. We work *beneath* `std::process`, calling
  `libc::posix_spawn` (or `nix::unistd` wrappers) directly. Patching
  std to consult `posix_spawn` on wasi is a possible upstream
  contribution; out of scope here.
- **Replacing wasi-libc.** `libcodepod.a` is additive — it provides
  the symbols wasi-libc doesn't, and wasi-libc continues to provide
  the rest (file I/O, time, env, alloc).
- **Forking rustc, std, or cargo.** No sysroot distribution, no custom
  target spec. Stock toolchain plus link flags only.
- **Porting upstream GNU bash (C).** Worthwhile, separate effort.
- **CP_STD (or any codepod-named Rust crate bash imports).** The
  abstraction is at the link layer, not the Rust module layer.

## Design

### Layering

```
                        ┌──────────────────────────────────────┐
   bash source     ───► │ libc / nix / std / std::os::fd       │  POSIX-standard names
                        └──────────────────────────────────────┘
                                     │
                            ┌────────┴─────────┐
                            ▼                  ▼
                     wasi-libc            libcodepod.a
                     (fd_read,            (posix_spawn,
                      fd_write,            pipe2, dup2,
                      path_open,           waitpid, kill,
                      ...)                 setpgid,
                                           sigaction,
                                           tcsetpgrp, ...)
                                                │
                                                ▼
                                        host_* imports
                                        (host_spawn,
                                         host_pipe,
                                         host_dup2,
                                         host_waitpid,
                                         ...)
```

The Rust source on the left is platform-neutral. The middle row is the
C ABI. The right column is codepod-specific but invisible to the bash
source — only the linker knows.

### What bash calls (mapping)

| Bash today (`host.rs`)                                              | Bash after                                              |
| ---                                                                 | ---                                                     |
| `host.spawn_async(prog, args, env, cwd, stdin_data, stdin_fd, stdout_fd, stderr_fd, nice)` + `host.waitpid(pid)` | `libc::posix_spawn(...)` + `libc::waitpid(...)`         |
| `host.pipe()` → `(r, w)`                                            | `nix::unistd::pipe2(O_CLOEXEC)` → `(OwnedFd, OwnedFd)`  |
| `host.dup(fd)` / `host.dup2(src, dst)` / `host.close_fd(fd)`        | `nix::unistd::dup` / `dup2` / `close` (or `libc::*`)    |
| `host.read_fd(fd)` / `host.write_fd(fd, data)`                      | `libc::read` / `libc::write` (or `std::io::Read/Write` over `OwnedFd`) |
| `host.stat(path)`                                                   | `std::fs::metadata` (wasi-libc covers it)               |
| `host.read_file(path)` / `host.write_file(path, data, mode)`        | `std::fs::read` / `std::fs::write`                      |
| `host.readdir(path)`                                                | `std::fs::read_dir`                                     |
| `host.mkdir(path)` / `host.remove(path, recursive)` / `host.chmod(path, mode)` | `std::fs::create_dir` / `std::fs::remove_*` / `std::os::unix::fs::PermissionsExt` |
| `host.glob(pattern)`                                                | `globset` or `glob` crate (Rust-side, no syscall)       |
| `host.rename`, `host.symlink`, `host.readlink`                       | `std::fs::rename`, `std::os::unix::fs::symlink`, `std::fs::read_link` |
| `host.socket_*`                                                     | POSIX socket calls (`libc::socket`, `libc::connect`, `getaddrinfo`, `send`, `recv`, ...), backed by `libcodepod.a` and the kernel socket backend. Stock Rust `std::net` on `wasm32-wasip1` does not currently lower through these libc symbols, so `std::net` support is separate custom-std / upstream-std work rather than part of the bash purity milestone. |
| `host.has_tool` / `host.register_tool`                              | Drop. Belongs in package manager surface, not bash.     |
| `host.run_command`                                                  | Drop. Was a detour around the lack of real spawn.       |
| `host.extension_invoke`                                             | Drop from bash. Routed via `/usr/extensions/<name>` → `/bin/host-call`. |
| `host.list_processes`                                               | Drop, or expose as a `/proc`-style read in the kernel-side VFS later. |
| `host.yield_now` / `host.waitpid_nohang`                            | `nix::unistd::sched_yield` / `waitpid(WNOHANG)`         |

After this, `host.rs` has no contents and is deleted with `WasmHost`
and `HostInterface`.

### `nix` is ergonomics, not abstraction

We default to the `nix` crate inside the executor for clarity. Example:

```rust
// before
let (r, w) = host.pipe()?;        // returns (i32, i32), JSON-marshalled
host.dup2(r, 0)?;
host.close_fd(r)?;
host.spawn_async(...)
```

```rust
// after
let (rx, tx) = nix::unistd::pipe2(OFlag::O_CLOEXEC)?;   // (OwnedFd, OwnedFd)
nix::unistd::dup2(rx.as_raw_fd(), 0)?;
drop(rx);
let pid = nix::unistd::posix_spawn(...)?;
```

`nix` itself just calls `extern "C"` libc symbols. On Mac it resolves
to system libc; on `wasm32-wasip1` it resolves to wasi-libc plus
`libcodepod.a`. No codepod awareness in the Rust source.

Where `nix` lacks a wrapper or its API is awkward, fall back to
`libc::*` directly. The rule is "POSIX-standard names only," not "must
use nix."

### `libcodepod.a` (renamed)

`packages/guest-compat/src/codepod_*.c` is the starting point for the
surface bash needs (per the existing
`packages/guest-compat/include/sys/{wait,signal,spawn}.h` headers and
the `cpcc` Tier-1 list), but this migration is also a gap-discovery
pass. The archive is not assumed complete at the start.

- process: `posix_spawn`, `posix_spawnp`, `posix_spawn_file_actions_*`,
  `execv`, `execve`, `execvp`, `waitpid`, `wait`, `kill`, `raise`
  (known area to validate: spawn attrs and non-stdio file actions)
- pipe/fd: `pipe`, `pipe2`, `dup`, `dup2`, `dup3`, `close`
- signal: `signal`, `sigaction`, `sigprocmask`, `sigemptyset`, ...
- session: `setpgid`, `getpgid`, `tcgetpgrp`, `tcsetpgrp`
- resource: `setrlimit`, `getrlimit`, `getrusage`
- sched: `sched_getaffinity`, `sched_yield`
- env / process info: `getpid`, `getppid`, `getuid`, `geteuid`,
  `getgroups`
- setjmp: `setjmp`, `longjmp` (asyncify-backed where possible; bash
  uses these in error recovery paths)
- sockets / netdb: complete the POSIX sockets interface required by shell
  networking paths and Rust POSIX FFI users (`socket`, `connect`, `bind`,
  `listen`, `accept`, `send`, `recv`, `shutdown`, socket options,
  `getaddrinfo`, ...). This is explicitly in scope for the shim/kernel
  layer. Stock `std::net` on `wasm32-wasip1` is handled through the
  Codepod custom-std patch stack until this can move upstream. Some
  POSIX socket names
  are already strong symbols in wasi-libc (`send`, `recv`, `getsockopt`,
  `accept` as of rustc 1.93 / wasi-sdk 30), so Rust FFI coverage also
  needs toolchain/postlink symbol-ownership work; `cpcc`/`cargo-codepod`
  should use `--wrap` for duplicate-owned names that libcodepod implements.
- mktemp, sysinfo

Bash's gap list against this is expected to be discovered by the
slices, not guessed up front. The work in this spec is the bash-side
refactor plus the `libcodepod.a`/kernel fixes that refactor exposes,
with sockets and spawn semantics called out as likely high-risk areas.

The C archive remains the right surface for libc and third-party C
ports. It is not where new codepod-authored Rust programs should put
their high-level codepod API. For Rust userland we prefer a Rust crate
over adding more C shim surface unless the point of the symbol is
specifically C/POSIX compatibility.

Rename mechanics:

- `libcodepod_guest_compat.a` → `libcodepod.a`
- `codepod-guest-compat-sys` crate → `codepod-sys` (or similar; bash
  doesn't depend on the Rust binding crate so this is internal cleanup)
- `cpcc` and `cargo-codepod` link-flag injection updates
- Headers under `packages/guest-compat/include/` keep their POSIX
  names (`sys/wait.h`, `signal.h`, `spawn.h`); only the archive
  changes name

### `codepod-host` (Rust codepod host API)

There is already a Rust precedent for this shape:
`packages/python/crates/codepod-host` (`codepod-host-native`) wraps
codepod-specific host calls for the Python wasm. This design promotes
that idea into a shared Rust userland crate, `packages/codepod-host/`
(`codepod-host`), instead of having each Rust binary declare raw
imports.

`codepod-host` owns codepod-specific functionality that is not POSIX:

- `extension_invoke` / future `native_invoke` style calls
- safe Rust wrappers over codepod host functionality when Rust
  userland needs it directly
- optional Rust-facing wrappers backed by `libcodepod.a` when the
  desired operation is already implemented at the C ABI layer

This keeps the source-purity test precise. Bash must not depend on
`codepod-host`, because bash is the thing proving the POSIX + libc
wiring is honest. `host-call` may depend on `codepod-host`, because
its job is explicitly to bridge a codepod extension protocol into a
normal executable.

### Extensions: `/bin/host-call`

`host-call` is a small Rust wasm binary. It depends on `codepod-host`
and owns the command-line protocol for extension dispatch. Its full
responsibility:

```rust
fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    let invoked_as = std::path::Path::new(&argv[0])
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    let args = &argv[1..];

    // Read stdin if any
    let mut stdin = Vec::new();
    std::io::stdin().read_to_end(&mut stdin).ok();

    // The extension dispatch call is codepod-specific, but the raw
    // import is hidden behind the shared Rust wrapper crate.
    let result = codepod_host::extension_invoke(invoked_as, args, &env(), &stdin);

    std::io::stdout().write_all(&result.stdout).ok();
    std::io::stderr().write_all(&result.stderr).ok();
    ExitCode::from(result.exit_code as u8)
}
```

Extension registration on the kernel side:

- Host SDK user calls `sandbox.registerExtension(name, handler)`.
- Kernel creates a normal symlink
  `/usr/extensions/<name> -> /bin/host-call` in the VFS.
- `/usr/extensions/` is on the default `PATH`.
- Discovery is `readdir("/usr/extensions/")`.
- Unregister deletes the symlink.

Dispatch: when bash execs `<name>`, PATH lookup finds
`/usr/extensions/<name>`, the kernel's spawn path resolves the symlink
to `/bin/host-call`, *preserves `argv[0]` as `<name>`*, and runs the
binary. `host-call` reads its own invocation name and routes the call.

There is no `S_TOOL` compatibility path in the target design. Extension
entries are not registered-tool stubs and do not rely on a special VFS
mode bit. The kernel work here is to make `/bin/host-call` execute
through the same generic spawn path as any other wasm binary, including
symlink resolution from `/usr/extensions`, executable permission checks,
and argv preservation. Removing the old mode-bit routing is part of
the feature, not a follow-up compatibility concern.

This is the busybox-multicall pattern. POSIX `execve` already
specifies that argv is opaque to the kernel — argv[0] is whatever the
caller passed, independent of how the path was resolved. We need to
verify the kernel's `host_spawn` path preserves this; coreutils
multicall has the same dependency, so it likely already does.

### Mac dev loop

With the bash source platform-neutral:

```bash
$ cd packages/bash-rs
$ cargo build
$ ./target/debug/codepod-bash
$ echo 'echo hello | tr a-z A-Z' | ./target/debug/codepod-bash
HELLO
```

This is the inner loop for bash-rs development. Tests, debugger,
profiler, all work normally. WASM is reserved for "is the linkage
correct" validation, not iteration.

The native path uses real fork/exec via Mac libc. The wasm path uses
`libcodepod.a`'s `posix_spawn`. The bash source is identical. If a
test passes on Mac and fails on wasm, the failure is in
`libcodepod.a` or the host-side `host_*` imports, not in bash.

### Build-time selection

No `--cfg codepod` flags. Selection is purely target + link flags:

| Target              | Linker config                                         |
| ---                 | ---                                                   |
| Native (host arch)  | system libc, nothing extra                            |
| `wasm32-wasip1`     | wasi-libc (default) + `-lcodepod` (via cpcc) + `--allow-undefined` cleanup |

cpcc emits the `-L<libdir> -lcodepod` flags and any post-link work
(e.g., the existing wasi-shims rewriter for stdlib panic stubs). For
bash specifically, we expect post-link rewriting to be unnecessary —
bash's source has been written to avoid the std paths that need
rewriting. If cpcc reports it had to rewrite something for bash, that
is interesting information: either bash is using a wasi-broken std
path (source bug), or our shim is missing a symbol (shim gap).

## What changes concretely

**Add:**

- `packages/codepod-host/` — shared Rust userland crate, promoted from
  the existing Python-local `packages/python/crates/codepod-host`
  shape. Owns raw codepod-specific imports such as `extension_invoke`
  and exposes safe Rust wrappers. May expose `libcodepod.a`-backed
  functionality to Rust code where that is useful.
- `packages/host-call/` — new Rust crate, small single binary target.
  Compiles to `host-call.wasm`. Depends on `codepod-host` and dispatches
  extension invocations from argv/stdin/env.
- Kernel-side: extension registration writes
  `/usr/extensions/<name> -> /bin/host-call` symlinks. Default PATH
  includes `/usr/extensions/`.
- Acceptance tests: bash binary built two ways (native + wasm) passes
  the same bash-rs test suite where applicable.

**Change:**

- `packages/shell-exec/` → `packages/bash-rs/`. Rename the Rust crate
  to `codepod-bash`. The Cargo-produced artifact remains a package
  artifact; build scripts copy it into runtime fixture locations as
  `bash.wasm`, and the sandbox still installs it into the VFS as
  `/bin/bash`.
- `packages/bash-rs/src/executor.rs` — replace every
  `host.<method>(...)` with `nix::*` / `libc::*` / `std::*` equivalent.
- `packages/bash-rs/Cargo.toml` — add `nix` dependency, add
  `libc` if not already present. Remove any codepod-specific deps.
- `packages/bash-rs/src/lib.rs` — holds the platform-neutral shell
  engine and executor.
- `packages/bash-rs/src/bin/codepod-bash.rs` — native CLI entrypoint
  that reads from stdin and runs as a normal shell.
- `packages/bash-rs/src/wasm.rs` or equivalent thin wasm entrypoint —
  keeps the `__run_command` resident-mode export for now (kernel still
  calls in via that ABI). This layer may use target-specific cfg; the
  shell engine must not.
- `packages/guest-compat/` rename to drop "guest":
  - `libcodepod_guest_compat.a` → `libcodepod.a`
  - cpcc / cargo-codepod link flags updated
  - `codepod-guest-compat-sys` crate → `codepod-sys` (internal)

**Delete:**

- `packages/bash-rs/src/host.rs` (entire file)
- `WasmHost` impl
- `HostInterface` trait (or shrink to whatever native parity layer is
  unavoidable — ideally nothing)
- All bash-side call sites for `host_run_command`,
  `host_extension_invoke`, `host_register_tool`, `host_has_tool`

## Migration path (slices)

The work lands incrementally so the API of `libcodepod.a` is
pressure-tested before bash is fully on it.

**Slice 0 — Rename shell-exec to bash-rs.** Move
`packages/shell-exec/` to `packages/bash-rs/`, rename the Rust package
to `codepod-bash`, update build scripts and fixture install paths to
use `bash.wasm`, and keep installing the produced wasm as `/bin/bash`.
This is deliberately mechanical so later POSIX refactors are not mixed
with naming churn.

**Slice 1 — File redirection.** The smallest self-contained POSIX
cluster. Refactor bash's `<`, `>`, `>>`, `<<` redirection paths off
`host.rs` and onto `libc::open` + `libc::dup2` + `OwnedFd`. Build
bash-rs native, run a smoke test. Build wasm via cpcc, run the
existing redirection tests. Validates the open/dup2/close path
end-to-end.

**Slice 2 — Pipes.** Refactor pipeline construction (`|`, `|&`) off
`host.pipe`/`host.dup2` and onto `nix::unistd::pipe2` +
`nix::unistd::dup2`. Validates pipe semantics — buffer behavior, EOF
propagation, SIGPIPE.

**Slice 3 — Spawn + wait.** Refactor `host.spawn_async` +
`host.waitpid` onto `libc::posix_spawn` (with file-actions for fd
remapping) + `libc::waitpid`. This is the meatiest slice. Validates
process lifecycle, exit codes, signal-on-exit reporting, fd
inheritance.

**Slice 4 — Filesystem.** Replace `host.stat`/`host.read_file`/etc.
with `std::fs::*`. Mostly mechanical.

**Slice 5 — POSIX sockets, traps, signals.** Complete the POSIX
sockets interface in `libcodepod.a` and the kernel socket backend until
bash networking paths can use libc/POSIX socket calls directly. Then
refactor `host.socket_*` call sites onto `libc::*`/small Rust wrappers
that call POSIX symbols. `trap` / signal handling move onto
`libc::sigaction`. `std::net::*` support is tracked separately because
stock Rust's `wasm32-wasip1` std does not currently route through these
libc socket symbols.

**Slice 6 — `codepod-host`, `host-call`, and extension registration
rewire.** Promote/generalize the existing Python-local
`codepod-host` shape into `packages/codepod-host/`, build
`/bin/host-call` on top of it, make `/bin/host-call` executable through
the generic spawn path, switch kernel registration to normal symlinks
under `/usr/extensions`, and remove `S_TOOL` / mode-bit routing. Drop
`host_extension_invoke` from bash (already unused after slice 3 if we
did it cleanly). The raw extension import should live in
`codepod-host`, not in `host-call`.

**Slice 7 — Cleanup.** Delete `host.rs`, `WasmHost`, `HostInterface`.
Drop unused `host_*` imports from `kernel-imports.ts`. Rename archive
to `libcodepod.a`. Update cpcc.

Each slice is independently shippable, tested by the existing
bash-rs suite plus the cross-build smoke (native + wasm).

## Open questions

These don't block starting, but want to be answered before they're
forced:

1. **`std::process::Command` on wasi.** Confirmed stubbed. Decision
   stands: bash works beneath `std::process`. Worth occasionally
   re-checking upstream — if std starts honoring `posix_spawn` on
   wasi, we get the higher-level API for free.
2. **Native job control.** Mac's job-control story (`tcsetpgrp`,
   `setpgid`) works natively. Wasi side relies on `libcodepod.a`'s
   shims, which are stubs in some places. If bash exercises real job
   control on the native dev loop and not on wasm, the divergence
   could let regressions hide. Mitigation: a CI mode that runs the
   bash-rs suite on both targets and diffs results.
3. **Setjmp / longjmp.** Bash uses these for parser error recovery.
   `libcodepod.a` provides them via asyncify on wasm; on native
   they're real. If our asyncify path isn't behaviorally identical,
   bash may behave differently across builds. Worth a focused test.
4. **Signal delivery semantics.** Async-signal-safe rules don't apply
   the same way under `libcodepod.a`'s emulated signal layer. Bash's
   handlers should be fine because they are already designed for
   unusual platforms, but documentation of the divergence is owed.
5. **argv[0] preservation through symlink resolution.** Verify the
   kernel's `host_spawn` path preserves `argv[0]` as the invoked
   name, not the resolved target. If coreutils-multicall already
   works, this is already handled — but confirm.
6. **Rust `std::net` on `wasm32-wasip1`.** Confirmed not solved by
   simply linking `libcodepod.a`: stock std uses its own unsupported
   WASI networking path rather than the libc `getaddrinfo` / `socket`
   symbols we provide. Rust-authored userland can use POSIX FFI today;
   ergonomic `std::net` requires custom-std, build-std, or upstream work.
7. **Duplicate-owned socket symbols.** wasi-libc already provides strong
   `send`, `recv`, `getsockopt`, and `accept` symbols. Codepod's POSIX
   socket implementation must make any implemented duplicate-owned names
   resolve consistently through `libcodepod.a` without backend-specific
   linker functions. Implemented duplicate-owned names use linker `--wrap`;
   `accept` is now backed by the same listener backend as `bind` and
   `listen`.
8. **Server socket exposure policy.** Server sockets are supported for
   TCP loopback listeners and explicit mapped `0.0.0.0` ports. Loopback
   listeners are sandbox-local and do not expose host ports. Mapped
   listeners require `Sandbox.create({ serverSockets })` policy and the
   runtime backend must authorize the final `listen()` call. Backends
   without listener support return `EOPNOTSUPP`.

## Non-questions (decided)

- **No `cp_std` crate.** Source has no codepod-named Rust dependencies.
  All abstraction is at the link layer.
- **`libcodepod.a` is additive over wasi-libc**, not a replacement.
- **Extensions go through `/bin/host-call`**, dispatched by symlinks
  in `/usr/extensions/`. Bash does not know about extensions.
- **No fork emulation.** Spawn-and-glue is the model. Where bash uses
  fork-shaped patterns internally, those are bash refactors, not
  kernel refactors.
- **No rustc/cargo/std fork.** Stock toolchain plus link flags.

## Acceptance criteria

Done when all the following hold:

1. `cargo build` in `packages/bash-rs/` produces a native binary on
   Mac and Linux. The binary runs as a tiny shell (`echo`,
   pipelines, redirection, simple commands work).
2. `cargo build --target wasm32-wasip1` (via cpcc) produces a wasm
   binary that drops into the existing kernel's resident-mode loader
   as `/bin/bash` and passes the existing bash-rs test suite.
3. `packages/bash-rs/src/host.rs` does not exist.
4. The `WasmHost` and `HostInterface` symbols do not exist anywhere
   in `packages/bash-rs/`.
5. No bash-owned source file or bash-owned object declares or directly
   imports `host_*` symbols. Any `host_*` imports in the final wasm are
   contributed only by linked platform support objects from
   `libcodepod.a`, never by `packages/bash-rs/`.
6. `packages/codepod-host/` exists and owns the raw
   `extension_invoke` import. `packages/host-call/` references
   extension dispatch only through `codepod_host::extension_invoke`.
7. `packages/host-call/` exists and builds to `host-call.wasm`.
8. Extension registration from the SDK creates a normal symlink under
   `/usr/extensions/`. Bash dispatches extensions via PATH lookup and
   the kernel executes `/bin/host-call` through the generic spawn path,
   with no `S_TOOL`, mode-bit, or registered-tool-stub path involved.
9. `libcodepod.a` (renamed) and cpcc build flag updates land. CI
   builds bash, coreutils, and the existing third-party ports
   (busybox testsuite, coreutils testsuite, grex) all pass with the
   renamed archive.
