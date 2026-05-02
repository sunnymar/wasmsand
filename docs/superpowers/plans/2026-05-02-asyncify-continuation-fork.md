# Asyncify Continuation Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the fork-only Asyncify continuation milestone with fail-closed loader validation, continuation toolchain naming, process-count limits, and a basic fork canary.

**Architecture:** Reuse the existing Asyncify setjmp path and rename it to continuations. Centralize module feature validation so every process entrypoint agrees on when Asyncify is required. Add synchronous process-slot reservation before PID allocation, then implement `host_fork` as an Asyncify-only continuation operation that snapshots process state, registers a child, and resumes parent/child with POSIX return values.

**Tech Stack:** TypeScript/Deno kernel, Binaryen Asyncify, WASI preview1, C guest-compat archive, Rust cpcc toolchain.

---

### Task 1: Baseline Toolchain Compile Fix

**Files:**
- Modify: `packages/guest-compat/toolchain/cpcc/src/main.rs`
- Test: `packages/guest-compat/toolchain/cpcc/tests/cli.rs`

- [x] **Step 1: Confirm the current cpcc test target fails**

Run: `cargo test -q -p cpcc-toolchain`

Expected: FAIL with `cannot find value WRAPPED_WASI_LIBC_SYMBOLS in this scope`.

- [x] **Step 2: Import the missing constant**

In `packages/guest-compat/toolchain/cpcc/src/main.rs`, change the import to include `WRAPPED_WASI_LIBC_SYMBOLS`:

```rust
use cpcc_toolchain::{archive, env, features, preserve, wasi_sdk, wasm_opt, TIER1, WRAPPED_WASI_LIBC_SYMBOLS};
```

- [x] **Step 3: Verify the compile error is gone**

Run: `cargo test -q -p cpcc-toolchain`

Expected: the previous `WRAPPED_WASI_LIBC_SYMBOLS` error is gone. Any remaining failures must be new findings and handled before proceeding.

### Task 2: Continuation Toolchain Naming

**Files:**
- Modify: `packages/guest-compat/toolchain/cpcc/src/env.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/features.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/main.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/wasm_opt.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/tests/cli.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/features.rs` tests

- [x] **Step 1: Add failing tests for `CPCC_USE_CONTINUATIONS`**

Extend `cpcc` CLI tests so a dry run with:

```text
CPCC_ARCHIVE=/fake/libcodepod_guest_compat.a
CPCC_CONTINUATIONS_ARCHIVE=/fake/libcodepod_continuations.a
CPCC_USE_CONTINUATIONS=1
```

expects the continuation archive in the link line and `-DCODEPOD_USE_CONTINUATIONS=1`.

- [x] **Step 2: Add failing tests for legacy aliases**

Keep `CPCC_USE_SETJMP=1` and `CPCC_SETJMP_ARCHIVE` working as aliases that enable the same continuation mode.

- [x] **Step 3: Rename internal env fields**

Use `continuations_archive` and `use_continuations` internally. `CPCC_USE_SETJMP` and `CPCC_SETJMP_ARCHIVE` remain aliases only at env parsing.

- [x] **Step 4: Rename metadata helper**

Emit:

```json
{"async":"asyncify","features":["continuations","setjmp"]}
```

The long-term feature is `continuations`; `setjmp` remains temporarily for loader compatibility.

- [x] **Step 5: Verify cpcc tests**

Run: `cargo test -q -p cpcc-toolchain`.

### Task 3: Shared Module Profile Validation

**Files:**
- Create: `packages/kernel/src/process/module-profile.ts`
- Create: `packages/kernel/src/process/__tests__/module-profile.test.ts`
- Modify: `packages/kernel/src/process/loader.ts`
- Modify: `packages/kernel/src/process/manager.ts`

- [x] **Step 1: Write failing module-profile tests**

Tests cover:

- `host_setjmp` without `codepod.features` fails with rebuild guidance.
- `host_fork` without `continuations` fails with rebuild guidance.
- `continuations` without Asyncify exports fails.
- legacy `setjmp` metadata is accepted.
- `continuations` chooses the Asyncify bridge even when JSPI exists.

- [x] **Step 2: Implement `analyzeCodepodModule()`**

Return a profile containing imports, features, Asyncify exports, and bridge selection. Export one validation function used by loader and manager.

- [x] **Step 3: Refactor `loadProcess()`**

Replace local setjmp feature parsing with the shared profile helper.

- [x] **Step 4: Refactor `ProcessManager.spawn()` and `spawnSync()**

Use the same helper. Legacy sync paths must reject continuation modules they cannot run correctly.

- [x] **Step 5: Verify module-profile tests**

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/kernel/src/process/__tests__/module-profile.test.ts`.

### Task 4: Process Slot Reservation

**Files:**
- Modify: `packages/kernel/src/security.ts`
- Modify: `packages/kernel/src/process/kernel.ts`
- Modify: `packages/kernel/src/process/__tests__/kernel.test.ts`
- Modify: call sites that allocate PIDs through `ProcessKernel`

- [x] **Step 1: Write failing process-limit tests**

Tests cover:

- default max process count is finite.
- process limit applies before PID allocation.
- failed reservation leaves no process table or fd table side effects.
- `host_spawn` and fork reservation use the same allocator.

- [x] **Step 2: Add `SecurityLimits.processes`**

Add:

```ts
processes?: number;
```

