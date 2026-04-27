# Kernel / Userland Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `packages/orchestrator/` → `packages/kernel/` and split userland-shaped code (shell-instance, shell-imports, `Sandbox.run`/history) out into host-side modules, exposing the kernel as a generic process+resource runtime.

**Architecture:** Six sequential PRs. **PR1** installs the shell wasm into the sandbox VFS as `/bin/bash` (prerequisite for everything else). **PR2** carves a generic `Process` API + resident-mode loader out of `shell-instance.ts` (additive — existing callers keep working). **PR3** audits `host-imports/shell-imports.ts` and folds generic helpers into `kernel-imports.ts`, marking shell-legacy imports for relocation. **PR4** rewires every `ShellInstance` consumer to the new generic API, moves bash-specific dispatch + shell-legacy imports out to `mcp-server`/`sdk-server`, and deletes `shell/`. **PR5** is a pure rename (`orchestrator/` → `kernel/`). **PR6** adds the kernel README and boundary marker.

**Tech Stack:** TypeScript (Deno + Node), wasm32-wasip1, JSPI / Asyncify, the existing codepod runtime (VFS, ProcessManager, host imports).

**Spec:** [`docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md`](../specs/2026-04-27-kernel-userland-separation-design.md)

---

## Files Affected

This plan touches the following files. Each PR section below specifies which subset.

### `packages/orchestrator/src/`

- `sandbox.ts` — `Sandbox.create`, `Sandbox.fork`, `Sandbox.run/getHistory/clearHistory`. Touched in PR1, PR2, PR4.
- `cli.ts` — One `ShellInstance.create` call site. Touched in PR4.
- `index.ts` — Public exports including `ShellInstance`. Touched in PR4.
- `shell/shell-instance.ts` — 1157 lines. Carved out in PR2, deleted in PR4.
- `shell/shell-like.ts`, `shell/history.ts`, `shell/shell-types.ts` — Companion modules. Deleted in PR4.
- `shell/__tests__/` — Conformance tests (kept; rewired to new API in PR4) plus instance-direct unit tests (deleted in PR4).
- `process/manager.ts` — Adds resident-mode bookkeeping in PR2.
- `process/process.ts` — **Created** in PR2 (the generic `Process` class).
- `process/loader.ts` — **Created** in PR2 (generic instantiate + wire imports + resident-mode lifecycle).
- `host-imports/kernel-imports.ts` — Touched in PR3 (generic-helpers fold-in) and PR4 (`host_run_command` callback delegate).
- `host-imports/shell-imports.ts` — Audited in PR3, deleted in PR4.
- `host-imports/common.ts` — Possibly extended in PR3 with shared decoding helpers.
- `execution/execution-worker.ts`, `execution/worker-executor.ts` — Rewired in PR4 to use generic `Process` API.

### `packages/sdk-server/src/`

- `dispatcher.ts` — `sandbox.run`, `shell.history.list`, `shell.history.clear` consumers. Rewired in PR4.
- `bash-dispatch.ts` — **Created** in PR4. The bash-specific `__run_command` wrapper for the user-facing path.
- `bash-host-imports.ts` — **Created** in PR4. Builds the shell-legacy import bag (host_stat, host_register_tool, etc.) for bash to receive at boot.

### `packages/mcp-server/src/`

- `index.ts` — `sandbox.run` consumer (the `run_command` MCP tool). Rewired in PR4.
- `bash-dispatch.ts` — **Created** in PR4. Near-duplicate of sdk-server's.
- `bash-host-imports.ts` — **Created** in PR4. Near-duplicate of sdk-server's.

### Root + scripts

- `scripts/build-sdk-server.sh` — Touched in PR5 (path references).
- `scripts/build-mcp.sh` — Touched in PR5 (path references).
- `CLAUDE.md` — Touched in PR5 (architecture section path references).
- `packages/kernel/README.md` — **Created** in PR6.

---

## PR1 — VFS `/bin/bash` Install

**Goal:** Make `/bin/bash` exist as a real file in the sandbox VFS, marked executable. Today the shell wasm comes from a host filesystem path passed to `ShellInstance.create`; nothing exists at `/bin/bash`. PR2+ depends on `bootArgv: ["/bin/bash"]` resolving to a real VFS file.

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts`
- Test: `packages/orchestrator/src/__tests__/bin-bash-install.test.ts` (new)

### Task 1.1: Failing test for /bin/bash existence

**Files:**
- Test: `packages/orchestrator/src/__tests__/bin-bash-install.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/src/__tests__/bin-bash-install.test.ts`:

```ts
import { assertEquals, assert } from 'jsr:@std/assert';
import { Sandbox } from '../sandbox.ts';

Deno.test('Sandbox.create installs shell wasm at /bin/bash', async () => {
  const sb = await Sandbox.create();
  try {
    const stat = sb.vfs.stat('/bin/bash');
    assert(stat, '/bin/bash should exist after Sandbox.create');
    assertEquals(stat.kind, 'file', '/bin/bash should be a regular file');
    // Mode lower 9 bits should include executable for owner (0o100).
    assert(
      (stat.mode & 0o100) !== 0,
      `/bin/bash should be marked executable, mode=${stat.mode.toString(8)}`,
    );
    // Should look like wasm: starts with \0asm magic.
    const bytes = sb.vfs.readFile('/bin/bash');
    assert(bytes.length > 8, '/bin/bash should be non-trivially long');
    assertEquals(bytes[0], 0x00);
    assertEquals(bytes[1], 0x61); // 'a'
    assertEquals(bytes[2], 0x73); // 's'
    assertEquals(bytes[3], 0x6d); // 'm'
  } finally {
    await sb.destroy();
  }
});

