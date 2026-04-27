# codepod Kernel / Userland Separation

## Status

Draft, design phase. No code merged. Replaces no existing spec; predecessor
to a CPython port effort and to follow-on userland-package reorgs.

## Outcome

Target end state — `packages/orchestrator/` becomes `packages/kernel/`, a
kernel that exposes WASI + POSIX primitives and treats the boot process
as opaque. Bash, busybox, coreutils, and (eventually) CPython all run on
top as ordinary userland `.wasm` packages. The kernel surface is
boundary-clean for new code; pre-existing Python-coupled code stays
in place as documented debt to be cleared by a follow-on CPython port.

Concretely:

- The kernel's host-facing TS API exposes `Sandbox.create({ bootArgv })`
  and a generic `process(pid).callExport(...)`. The `shell/` directory
  and `ShellInstance` class are deleted; their generic bits move into
  `process/`, their bash-specific bits move out to `mcp-server` /
  `sdk-server`.
- `host-imports/shell-imports.ts` (an entire shell-named host-imports
  module) is audited and consolidated: generic helpers fold into
  `kernel-imports.ts`; anything intrinsically shell-shaped moves out
  with the bash-dispatch wrapper.
- The shell wasm becomes a normal VFS file at `/bin/bash`, instead of
  being passed as a host filesystem path to `ShellInstance.create`.
- `host_extension_invoke` / `host_native_invoke` remain as kernel
  primitives, unchanged. They have a current consumer (RustPython); a
  future hostbridge userland design supersedes the current
  auto-create-virtual-command implementation when CPython lands.
- `codepod-server` (and `codepod-server-deno`, `codepod-mcp`) continue
  to bundle kernel TS + selected userland `.wasm` assets at build time;
  pkg-installed userland at runtime continues to work.

**Explicitly deferred to a follow-on effort** (out of scope here):
deletion of `python/`, RustPython removal, deletion of
`host_run_command`, deletion of `extension/codepod-ext-shim.ts`. These
are entangled — RustPython consumes `host_run_command` directly,
`build-mcp.sh` auto-builds `python3.wasm` via `packages/python/build.sh`,
and `Sandbox.create()` installs Python `/usr/lib/python` shims at boot.
Removing any of these in isolation regresses functionality; they should
all clear together as part of the CPython port that replaces RustPython.

The product requirement is **boundary correctness for new code**, not
all-at-once cleanup. Existing functionality is preserved end-to-end
(mcp-server, sdk-server, python-sdk all continue to operate against
bash boot, with RustPython still working).

## Problem

Today `packages/orchestrator/` mixes three concerns:

**1. The actual kernel.** `vfs/`, `process/`, `wasi/`, `host-imports/`,
`network/`, `persistence/`, `pool/`, `platform/` — these are primitives
the kernel must own.

**2. Userland-shaped code on the kernel side of the import.** Specifically:

- `host-imports/kernel-imports.ts` exports `host_run_command` — names a
  userland feature; should be `host_spawn`. (Deferred: RustPython
  consumer.)
- `host-imports/shell-imports.ts` (403 lines) is an entire shell-named
  module within `host-imports/`. By the naming test, the file itself is
  a violation; its contents are a mix of generic primitives that should
  fold into `kernel-imports.ts` and shell-specific helpers that should
  move out to bash-host.
- `shell/shell-instance.ts` (1157 lines) is a TS module specifically
  about *the shell*: it knows `__run_command(jsonString)`, the shell
  history, the shell-only call protocol. Generic process-loading bits
  (memory wiring, fd setup, JSPI/Asyncify, threads-backend wiring,
  resident-mode lifecycle) are entangled with bash-specific knowledge.
- `python/` carries RustPython integration: TS glue for a userland
  binary, mixed with auto-create-virtual-command machinery used to
  thunk Python extensions to host functions. (Deferred: clears with
  CPython port.)
- `extension/codepod-ext-shim.ts` literally embeds Python source for
  `/usr/lib/python/codepod_ext.py`. (Deferred.)
- `Sandbox.create()` installs Python `/usr/lib/python` shims,
  `sitecustomize.py`, and socket/ssl/requests shims directly from
  orchestrator. (Deferred: clears when the Python userland package
  takes over its own shim install.)

