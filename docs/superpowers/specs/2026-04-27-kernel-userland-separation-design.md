# codepod Kernel / Userland Separation

## Status

Draft, design phase. No code merged. Replaces no existing spec; predecessor
to a CPython port effort and to follow-on userland-package reorgs.

## Outcome

Target end state — `packages/orchestrator/` becomes `packages/kernel/`, a
true kernel that exposes only WASI + POSIX primitives. Bash, busybox,
coreutils, and (eventually) CPython all run on top as ordinary userland
`.wasm` packages. The kernel does not name a single userland feature.

Concretely:

- The kernel's guest-facing imports name only primitives (`spawn`, `pipe`,
  `mutex_lock`, `extension_invoke`, …). No `run_command`, no `shell_*`,
  no `python_*`.
- The kernel's host-facing TS API exposes `Sandbox.create({ bootArgv })`
  and a generic `process(pid).callExport(...)`. No `sandbox.shell`.
- `RustPython` and the `python/` directory are deleted; the dynamic
  extension dispatch (`host_extension_invoke` / `host_native_invoke`)
  remains as kernel primitives with no current consumer, awaiting a
  future hostbridge userland.
- `codepod-server` (and `codepod-server-deno`, `codepod-mcp`) continue
  to bundle kernel TS + selected userland `.wasm` assets at build time;
  pkg-installed userland at runtime continues to work.

The product requirement is **boundary correctness**, not feature change.
Existing functionality is preserved end-to-end (mcp-server, sdk-server,
python-sdk all continue to operate against bash boot).

## Problem

Today `packages/orchestrator/` mixes three concerns:

**1. The actual kernel.** `vfs/`, `process/`, `wasi/`, `host-imports/`,
`network/`, `persistence/`, `pool/`, `platform/` — these are primitives
the kernel must own.

**2. Userland-shaped code on the kernel side of the import.** Specifically:

- `host-imports/kernel-imports.ts` exports `host_run_command` — names a
  userland feature; should be `host_spawn`.
- `shell/shell-instance.ts` is a TS module specifically about *the shell*:
  it knows `__run_command(jsonString)`, the shell history, the shell-only
  call protocol. Generic process-loading bits (memory wiring, fd setup,
  JSPI/Asyncify, threads-backend wiring) are entangled with bash-specific
  knowledge.
- `python/` carries RustPython integration: TS glue for a userland
  binary, mixed with auto-create-virtual-command machinery used to
  thunk Python extensions to host functions.

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
delete the userland-shaped bits that we're not keeping, factor the
generic process loader out of `shell-instance.ts`, and move the
bash-specific dispatch to the host servers that need it.

## Boundary Principle

Two-pronged test for "is this kernel?":

1. **Naming test.** A kernel symbol must name a primitive (`spawn`,
   `pipe`, `read_fd`, `mutex_lock`, `extension_invoke`). It must not
   name a userland feature (`run_command`, `shell_*`, `python_*`).
2. **Agnosticism test.** The kernel's behavior must not depend on
   *which* userland is running. Replacing bash with another binary at
   boot must require zero kernel changes.

Both prongs must pass for code to live in the kernel package.

## Source-Tree Changes

### Rename

- `packages/orchestrator/` → `packages/kernel/`.
- npm package `@codepod/orchestrator` → `@codepod/kernel`.
- Internal layout under `packages/kernel/src/` keeps existing dirs
  (`vfs/`, `process/`, `wasi/`, `host-imports/`, `network/`,
  `persistence/`, `pool/`, `platform/`, `packages/`, `pkg/`,
  `execution/`, `extension/`). `extension/` is audited as part of PR1:
  generic registration / dispatch machinery (the host-facing
  `registerExtension` API and the `host_extension_invoke`
  guest-import handler) stays; any Python-specific code is deleted
  along with `python/`.
- All imports across the workspace updated (`mcp-server`, `sdk-server`,
  others).

### Delete

- `packages/orchestrator/src/python/` (entire directory + its tests).
  Drops RustPython integration.
- `host_run_command` from `host-imports/kernel-imports.ts`. Guests use
  `host_spawn` for the same capability.
- The auto-create-virtual-command machinery used to synthesize wasm
  thunks for Python extensions.
- All tests against the deleted paths.

### Carve Out

`packages/orchestrator/src/shell/shell-instance.ts` is split:

- **Generic bits stay in kernel** → `packages/kernel/src/process/`:
  process spawn, memory wiring, fd setup, host-imports wiring,
  JSPI/Asyncify call-export plumbing, threads-backend wiring (the
  wasi-threads code we just landed).