and a `DEFAULT_MAX_PROCESSES = 64` constant near process-kernel construction.

- [x] **Step 3: Add synchronous reservation APIs**

Add `tryReserveProcessSlot()` / `commitReservedProcess()` or an equivalent single allocator that reserves before side effects.

- [x] **Step 4: Route PID allocation through reservation**

Update `allocPid`, pending registration, and spawn paths so limit failures leave no PID/fd/memory side effects.

- [x] **Step 5: Verify process-kernel tests**

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/kernel/src/process/__tests__/kernel.test.ts`.

### Task 5: Guest Fork ABI And Archive Split

**Files:**
- Modify: `packages/guest-compat/src/codepod_runtime.h`
- Modify: `packages/guest-compat/src/codepod_process.c`
- Create: `packages/guest-compat/src/codepod_fork.c`
- Modify: `packages/guest-compat/Makefile`
- Create: `packages/guest-compat/conformance/c/fork-canary.c`

- [x] **Step 1: Write a default fork canary expectation**

Default build still returns `-1` with `errno=ENOSYS`.

- [x] **Step 2: Write a continuation fork canary**

The continuation canary has cases for return split, PID relationship, memory divergence, and waitpid.

- [x] **Step 3: Make default stubs weak**

Mark default `fork()` / `vfork()` stubs in `codepod_process.c` weak or split them so `codepod_fork.c` wins in the continuation archive.

- [x] **Step 4: Add `host_fork` declaration and shim**

`codepod_fork.c` imports `codepod.host_fork`, maps negative errno returns, and provides a strong `fork()`.

- [x] **Step 5: Rename setjmp archive to continuations**

Build `libcodepod_continuations.a` from `codepod_setjmp.o` and `codepod_fork.o`. Keep old archive env aliases in cpcc only.

### Task 6: Asyncify Fork Runtime

**Files:**
- Modify: `packages/kernel/src/async-bridge.ts`
- Modify: `packages/kernel/src/process/loader.ts`
- Modify: `packages/kernel/src/process/kernel.ts`
- Modify: `packages/kernel/src/wasi/wasi-host.ts`
- Modify: `packages/kernel/src/vfs/fd-table.ts`
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`

- [x] **Step 1: Write failing runtime tests**

Tests use the fork canary and assert parent/child return split, child `getppid()`, memory divergence, and `waitpid(child)` success.

- [x] **Step 2: Add fork state to `AsyncifyAsyncBridge`**

Add `hostFork`, pending fork return, fork snapshot hooks, and child rewind support.

- [x] **Step 3: Snapshot and restore process state**

Snapshot memory, bridge continuation state, kernel fd table, WASI fd state, cwd/env/argv, and process metadata after Asyncify unwind and before parent rewind.

- [x] **Step 4: Register and start the child**

Reserve a child process slot synchronously, clone fd/process state, return child PID to the parent, and enqueue child instantiation/resume from the copied snapshot.

- [x] **Step 5: Verify runtime tests**

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/kernel/src/__tests__/guest-compat.test.ts --filter fork`.

### Task 7: Build Fixtures And Final Verification

**Files:**
- Modify generated fixtures under `packages/kernel/src/platform/__tests__/fixtures/` only for rebuilt canaries.

- [x] **Step 1: Build guest compat canaries**

Run:

```bash
make -C packages/guest-compat build/fork-default-canary.wasm build/fork-canary.wasm
```

- [x] **Step 2: Run focused Deno tests**

Run:

```bash
source scripts/dev-init.sh && deno check \
  packages/kernel/src/async-bridge.ts \
  packages/kernel/src/process/module-profile.ts \
  packages/kernel/src/process/loader.ts \
  packages/kernel/src/process/manager.ts \
  packages/kernel/src/process/kernel.ts \
  packages/kernel/src/wasi/wasi-host.ts \
  packages/kernel/src/host-imports/kernel-imports.ts \
  packages/kernel/src/process/__tests__/loader.test.ts \
  packages/kernel/src/process/__tests__/module-profile.test.ts \
  packages/kernel/src/process/__tests__/kernel.test.ts \
  packages/kernel/src/host-imports/__tests__/imports-shape.test.ts \
  packages/kernel/src/host-imports/__tests__/imports-parity.test.ts

source scripts/dev-init.sh && deno test -A --no-check \
  packages/kernel/src/process/__tests__/module-profile.test.ts

source scripts/dev-init.sh && deno test -A --no-check \
  packages/kernel/src/process/__tests__/loader.test.ts \
  --filter "continuation fork"

source scripts/dev-init.sh && deno test -A --no-check \
  packages/kernel/src/process/__tests__/kernel.test.ts \
  packages/kernel/src/host-imports/__tests__/imports-shape.test.ts \
  packages/kernel/src/host-imports/__tests__/imports-parity.test.ts
```

- [x] **Step 3: Run focused Rust tests**

Run:

```bash
cargo test -q -p cpcc-toolchain --lib
cargo test -q -p cpcc-toolchain --test cli dry_run_
```

Known existing broader-suite blocker:

```bash
cargo test -q -p cpcc-toolchain
```

still fails in `tests/canary_coverage.rs` because many Tier 1 symbols are not
covered by canaries.

- [x] **Step 4: Run diff hygiene**

Run: `git diff --check`.

- [ ] **Step 5: Open PR**

Push `feature/continuation-fork` and open a PR against `main` with the fork-only scope and known `execve` companion follow-up called out.