**3. Userland-package metadata.** `packages/orchestrator/src/packages/`
carries the manifest parser and tool registry — kernel concerns (the
kernel installs at boot and at runtime), but conflated with packaging
specifics.

The problem this causes:

- Replacing `bash` with another boot binary requires kernel changes.
- Replacing RustPython with CPython requires touching kernel code.
- New userland (e.g., a hostbridge wasm) has no clear shape, because the
  Python-specific machinery sits where reusable mechanism should live.
- Code review can't enforce "kernel doesn't know about userland" because
  the boundary isn't named.

The fix is to commit to the boundary: rename `orchestrator/` → `kernel/`,
factor the generic process loader out of `shell-instance.ts`, audit
and consolidate `shell-imports.ts`, install `/bin/bash` as a real VFS
file, and move the bash-specific dispatch to the host servers that
need it. Python-coupled debt (`python/`, `host_run_command`,
`extension/codepod-ext-shim.ts`, `Sandbox.create()` Python shim
install) is deferred to a follow-on CPython port.

## Boundary Principle

Two-pronged test for "is this kernel?":

1. **Naming test.** A kernel symbol must name a primitive (`spawn`,
   `pipe`, `read_fd`, `mutex_lock`, `extension_invoke`). It must not
   name a userland feature (`run_command`, `shell_*`, `python_*`).
2. **Agnosticism test.** The kernel's behavior must not depend on
   *which* userland is running. Replacing bash with another binary at
   boot must require zero kernel changes.

Both prongs apply to *new* code in this refactor. Existing boundary
violations are tracked as documented debt and cleared in dedicated
follow-on efforts:

- **Python-shaped code** (`python/`, `extension/codepod-ext-shim.ts`,
  `host_run_command`, the `Sandbox.create()` Python `/usr/lib/python`
  shim install) — clears with the CPython port that replaces
  RustPython.
- **`host_extension_invoke` naming** — "extension" is a host-plugin
  abstraction, not a primitive like `pipe`/`spawn`. Marginal; not
  worth renaming until hostbridge lands.

The boundary principle is *aspirational* for legacy code and
*enforceable* for any code added by this refactor.

## Source-Tree Changes

### Rename

- `packages/orchestrator/` → `packages/kernel/`.
- npm package `@codepod/orchestrator` → `@codepod/kernel`.
- Internal layout under `packages/kernel/src/` keeps existing dirs
  (`vfs/`, `process/`, `wasi/`, `host-imports/`, `network/`,
  `persistence/`, `pool/`, `platform/`, `packages/`, `pkg/`,
  `execution/`, `extension/`). `python/` also stays for now (Python
  debt — see Out of Scope). `shell/` is removed (carved out in PR4).
- All imports across the workspace updated (`mcp-server`, `sdk-server`,
  others).

### Delete

- `packages/orchestrator/src/shell/shell-instance.ts` and the entire
  `shell/` directory inside the kernel package — after carve-out
  (below) and after all consumers have switched to the new generic
  API.
- All tests under `shell/__tests__/` that exercise the deleted
  `ShellInstance` API directly. (Conformance tests that exercise
  `/bin/bash` end-to-end stay; they target the boot process via the
  new generic API.)

### Carve Out

`packages/orchestrator/src/shell/shell-instance.ts` (1157 lines) is
split:

- **Generic bits stay in kernel** → `packages/kernel/src/process/`:
  process spawn, memory wiring, fd setup, host-imports wiring,
  JSPI/Asyncify call-export plumbing, threads-backend wiring (the
  wasi-threads code we just landed), the resident-export-driven
  process model (see §Boot Process Model — Resident Mode).
- **Bash-specific bits move out** → `sdk-server/src/bash-dispatch.ts`
  and `mcp-server/src/bash-dispatch.ts` (~50 lines each, near
  duplicates). The `__run_command` JSON protocol and the result-shape
  parsing live there. Any other bash-only state currently held in
  `shell-instance.ts` (history, pending-output buffers) moves with it.

`packages/orchestrator/src/host-imports/shell-imports.ts` (403 lines)
is audited and split:

- **Generic helpers** (anything that is mechanically shell-named but
  semantically primitive — file-descriptor I/O, process spawn,
  argv/env decoding, shared memory access) folds into
  `kernel-imports.ts`. The two import-builder functions converge into
  one, with the differences expressed as configuration options
  (e.g., a `syncSpawn` callback for synchronous testing).
- **Truly shell-specific helpers** (e.g., the glob-expansion path: the
  shell's host-side glob matching against the VFS) move out to the
  bash-host package alongside `bash-dispatch.ts`, or — if the shell
  binary doesn't actually need them once it goes through generic
  imports — get deleted.

Intra-orchestrator consumers of `ShellInstance` are rewired in PR4
(see Migration Plan):

- `packages/orchestrator/src/sandbox.ts` — three `ShellInstance.create`
  call sites (creation + `fork()`).
- `packages/orchestrator/src/cli.ts` — one call site.
- `packages/orchestrator/src/index.ts` — one re-export.
- `packages/orchestrator/src/execution/execution-worker.ts` and
  `packages/orchestrator/src/execution/worker-executor.ts` — both
  import `ShellInstance` directly. The worker bridge is rewritten to
  use the generic Process API; the bash-protocol awareness, if any,
  goes through the host-side bash-dispatch module.

### Untouched in This Refactor

- Userland sibling packages (`shell-exec/`, `coreutils/`,
  `pdf-tools/`, `sips/`, `sqlite/`, `xlsx-tools/`, the
  matplotlib/numpy/pandas/pillow ports) stay where they are. No
  `packages/userland/` umbrella.
  - `packages/guest-compat/` is also untouched, but currently only
    exists in the `feature/wasi-threads` and `guest-compat-step-1`
    branches. This refactor assumes those branches merge to `main`
    before PR1 starts — or, equivalently, the kernel-rename PR sweeps
    over whatever set of userland packages happens to be on `main` at
    that time.
- `python/`, `extension/codepod-ext-shim.ts`, `host_run_command`, and
  the auto-create-virtual-command machinery — all stay in place as
  documented Python-coupled debt. They clear together when CPython
  lands.
- `host_extension_invoke` / `host_native_invoke` stay as kernel
  primitives, unchanged. RustPython continues to consume them.
- `codepod-server` build pipeline structure unchanged.
- The manifest format itself is unchanged. The manifest parser stays
  in kernel.

## Kernel Surface

### Guest-facing imports (`codepod::host_*`)

The full list after the refactor.

**Process management:**

- `host_pipe()` → `{read_fd, write_fd}`
- `host_spawn(req)` → pid
- `host_waitpid(pid)` → `{exit_code}` (async/JSPI)
- `host_waitpid_nohang(pid)` → exit_code
- `host_close_fd(fd)` → 0/-1
- `host_getpid()` → i32
- `host_getppid()` → i32
- `host_kill(pid, sig)` → 0/-1
- `host_list_processes()` → JSON array

**File-descriptor I/O:**

- `host_read_fd(fd, out_ptr, out_cap)` → bytes_read
- `host_write_fd(fd, data_ptr, data_len)` → bytes_written
- `host_dup(fd, out_ptr, out_cap)` → `{fd}`
- `host_dup2(src_fd, dst_fd)` → 0/-1

**Networking:**

- `host_network_fetch(req, out_ptr, out_cap)` (async)
- `host_socket_connect(req, out_ptr, out_cap)`
- `host_socket_send(req, out_ptr, out_cap)`
- `host_socket_recv(req, out_ptr, out_cap)`
- `host_socket_close(req)`

**Threading** (gated by `threadsBackend`):

- `host_thread_spawn(fn_ptr, arg)` (async)
- `host_thread_join(tid)` (async)
- `host_thread_detach(tid)` (async)
- `host_thread_self()` → tid
- `host_thread_yield()` (async)
- `host_mutex_lock(ptr)` (async)
- `host_mutex_unlock(ptr)`
- `host_mutex_trylock(ptr)` → 0/1
- `host_cond_wait(ptr, mutex_ptr)` (async)
- `host_cond_signal(ptr)`
- `host_cond_broadcast(ptr)`

**Dynamic extension dispatch** (no current consumer):

- `host_extension_invoke(req, out_ptr, out_cap)` (async)
- `host_native_invoke(module, method, args, out_ptr, out_cap)`

**Control flow:**

- `host_setjmp(env_ptr)` → 0 (current implementation is a stub
  returning 0; full implementation deferred to a separate spec)
- `host_longjmp(env_ptr, val)` (stub; throws — same status as
  `host_setjmp`)
- `host_yield()` (async microtask yield)

**Deferred to the CPython-port effort (NOT removed by this refactor):**

- `host_run_command` — RustPython's `codepod-host` crate still consumes
  it directly, `ShellInstance` wires it into JSPI/Asyncify, and
  `build-coreutils.sh` marks it as an asyncify import. Removal lands
  with the broader Python cleanup. The replacement story is
  unchanged: future guests use `host_spawn`.

Plus the standard WASI Preview 1 surface (`fd_read`, `fd_write`,
`path_open`, …) handled by the kernel's WASI host.

### Host-facing TS API

The TS surface that `mcp-server`, `sdk-server`, and other hosts use.

**Sandbox lifecycle:**

- `Sandbox.create({ bootArgv, env?, vfs?, threadsBackend?, network?,
  persistence?, … })` — `bootArgv[0]` is spawned as PID 1. **No `bash`
  or `shell` parameter.** Default supplied by the *caller* (typically
  `["/bin/bash"]`).
- `Sandbox.destroy()` — tears down.
- `Sandbox.fork()`, `Sandbox.snapshot()`, `Sandbox.restore()` —
  existing, unchanged.

**Process control (generic):**

- `sandbox.process(pid)` → `Process` with:
  - `.callExport(name, args)` — invoke a wasm export, JSPI/Asyncify-aware.
    Replaces today's shell-instance `__run_command` plumbing.
  - `.fd(n).read(n)` / `.fd(n).write(buf)` — generic fd I/O.
  - `.kill(sig)`, `.waitpid()`, `.exitCode`.
- `sandbox.spawn(argv, opts)` → `Process` — host-side mirror of
  `host_spawn`.

**VFS:**

- `sandbox.fs.read/write/list/...` — existing surface, unchanged in
  shape.

**Extensions:**

- `kernel.registerExtension(name, fn)` — installs a TS function
  reachable via `host_extension_invoke`. No current consumer; future
  hostbridge userland will use this.

**Removed from host API:**

- `sandbox.shell` and `sandbox.commands.run` (and any other
  shell-shaped surface). Consumers (sdk-server, mcp-server) build their
  own command-running wrappers using
  `sandbox.process(1).callExport("__run_command", ...)`.

## Boot Process Model

### Resident Mode vs CLI Mode

A wasm process under codepod runs in one of two modes:

- **CLI mode (default).** The process's `_start` runs to completion;
  WASI `proc_exit` ends the process; the wasm instance is discarded.
  Standard for most binaries (`ls`, `awk`, `jq`).
- **Resident mode (export-driven).** The process's `_start` runs to
  completion (typically calling `proc_exit(0)` after one-time
  initialization), but the **wasm instance and its memory are
  retained**. The host then drives further work by calling exported
  functions (e.g., `__run_command`). The process is logically alive
  even though `_start` returned.

The current shell binary runs in resident mode. The current
`ShellInstance` already implements this: it intercepts `proc_exit(0)`
during boot, retains the instance, and dispatches `__run_command` on
it. **This refactor preserves resident mode as a generic kernel
capability, decoupled from "shell".**

`Process` exposes a `mode: "cli" | "resident"` flag. Resident-mode
processes treat `proc_exit(0)` during boot as "initialization
complete"; subsequent `proc_exit` from within an exported call
terminates only the call, not the process; explicit
`Process.terminate()` ends a resident process.

The boot process (PID 1) defaults to resident mode. Other userland
binaries default to CLI mode. The mode is configured per-spawn.

### Boot at Sandbox Creation

`Sandbox.create({ bootArgv })`:

1. Validates `bootArgv[0]` resolves to an executable in the VFS.
   Specifically: there must be a regular file or symlink at that
   path, readable, with wasm magic bytes. Otherwise → error
   (`E_BOOT_NOT_FOUND` if missing, `E_BOOT_NOT_EXECUTABLE` if not
   wasm).
2. Spawns it as **PID 1** in resident mode.
3. Awaits initialization (PID 1's `_start` runs to its first
   `proc_exit(0)` or to a host-defined "ready" signal). If `_start`
   throws or `proc_exit(N)` for N != 0 fires before init completes,
   `Sandbox.create` rejects with `E_BOOT_FAILED` and the wasm
   instance is dropped.
4. Returns the live Sandbox.

### Boot Error Paths

Every transition has a defined error:

- **Boot binary missing in VFS** → `Sandbox.create` rejects with
  `E_BOOT_NOT_FOUND`.
- **Boot binary not executable wasm** → `Sandbox.create` rejects with
  `E_BOOT_NOT_EXECUTABLE`.
- **Instantiation throws** (link error, host-import mismatch,
  start-trap) → `Sandbox.create` rejects with `E_BOOT_FAILED`,
  carrying the underlying error.
- **PID 1 exits non-zero during init** → `Sandbox.create` rejects with
  `E_BOOT_FAILED`.
- **PID 1 exits after `Sandbox.create` returns** (CLI-style or
  unexpected exit) → sandbox transitions to "exited"; subsequent
  host calls reject with `E_SANDBOX_EXITED`. Pending operations are
  cancelled.
- **PID 1 traps during a `callExport`** → that single call rejects
  with `E_PROCESS_TRAP`; the sandbox stays alive only if the trap was
  caught and the instance is still consistent. By default, traps in
  PID 1 are fatal (sandbox transitions to "exited").

### Init-Process Semantics for PID 1

- Orphan reaping: child processes whose parent dies get reparented to
  PID 1 (standard Unix behavior). This already exists in
  `process/manager.ts`.
- PID 1 cannot be killed by signals from inside the sandbox. (Existing
  behavior; kept.)

### Bash-Dispatch Wrapper (Host-Side)

Each host server carries a small TS module that holds the bash-specific
protocol. Example shape (the same in `sdk-server/src/bash-dispatch.ts`
and `mcp-server/src/bash-dispatch.ts`):

```ts
async function runCommand(
  sandbox: Sandbox,
  cmd: string,
  opts?: RunOpts,
): Promise<RunResult> {
  const raw = await sandbox.process(1).callExport(
    "__run_command",
    JSON.stringify({ cmd, ...opts }),
  );
  return JSON.parse(raw); // { exit_code, stdout, stderr, ... }
}
```

This is the *only* place that knows:

1. The boot process is bash.
2. Bash exposes `__run_command(jsonString)` as its dispatch entrypoint.
3. The request/response JSON shape.

Swap the boot default → only this file (×2) changes. ~50 lines
duplicated across two consumers is acceptable; promote to a shared
`packages/bash-host/` if a third consumer ever appears.

### VFS Prerequisite — Install Step Required

`/bin/bash` must exist in the VFS at boot. **This is not satisfied
today.** Currently, `mcp-server` and `sdk-server` pass a host
filesystem path (`shellExecWasmPath`) to `ShellInstance.create`, and
the wasm bytes are loaded directly from disk — never written into the
sandbox VFS.

Migration requires an explicit install step (PR1 in the migration
plan):

1. The host server reads the shell wasm bytes once at startup (from
   embedded asset or filesystem path, as today).
2. At sandbox creation, the kernel writes those bytes to `/bin/bash`
   in the sandbox's VFS, marked executable. (Or a symlink from
   `/bin/bash` to wherever the wasm package's manifest places its
   binary, once the manifest-driven model is fully in play.)