- **Bash-specific bits move out** → `sdk-server/src/bash-dispatch.ts`
  and `mcp-server/src/bash-dispatch.ts` (~50 lines each, near
  duplicates). The `__run_command` JSON protocol and the result-shape
  parsing live there. Any other bash-only state currently held in
  `shell-instance.ts` (history, pending-output buffers) moves with it.

Once split, `packages/kernel/src/shell/` is deleted entirely.

### Untouched in This Refactor

- Userland sibling packages (`shell-exec/`, `coreutils/`,
  `guest-compat/`, `pdf-tools/`, `sips/`, `sqlite/`, `xlsx-tools/`,
  the matplotlib/numpy/pandas/pillow ports) stay where they are.
  No `packages/userland/` umbrella.
- `host_extension_invoke` / `host_native_invoke` stay as kernel
  primitives. No current consumer. Reserved for future hostbridge
  userland.
- `codepod-server` build pipeline structure unchanged.
- The manifest format itself is unchanged. The manifest parser
  stays in kernel.

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

- `host_setjmp(env_ptr)` → 0 (Phase 1 stub)
- `host_longjmp(env_ptr, val)` (Phase 1 stub; throws)
- `host_yield()` (async microtask yield)

**Removed by this refactor:**

- `host_run_command` — guests use `host_spawn`.

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

### Boot at Sandbox Creation

`Sandbox.create({ bootArgv })`:

1. Validates `bootArgv[0]` exists in the VFS (else error).
2. Spawns it as **PID 1** with normal process semantics.
3. Returns once PID 1 is instantiated (not once it exits).

### Init-Process Semantics for PID 1

- If PID 1 exits, the sandbox transitions to "exited" state. Subsequent
  host calls return errors.
- Orphan reaping: child processes whose parent dies get reparented to
  PID 1 (standard Unix behavior). This already mostly exists in
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

Swap the boot default → only this file (×2) changes. Per (a) from §2,
~50 lines duplicated across two consumers is acceptable; promote to a
shared `packages/bash-host/` if a third consumer ever appears.

### VFS Prerequisite

`/bin/bash` must exist in the VFS at boot. Already satisfied today via
`codepod-server`'s built-in bundle (the build embeds bash + manifest;
the manifest installs into VFS at sandbox boot). No build pipeline
change in this refactor.

### Fork & Snapshot

Existing semantics preserved. `Sandbox.fork()` clones VFS state; the
boot process is per-instance. `Sandbox.snapshot/restore` work as today.

### Public API Change

Today's callers pass shell options; the orchestrator implicitly knows
bash is the default and wires shell-instance. After this refactor,
callers pass `bootArgv`. `mcp-server` / `sdk-server` set their default
to `["/bin/bash"]`. This is a public API change for any external
consumer of `@codepod/orchestrator`, but our two callers are in-tree,
so it's a sweep.

## Migration Plan

Five PRs, each merges independently and keeps `main` green.

### PR1 — Drop deprecated paths (independent cleanup)

- Delete `packages/orchestrator/src/python/` + its tests.
- Delete `host_run_command` from `host-imports/kernel-imports.ts`.
  Verify no guest .wasm or test imports it.
- Delete the auto-create-virtual-command machinery used for Python.
- Audit `packages/orchestrator/src/extension/`: keep generic
  registration / dispatch machinery; delete any Python-specific code
  along with `python/`.
- All deleted-path tests removed.

**Risk:** low. Pure deletion. Can land first, before any other
refactor work.

**Verification:** unit tests, guest-compat tests, mcp-server +
sdk-server smoke tests, `python-sdk` end-to-end (with RustPython gone,
verify no dangling imports).

### PR2 — Generic process loader (carve-out, additive)

- Inside `packages/orchestrator/src/process/`, factor the generic loader
  out of `shell/shell-instance.ts`:
  - `Process` class with `.callExport()`, `.fd(n).read/write`, exit
    handling.
  - JSPI/Asyncify wrapping plumbing moves into the generic path.
  - Threads-backend wiring (just-landed wasi-threads) moves with it.
- Add `Sandbox.create({ bootArgv, … })`. **Default `["/bin/bash"]` kept
  inside orchestrator for this PR** so existing callers don't break.
- Reduce `shell-instance.ts` to a thin wrapper around the new Process
  API (still does `__run_command` dispatch, but spawn / imports / JSPI
  are now via the generic loader).