Deno.test('Sandbox.fork inherits /bin/bash in child', async () => {
  const parent = await Sandbox.create();
  try {
    const child = await parent.fork();
    try {
      const stat = child.vfs.stat('/bin/bash');
      assert(stat, 'forked sandbox should also have /bin/bash');
      assertEquals(stat.kind, 'file');
    } finally {
      await child.destroy();
    }
  } finally {
    await parent.destroy();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/bin-bash-install.test.ts
```

Expected: FAIL — `/bin/bash` does not exist in the VFS today.

### Task 1.2: Install shell wasm at `/bin/bash` during `Sandbox.create`

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts` (around line 220, where `ShellInstance.create` is called)

- [ ] **Step 1: Read the existing call site**

Locate the block in `Sandbox.create` that resolves `shellExecWasmPath` and calls `ShellInstance.create(...)`. It currently looks like:

```ts
const shellBinarySuffix = typeof WebAssembly.Suspending === 'function' ? '' : '-asyncify';
const shellExecWasmPath = options.shellExecWasmPath ??
  `${options.wasmDir}/codepod-shell-exec${shellBinarySuffix}.wasm`;

await mgr.preloadModules();

const runner = await ShellInstance.create(vfs, mgr, adapter, shellExecWasmPath, { ... });
```

- [ ] **Step 2: Add the VFS install before `ShellInstance.create`**

Replace the block above with:

```ts
const shellBinarySuffix = typeof WebAssembly.Suspending === 'function' ? '' : '-asyncify';
const shellExecWasmPath = options.shellExecWasmPath ??
  `${options.wasmDir}/codepod-shell-exec${shellBinarySuffix}.wasm`;

await mgr.preloadModules();

// Install the shell wasm into the sandbox VFS at /bin/bash so it is
// reachable by path. Future PRs will pass `bootArgv: ["/bin/bash"]`
// to spawn it; today's ShellInstance still loads from shellExecWasmPath
// directly. Both reads see the same bytes.
const shellWasmBytes = await adapter.readBytes(shellExecWasmPath);
vfs.withWriteAccess(() => {
  vfs.mkdirp('/bin');
  vfs.writeFile('/bin/bash', shellWasmBytes);
  vfs.chmod('/bin/bash', 0o755);
});

const runner = await ShellInstance.create(vfs, mgr, adapter, shellExecWasmPath, { ... });
```

- [ ] **Step 3: Update `Sandbox.fork()` to install /bin/bash in the child VFS**

Locate `Sandbox.fork()` (around line 820 in sandbox.ts). It calls `ShellInstance.create(childVfs, ...)`. Insert the same VFS install before that call:

```ts
// Forked sandbox gets its own /bin/bash install. (VFS state is cloned
// from parent, so /bin/bash should already be present, but install
// idempotently in case the parent VFS was constructed before this PR.)
const shellWasmBytes = await this.adapter.readBytes(this.shellExecWasmPath);
childVfs.withWriteAccess(() => {
  childVfs.mkdirp('/bin');
  childVfs.writeFile('/bin/bash', shellWasmBytes);
  childVfs.chmod('/bin/bash', 0o755);
});

const childRunner = await ShellInstance.create(childVfs, childMgr, this.adapter, this.shellExecWasmPath, ...);
```

If `this.shellExecWasmPath` isn't currently stored on the Sandbox instance, also add a private field `private readonly shellExecWasmPath: string` populated in the constructor.

- [ ] **Step 4: Run the test to verify it passes**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/bin-bash-install.test.ts
```

Expected: PASS — both tests green.

- [ ] **Step 5: Run the full unit-test suite to verify no regressions**

```bash
deno test -A --no-check packages/orchestrator/src/**/*.test.ts packages/orchestrator/src/pool/__tests__/*.test.ts packages/sdk-server/src/*.test.ts
```

Expected: all tests pass that passed before.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/orchestrator/src/__tests__/bin-bash-install.test.ts
git commit -m "feat(kernel): install shell wasm at /bin/bash in VFS at Sandbox.create"
```

### Task 1.3: PR1 PR

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feature/kernel-userland-separation
gh pr create --draft --title "PR1: Install shell wasm at /bin/bash in VFS" --body "$(cat <<'EOF'
## Summary
First PR in the kernel/userland separation series. Installs the shell wasm into the sandbox VFS at `/bin/bash` (chmod 0755) at sandbox creation and fork, so subsequent PRs can spawn it by path.

## Test plan
- [ ] `bin-bash-install.test.ts` passes (asserts file exists, is executable, has wasm magic).
- [ ] All existing unit tests pass.
- [ ] guest-compat tests pass.
- [ ] mcp-server + sdk-server smoke test (manual `Sandbox()` + `sb.run("ls /")`).

Spec: docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md
EOF
)"
```

---

## PR2 — Generic Process Loader (Carve-Out, Additive)

**Goal:** Factor the generic process loading logic out of `shell-instance.ts` into reusable `process/process.ts` + `process/loader.ts`. Existing `ShellInstance` continues to work as a thin wrapper. New API: `Sandbox.create({ bootArgv, … })` and `sandbox.process(pid)`.

**Files:**
- Create: `packages/orchestrator/src/process/process.ts` (the generic `Process` class)
- Create: `packages/orchestrator/src/process/loader.ts` (instantiate, wire imports, run init, support resident mode)
- Modify: `packages/orchestrator/src/process/manager.ts` (track resident-mode bookkeeping, expose `process(pid)` accessor)
- Modify: `packages/orchestrator/src/sandbox.ts` (add `bootArgv` option; keep default `["/bin/bash"]` for compat; expose `sandbox.process(pid)`)
- Modify: `packages/orchestrator/src/shell/shell-instance.ts` (delegate spawn/imports/JSPI to the generic loader; keep `__run_command` dispatch)
- Test: `packages/orchestrator/src/process/__tests__/process.test.ts` (new)

### Task 2.1: Define `Process` interface and types

**Files:**
- Create: `packages/orchestrator/src/process/process.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/src/process/__tests__/process.test.ts`:

```ts
import { assertEquals, assert, assertRejects } from 'jsr:@std/assert';
import { Process, type ProcessMode } from '../process.ts';

Deno.test('Process exposes pid, mode, and exitCode', () => {
  // We only need a stub instance to test the shape of the class.
  // Real instantiation is exercised in loader.test.ts.
  const p = Process.__forTesting({
    pid: 7,
    mode: 'resident',
  });
  assertEquals(p.pid, 7);
  assertEquals(p.mode, 'resident');
  assertEquals(p.exitCode, undefined);
});

Deno.test('Process.callExport rejects when no export wired', async () => {
  const p = Process.__forTesting({ pid: 7, mode: 'resident' });
  await assertRejects(
    () => p.callExport('__run_command', 'foo'),
    Error,
    'no export named __run_command',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno test -A --no-check packages/orchestrator/src/process/__tests__/process.test.ts
```

Expected: FAIL — `process.ts` does not exist.

- [ ] **Step 3: Write the minimal `Process` implementation**

Create `packages/orchestrator/src/process/process.ts`:

```ts
/**
 * Process — the generic kernel-side handle for a running wasm process.
 *
 * Resident vs CLI:
 *   - "cli" — _start runs to completion; proc_exit terminates; instance discarded.
 *   - "resident" — _start runs to first proc_exit(0) (treated as init complete);
 *     the wasm instance is retained; subsequent work happens via callExport().
 *     proc_exit during a callExport invocation is NOT caught; it traps and is
 *     fatal (for PID 1, transitions the sandbox to "exited").
 *
 * See docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md
 * — §Resident Mode for the full contract, including the single-flight FIFO
 * invariant on callExport.
 */

export type ProcessMode = 'cli' | 'resident';

export interface ProcessExports {
  /** Map from export name (e.g. "__run_command") to the wrapped callable.
   *  Wrapped means JSPI-or-Asyncify already applied so calls return Promises. */
  readonly exports: Record<string, (...args: number[]) => unknown>;
}

export class Process {
  readonly pid: number;
  readonly mode: ProcessMode;
  exitCode: number | undefined;

  // FIFO queue for callExport — one in-flight call per resident process.
  private inflight: Promise<unknown> = Promise.resolve();

  // Wired by the loader after instantiation. Undefined for stub instances.
  private exportsRef: ProcessExports | undefined;

  private constructor(opts: { pid: number; mode: ProcessMode }) {
    this.pid = opts.pid;
    this.mode = opts.mode;
  }

  /** Internal factory used by loader.ts. Not for external consumers. */
  static __forLoader(opts: { pid: number; mode: ProcessMode }): Process {
    return new Process(opts);
  }

  /** Test-only factory. Skips loader machinery. */
  static __forTesting(opts: { pid: number; mode: ProcessMode }): Process {
    return new Process(opts);
  }

  /** Internal wiring used by loader.ts after WebAssembly.instantiate returns. */
  __setExports(refs: ProcessExports): void {
    this.exportsRef = refs;
  }

  /**
   * Invoke a wasm export on this process.
   *
   * Single-flight FIFO: subsequent callExport calls queue behind the in-flight
   * one. Per-process queue (independent processes run concurrently). See the
   * spec's §Resident Mode for why this matters and when it does NOT prevent
   * deadlock (recursive host_run_command — host callback must spawn a fresh
   * process, not re-enter PID 1).
   */
  async callExport(name: string, ...args: unknown[]): Promise<unknown> {
    const exports = this.exportsRef?.exports;
    if (!exports || !(name in exports)) {
      throw new Error(`no export named ${name}`);
    }
    const fn = exports[name];
    const next = this.inflight.then(() => fn(...(args as number[])));
    // Capture into inflight so subsequent calls queue behind this one,
    // even if `next` rejects.
    this.inflight = next.catch(() => {});
    return next;
  }

  /** Terminate a resident process (or signal a CLI process). */
  async terminate(): Promise<void> {
    // Implementation provided by loader.ts via __setTerminate; keep the
    // interface here for type completeness.
    if (this.terminateImpl) await this.terminateImpl();
    this.exitCode ??= 0;
  }

  private terminateImpl?: () => Promise<void>;
  __setTerminate(fn: () => Promise<void>): void {
    this.terminateImpl = fn;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
deno test -A --no-check packages/orchestrator/src/process/__tests__/process.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/process/process.ts packages/orchestrator/src/process/__tests__/process.test.ts
git commit -m "feat(kernel): add Process class with mode + single-flight FIFO callExport"
```

### Task 2.2: FIFO serialization test

**Files:**
- Test: `packages/orchestrator/src/process/__tests__/process.test.ts` (extend)

- [ ] **Step 1: Add a FIFO test that fails until queueing is verified**

Append to `process.test.ts`:

```ts
Deno.test('Process.callExport serializes FIFO per process', async () => {
  const p = Process.__forTesting({ pid: 7, mode: 'resident' });
  let inflight = 0;
  let maxInflight = 0;
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  // Wire a fake export that sleeps and tracks concurrent invocations.
  p.__setExports({
    exports: {
      slow: async () => {
        inflight++;
        if (inflight > maxInflight) maxInflight = inflight;
        await sleep(20);
        inflight--;
        return 0;
      },
    },
  });
  // Issue 5 calls in parallel; FIFO must serialize them.
  await Promise.all([
    p.callExport('slow'),
    p.callExport('slow'),
    p.callExport('slow'),
    p.callExport('slow'),
    p.callExport('slow'),
  ]);
  assertEquals(maxInflight, 1, 'FIFO must serialize callExport — at most 1 in flight');
});
```

- [ ] **Step 2: Run — should pass already (we built FIFO into Task 2.1)**

```bash
deno test -A --no-check packages/orchestrator/src/process/__tests__/process.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/process/__tests__/process.test.ts
git commit -m "test(kernel): assert Process.callExport FIFO serialization"
```

### Task 2.3: Generic loader (`process/loader.ts`)

**Files:**
- Create: `packages/orchestrator/src/process/loader.ts`
- Test: `packages/orchestrator/src/process/__tests__/loader.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/src/process/__tests__/loader.test.ts`:

```ts
import { assertEquals, assert } from 'jsr:@std/assert';
import { loadProcess } from '../loader.ts';
import { Sandbox } from '../../sandbox.ts';

Deno.test('loadProcess instantiates a wasm at a VFS path and returns a Process', async () => {
  const sb = await Sandbox.create();
  try {
    // /bin/bash exists post-PR1.
    const proc = await loadProcess(sb, {
      argv: ['/bin/bash'],
      mode: 'resident',
    });
    assertEquals(proc.mode, 'resident');
    assert(proc.pid > 0);
    // Should expose __run_command on a resident bash.
    assert(
      typeof proc.callExport === 'function',
      'callExport should be available',
    );
    await proc.terminate();
  } finally {
    await sb.destroy();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno test -A --no-check packages/orchestrator/src/process/__tests__/loader.test.ts
```

Expected: FAIL — `loader.ts` does not exist.

- [ ] **Step 3: Implement `loader.ts`**

Create `packages/orchestrator/src/process/loader.ts`:

```ts
/**
 * Generic process loader. Instantiates a wasm guest, wires WASI + codepod
 * imports, runs _start, and returns a Process handle.
 *
 * For resident-mode processes, the wasm instance is retained and exports
 * become callable via Process.callExport. For CLI-mode processes, the
 * wasm instance is dropped after _start returns.
 *
 * This is the carve-out of the generic bits of ShellInstance.create. The
 * shell-specific bits (host_run_command JSPI wrapping for the bash protocol,
 * the __run_command export wrapping convention) stay in shell-instance.ts
 * for PR2 and move out in PR4.
 */

import type { Sandbox } from '../sandbox.ts';
import { Process, type ProcessMode } from './process.ts';
import type { PlatformAdapter } from '../platform/adapter.ts';

export interface LoadProcessOptions {
  argv: string[];
  mode: ProcessMode;
  env?: Record<string, string>;
  cwd?: string;
  /**
   * Additional codepod imports to merge alongside the kernel's standard set.
   * Used by host servers (post-PR4) to supply userland-specific imports
   * (e.g., bash-host's host_stat, host_register_tool). The kernel ignores
   * the names; it just merges them into the import object.
   */
  extraCodepodImports?: Record<string, WebAssembly.ImportValue>;
}

export async function loadProcess(
  sandbox: Sandbox,
  opts: LoadProcessOptions,
): Promise<Process> {
  const { argv, mode } = opts;
  const path = argv[0];
  if (!path) throw new Error('loadProcess: argv[0] is required');

  // Resolve the wasm bytes from the VFS.
  const bytes = sandbox.vfs.readFile(path);
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61) {
    throw new Error(`loadProcess: ${path} is not a wasm binary`);
  }

  const adapter: PlatformAdapter = sandbox.adapter;
  const module = await adapter.compile(bytes);

  // Allocate a pid in the ProcessManager.
  const pid = sandbox.processManager.allocatePid({
    argv, env: opts.env ?? {}, cwd: opts.cwd ?? '/',
  });

  const proc = Process.__forLoader({ pid, mode });

  // Build imports: WASI + standard kernel codepod imports + caller extras.
  const wasiImports = sandbox.wasi.buildImports(pid);
  const kernelImports = sandbox.buildKernelImports(pid);
  const codepodImports: Record<string, WebAssembly.ImportValue> = {
    ...kernelImports,
    ...(opts.extraCodepodImports ?? {}),
  };

  const imports: WebAssembly.Imports = {
    wasi_snapshot_preview1: wasiImports,
    codepod: codepodImports,
  };

  const instance = await adapter.instantiate(module, imports);

  // Wire memory back into the imports so they can read/write the linear
  // memory of the freshly-instantiated process.
  const memoryRef = instance.exports.memory as WebAssembly.Memory;
  sandbox.bindMemoryForProcess(pid, memoryRef);

  // Wrap exports with JSPI / Asyncify if the binary requires it.
  const wrappedExports: Record<string, (...args: number[]) => unknown> = {};
  for (const [name, raw] of Object.entries(instance.exports)) {
    if (typeof raw !== 'function') continue;
    if (typeof (WebAssembly as { promising?: unknown }).promising === 'function') {
      wrappedExports[name] = (WebAssembly as unknown as {
        promising: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => Promise<unknown>;
      }).promising(raw as (...args: unknown[]) => unknown) as (...args: number[]) => unknown;
    } else {
      wrappedExports[name] = raw as (...args: number[]) => unknown;
    }
  }
  proc.__setExports({ exports: wrappedExports });

  // Run _start. Resident mode catches proc_exit(0) as init-complete; CLI
  // mode lets it propagate as terminal exit.
  const start = instance.exports._start as (() => void) | undefined;
  if (start) {
    try {
      start();
    } catch (e: unknown) {
      const isExit0 = e instanceof Error && e.message === 'proc_exit(0)';
      if (mode === 'resident' && isExit0) {
        // ok — init complete
      } else if (mode === 'cli' && isExit0) {
        proc.exitCode = 0;
      } else {
        throw e;
      }
    }
  }

  // Wire termination. Resident: drop the instance + free pid. CLI: same
  // (since _start already returned, this is just bookkeeping).
  proc.__setTerminate(async () => {
    sandbox.processManager.releasePid(pid);
  });

  return proc;
}
```

- [ ] **Step 4: Add the supporting `Sandbox` accessors used by the loader**

Modify `packages/orchestrator/src/sandbox.ts` — add public read access to `vfs`, `adapter`, `processManager`, `wasi`, plus `buildKernelImports(pid)` and `bindMemoryForProcess(pid, mem)` methods. These already exist internally; surface them or add thin accessors:

```ts
// In Sandbox class:
readonly vfs: VFS;
readonly adapter: PlatformAdapter;
readonly processManager: ProcessManager;
readonly wasi: WasiHost;

buildKernelImports(pid: number): Record<string, WebAssembly.ImportValue> {
  // Delegate to existing kernel-imports.ts factory; bind to this sandbox + pid.
  return createKernelImports({
    vfs: this.vfs,
    processManager: this.processManager,
    pid,
    networkBridge: this.networkBridge,
    extensionRegistry: this.extensionRegistry,
    threadsBackend: this.threadsBackend,
  });
}

bindMemoryForProcess(pid: number, memory: WebAssembly.Memory): void {
  this.processManager.setMemoryRef(pid, memory);
}
```

If `ProcessManager.allocatePid` / `releasePid` / `setMemoryRef` aren't already public, expose them. If they require additional work (e.g., the existing manager doesn't have an `allocatePid` separate from `spawn`), name the actual existing method here and adjust the loader accordingly. Read `manager.ts` to find the right entry points before writing.

- [ ] **Step 5: Run the loader test to verify it passes**

```bash
deno test -A --no-check packages/orchestrator/src/process/__tests__/loader.test.ts
```

Expected: PASS — loader instantiates `/bin/bash`, returns a resident `Process` with `__run_command` available.

- [ ] **Step 6: Run the full unit-test suite**

```bash
deno test -A --no-check packages/orchestrator/src/**/*.test.ts packages/orchestrator/src/pool/__tests__/*.test.ts packages/sdk-server/src/*.test.ts
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src/process/loader.ts packages/orchestrator/src/process/__tests__/loader.test.ts packages/orchestrator/src/sandbox.ts
git commit -m "feat(kernel): add generic process loader (instantiate + JSPI + resident mode)"
```

### Task 2.4: `Sandbox.create({ bootArgv })` + `sandbox.process(pid)`

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts`
- Test: `packages/orchestrator/src/__tests__/sandbox-bootArgv.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/src/__tests__/sandbox-bootArgv.test.ts`:

```ts
import { assertEquals, assert } from 'jsr:@std/assert';
import { Sandbox } from '../sandbox.ts';

Deno.test('Sandbox.create accepts bootArgv and exposes sandbox.process(1)', async () => {
  const sb = await Sandbox.create({ bootArgv: ['/bin/bash'] });
  try {
    const p = sb.process(1);
    assert(p, 'sandbox.process(1) should return a Process');
    assertEquals(p.pid, 1);
    assertEquals(p.mode, 'resident');
    // The bash binary exposes __run_command.
    assert(typeof p.callExport === 'function');
  } finally {
    await sb.destroy();
  }
});

Deno.test('Sandbox.create defaults bootArgv to /bin/bash for compat', async () => {
  // No bootArgv supplied — should still work using the existing default.
  const sb = await Sandbox.create();
  try {
    const p = sb.process(1);
    assert(p, 'PID 1 should exist with default bootArgv');
  } finally {
    await sb.destroy();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox-bootArgv.test.ts
```

Expected: FAIL — `bootArgv` option not yet recognized; `sandbox.process(1)` not yet defined.

- [ ] **Step 3: Add `bootArgv` to `Sandbox.create`**

In `packages/orchestrator/src/sandbox.ts`, modify the `Sandbox.create` signature (the `options` interface) and use the loader for PID 1:

```ts
export interface SandboxOptions {
  // ... existing fields ...
  /**
   * argv for the boot process (PID 1). Defaults to `["/bin/bash"]` for
   * backward compatibility — this default goes away in PR4 once host
   * servers take over. Pass any executable that exists in the VFS.
   */
  bootArgv?: string[];
}
```

In the body of `Sandbox.create`, replace the `ShellInstance.create(...)` line with both:

```ts
const bootArgv = options.bootArgv ?? ['/bin/bash'];

// PR2: use the generic loader to spawn PID 1 alongside the existing
// ShellInstance pathway. shell-instance.ts will be reduced to a thin
// wrapper in Task 2.5; for now both paths run.
const sandboxInstance = new Sandbox(/* existing constructor args */);
sandboxInstance.bootArgvField = bootArgv;

// Existing ShellInstance.create call stays:
const runner = await ShellInstance.create(vfs, mgr, adapter, shellExecWasmPath, { ... });
sandboxInstance.runner = runner;

// Spawn PID 1 via the new generic loader. ShellInstance retained the
// instance under a different bookkeeping path; in PR4 the two converge.
const pid1 = await loadProcess(sandboxInstance, { argv: bootArgv, mode: 'resident' });
sandboxInstance.pid1 = pid1;

return sandboxInstance;
```

NOTE: this temporarily creates two bash instances per sandbox (one via ShellInstance, one via loader). That waste is intentional and disappears in Task 2.5. The plan accepts double-instantiation only for the PR2 transient — PR2 ships green, PR3+PR4 collapses to one.

If double-instantiation is too costly to ship (very large wasm or memory pressure), add a `legacyShell` flag to `loadProcess` that *does not* run `_start` again — relying on ShellInstance having already done so. Decide at implementation time based on sandbox boot timing.

- [ ] **Step 4: Add `sandbox.process(pid)` accessor**

Add a method to the `Sandbox` class:

```ts
process(pid: number): Process | undefined {
  if (pid === 1) return this.pid1;
  return this.processManager.processByPid(pid);
}
```

If `ProcessManager` has no `processByPid`, add a thin getter that maps the manager's internal PID table to `Process` instances. For PR2, returning the `Process` only for pid 1 is sufficient — the test asserts only `process(1)`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox-bootArgv.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/orchestrator/src/__tests__/sandbox-bootArgv.test.ts
git commit -m "feat(kernel): Sandbox.create accepts bootArgv; sandbox.process(1) exposed"
```

### Task 2.5: Reduce `shell-instance.ts` to thin wrapper

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-instance.ts`

This task collapses the double-instantiation introduced in Task 2.4. After it, `ShellInstance` reuses the loader's `Process` and only adds bash-specific dispatch.

- [ ] **Step 1: Read the current `ShellInstance.create` flow**

Open `packages/orchestrator/src/shell/shell-instance.ts`. The relevant flow runs from the entry of `static async create()` through the `_start()` invocation (around line 482-495) to the construction of the `ShellInstance` object.

- [ ] **Step 2: Replace the manual instantiation block with a call to `loadProcess`**

Replace the block from `adapter.instantiate(...)` through the `__alloc` / asyncify init (currently lines ~469 through ~510) with:

```ts
// Delegate generic process loading to the kernel's process loader.
const proc = await loadProcess(sandbox, {
  argv: ['/bin/bash'],
  mode: 'resident',
  // ShellInstance previously injected `host_run_command` via its own
  // wrapping of kernelImports. The wrapping moves into the loader
  // itself in PR4; for now, ShellInstance still patches the import
  // via extraCodepodImports. The patch is shell-specific (it dispatches
  // back to a fresh ShellInstance for subprocess), so it stays here.
  extraCodepodImports: {
    host_run_command: shellHostRunCommand,
  },
});

const wrappedRunCommand = (...args: number[]) =>
  proc.callExport('__run_command', ...args);

const memoryRef = proc.exportsRef!.exports.memory as unknown as WebAssembly.Memory;
const shell = new ShellInstance(proc, wrappedRunCommand, memoryRef);
```

Where `shellHostRunCommand` is the existing JSPI-or-asyncify-wrapped `host_run_command` function ShellInstance currently builds (it spawns a fresh ShellInstance for subprocess execution today — that behavior is preserved as-is and moves out in PR4). Keep its definition as a module-private function.

- [ ] **Step 3: Update the `ShellInstance` constructor signature**

Change the constructor to accept the new arguments:

```ts
private constructor(
  proc: Process,
  wrappedRunCommand: (...args: number[]) => Promise<number>,
  memoryRef: WebAssembly.Memory,
) {
  this.proc = proc;
  this.runCommandImpl = wrappedRunCommand;
  this.memoryRef = memoryRef;
}
```

Drop now-unused fields (`instance`, raw export refs) — they're held inside the `Process` now.

- [ ] **Step 4: Update `Sandbox.create` to skip the duplicate spawn**

Back in `sandbox.ts`, simplify the boot block: ShellInstance now wraps the same Process the loader returned. Remove the `const pid1 = await loadProcess(...)` line that ran in parallel; let `ShellInstance.create` own PID 1.

```ts
const runner = await ShellInstance.create(sandboxInstance, ...);
sandboxInstance.runner = runner;
sandboxInstance.pid1 = runner.process; // expose the underlying Process
```

`ShellInstance` exposes a `process: Process` getter for this.

- [ ] **Step 5: Run the existing shell tests**

```bash
deno test -A --no-check packages/orchestrator/src/shell/__tests__/*.test.ts
```

Expected: PASS — shell continues to work via the new wrapper.

- [ ] **Step 6: Run the guest-compat tests including the pthread canary**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/guest-compat.test.ts
```

Expected: PASS — pthread canary still asserts counter == 40000. This is the guard against breaking the wasi-threads work that just landed.

- [ ] **Step 7: Run the full suite**

```bash
deno test -A --no-check packages/orchestrator/src/**/*.test.ts packages/orchestrator/src/pool/__tests__/*.test.ts packages/sdk-server/src/*.test.ts
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/orchestrator/src/shell/shell-instance.ts packages/orchestrator/src/sandbox.ts
git commit -m "refactor(kernel): ShellInstance delegates spawn+JSPI to generic process loader"
```

### Task 2.6: PR2 PR

- [ ] **Step 1: Push and open the PR**

```bash
git push
gh pr create --draft --title "PR2: Generic process loader (carve-out, additive)" --body "$(cat <<'EOF'
## Summary
Second PR in the kernel/userland separation series. Carves the generic process-loading bits out of `shell-instance.ts` into a reusable `Process` class (`process/process.ts`) and `loadProcess` function (`process/loader.ts`). Adds `Sandbox.create({ bootArgv })` and `sandbox.process(pid)`. ShellInstance is now a thin wrapper around `Process` + bash-specific `__run_command` dispatch.

## Test plan
- [ ] `process.test.ts` (Process shape + FIFO serialization) passes.
- [ ] `loader.test.ts` (instantiate /bin/bash from VFS) passes.
- [ ] `sandbox-bootArgv.test.ts` (bootArgv + sandbox.process(1)) passes.
- [ ] All existing shell conformance tests pass.
- [ ] guest-compat pthread canary still green (counter == 40000).
- [ ] mcp-server + sdk-server smoke test.

Spec: docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md
EOF
)"
```

---

## PR3 — `host-imports/shell-imports.ts` Audit

**Goal:** Audit the 403-line `shell-imports.ts` import-by-import. Fold generic helpers into `kernel-imports.ts` (with config flags for any sync/async or argv-encoding differences). Mark shell-legacy convenience imports for removal (move out in PR4).

**Files:**
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts`
- Modify: `packages/orchestrator/src/host-imports/shell-imports.ts`
- Test: `packages/orchestrator/src/host-imports/__tests__/imports-parity.test.ts` (new)

### Task 3.1: Side-by-side import parity baseline

**Files:**
- Test: `packages/orchestrator/src/host-imports/__tests__/imports-parity.test.ts` (new)

This task records the pre-PR3 baseline so subsequent merges can be checked for silent divergence.

- [ ] **Step 1: Generate the import-name baseline**

Create `packages/orchestrator/src/host-imports/__tests__/imports-parity.test.ts`:

```ts
import { assertEquals, assertArrayIncludes } from 'jsr:@std/assert';
import { createKernelImports } from '../kernel-imports.ts';
import { createShellImports } from '../shell-imports.ts';
import { Sandbox } from '../../sandbox.ts';

/** Recorded baseline of pre-PR3 import names. PR3 must not silently
 *  drop or rename any of these without an explicit decision. */
const KERNEL_IMPORTS_BASELINE = [
  // Process
  'host_pipe', 'host_spawn', 'host_waitpid', 'host_waitpid_nohang',
  'host_close_fd', 'host_getpid', 'host_getppid', 'host_kill',
  'host_list_processes',
  // Fd I/O
  'host_read_fd', 'host_write_fd', 'host_dup', 'host_dup2',
  // Network
  'host_network_fetch',
  'host_socket_connect', 'host_socket_send', 'host_socket_recv', 'host_socket_close',
  // Threads (gated by threadsBackend)
  'host_thread_spawn', 'host_thread_join', 'host_thread_detach', 'host_thread_self',
  'host_thread_yield',
  'host_mutex_lock', 'host_mutex_unlock', 'host_mutex_trylock',
  'host_cond_wait', 'host_cond_signal', 'host_cond_broadcast',
  // Extensions
  'host_extension_invoke', 'host_native_invoke',
  // Control flow
  'host_setjmp', 'host_longjmp', 'host_yield',
  // Currently kept in kernel-imports for RustPython:
  'host_run_command',
];

const SHELL_IMPORTS_BASELINE = [
  // Will be split during PR3. The generic ones move into kernel; the
  // shell-legacy ones get a marker for relocation in PR4.
  'host_pipe', 'host_spawn', 'host_waitpid', 'host_close_fd',
  'host_getpid', 'host_kill', 'host_list_processes',
  'host_read_fd', 'host_write_fd', 'host_dup', 'host_dup2',
  // Shell-legacy (these MUST move out in PR4):
  'host_stat', 'host_read_file', 'host_write_file', 'host_readdir',
  'host_mkdir', 'host_remove', 'host_chmod', 'host_glob',
  'host_rename', 'host_readlink',
  'host_register_tool', 'host_has_tool',
  'host_time',
];

Deno.test('kernel-imports baseline export names', async () => {
  // Build a stub sandbox to obtain the imports map.
  const sb = await Sandbox.create();
  try {
    const imports = sb.buildKernelImports(1);
    const names = Object.keys(imports);
    for (const expected of KERNEL_IMPORTS_BASELINE) {
      assertArrayIncludes(names, [expected]);
    }
  } finally {
    await sb.destroy();
  }
});

Deno.test('shell-imports baseline names (pre-PR3)', () => {
  // We can call createShellImports with stub deps to inspect names without
  // running anything. PR3 will narrow this set.
  const imports = createShellImports({
    vfs: {} as never,
    processManager: {} as never,
    memoryRef: { current: undefined } as never,
  });
  const names = Object.keys(imports);
  for (const expected of SHELL_IMPORTS_BASELINE) {
    assertArrayIncludes(names, [expected]);
  }
});

Deno.test('kernel + shell imports cover the same generic primitives', async () => {
  // Generic primitives (the intersection) must agree on name; signature
  // parity is checked in `imports-shape.test.ts` (Task 3.2).
  const sb = await Sandbox.create();
  try {
    const kernelNames = new Set(Object.keys(sb.buildKernelImports(1)));
    const shellImports = createShellImports({
      vfs: {} as never, processManager: {} as never, memoryRef: { current: undefined } as never,
    });
    const shellNames = new Set(Object.keys(shellImports));
    const generic = [
      'host_pipe', 'host_spawn', 'host_waitpid', 'host_close_fd',
      'host_getpid', 'host_kill',
      'host_read_fd', 'host_write_fd', 'host_dup', 'host_dup2',
    ];
    for (const name of generic) {
      assertEquals(kernelNames.has(name), true, `${name} missing from kernel`);
      assertEquals(shellNames.has(name), true, `${name} missing from shell`);
    }
  } finally {
    await sb.destroy();
  }
});
```

- [ ] **Step 2: Run the baseline test (should pass on `main`)**

```bash
deno test -A --no-check packages/orchestrator/src/host-imports/__tests__/imports-parity.test.ts
```

Expected: PASS — establishes the pre-PR3 contract.

- [ ] **Step 3: Commit the baseline**

```bash
git add packages/orchestrator/src/host-imports/__tests__/imports-parity.test.ts
git commit -m "test(kernel): pin pre-PR3 host-imports baseline (kernel + shell)"
```

### Task 3.2: Signature parity check for generic imports

**Files:**
- Test: `packages/orchestrator/src/host-imports/__tests__/imports-shape.test.ts` (new)

- [ ] **Step 1: Write the parity assertion**

Create `packages/orchestrator/src/host-imports/__tests__/imports-shape.test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createKernelImports } from '../kernel-imports.ts';
import { createShellImports } from '../shell-imports.ts';

const STUB_DEPS = {
  vfs: {} as never,
  processManager: {} as never,
  memoryRef: { current: undefined } as never,
  pid: 1,
};

Deno.test('generic imports have matching arity in kernel + shell', () => {
  const k = createKernelImports(STUB_DEPS as never);
  const s = createShellImports({
    vfs: {} as never, processManager: {} as never, memoryRef: { current: undefined } as never,
  });
  const generic = [
    'host_pipe', 'host_spawn', 'host_waitpid', 'host_close_fd',
    'host_getpid', 'host_kill',
    'host_read_fd', 'host_write_fd', 'host_dup', 'host_dup2',
  ];
  for (const name of generic) {
    const kFn = k[name] as Function | { length: number };
    const sFn = s[name] as Function | { length: number };
    const kArity = (kFn instanceof WebAssembly.Suspending)
      ? // WebAssembly.Suspending wraps an async fn; .length is on the inner.
        // Inspect via .toString() length count or recorded metadata.
        // For PR3, treat suspending wrapping as transparent for arity check.
        (kFn as { length?: number }).length ?? -1
      : (kFn as Function).length;
    const sArity = (sFn as Function).length;
    assertEquals(kArity, sArity, `arity mismatch on ${name}: kernel=${kArity} shell=${sArity}`);
  }
});
```

- [ ] **Step 2: Run the test**

```bash
deno test -A --no-check packages/orchestrator/src/host-imports/__tests__/imports-shape.test.ts
```

Expected: PASS (or revealing arity mismatches that need to be reconciled). If a real mismatch exists, that's the kind of latent bug PR3 must catch — fix at the divergent site rather than hiding it.

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/host-imports/__tests__/imports-shape.test.ts
git commit -m "test(kernel): assert kernel/shell host-import generic-arity parity"
```

### Task 3.3: Fold generic helpers from shell-imports into kernel-imports

**Files:**
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts`
- Modify: `packages/orchestrator/src/host-imports/shell-imports.ts`

This task does the actual import-by-import audit. For each name in the generic set above, compare the implementations and fold any divergence into a config option on the kernel side.

- [ ] **Step 1: Read both files side by side**

Open `kernel-imports.ts` and `shell-imports.ts`. For each generic import name, compare:
- Argument decoding (ptr/len pairs vs string offsets)
- Async vs sync wrapping
- Error code conventions
- Memory access path (direct vs via `memoryRef` proxy)

Record any difference inline as a comment.

- [ ] **Step 2: Add config flags to `createKernelImports` for any divergence**

For each diverging entry, add an option to `KernelImportsOptions`:

```ts
export interface KernelImportsOptions {
  // ... existing ...
  /**
   * If set, host_spawn returns synchronously (used by shell tests that
   * cannot suspend). Default is async (suspending). When you set this
   * to true, the function is NOT wrapped in WebAssembly.Suspending.
   */
  syncSpawn?: boolean;
  // ... add similar flags for any other genuine divergences identified ...
}
```

Update the implementation of each affected import to branch on the flag.

- [ ] **Step 3: Reduce `shell-imports.ts` to only the shell-legacy bucket**

After folding, `createShellImports` should return only the shell-legacy convenience imports: `host_stat`, `host_read_file`, `host_write_file`, `host_readdir`, `host_mkdir`, `host_remove`, `host_chmod`, `host_glob`, `host_rename`, `host_readlink`, `host_register_tool`, `host_has_tool`, `host_time`. Add a header comment marking them as shell-legacy and slated for relocation in PR4.

```ts
/**
 * Shell-legacy convenience host imports.
 *
 * These violate the kernel boundary principle (naming test): the kernel
 * exposes only primitives; these are file-system convenience helpers that
 * the shell binary uses today. They MUST move out to bash-host (in
 * sdk-server / mcp-server) in PR4. Long-term the shell should use WASI
 * Preview 1 (fd_read, path_open, etc.) and host_spawn instead.
 *
 * Until PR4, ShellInstance assembles them via createShellImports and
 * merges them into the boot process's import object.
 */
export function createShellImports(opts: ShellImportsOptions): Record<string, WebAssembly.ImportValue> {
  // ... only the 13 shell-legacy entries ...
}
```

- [ ] **Step 4: Update `ShellInstance` to use `createKernelImports` + `createShellImports` together**

In `shell-instance.ts`, where the imports were built from `createShellImports` alone, switch to:

```ts
const kernelImports = createKernelImports({
  vfs, processManager: mgr, pid: 1,
  // Use sync paths for any tests that need them:
  syncSpawn: opts.syncSpawn ?? false,
  // ... other flags ...
});
const shellLegacyImports = createShellImports({
  vfs, processManager: mgr, memoryRef,
});
const codepodImports = { ...kernelImports, ...shellLegacyImports };
```

The merge is order-dependent: `shellLegacyImports` overrides any same-name entries from `kernelImports`. After PR3, no name should appear in both — verify with the parity test.

- [ ] **Step 5: Run the parity tests + full suite**

```bash
deno test -A --no-check packages/orchestrator/src/host-imports/__tests__/*.test.ts
deno test -A --no-check packages/orchestrator/src/**/*.test.ts packages/orchestrator/src/pool/__tests__/*.test.ts packages/sdk-server/src/*.test.ts
```

Expected: PASS — including the kernel+shell parity assertion (now confirms the post-PR3 partition).

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/host-imports/kernel-imports.ts packages/orchestrator/src/host-imports/shell-imports.ts packages/orchestrator/src/shell/shell-instance.ts
git commit -m "refactor(kernel): fold generic imports into kernel-imports; shell-imports holds shell-legacy only"
```

### Task 3.4: PR3 PR

- [ ] **Step 1: Push and open the PR**

```bash
git push
gh pr create --draft --title "PR3: Audit shell-imports.ts; fold generics into kernel-imports" --body "$(cat <<'EOF'
## Summary
Third PR in the kernel/userland separation series. Audits the 403-line shell-imports.ts and folds generic primitives (host_pipe, host_spawn, host_read_fd, …) into kernel-imports.ts. shell-imports.ts now holds only shell-legacy convenience imports (host_stat, host_register_tool, host_glob, …) which move out to bash-host in PR4.

## Test plan
- [ ] `imports-parity.test.ts` baseline + post-fold partition.
- [ ] `imports-shape.test.ts` arity parity for generic imports.
- [ ] All existing shell conformance tests pass.
- [ ] guest-compat pthread canary still green.

Spec: docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md
EOF
)"
```

---

## PR4 — Rewire Consumers, Move bash-dispatch Out, Delete `shell/`

**Goal:** This is the substantive PR. Move bash-specific knowledge out of the kernel package into `sdk-server` and `mcp-server`. Delete `shell/` directory. Implement the host-registered `runCommandHandler` callback (fresh resident bash per call). Rewire the 5 in-tree `ShellInstance` consumers and the worker bridge to the generic Process API.

**This PR can plausibly split into PR4a (consumer rewires + Sandbox.run/history removal) and PR4b (callback + import moves + shell-instance.ts deletion). Decided at implementation time based on diff size.**

**Files:**
- Create: `packages/sdk-server/src/bash-dispatch.ts`
- Create: `packages/sdk-server/src/bash-host-imports.ts`
- Create: `packages/mcp-server/src/bash-dispatch.ts`
- Create: `packages/mcp-server/src/bash-host-imports.ts`
- Modify: `packages/orchestrator/src/sandbox.ts`
- Modify: `packages/orchestrator/src/cli.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/orchestrator/src/execution/execution-worker.ts`
- Modify: `packages/orchestrator/src/execution/worker-executor.ts`
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts` (host_run_command delegate to callback)
- Modify: `packages/sdk-server/src/dispatcher.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Delete: `packages/orchestrator/src/shell/` (entire directory) — last step of PR4

### Task 4.1: `runCommandHandler` callback wiring in kernel

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts` (accept `runCommandHandler` option, store on sandbox)
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts` (delegate to the registered handler)
- Test: `packages/orchestrator/src/__tests__/run-command-handler.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/src/__tests__/run-command-handler.test.ts`:

```ts
import { assertEquals, assert } from 'jsr:@std/assert';
import { Sandbox } from '../sandbox.ts';

Deno.test('runCommandHandler is invoked when a guest calls host_run_command', async () => {
  let handlerCalled = 0;
  let lastCmd = '';
  const sb = await Sandbox.create({
    runCommandHandler: async (req) => {
      handlerCalled++;
      lastCmd = req.cmd;
      return { exit_code: 0, stdout: 'mock-stdout', stderr: '' };
    },
  });
  try {
    // Run a Python program (or test guest) that calls host_run_command.
    // For PR4 we use the existing RustPython integration as the test.
    const result = await sb.run('python3 -c "import _codepod; r = _codepod.run_command(\\"echo hi\\"); print(r)"');
    assertEquals(handlerCalled, 1);
    assertEquals(lastCmd, 'echo hi');
    assert(result.stdout.includes('mock-stdout'));
  } finally {
    await sb.destroy();
  }
});

Deno.test('runCommandHandler defaults to fresh-resident-bash dispatch when not provided', async () => {
  // No handler -> kernel uses a built-in fallback that errors.
  // Host servers MUST register one; this test asserts the default error.
  const sb = await Sandbox.create();
  try {
    // RustPython _codepod.run_command should fail with a clear message.
    await assertRejects(
      () => sb.run('python3 -c "import _codepod; _codepod.run_command(\\"echo hi\\")"'),
      Error,
      'no runCommandHandler registered',
    );
  } finally {
    await sb.destroy();
  }
});
```

NOTE: the second test's failure message depends on the kernel's default behavior. Pick one: either kernel errors with "no runCommandHandler registered", or kernel falls back to spawning a fresh resident bash itself. The spec says hosts must register; therefore the kernel default error matches the spec. Update the test if the implementation chooses the fallback path.

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/run-command-handler.test.ts
```

Expected: FAIL — `runCommandHandler` option not yet accepted.

- [ ] **Step 3: Add `runCommandHandler` to `SandboxOptions`**

In `sandbox.ts`:

```ts
export interface RunRequest { cmd: string; env?: Record<string, string>; cwd?: string; }
export interface RunResponse { exit_code: number; stdout: string; stderr: string; }
export interface RunCommandContext { sandbox: Sandbox; }
export type RunCommandHandler = (req: RunRequest, ctx: RunCommandContext) => Promise<RunResponse>;

export interface SandboxOptions {
  // ... existing ...
  /**
   * Host-registered handler for guest-issued host_run_command. The kernel's
   * host_run_command import handler delegates to this callback. The callback
   * must NOT re-enter PID 1's callExport (deadlock); the canonical
   * implementation spawns a fresh resident bash and invokes __run_command
   * once on it, then terminates. See spec §Resident Mode + §Kernel Surface.
   */
  runCommandHandler?: RunCommandHandler;
}
```

Store the callback on the Sandbox instance:

```ts
class Sandbox {
  // ...
  readonly runCommandHandler: RunCommandHandler | undefined;
}
```

- [ ] **Step 4: Wire the kernel-imports `host_run_command` to the callback**

Modify `kernel-imports.ts:425-` (the existing `host_run_command` handler). Replace its current implementation with:

```ts
async host_run_command(reqPtr: number, reqLen: number, outPtr: number, outCap: number): Promise<number> {
  const handler = opts.runCommandHandler;
  if (!handler) {
    return writeJson(memoryRef.current!, { error: 'no runCommandHandler registered' }, outPtr, outCap);
  }
  const reqJson = readString(memoryRef.current!, reqPtr, reqLen);
  const req = JSON.parse(reqJson) as RunRequest;
  // Inject sandbox into the handler context so the handler can spawn
  // fresh processes without holding a closure over the kernel internals.
  const resp = await handler(req, { sandbox: opts.sandbox });
  return writeJson(memoryRef.current!, resp, outPtr, outCap);
},
```

Pass `runCommandHandler` through `KernelImportsOptions` so `createKernelImports` receives it. Threading it through requires extending `KernelImportsOptions`:

```ts
export interface KernelImportsOptions {
  // ... existing ...
  runCommandHandler?: RunCommandHandler;
}
```

In `Sandbox.buildKernelImports`, pass `runCommandHandler: this.runCommandHandler`.

- [ ] **Step 5: Run the test**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/run-command-handler.test.ts
```

Expected: first test PASS (custom handler invoked); second test PASS (kernel error when no handler).

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/orchestrator/src/host-imports/kernel-imports.ts packages/orchestrator/src/__tests__/run-command-handler.test.ts
git commit -m "feat(kernel): host_run_command delegates to registered runCommandHandler"
```

### Task 4.2: bash-dispatch + bash-host-imports modules in `sdk-server`

**Files:**
- Create: `packages/sdk-server/src/bash-dispatch.ts`
- Create: `packages/sdk-server/src/bash-host-imports.ts`
- Test: `packages/sdk-server/src/bash-dispatch.test.ts` (new)

- [ ] **Step 1: Write the failing test for bash-dispatch**

Create `packages/sdk-server/src/bash-dispatch.test.ts`:

```ts
import { assertEquals, assert } from 'jsr:@std/assert';
import { Sandbox } from '@codepod/sandbox';
import { runCommand, makeRunCommandHandler } from './bash-dispatch.ts';

Deno.test('bashDispatch.runCommand executes a command via PID 1', async () => {
  const sb = await Sandbox.create({
    bootArgv: ['/bin/bash'],
    runCommandHandler: makeRunCommandHandler(/* spawn helper */),
  });
  try {
    const r = await runCommand(sb, 'echo hello');
    assertEquals(r.exit_code, 0);
    assertEquals(r.stdout.trim(), 'hello');
  } finally {
    await sb.destroy();
  }
});

Deno.test('bashDispatch handler spawns fresh resident bash, not PID 1', async () => {
  let pid1Calls = 0;
  let extraSpawnCount = 0;
  // Wrap sandbox.spawn to count fresh bash invocations.
  // ... (implementation-specific; verify in PR4 review)
  const sb = await Sandbox.create({
    bootArgv: ['/bin/bash'],
    runCommandHandler: makeRunCommandHandler({
      onFreshSpawn: () => extraSpawnCount++,
    }),
  });
  try {
    // Trigger host_run_command via Python subprocess.
    const r = await runCommand(sb, 'python3 -c "import _codepod; print(_codepod.run_command(\\"echo nested\\"))"');
    assertEquals(r.exit_code, 0);
    assert(extraSpawnCount >= 1, 'fresh bash should be spawned at least once');
  } finally {
    await sb.destroy();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno test -A --no-check packages/sdk-server/src/bash-dispatch.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `bash-dispatch.ts`**

Create `packages/sdk-server/src/bash-dispatch.ts`:

```ts
/**
 * Bash-specific dispatch for the user-facing run-command path.
 *
 * Two responsibilities:
 *   1. runCommand(sandbox, cmd) — wraps PID 1's __run_command export.
 *      Used by sdk-server's RPC handlers and any internal callers.
 *   2. makeRunCommandHandler() — produces the RunCommandHandler callback
 *      passed to Sandbox.create. Used to back guest-issued
 *      host_run_command (RustPython subprocess). Spawns a fresh resident
 *      bash per call to side-step PID 1's callExport queue (avoids the
 *      recursive deadlock — see kernel/userland-separation spec
 *      §Resident Mode).
 */

import type {
  Sandbox, RunCommandHandler, RunRequest, RunResponse,
} from '@codepod/sandbox';

export interface RunOpts { env?: Record<string, string>; cwd?: string; }
export interface RunResult { exit_code: number; stdout: string; stderr: string; }

/** User-facing run via PID 1 (the resident shell session). */
export async function runCommand(
  sandbox: Sandbox,
  cmd: string,
  opts?: RunOpts,
): Promise<RunResult> {
  const raw = await sandbox.process(1)!.callExport(
    '__run_command',
    JSON.stringify({ cmd, ...opts }),
  );
  return JSON.parse(raw as string) as RunResult;
}

/** Builds the runCommandHandler that backs guest-issued host_run_command.
 *  Spawns a fresh resident bash per call — must not reuse PID 1. */
export function makeRunCommandHandler(
  opts: { onFreshSpawn?: () => void } = {},
): RunCommandHandler {
  return async (req: RunRequest): Promise<RunResponse> => {
    // Implementation note: the handler closes over the Sandbox via a
    // setter exposed by the kernel after construction. Sandbox.create
    // calls handler(req) with `this` bound to the sandbox; the handler
    // then has sandbox.spawn available.
    // Concretely: the kernel passes the sandbox in to the handler as
    // part of the RunRequest envelope, OR handler is wrapped at
    // registration-time. Pick at implementation; treat as injected here.
    const sb: Sandbox = (req as RunRequest & { __sandbox?: Sandbox }).__sandbox!;
    if (!sb) throw new Error('runCommandHandler invoked without sandbox binding');

    opts.onFreshSpawn?.();
    const child = await sb.spawn(['/bin/bash'], {
      mode: 'resident',
      env: req.env,
      cwd: req.cwd,
    });
    try {
      const raw = await child.callExport(
        '__run_command',
        JSON.stringify({ cmd: req.cmd }),
      );
      const r = JSON.parse(raw as string) as RunResult;
      return { exit_code: r.exit_code, stdout: r.stdout, stderr: r.stderr };
    } finally {
      await child.terminate();
    }
  };
}
```

NOTE on sandbox-binding: the kernel needs to inject the live `Sandbox` into the handler invocation context. Two reasonable shapes:

- **(a)** kernel calls `handler(req, { sandbox })`; handler reads sandbox from the second arg.
- **(b)** kernel wraps the user-supplied handler at registration time:
  ```ts
  this.runCommandHandler = (req) => userHandler({ ...req, __sandbox: this });
  ```

Pick (a) — it's cleaner. Update `RunCommandHandler` type accordingly:

```ts
export type RunCommandHandler = (req: RunRequest, ctx: { sandbox: Sandbox }) => Promise<RunResponse>;
```

The dispatch handler then becomes:

```ts
return async (req, { sandbox }) => {
  // ... uses sandbox.spawn ...
};
```

- [ ] **Step 4: Implement `bash-host-imports.ts`**

Create `packages/sdk-server/src/bash-host-imports.ts`:

```ts
/**
 * Shell-legacy host imports — the wider import surface the bash binary
 * depends on today (host_stat, host_read_file, host_write_file,
 * host_readdir, host_mkdir, host_remove, host_chmod, host_glob,
 * host_rename, host_readlink, host_register_tool, host_has_tool,
 * host_time).
 *
 * These were inside `packages/orchestrator/src/host-imports/shell-imports.ts`
 * pre-PR4. They violate the kernel boundary (naming test) so they live
 * with the host server, alongside bash-dispatch. They are merged into
 * the boot process's import object via Sandbox.create({ bootImports }).
 *
 * Long-term these should disappear: the shell binary should be rebuilt
 * to use WASI Preview 1 (fd_read, path_open, …) and host_spawn instead.
 * That migration is a separate userland effort.
 */

import type { KernelApi } from '@codepod/sandbox';

export function bashBootImports(api: KernelApi): Record<string, WebAssembly.ImportValue> {
  // Each handler below is a mechanical port from the pre-PR3
  // `packages/orchestrator/src/host-imports/shell-imports.ts`. The substitution
  // pattern is identical for every entry:
  //
  //   - readString(memoryRef.current!, ptr, len) → api.memory.readString(ptr, len)
  //   - writeBytes(memoryRef.current!, ...)      → api.memory.writeBytes(...)
  //   - writeJson(memoryRef.current!, ...)       → api.memory.writeJson(...)
  //   - vfs.X(...)                               → api.vfs.X(...)
  //   - processManager.X(...)                    → api.processManager.X(...)
  //
  // The 13 handlers and their pre-PR3 source line ranges (read from the
  // pre-PR3 file before deletion):
  //
  //   host_stat           — shell-imports.ts handler that wraps vfs.stat
  //   host_read_file      — wraps vfs.readFile
  //   host_write_file     — wraps vfs.writeFile (mode-aware)
  //   host_readdir        — wraps vfs.readdir; serializes DirEntry[]
  //   host_mkdir          — wraps vfs.mkdir
  //   host_remove         — wraps vfs.unlink/rmdir; recursive flag
  //   host_chmod          — wraps vfs.chmod
  //   host_glob           — walks vfs via globToRegExp + walkVfs helpers
  //                         (the helpers also live in pre-PR3 shell-imports.ts;
  //                         move them into this file as private helpers)
  //   host_rename         — wraps vfs.rename
  //   host_readlink       — wraps vfs.readlink
  //   host_register_tool  — wraps processManager.registerTool
  //   host_has_tool       — wraps processManager.hasTool
  //   host_time           — wraps api.time.now()
  //
  // Three example bodies shown here verbatim. Use them as templates for the
  // remaining ten — every body follows the same shape.

  return {
    host_stat: (pathPtr, pathLen, outPtr, outCap) => {
      const path = api.memory.readString(pathPtr, pathLen);
      try {
        const st = api.vfs.stat(path);
        return api.memory.writeJson({ kind: st.kind, mode: st.mode, size: st.size }, outPtr, outCap);
      } catch { return -1; }
    },

    host_read_file: (pathPtr, pathLen, outPtr, outCap) => {
      const path = api.memory.readString(pathPtr, pathLen);
      try {
        const bytes = api.vfs.readFile(path);
        return api.memory.writeBytes(bytes, outPtr, outCap);
      } catch { return -1; }
    },

    host_glob: (patternPtr, patternLen, outPtr, outCap) => {
      const pattern = api.memory.readString(patternPtr, patternLen);
      // Reuse the globToRegExp / globBaseDir / walkVfs / globMatch helpers
      // copied from pre-PR3 shell-imports.ts (declared as module-private
      // functions in this file). Their signatures and bodies are unchanged.
      const matches = globMatch(api.vfs, pattern);
      return api.memory.writeJson({ matches }, outPtr, outCap);
    },

    host_register_tool: (namePtr, nameLen, kindPtr, kindLen) => {
      const name = api.memory.readString(namePtr, nameLen);
      const kind = api.memory.readString(kindPtr, kindLen);
      api.processManager.registerTool(name, { kind });
      return 0;
    },

    host_has_tool: (namePtr, nameLen) => {
      const name = api.memory.readString(namePtr, nameLen);
      return api.processManager.hasTool(name) ? 1 : 0;
    },

    host_time: () => api.time.now(),

    // The remaining 7 handlers (host_write_file, host_readdir, host_mkdir,
    // host_remove, host_chmod, host_rename, host_readlink) follow the
    // same template: readString for paths, call api.vfs.X(...), return 0 on
    // success or -1 on error. Copy each body from the pre-PR3 file with the
    // four-line substitution rule above.
  };
}

// Move the glob helpers (globToRegExp, globBaseDir, walkVfs, globMatch) here
// as module-private functions, copied verbatim from pre-PR3 shell-imports.ts.
// Their inputs need to retarget `vfs` parameter from `VfsLike` to the same
// `VfsLike` exposed by `KernelApi` — types are identical, no changes inside.
```

The implementer should checkout the pre-PR3 commit (the commit immediately before PR3's deletion of `shell-imports.ts`) to read the original handler bodies, then copy each handler verbatim into `bash-host-imports.ts` with the four-line substitution pattern.

- [ ] **Step 5: Add `KernelApi` to the kernel's public exports**

Modify `packages/orchestrator/src/index.ts` to export `KernelApi`. Add the type definition in `packages/orchestrator/src/kernel-api.ts` (new):

```ts
import type { VfsLike } from './vfs/vfs-like.ts';
import type { ProcessManager } from './process/manager.ts';

export interface KernelApi {
  vfs: VfsLike;
  processManager: {
    registerTool(name: string, impl: unknown): void;
    hasTool(name: string): boolean;
    spawn(req: unknown): Promise<unknown>;
    listProcesses(): unknown[];
  };
  time: { now(): number; monotonic(): number; };
  memory: {
    readString(ptr: number, len: number): string;
    readBytes(ptr: number, len: number): Uint8Array;
    writeString(s: string, outPtr: number, outCap: number): number;
    writeBytes(b: Uint8Array, outPtr: number, outCap: number): number;
    writeJson(obj: unknown, outPtr: number, outCap: number): number;
  };
}
```

The `memory` handle is a late-bound proxy: calling its methods synchronously inside `bootImports` is an error; calling them from inside import handlers (post-instantiation) works. Implement by keeping a `memoryRef: { current?: WebAssembly.Memory }` closure that throws if `current` is undefined. The kernel sets `memoryRef.current = instance.exports.memory` immediately after `WebAssembly.instantiate` returns, before `_start`.

- [ ] **Step 6: Run the bash-dispatch test**

```bash
deno test -A --no-check packages/sdk-server/src/bash-dispatch.test.ts
```

Expected: PASS — both tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-server/src/bash-dispatch.ts packages/sdk-server/src/bash-host-imports.ts packages/sdk-server/src/bash-dispatch.test.ts packages/orchestrator/src/kernel-api.ts packages/orchestrator/src/index.ts
git commit -m "feat(sdk-server): add bash-dispatch + bash-host-imports modules"
```

### Task 4.3: mcp-server bash-dispatch + bash-host-imports

**Files:**
- Create: `packages/mcp-server/src/bash-dispatch.ts`
- Create: `packages/mcp-server/src/bash-host-imports.ts`

- [ ] **Step 1: Copy the sdk-server modules verbatim**

Both files are near-duplicates of the sdk-server versions. Copy them and adjust imports/paths if there are package-specific differences.

```bash
cp packages/sdk-server/src/bash-dispatch.ts packages/mcp-server/src/bash-dispatch.ts
cp packages/sdk-server/src/bash-host-imports.ts packages/mcp-server/src/bash-host-imports.ts
```

If `mcp-server` runs in Node and `sdk-server` runs in Deno with different module-resolution conventions, adjust the `@codepod/sandbox` import path to match.

- [ ] **Step 2: Update `packages/mcp-server/src/index.ts:282`**

The current `run_command` MCP tool calls `sandbox.run(cmd)`. Change it to:

```ts
import { runCommand, makeRunCommandHandler } from './bash-dispatch.ts';
import { bashBootImports } from './bash-host-imports.ts';

// At sandbox creation:
const sandbox = await Sandbox.create({
  bootArgv: ['/bin/bash'],
  bootImports: (api) => bashBootImports(api),
  runCommandHandler: makeRunCommandHandler(),
  // ... existing options ...
});

// In the run_command MCP tool handler:
const result = await runCommand(sandbox, cmd, opts);
```

- [ ] **Step 3: Run mcp-server tests**

```bash
deno test -A --no-check packages/mcp-server/src/*.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/src/bash-dispatch.ts packages/mcp-server/src/bash-host-imports.ts packages/mcp-server/src/index.ts
git commit -m "feat(mcp-server): add bash-dispatch + bash-host-imports modules; switch run_command tool"
```

### Task 4.4: sdk-server dispatcher rewire (`sb.run`, `shell.history.*`)

**Files:**
- Modify: `packages/sdk-server/src/dispatcher.ts`

- [ ] **Step 1: Update `sandbox.run` RPC handler**

In `dispatcher.ts:218`, replace the `sb.run(cmd)` call with `runCommand(sb, cmd)`:

```ts
import { runCommand, makeRunCommandHandler } from './bash-dispatch.ts';
import { bashBootImports } from './bash-host-imports.ts';

case 'sandbox.run': {
  const result = await runCommand(sb, params.cmd, params);
  return result;
}
```

- [ ] **Step 2: Wire bashBootImports + makeRunCommandHandler at sandbox creation**

In whichever dispatcher method handles `sandbox.create` (around line 100-140), add:

```ts
case 'sandbox.create': {
  const sb = await Sandbox.create({
    bootArgv: ['/bin/bash'],
    bootImports: (api) => bashBootImports(api),
    runCommandHandler: makeRunCommandHandler(),
    // ... existing options pass-through ...
  });
  // ...
}
```

- [ ] **Step 3: Remove `shell.history.list` and `shell.history.clear` cases**

In `dispatcher.ts:135` and `:137` (the `case 'shell.history.list':` and `case 'shell.history.clear':` blocks), delete the cases entirely. The default case (or the explicit method-not-found path) will return a JSON-RPC error to any caller, which is the desired behavior.

```ts
// Before:
case 'shell.history.list':
  return sb.getHistory();
case 'shell.history.clear':
  sb.clearHistory();
  return null;

// After: lines deleted; default case returns method-not-found.
```

- [ ] **Step 4: Run sdk-server tests**

```bash
deno test -A --no-check packages/sdk-server/src/*.test.ts
```

Expected: PASS — except any tests that explicitly exercise `shell.history.*`. Those tests must be removed or updated to assert the method-not-found response.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-server/src/dispatcher.ts packages/sdk-server/src/*.test.ts
git commit -m "feat(sdk-server): switch run RPC to bashDispatch; remove shell.history.*"
```

### Task 4.5: Rewire intra-orchestrator consumers

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts` (delete `Sandbox.run`, `getHistory`, `clearHistory`; rewire `fork()`)
- Modify: `packages/orchestrator/src/cli.ts` (replace `ShellInstance.create` with bootArgv pathway)
- Modify: `packages/orchestrator/src/index.ts` (drop `ShellInstance` re-export)
- Modify: `packages/orchestrator/src/execution/execution-worker.ts`
- Modify: `packages/orchestrator/src/execution/worker-executor.ts`

- [ ] **Step 1: Delete `Sandbox.run`, `getHistory`, `clearHistory`**

In `packages/orchestrator/src/sandbox.ts`, locate the three methods (lines 537, 719, 725) and delete them. Also delete the `runner` field if it's no longer used elsewhere, and the `StreamCallbacks`/`HistoryEntry` type imports/exports if they become unused.

- [ ] **Step 2: Rewire `Sandbox.fork()` to use the loader**

`Sandbox.fork()` currently calls `ShellInstance.create(childVfs, ...)` (line 828). Replace with:

```ts
async fork(): Promise<Sandbox> {
  // ... existing VFS clone, mgr setup, /bin/bash install (PR1) ...
  const child = new Sandbox(/* args */);
  child.bootArgvField = this.bootArgvField; // inherit
  child.runCommandHandler = this.runCommandHandler; // inherit
  child.bootImports = this.bootImports; // inherit
  await child.bootPid1();
  return child;
}

private async bootPid1(): Promise<void> {
  this.pid1 = await loadProcess(this, {
    argv: this.bootArgvField,
    mode: 'resident',
    extraCodepodImports: this.bootImports?.(this.kernelApi()),
  });
}
```

`Sandbox.create` is updated similarly: instead of calling `ShellInstance.create`, build the sandbox object, then `await sandbox.bootPid1()`.

- [ ] **Step 3: Update `cli.ts:48`**

Replace the `ShellInstance.create(vfs, mgr, adapter, SHELL_EXEC_WASM)` call with:

```ts
const sb = await Sandbox.create({
  bootArgv: ['/bin/bash'],
  bootImports: (api) => bashBootImports(api),
  runCommandHandler: makeRunCommandHandler(),
  // ... existing options ...
});
// CLI then uses sb.process(1).callExport for command execution, OR
// imports `runCommand` from the appropriate bash-dispatch module.
```

If `cli.ts` is itself part of the kernel package and shouldn't import from sdk-server, copy the bash-dispatch wrapper inline (it's ~10 lines) or move CLI to a host package. Easiest: move `cli.ts` to its own bin package, or inline the `__run_command` call directly.

- [ ] **Step 4: Update `index.ts`**

Remove `export { ShellInstance } from './shell/shell-instance.js'` from `packages/orchestrator/src/index.ts:5`. Replace with the new generic exports if any consumer relied on `ShellInstance`'s public type.

- [ ] **Step 5: Rewrite worker bridge (`execution-worker.ts`, `worker-executor.ts`)**

Both files import `ShellInstance` directly. The worker-bridge's job is to spawn a process inside the sandbox and route its I/O via a Worker. Rewrite to use the generic `Process` API instead:

```ts
// In execution-worker.ts (sketch):
import { Sandbox } from '../sandbox.ts';
import { loadProcess } from '../process/loader.ts';

// Where ShellInstance.create was called:
const proc = await loadProcess(sandbox, {
  argv: ['/bin/bash'],  // or whatever the worker spawns
  mode: 'resident',
});
// Where shell.run(cmd) was called:
const raw = await proc.callExport('__run_command', JSON.stringify({ cmd }));
const result = JSON.parse(raw as string);
```

If the worker bridge currently relies on `ShellInstance`'s history or stream callbacks, that goes — the worker is now pure process execution per the spec (no kernel→host inversion, no bash-protocol awareness in the kernel package).

- [ ] **Step 6: Run all tests**

```bash
deno test -A --no-check packages/orchestrator/src/**/*.test.ts packages/orchestrator/src/pool/__tests__/*.test.ts packages/sdk-server/src/*.test.ts packages/mcp-server/src/*.test.ts
```

Expected: PASS — all in-tree tests green. guest-compat pthread canary still asserts counter == 40000.

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/orchestrator/src/cli.ts packages/orchestrator/src/index.ts packages/orchestrator/src/execution/execution-worker.ts packages/orchestrator/src/execution/worker-executor.ts
git commit -m "refactor(kernel): rewire all ShellInstance consumers to generic Process API"
```

### Task 4.6: Delete `shell/` directory

**Files:**
- Delete: `packages/orchestrator/src/shell/` (entire directory)

- [ ] **Step 1: Verify no remaining imports of shell-instance or shell-imports**

```bash
grep -r "ShellInstance\|shell-instance\|shell/shell-imports" packages/orchestrator/src/ packages/sdk-server/ packages/mcp-server/
```

Expected: only matches inside `packages/orchestrator/src/shell/` itself (which is about to be deleted) and inside test fixtures. If matches appear elsewhere, fix them before proceeding.

- [ ] **Step 2: Delete the directory**

```bash
git rm -r packages/orchestrator/src/shell
```

- [ ] **Step 3: Move shell-conformance tests that target `/bin/bash`**

If any tests in `shell/__tests__/` exercised `/bin/bash` end-to-end (vs. testing `ShellInstance` directly), move them to `packages/orchestrator/src/__tests__/bash-conformance/`. Update them to use `runCommand` from the appropriate bash-dispatch module instead of calling `shell.run` directly.

- [ ] **Step 4: Delete `shell-imports.ts` (now empty post-PR3 carve-out)**

```bash
git rm packages/orchestrator/src/host-imports/shell-imports.ts
```

If any kernel code still imports `createShellImports`, audit and remove. The shell-legacy imports now live in `packages/sdk-server/src/bash-host-imports.ts` and `packages/mcp-server/src/bash-host-imports.ts`.

- [ ] **Step 5: Run all tests**

```bash
deno test -A --no-check packages/orchestrator/src/**/*.test.ts packages/orchestrator/src/pool/__tests__/*.test.ts packages/sdk-server/src/*.test.ts packages/mcp-server/src/*.test.ts
```

Expected: PASS — including bash conformance tests now running through `runCommand`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(kernel): delete shell/ directory and shell-imports.ts"
```

### Task 4.7: PR4 verification + PR

- [ ] **Step 1: End-to-end host_run_command callback test**

Add or extend `run-command-handler.test.ts` to specifically assert:

```ts
Deno.test('host_run_command callback spawns fresh resident bash, not PID 1', async () => {
  let pid1CallCount = 0;
  let freshSpawnCount = 0;
  // Wrap sandbox.process(1).callExport via instrumentation hook;
  // wrap sandbox.spawn similarly. Implementation-specific.
  const sb = await Sandbox.create({
    bootArgv: ['/bin/bash'],
    bootImports: (api) => bashBootImports(api),
    runCommandHandler: makeRunCommandHandler({
      onPid1Call: () => pid1CallCount++,
      onFreshSpawn: () => freshSpawnCount++,
    }),
  });
  try {
    // Trigger PID 1 mid-call (outer) and an inner host_run_command.
    const r = await runCommand(
      sb,
      'python3 -c "import _codepod; print(_codepod.run_command(\\"echo nested\\"))"',
    );
    assertEquals(r.exit_code, 0);
    assert(r.stdout.includes('nested'));
    assertEquals(pid1CallCount, 1, 'outer __run_command on PID 1');
    assert(freshSpawnCount >= 1, 'inner host_run_command should spawn fresh bash');
  } finally {
    await sb.destroy();
  }
});

Deno.test('recursive host_run_command does not deadlock', async () => {
  const sb = await Sandbox.create({
    bootArgv: ['/bin/bash'],
    bootImports: (api) => bashBootImports(api),
    runCommandHandler: makeRunCommandHandler(),
  });
  try {
    // Outer __run_command (PID 1 in flight) → Python → inner host_run_command.
    // If the FIFO queue were misused, this would hang. With fresh spawns,
    // it must complete in well under the test timeout.
    const r = await Promise.race([
      runCommand(sb, 'python3 -c "import _codepod; print(_codepod.run_command(\\"echo ok\\"))"'),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock detected')), 30_000)),
    ]);
    assertEquals(r.exit_code, 0);
  } finally {
    await sb.destroy();
  }
});
```

- [ ] **Step 2: Run the verification suite**

```bash
deno test -A --no-check packages/orchestrator/src/**/*.test.ts packages/orchestrator/src/pool/__tests__/*.test.ts packages/sdk-server/src/*.test.ts packages/mcp-server/src/*.test.ts
```

Expected: PASS — including the new deadlock-canary tests.

- [ ] **Step 3: Run guest-compat tests**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/guest-compat.test.ts
```

Expected: PASS — pthread canary 4-thread mutex stress still asserts counter == 40000.

- [ ] **Step 4: Run python-sdk end-to-end smoke test**

```bash
cd packages/python-sdk && pip install -e . && pytest -k "test_basic_run_command"
```

Expected: PASS — `Sandbox()`, `sb.commands.run("ls /")` round-trip works.

- [ ] **Step 5: Push and open the PR**

```bash
git push
gh pr create --draft --title "PR4: Rewire ShellInstance consumers; move bash-dispatch out; delete shell/" --body "$(cat <<'EOF'
## Summary
Substantive PR. Moves bash-specific dispatch + shell-legacy imports out of the kernel package into sdk-server and mcp-server. Adds runCommandHandler callback (fresh resident bash per call, side-stepping PID 1's queue). Rewires sandbox.ts, cli.ts, index.ts, and the execution worker bridge to the generic Process API. Deletes shell/ directory.

## Test plan
- [ ] run-command-handler tests (callback delegation, fresh-spawn assertion, deadlock canary).
- [ ] bash-dispatch tests (sdk-server + mcp-server).
- [ ] All existing shell conformance tests rewired and passing.
- [ ] guest-compat pthread canary still green.
- [ ] mcp-server + sdk-server smoke tests.
- [ ] python-sdk end-to-end (Sandbox, sb.commands.run).
- [ ] No remaining `ShellInstance` or `shell/shell-imports` imports (grep clean).

Spec: docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md
EOF
)"
```

---

## PR5 — Rename `orchestrator/` → `kernel/`

**Goal:** Pure rename. No behavior change. After PR4 lands, the directory contents are clean kernel; this PR commits to the new name.

**Files:**
- Move: `packages/orchestrator/` → `packages/kernel/`
- Modify: `packages/kernel/package.json` (name → `@codepod/kernel`)
- Modify: every consumer's import path
- Modify: `scripts/build-sdk-server.sh`, `scripts/build-mcp.sh`
- Modify: `CLAUDE.md`

### Task 5.1: Move directory + update package name

- [ ] **Step 1: Verify clean tree**

```bash
git status
```

Expected: clean (PR4 merged, working dir matches HEAD).

- [ ] **Step 2: Rename directory**

```bash
git mv packages/orchestrator packages/kernel
```

- [ ] **Step 3: Update `package.json`**

Modify `packages/kernel/package.json`:

```json
{
  "name": "@codepod/kernel",
  ...
}
```

- [ ] **Step 4: Update all import paths**

```bash
# Find all imports of @codepod/sandbox or relative paths to ../orchestrator
grep -rln "@codepod/sandbox\|packages/orchestrator" packages/ scripts/ | grep -v node_modules
```

For each file in the result:
- Replace `@codepod/sandbox` with `@codepod/kernel` in import statements.
- Replace any relative path `../orchestrator/` with `../kernel/`.

A safe sed pass (review the diff before committing):

```bash
git grep -l '@codepod/sandbox' | xargs sed -i.bak 's|@codepod/sandbox|@codepod/kernel|g'
git grep -l 'packages/orchestrator' | xargs sed -i.bak 's|packages/orchestrator|packages/kernel|g'
find . -name "*.bak" -delete
```

- [ ] **Step 5: Update build scripts**

In `scripts/build-sdk-server.sh` and `scripts/build-mcp.sh`, replace any `packages/orchestrator` path references with `packages/kernel`. Also any references to the old npm name.

- [ ] **Step 6: Update `CLAUDE.md`**

In the Architecture section, change:

```
- **`packages/orchestrator/`** — Core sandbox: VFS, shell executor, process manager, networking, sandbox pool
```

to:

```
- **`packages/kernel/`** — Core sandbox kernel: VFS, process manager, host imports, networking, pool. (Renamed from `packages/orchestrator/` in the kernel/userland separation refactor — see `docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md`.)
```

- [ ] **Step 7: Build artifacts from scratch**

```bash
bash scripts/build-sdk-server.sh
bash scripts/build-mcp.sh
```

Expected: both succeed; resulting binaries (`dist/codepod-server`, `dist/codepod-mcp`) work at runtime.

- [ ] **Step 8: Run all tests**

```bash
deno test -A --no-check packages/kernel/src/**/*.test.ts packages/kernel/src/pool/__tests__/*.test.ts packages/sdk-server/src/*.test.ts packages/mcp-server/src/*.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(kernel): rename packages/orchestrator -> packages/kernel"
```

### Task 5.2: PR5 PR

- [ ] **Step 1: Push and open the PR**

```bash
git push
gh pr create --draft --title "PR5: Rename packages/orchestrator -> packages/kernel" --body "$(cat <<'EOF'
## Summary
Pure rename. After PR4's content cleanup, the directory holds a clean kernel; this PR commits to the new name. No behavior change.

## Test plan
- [ ] Build dist/codepod-server and dist/codepod-mcp from scratch.
- [ ] All unit tests pass.
- [ ] guest-compat tests pass.
- [ ] mcp-server + sdk-server smoke tests.
- [ ] python-sdk end-to-end.

Spec: docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md
EOF
)"
```

---

## PR6 — Documentation + Boundary Marker

**Goal:** Add `packages/kernel/README.md` documenting the boundary principle, the guest-facing imports, the host-facing API, and the deferred Python debt. Add comments on `host_extension_invoke` / `host_native_invoke`.

**Files:**
- Create: `packages/kernel/README.md`
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts` (comments on extension imports)

### Task 6.1: Kernel README

**Files:**
- Create: `packages/kernel/README.md`

- [ ] **Step 1: Write the README**

Create `packages/kernel/README.md`:

```markdown
# @codepod/kernel

The codepod kernel: a TypeScript library exposing a generic process+resource runtime for wasm guests. Embedded by `mcp-server`, `sdk-server`, and any other host that wants to instantiate codepod sandboxes.

## Boundary Principle

The kernel exposes **primitives**, not userland features.

Two-pronged test for "is this kernel?":

1. **Naming test.** A kernel symbol must name a primitive (`spawn`, `pipe`, `read_fd`, `mutex_lock`, `extension_invoke`). It must not name a userland feature (`run_command`, `shell_*`, `python_*`).
2. **Agnosticism test.** The kernel's behavior must not depend on which userland is running. Replacing bash with another binary at boot must require zero kernel changes.

The principle is **enforceable for new code**, **aspirational for legacy code**. Pre-existing Python-coupled debt (`python/`, `host_run_command`, `extension/codepod-ext-shim.ts`, `Sandbox.create()` Python shim install) clears with the planned CPython port. Touching those files in unrelated work does *not* obligate cleanup — see scope discipline in the kernel/userland separation spec.

## Guest-Facing Imports (`codepod::host_*`)

**Process:** `host_pipe`, `host_spawn`, `host_waitpid`, `host_waitpid_nohang`, `host_close_fd`, `host_getpid`, `host_getppid`, `host_kill`, `host_list_processes`.

**Fd I/O:** `host_read_fd`, `host_write_fd`, `host_dup`, `host_dup2`.

**Network:** `host_network_fetch`, `host_socket_connect`, `host_socket_send`, `host_socket_recv`, `host_socket_close`.

**Threading** (gated by `threadsBackend`): `host_thread_spawn/join/detach/self/yield`, `host_mutex_lock/unlock/trylock`, `host_cond_wait/signal/broadcast`.

**Extensions:** `host_extension_invoke`, `host_native_invoke`. Currently consumed by RustPython via the auto-create-virtual-command machinery (Python-coupled debt). New consumers should use the host-facing `kernel.registerExtension` API and the planned hostbridge userland design.

**Control flow:** `host_setjmp` (stub), `host_longjmp` (stub), `host_yield`.

**Deferred (Python-coupled):** `host_run_command`. Today its handler delegates to a host-registered `runCommandHandler` callback (provided via `Sandbox.create({ runCommandHandler })`); the canonical implementation in `bash-dispatch` spawns a fresh resident bash per call to avoid the recursive deadlock with PID 1's `callExport` queue.

Plus the standard WASI Preview 1 surface (`fd_read`, `fd_write`, `path_open`, …).

## Host-Facing TS API

**Sandbox lifecycle:**
- `Sandbox.create({ bootArgv, bootImports?, runCommandHandler?, ... })` — `bootArgv[0]` spawned as PID 1.
- `Sandbox.destroy()`, `Sandbox.fork()`, `Sandbox.snapshot()`, `Sandbox.restore()`.

**Process control (generic):**
- `sandbox.process(pid).callExport(name, args)` — JSPI/Asyncify-aware. Per-process FIFO. Recursive deadlock avoidance: see resident-mode contract in the spec.
- `sandbox.process(pid).fd(n).read/write` — generic fd I/O.
- `sandbox.process(pid).kill(sig)`, `.waitpid()`, `.exitCode`.
- `sandbox.spawn(argv, opts)` — host-side mirror of `host_spawn`.

**`KernelApi`** (passed to `bootImports`): `vfs`, `processManager`, `time`, `memory` (late-bound proxy). The only way userland host modules reach into kernel state — never imports kernel internals directly.

**Userland-protocol hook:**
- `bashDispatch.runCommand(sandbox, cmd)` lives in `sdk-server/src/bash-dispatch.ts` and `mcp-server/src/bash-dispatch.ts`. **Not in the kernel.** Encodes the bash `__run_command` JSON protocol; swap it out by writing a different host-side dispatch wrapper.

## What's NOT in the Kernel

- Bash binary (lives at `/bin/bash` in the sandbox VFS, installed at boot).
- The `__run_command` JSON protocol (lives in host-side bash-dispatch).
- Shell-legacy imports (`host_stat`, `host_register_tool`, `host_glob`, …) — live in `bash-host-imports` modules, supplied via `bootImports`.
- Shell history.

Everything above moved out in the kernel/userland separation refactor (PR1–PR6, 2026-04). See `docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md`.
```

- [ ] **Step 2: Add comments on extension imports**

In `packages/kernel/src/host-imports/kernel-imports.ts`, locate the `host_extension_invoke` and `host_native_invoke` declarations. Add a doc comment:

```ts
/**
 * host_extension_invoke / host_native_invoke — dynamic extension dispatch.
 *
 * Currently consumed by RustPython via the auto-create-virtual-command
 * machinery. That consumer is Python-coupled debt scheduled for removal
 * with the CPython port.
 *
 * The host-facing kernel.registerExtension(name, fn) API is the supported
 * surface for new consumers. The planned /bin/hostbridge userland wasm
 * (see kernel/userland separation spec, Open Questions) will be its first
 * non-RustPython consumer: argv[0] names the extension, body thunks to
 * host_extension_invoke.
 */
async host_extension_invoke(req: number, outPtr: number, outCap: number): Promise<number> {
  // ...
}
```

- [ ] **Step 3: Run docs link check (if any)**

Sanity-check that the markdown links resolve:

```bash
grep -E "\]\(\.\./|\]\(/" packages/kernel/README.md
```

Inspect each linked path manually.

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/README.md packages/kernel/src/host-imports/kernel-imports.ts
git commit -m "docs(kernel): add README + boundary principle marker on extension imports"
```

### Task 6.2: PR6 PR

- [ ] **Step 1: Push and open the PR**

```bash
git push
gh pr create --draft --title "PR6: Kernel README + boundary marker" --body "$(cat <<'EOF'
## Summary
Final PR in the series. Adds packages/kernel/README.md documenting the boundary principle, the guest-facing imports, the host-facing API, and the deferred Python debt. Adds comments on host_extension_invoke / host_native_invoke pointing to future hostbridge consumer.

## Test plan
- [ ] Markdown links resolve.
- [ ] No code changes; existing test suites still pass (regression check only).

Spec: docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md
EOF
)"
```

---

## Final Verification After All PRs Land

After PR1–PR6 are merged to `main`:

- [ ] `grep -r "ShellInstance\|orchestrator" packages/` — only matches inside conformance tests / fixtures, no production imports.
- [ ] `grep -r "shell-imports" packages/` — zero matches.
- [ ] `grep -r "@codepod/sandbox" packages/` — zero matches; `@codepod/kernel` everywhere instead.
- [ ] All unit tests pass.
- [ ] guest-compat pthread canary asserts counter == 40000.
- [ ] python-sdk round-trip succeeds (`Sandbox()`, `sb.commands.run("ls /")`).
- [ ] mcp-server + sdk-server build cleanly into `dist/codepod-server` and `dist/codepod-mcp`.
- [ ] `docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md`'s "Final Verification" item checklist (under §Migration Plan / Verification Per PR) green for the merged set.

## Rolling Back

Each PR is independently revertible. If a regression appears mid-series:

- **PR1 revert:** `/bin/bash` install removal. Safe; no other PR has shipped yet that *requires* it.
- **PR2 revert:** generic loader removed. `ShellInstance` resumes its full role. PR3 must not have shipped yet (PR3 depends on PR2's loader being callable).
- **PR3 revert:** import partition undone; `shell-imports.ts` restored. PR4 must not have shipped yet.
- **PR4 revert:** the substantive PR. Most failure-prone. Bisect into PR4a/PR4b at implementation time if needed.
- **PR5 revert:** `git revert` of the rename. Mechanical.
- **PR6 revert:** docs only; trivially safe.