3. After this install step, `bootArgv: ["/bin/bash"]` resolves to a
   real VFS file.

The wasm bytes themselves continue to come from the host server's
embedded bundle (no build pipeline change). Only the *delivery* into
the sandbox changes: host-fs path → VFS file at `/bin/bash`.

### Fork & Snapshot

`Sandbox.fork()` clones VFS state, then spawns a fresh PID 1 in the
child using **the parent's `bootArgv`**. The kernel does retain
knowledge of the boot command — but only as opaque sandbox metadata
(a `bootArgv: string[]` field), not as embedded "this is the shell"
logic. Replacing the parent's boot binary still requires zero kernel
changes.

`Sandbox.snapshot/restore` capture and replay sandbox state including
`bootArgv`. The restored sandbox respawns PID 1 from the saved
`bootArgv` (or, for snapshots that capture wasm memory, restores the
captured PID 1 instance directly — existing behavior).

### Public API Change

Today's callers pass shell options; the orchestrator implicitly knows
bash is the default and wires shell-instance. After this refactor,
callers pass `bootArgv`. `mcp-server` / `sdk-server` set their default
to `["/bin/bash"]`. This is a public API change for any external
consumer of `@codepod/orchestrator`, but our two callers are in-tree,
so it's a sweep.

## Migration Plan