**Risk:** medium. Verify JSPI/Asyncify + threads-backend still work via
the guest-compat pthread canary. End-to-end Python-SDK round-trip.

**Verification:** unit tests, guest-compat pthread canary (4-thread
mutex stress, asserts counter == 40000), mcp-server + sdk-server smoke
tests, Python-SDK round-trip.

### PR3 — Move bash-dispatch to host servers

- Create `sdk-server/src/bash-dispatch.ts` and
  `mcp-server/src/bash-dispatch.ts` (~50 lines each, near duplicates).
- Switch both servers to call
  `sandbox.process(1).callExport("__run_command", …)` via their own
  dispatch wrapper.
- Move the `bootArgv` default *out* of orchestrator, *into* each host
  server. Kernel's `Sandbox.create` now requires `bootArgv`.
- Delete `packages/orchestrator/src/shell/shell-instance.ts` and the
  `shell/` directory.

**Risk:** medium. Touches both servers and cross-package wiring.

**Verification:** unit tests, guest-compat tests, mcp-server +
sdk-server smoke tests, Python-SDK end-to-end (`Sandbox()`,
`sb.commands.run("ls /")`).

### PR4 — Rename `orchestrator/` → `kernel/`

- `git mv packages/orchestrator packages/kernel`.
- `package.json` name → `@codepod/kernel`.
- Update imports workspace-wide (`mcp-server`, `sdk-server`, others).
- Update `scripts/build-sdk-server.sh`, `scripts/build-mcp.sh`,
  `CLAUDE.md`.

**Risk:** low. Mechanical, but big diff. Pure rename — no behavior
change.

**Verification:** unit tests, guest-compat tests, mcp-server +
sdk-server smoke tests, Python-SDK end-to-end. Build `dist/codepod-server`
and `dist/codepod-mcp` from scratch.

### PR5 — Documentation + boundary marker

- `packages/kernel/README.md` documenting:
  - The boundary principle (naming + agnosticism tests).
  - Guest-facing imports list.
  - Host-facing TS API.
  - The "USERLAND PROTOCOL handled by host" note for the bash-dispatch.
- Comments on `host_extension_invoke` / `host_native_invoke`
  documenting the future hostbridge consumer.

**Risk:** zero.

### Why Not One Big PR

PR2 + PR3 + PR4 interleaved would be a ~3000+ line diff touching
JSPI/Asyncify wiring, the threads-backend, the public API, and a
top-level rename — too many simultaneous failure modes. Splitting
keeps each PR's blast radius contained, and PR4 (the rename) becomes
purely mechanical.

### Verification Per PR

For every PR:

- All unit tests pass.
- guest-compat tests pass (especially the pthread canary — must
  preserve the wasi-threads work that just landed).
- mcp-server + sdk-server smoke tests.
- `python-sdk` end-to-end (`Sandbox()`, `sb.commands.run("ls /")`).

## Out of Scope

Explicitly *not* in this refactor:

- **CPython port.** Linking CPython against guest-compat is the long-
  term reason to do this work, but lands in a separate spec/effort.
- **RustPython replacement.** RustPython is deleted in PR1; what fills
  its place (CPython) is a separate effort.
- **Hostbridge implementation.** The `host_extension_invoke` /
  `host_native_invoke` primitives stay; the `/bin/hostbridge` userland
  wasm and its TS-side `kernel.registerExtension(...)` integration are
  designed but unimplemented in this refactor (no current consumer).
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

## Open Questions / Future Work

These are *not* gating this refactor but are worth noting:

- **Hostbridge implementation.** When CPython lands and needs native
  modules, build `/bin/hostbridge` (a tiny wasm that reads `argv[0]`
  and calls `host_extension_invoke`) plus the
  `kernel.registerExtension(name, fn)` host API. Symlinks named after
  extensions point at `/bin/hostbridge`.
- **Promote bash-dispatch to a shared package.** If a third consumer
  appears, move `bash-dispatch.ts` from per-host duplication to
  `packages/bash-host/`.
- **`packages/userland/` umbrella.** Once we have bash, busybox,
  CPython, jq, file, sqlite, … as separate packages, a flat list under
  `packages/` may become unwieldy. Defer.
- **Hard import-boundary lint.** Add a dependency-cruiser rule
  enforcing kernel cannot import from userland.
- **POSIX-facade extension.** Additional kernel primitives (full
  signal delivery, real PTY, more of POSIX) follow on top of this
  cleanly-bounded kernel.

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