Six PRs, each merges independently and keeps `main` green. Python work
is **out of scope** throughout (clears in a separate CPython-port
effort).

### PR1 — Install shell wasm into VFS as `/bin/bash`

- At sandbox creation, the kernel writes the shell wasm bytes (passed
  by the host server, as today) to `/bin/bash` in the sandbox VFS,
  marked executable.
- Existing `shellExecWasmPath` parameter to `ShellInstance.create`
  still accepted (read source unchanged).
- Add a unit test asserting that immediately after `Sandbox.create`,
  the sandbox VFS has a readable, executable `/bin/bash`.

**Why first:** the entire boot model (PR3, PR4) depends on
`bootArgv: ["/bin/bash"]` resolving to a real VFS path. This step is
a strict prerequisite and is independently verifiable.

**Risk:** low. Additive; no behavior change beyond an extra VFS file.

**Verification:** unit tests, guest-compat tests, mcp-server +
sdk-server smoke tests, `python-sdk` end-to-end.

### PR2 — Generic process loader (carve-out, additive)

- Inside `packages/orchestrator/src/process/`, factor the generic
  loader out of `shell/shell-instance.ts`:
  - `Process` class with `.callExport()`, `.fd(n).read/write`, exit
    handling.
  - JSPI/Asyncify wrapping plumbing moves into the generic path.
  - Threads-backend wiring (just-landed wasi-threads) moves with it.
  - `mode: "cli" | "resident"` flag on `Process`. Resident-mode
    processes intercept `proc_exit(0)` during boot as
    "initialization complete"; CLI-mode processes terminate on
    `proc_exit`.
- Add `Sandbox.create({ bootArgv, … })`. **For this PR**,
  orchestrator still defaults `bootArgv` to `["/bin/bash"]` if not
  provided, to keep existing callers working without change.
- Reduce `shell-instance.ts` to a thin wrapper around the new Process
  API. Still does `__run_command` dispatch but spawn / imports /
  JSPI / resident-mode are now via the generic loader. The thin
  wrapper duplicates a small amount of logic with the new generic
  path during PR2; that duplication clears in PR4.

**Risk:** medium. Verify JSPI/Asyncify + threads-backend still work
via the guest-compat pthread canary. End-to-end Python-SDK round-trip.
Resident-mode behavior must match today's `ShellInstance` exactly.

**Verification:** unit tests, guest-compat pthread canary (4-thread
mutex stress, asserts counter == 40000), mcp-server + sdk-server smoke
tests, Python-SDK round-trip.

### PR3 — Audit `host-imports/shell-imports.ts`

- Compare `kernel-imports.ts` and `shell-imports.ts` import-by-import.
- For each import in `shell-imports.ts`:
  - **Generic** (e.g., process spawn, fd I/O, argv decoding): merge
    with the corresponding `kernel-imports.ts` entry; lift any
    behavioral difference into a configuration option.
  - **Shell-specific** (e.g., glob expansion against VFS): mark for
    move to `bash-host`. Defer the actual move to PR4 (where
    bash-dispatch lands), but the audit / categorization happens
    here.
- After this PR, `shell-imports.ts` either no longer exists (if every
  helper folded into kernel-imports) or contains only the
  shell-specific helpers awaiting their move in PR4.

**Risk:** medium. Subtle import-shape mismatches can cause hard-to-
diagnose runtime failures.

**Verification:** unit tests, guest-compat tests, mcp-server +
sdk-server smoke tests, Python-SDK round-trip. Targeted test that
spawns the shell and runs `ls /`, `find -name '*.txt'`, `echo *`
(exercises any shell-specific glob path).

### PR4 — Rewire all `ShellInstance` consumers; move bash-dispatch out

This is the substantive PR; it does what (B) was always going to
require.

- Create `sdk-server/src/bash-dispatch.ts` and
  `mcp-server/src/bash-dispatch.ts` (~50 lines each, near duplicates).
  They wrap `sandbox.process(1).callExport("__run_command", …)`.
- Switch all `ShellInstance` consumers to the new Process API:
  - `packages/orchestrator/src/sandbox.ts` (3 call sites incl.
    `fork()`).
  - `packages/orchestrator/src/cli.ts` (1 call site).
  - `packages/orchestrator/src/index.ts` (1 re-export — drop or
    re-export the new generic API).
  - `packages/orchestrator/src/execution/execution-worker.ts` and
    `worker-executor.ts` — rewrite the worker bridge to use the
    generic Process API; bash-protocol awareness, if needed, goes
    through a dependency on the host-side bash-dispatch (or the
    worker bridge becomes pure-process and no longer knows about
    bash).
- Move shell-specific bits identified in PR3 (glob helpers, etc.)
  out of `host-imports/` to the bash-host module(s).
- Move the `bootArgv` default out of orchestrator and into each host
  server. Kernel's `Sandbox.create` now **requires** `bootArgv`.
- Delete `packages/orchestrator/src/shell/shell-instance.ts` and the
  `shell/` directory.

**Risk:** high. Largest blast radius of the migration; touches every
in-tree consumer.

**Verification:** unit tests, guest-compat tests, mcp-server +
sdk-server smoke tests, Python-SDK end-to-end (`Sandbox()`,
`sb.commands.run("ls /")`), explicit `Sandbox.fork()` test (verifies
bootArgv inheritance).

### PR5 — Rename `orchestrator/` → `kernel/`

- `git mv packages/orchestrator packages/kernel`.
- `package.json` name → `@codepod/kernel`.
- Update imports workspace-wide (`mcp-server`, `sdk-server`, others).
- Update `scripts/build-sdk-server.sh`, `scripts/build-mcp.sh`,
  `CLAUDE.md`.

**Risk:** low. Mechanical, but big diff. Pure rename — no behavior
change. By landing after PR4, the diff contains *only* the rename, no
content shifts.

**Verification:** unit tests, guest-compat tests, mcp-server +
sdk-server smoke tests, Python-SDK end-to-end. Build
`dist/codepod-server` and `dist/codepod-mcp` from scratch.

### PR6 — Documentation + boundary marker

- `packages/kernel/README.md` documenting:
  - The boundary principle (naming + agnosticism tests, with the
    "aspirational for legacy code, enforceable for new code"
    qualifier).
  - Guest-facing imports list.
  - Host-facing TS API.
  - The "USERLAND PROTOCOL handled by host" note for the bash-dispatch.
  - The "Python-coupled debt cleared by CPython port" note pointing
    at `python/`, `host_run_command`, `extension/codepod-ext-shim.ts`.
- Comments on `host_extension_invoke` / `host_native_invoke`
  documenting the future hostbridge consumer.

**Risk:** zero.

### Why Six Small PRs

The previous five-PR plan combined too much into PR1 (Python
deletions that can't actually land alone) and underspecified PR3
(missed `shell-imports.ts`, `execution/`, intra-orchestrator
consumers). Splitting into six gives each PR a single failure mode
and lets PR5 (the rename) be purely mechanical.

### Verification Per PR

For every PR:

- All unit tests pass.
- guest-compat tests pass (especially the pthread canary — must
  preserve the wasi-threads work that just landed).
- mcp-server + sdk-server smoke tests.
- `python-sdk` end-to-end (`Sandbox()`, `sb.commands.run("ls /")`).

## Out of Scope

Explicitly *not* in this refactor:

- **All Python work** — bundled together as a follow-on CPython-port
  effort. Specifically deferred:
  - Deletion of `packages/orchestrator/src/python/`.
  - Deletion of `host_run_command` (RustPython consumer).
  - Deletion of `extension/codepod-ext-shim.ts` (Python source for
    `/usr/lib/python/codepod_ext.py`).
  - Removal of the auto-create-virtual-command machinery.
  - Removal of Python `/usr/lib/python` shim install in
    `Sandbox.create()`.
  - Removal of `packages/python/` and `python3.wasm` from the build.
  - RustPython replacement by CPython.

  These are entangled (build, runtime, tests) and would normally clear
  together. **Escape hatch:** if any individual PR in this refactor
  turns out to be blocked by Python coupling we didn't anticipate
  (e.g. `sandbox.ts` rewire can't proceed without untangling the
  Python shim install, or `execution/` worker bridge can't be
  generalized while RustPython hooks into it), we drop RustPython
  inline rather than working around it. Deferral is for
  functionality-preservation, not for Python being load-bearing.

- **Hostbridge implementation.** The `host_extension_invoke` /
  `host_native_invoke` primitives stay unchanged. The `/bin/hostbridge`
  userland wasm + `kernel.registerExtension(...)` integration are
  designed but unimplemented in this refactor — they land with the
  CPython port.
- **`packages/userland/` umbrella.** Userland sibling packages stay
  where they are. Reorg deferred until there's enough userland to
  make a flat list unwieldy.
- **Hard import-boundary lint.** The "kernel can't import from
  userland" rule is enforced by review for now. Promotable to a
  dependency-cruiser rule later.
- **Manifest format changes.** The package manifest (file lists,
  symlinks, multicall applets) is unchanged. The parser stays in
  kernel.
- **`codepod-server` build pipeline structure.** Bundling kernel +
  selected userland into a single binary continues unchanged.
- **Renaming `host_extension_invoke`.** "Extension" is arguably a
  host-plugin abstraction rather than a primitive. Worth revisiting
  when hostbridge lands; not worth the churn now.

## Open Questions / Future Work

These are *not* gating this refactor but are worth noting:

- **CPython port — the headline consumer.** Linking CPython against
  guest-compat → kernel primitives is the reason this refactor
  matters. That effort also clears all the deferred Python items
  listed under Out of Scope. Spec lands separately.
- **Hostbridge implementation.** When CPython lands and needs native
  modules, build `/bin/hostbridge` (a tiny wasm that reads `argv[0]`
  and calls `host_extension_invoke`) plus the
  `kernel.registerExtension(name, fn)` host API. Symlinks named after
  extensions point at `/bin/hostbridge`. This pattern supersedes the
  current auto-create-virtual-command implementation.
- **Promote bash-dispatch to a shared package.** If a third consumer
  appears, move `bash-dispatch.ts` from per-host duplication to
  `packages/bash-host/`.
- **`packages/userland/` umbrella.** Once we have bash, busybox,
  CPython, jq, file, sqlite, … as separate packages, a flat list
  under `packages/` may become unwieldy. Defer.
- **Hard import-boundary lint.** Add a dependency-cruiser rule
  enforcing kernel cannot import from userland.
- **POSIX-facade extension.** Additional kernel primitives (full
  signal delivery, real PTY, more of POSIX) follow on top of this
  cleanly-bounded kernel.
- **Naming clash with `packages/codepod-process/`.** The Rust crate
  `codepod-process` (a guest-side wrapper around `host_spawn` /
  `host_waitpid`) lives next to a refactor that promotes "process"
  terminology in the kernel API (`sandbox.process(pid)`,
  `packages/kernel/src/process/`). They sit on opposite sides of the
  boundary so collision risk is low, but a one-line note in
  `codepod-process/README.md` clarifies which side it belongs to.
- **`host_extension_invoke` rename.** Possibly to `host_plugin_invoke`
  or `host_callback_invoke` to better satisfy the naming test. Not a
  blocker; revisit when hostbridge actually lands.

## References

- [`2026-04-19-guest-compat-runtime-design.md`](./2026-04-19-guest-compat-runtime-design.md)
  — guest-compat library that links userland binaries against kernel
  imports.
- [`2026-04-27-wasi-threads-design.md`](./2026-04-27-wasi-threads-design.md)
  — threads frontend/backend split. The threads-backend wiring is the
  most recent code to enter `shell-instance.ts`; this refactor moves
  it into the generic process loader.
- [`2026-03-18-wasi-host-posix-extensions-design.md`](./2026-03-18-wasi-host-posix-extensions-design.md)
  — origin of the `codepod::host_*` import surface.
