# Shared Wasm Module Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile immutable WebAssembly executable modules once per artifact digest and reuse the resulting `WebAssembly.Module` objects across sandbox instances.

**Architecture:** Module sharing is content-addressed and independent of path names. The kernel reads executable bytes from the VFS, computes a SHA-256 digest, asks a `WasmModuleCache` for a compiled module, then instantiates that module with per-process imports. Sharing a compiled module does not share linear memory, stacks, globals, tables, guest heap, file descriptors, process state, or environment.

**Tech Stack:** TypeScript, Deno tests, WebAssembly JS API, `packages/kernel/src/process/loader.ts`, `packages/kernel/src/process/manager.ts`, `packages/kernel/src/sandbox.ts`.

---

## Status

This plan covers compiled executable-module sharing only.

Layered VFS storage is separate and already handles where bytes live. This plan handles the memory/CPU cost of compiling those bytes after they are read.

This plan assumes the root-overlay/VFS base-root work has landed. If the checkout does not have `SandboxOptions.baseRoot` and `packages/kernel/src/__tests__/sandbox-base-root.test.ts`, first rebase onto the VFS base-root merge before implementing Task 4.

## Explicitly Deferred: Dynamic Linking

Do not implement dynamic libraries in this slice.

In Codepod, "dynamic library" should mean a real runtime-linked library model: dependencies resolved at load time, symbols linked automatically, relocation/base addresses handled, ABI/version mismatches reported explicitly, and tooling able to produce compatible artifacts. That likely requires major clang/rustc/toolchain work plus package-format decisions.

This plan intentionally does **not** add:

- `.so`/wasm-dylink support
- `dlopen`/`dlsym`
- symbol interposition
- relocation processing
- automatic dependency resolution
- shared memory/table dependency instantiation
- a custom Codepod linker

If a future port needs true dynamic linking, write a separate design spec for the actual wasm dynamic linking ABI or component-model path. Do not grow this cache plan into a linker.

## Current-State Notes

- The current package is `packages/kernel`; implementation must not use old package locations.
- `NodeAdapter` has a path-keyed static compile cache, but the generic process loader reads executable bytes from VFS and calls `WebAssembly.compile(bytes)` directly.
- Other execution paths still compile independently:
  - `ProcessManager.loadModule()` / registered tools
  - `ProcessManager.loadModuleFromSource()` / native package sources
  - `native-modules.ts`
  This plan starts with the generic loader and then wires process-manager paths where they share the same executable artifact model.
- `ProcessManager` already has a path/source-keyed `moduleCache: Map<string, WebAssembly.Module>` used by `spawnSync()`. Do not replace that field with the digest cache. The new digest cache field must use a distinct name, e.g. `wasmModuleCache`.
- `WebAssembly.Module` objects are runtime/agent objects. This cache is process-local to the current JS runtime. Worker backends and non-JS engines need their own equivalent cache or an explicit bridge later.
- Cache keys are content digests, not VFS paths. Two paths with identical bytes should compile once.
- Failed compilation must not poison the cache permanently. A rejected compile promise must be removed so a later retry can work.

## File Map

- Create `packages/kernel/src/process/module-cache.ts` — SHA-256 helper, digest-keyed cache interfaces, and default in-memory implementation.
- Create `packages/kernel/src/process/__tests__/module-cache.test.ts` — cache hit/miss, digest, and rejected-compile retry tests.
- Modify `packages/kernel/src/process/loader.ts` — compile VFS executable bytes through the cache.
- Modify `packages/kernel/src/process/__tests__/loader.test.ts` — loader compile deduplication tests.
- Modify `packages/kernel/src/process/manager.ts` — compile registered/preloaded tool modules through the same cache where bytes are available.
- Modify `packages/kernel/src/process/__tests__/process.test.ts` — process-manager compile deduplication tests.
- Modify `packages/kernel/src/sandbox.ts` — accept optional `moduleCache`, defaulting to process-wide cache.
- Modify `packages/kernel/src/index.ts` — export cache interfaces.

## Task 1: Digest-Keyed Module Cache

**Files:**
- Create: `packages/kernel/src/process/module-cache.ts`
- Test: `packages/kernel/src/process/__tests__/module-cache.test.ts`
- Modify: `packages/kernel/src/index.ts`

- [ ] **Step 1: Write failing cache tests**

Create `packages/kernel/src/process/__tests__/module-cache.test.ts`:

```ts
import { assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert@^1.0.19";
import { MemoryWasmModuleCache, sha256Hex } from "../module-cache.ts";

const emptyModule = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
]);

Deno.test("MemoryWasmModuleCache compiles once per digest", async () => {
  let calls = 0;
  const cache = new MemoryWasmModuleCache(async () => {
    calls++;
    return await WebAssembly.compile(emptyModule);
  });

  const first = await cache.getOrCompile("abc", emptyModule);
  const second = await cache.getOrCompile("abc", emptyModule);

  assertStrictEquals(first, second);
  assertEquals(calls, 1);
  assertEquals(cache.stats(), { modules: 1 });
});

Deno.test("MemoryWasmModuleCache uses digest rather than object identity", async () => {
  const cache = new MemoryWasmModuleCache();
  const first = await cache.getOrCompile("digest", emptyModule);
  const second = await cache.getOrCompile("digest", new Uint8Array(emptyModule));
  assertStrictEquals(first, second);
});

Deno.test("MemoryWasmModuleCache retries after a rejected compile", async () => {
  let calls = 0;
  const cache = new MemoryWasmModuleCache(async () => {
    calls++;
    if (calls === 1) throw new Error("compile failed");
    return await WebAssembly.compile(emptyModule);
  });

  await assertRejects(
    () => cache.getOrCompile("retry", emptyModule),
    Error,
    "compile failed",
  );
  await cache.getOrCompile("retry", emptyModule);

  assertEquals(calls, 2);
  assertEquals(cache.stats(), { modules: 1 });
});

Deno.test("sha256Hex computes stable SHA-256 hex digests", async () => {
  assertEquals(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/process/__tests__/module-cache.test.ts
```

Expected: FAIL because `module-cache.ts` does not exist.

- [ ] **Step 3: Implement the cache**

Create `packages/kernel/src/process/module-cache.ts`:

```ts
export interface WasmModuleCacheStats {
  modules: number;
}

export interface WasmModuleCache {
  getOrCompile(digest: string, bytes: Uint8Array): Promise<WebAssembly.Module>;
  stats(): WasmModuleCacheStats;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

export class MemoryWasmModuleCache implements WasmModuleCache {
  private readonly modules = new Map<string, Promise<WebAssembly.Module>>();

  constructor(
    private readonly compile: (bytes: Uint8Array) => Promise<WebAssembly.Module> =
      (bytes) => WebAssembly.compile(bytes as BufferSource),
  ) {}

  getOrCompile(digest: string, bytes: Uint8Array): Promise<WebAssembly.Module> {
    const existing = this.modules.get(digest);
    if (existing) return existing;

    const compiled = this.compile(new Uint8Array(bytes));
    this.modules.set(digest, compiled);
    compiled.catch(() => {
      if (this.modules.get(digest) === compiled) {
        this.modules.delete(digest);
      }
    });
    return compiled;
  }

  stats(): WasmModuleCacheStats {
    return { modules: this.modules.size };
  }
}

export const defaultWasmModuleCache = new MemoryWasmModuleCache();
```

- [ ] **Step 4: Export the API**

Add to `packages/kernel/src/index.ts`:

```ts
export type { WasmModuleCache, WasmModuleCacheStats } from "./process/module-cache.js";
export { MemoryWasmModuleCache, defaultWasmModuleCache, sha256Hex } from "./process/module-cache.js";
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/process/__tests__/module-cache.test.ts
git add packages/kernel/src/process/module-cache.ts packages/kernel/src/process/__tests__/module-cache.test.ts packages/kernel/src/index.ts
git commit -m "feat(process): add wasm module cache"
```

Expected: tests pass and commit succeeds.

## Task 2: Process Loader Uses Module Cache

**Files:**
- Modify: `packages/kernel/src/process/loader.ts`
- Modify: `packages/kernel/src/sandbox.ts`
- Test: `packages/kernel/src/process/__tests__/loader.test.ts`

- [ ] **Step 1: Add loader cache test**

Modify the existing `makeLoaderContext()` helper in `packages/kernel/src/process/__tests__/loader.test.ts` to accept `Partial<LoaderContext>` overrides and merge them into the returned context.

Add:

```ts
Deno.test("loadProcess compiles identical executable bytes once through the module cache", async () => {
  let compiles = 0;
  const moduleCache = new MemoryWasmModuleCache(async (bytes) => {
    compiles++;
    return await WebAssembly.compile(bytes as BufferSource);
  });

  const ctx = await makeLoaderContext({ moduleCache });

  const first = await loadProcess(ctx, { argv: ["/bin/true"], mode: "cli" });
  const second = await loadProcess(ctx, { argv: ["/bin/true"], mode: "cli" });

  assertEquals(first.exitCode, 0);
  assertEquals(second.exitCode, 0);
  assertEquals(compiles, 1);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/process/__tests__/loader.test.ts
```

Expected: FAIL because `LoaderContext` does not accept `moduleCache`.

- [ ] **Step 3: Wire cache into `LoaderContext`**

In `packages/kernel/src/process/loader.ts`, import:

```ts
import { defaultWasmModuleCache, sha256Hex, type WasmModuleCache } from "./module-cache.js";
```

Extend `LoaderContext`:

```ts
moduleCache?: WasmModuleCache;
```

Replace:

```ts
const module = await WebAssembly.compile(bytes as BufferSource);
```

with:

```ts
const digest = await sha256Hex(bytes);
const module = await (ctx.moduleCache ?? defaultWasmModuleCache).getOrCompile(digest, bytes);
```

- [ ] **Step 4: Give each sandbox an explicit cache option**

In `packages/kernel/src/sandbox.ts`, import:

```ts
import { defaultWasmModuleCache, type WasmModuleCache } from "./process/module-cache.js";
```

Extend `SandboxOptions`:

```ts
/** Optional wasm module cache. Defaults to the process-wide cache. */
moduleCache?: WasmModuleCache;
```

Store the selected cache on the `Sandbox` instance, not only inside `create()`.

Add to `SandboxParts` and the `Sandbox` class:

```ts
moduleCache: WasmModuleCache;
```

In the constructor:

```ts
this.moduleCache = parts.moduleCache;
```

When constructing the root sandbox:

```ts
const moduleCache = options.moduleCache ?? defaultWasmModuleCache;
```

Pass `moduleCache` into:

- the root `ProcessManager`
- root `SandboxParts`
- every root loader context
- `spawn()` loader contexts created from the instance
- `fork()` child `ProcessManager`
- fork child loader contexts
- fork child `SandboxParts`

When building the root loader context inside `Sandbox.create()`, pass the local `moduleCache` variable:

```ts
moduleCache,
```

When building loader contexts from instance methods such as `spawn()` and `fork()`, pass:

```ts
moduleCache: this.moduleCache,
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/process/__tests__/module-cache.test.ts packages/kernel/src/process/__tests__/loader.test.ts
git add packages/kernel/src/process/loader.ts packages/kernel/src/sandbox.ts packages/kernel/src/process/__tests__/loader.test.ts
git commit -m "feat(process): compile vfs executables through module cache"
```

Expected: tests pass and commit succeeds.

## Task 3: ProcessManager Uses Digest Cache Behind Its Path Cache

**Files:**
- Modify: `packages/kernel/src/process/manager.ts`
- Modify: `packages/kernel/src/sandbox.ts`
- Test: `packages/kernel/src/process/__tests__/process.test.ts`

- [ ] **Step 1: Add process-manager cache tests**

Add a focused test to `packages/kernel/src/process/__tests__/process.test.ts` for the path that currently calls `WebAssembly.compile(wasmBytes)` from registered tool bytes.

Test intent:

- register or load the same wasm bytes twice under two paths
- use a `MemoryWasmModuleCache` whose compile function increments `compiles`
- assert the two loads produce one compile for identical bytes

Use the existing fixtures and helper style in `process.test.ts`.

- [ ] **Step 2: Run the failing test**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/process/__tests__/process.test.ts
```

Expected: FAIL because `ProcessManager` does not accept or use a module cache.

- [ ] **Step 3: Wire cache into `ProcessManager`**

Add a `wasmModuleCache?: WasmModuleCache` constructor option or field in `ProcessManager`.

Keep the existing path/source-keyed field, but rename it for clarity if needed:

```ts
private moduleCache: Map<string, WebAssembly.Module> = new Map();
```

may become:

```ts
private pathModuleCache: Map<string, WebAssembly.Module> = new Map();
private wasmModuleCache: WasmModuleCache;
```

For every path where `ProcessManager` has raw executable bytes and currently calls `WebAssembly.compile(...)`, replace it with:

```ts
const digest = await sha256Hex(bytes);
const module = await this.wasmModuleCache.getOrCompile(digest, bytes);
```

For `ToolSource.kind === "host"`, use `adapter.readBytes(source.path)` and the digest cache, then store the returned module in the path/source cache for `spawnSync()`. This replaces the current `adapter.loadModule(source.path)` path in `ProcessManager.loadModule()` for registered tools.

Keep the path/source cache because `spawnSync()` needs synchronous lookup by resolved tool source. The digest cache is only the compile backend.

Preserve the existing path-cache semantics exactly:

- `loadModule(source)` must still populate the path/source cache with `this.pathModuleCache.set(this.cacheKey(source), module)` after digest compilation.
- `registerAndLoadTool()` must compile VFS bytes through the digest cache and then populate the same path/source cache with `this.cacheKey(source)`.
- `getModule()` and `spawnSync()` must continue reading from the path/source cache only; they must not become async or compute digests.
- If `adapter.readBytes(source.path)` fails for a host tool path, fail the load. Do not silently fall back to `adapter.loadModule(source.path)`, because fallback would bypass digest sharing and make cache behavior platform-dependent. `PlatformAdapter` already requires `readBytes()`.

- [ ] **Step 4: Pass the sandbox cache to `ProcessManager`**

In `Sandbox.create()`, pass the sandbox instance cache to `ProcessManager`. In `fork()`, pass `this.moduleCache` to the child `ProcessManager` so forked sandboxes share compiled modules with the parent.

- [ ] **Step 5: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/process/__tests__/module-cache.test.ts packages/kernel/src/process/__tests__/loader.test.ts packages/kernel/src/process/__tests__/process.test.ts
git add packages/kernel/src/process/manager.ts packages/kernel/src/sandbox.ts packages/kernel/src/process/__tests__/process.test.ts
git commit -m "feat(process): cache compiled registered tool modules"
```

Expected: tests pass and commit succeeds.

## Task 4: Cross-Sandbox Module Sharing Test

**Files:**
- Modify: `packages/kernel/src/__tests__/sandbox-base-root.test.ts`

- [ ] **Step 1: Add cross-sandbox cache test**

Add to `packages/kernel/src/__tests__/sandbox-base-root.test.ts`, using the existing base-root fixture setup in that file. If this file is missing, the VFS base-root work is not present in the checkout; rebase/merge that work before continuing rather than moving this test to an older sandbox fixture.

```ts
it("shares compiled boot modules across instances when using the same cache", async () => {
  const baseRoot = await createBaseRoot();
  let compiles = 0;
  const moduleCache = new MemoryWasmModuleCache(async (bytes) => {
    compiles++;
    return await WebAssembly.compile(bytes as BufferSource);
  });

  const a = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    baseRoot,
    bootArgv: ["/bin/true"],
    bootWasmPath: join(WASM_DIR, "true-cmd.wasm"),
    moduleCache,
  });
  const b = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    baseRoot,
    bootArgv: ["/bin/true"],
    bootWasmPath: join(WASM_DIR, "true-cmd.wasm"),
    moduleCache,
  });

  try {
    expect(compiles).toBe(1);
  } finally {
    a.destroy();
    b.destroy();
  }
});
```

Add imports for `MemoryWasmModuleCache` if needed. The existing file already has `join`, `WASM_DIR`, `NodeAdapter`, `Sandbox`, `expect`, and `createBaseRoot()`.

- [ ] **Step 2: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/__tests__/sandbox-base-root.test.ts
git add packages/kernel/src/__tests__/sandbox-base-root.test.ts
git commit -m "test(kernel): cover cross sandbox wasm module sharing"
```

Expected: tests pass and commit succeeds.

## Final Verification

Run:

```bash
source scripts/dev-init.sh
deno check packages/kernel/src/process/loader.ts packages/kernel/src/process/manager.ts packages/kernel/src/process/module-cache.ts packages/kernel/src/sandbox.ts
deno test -A --no-check packages/kernel/src/process/__tests__/module-cache.test.ts packages/kernel/src/process/__tests__/loader.test.ts packages/kernel/src/process/__tests__/process.test.ts packages/kernel/src/__tests__/sandbox-base-root.test.ts
```

Expected:
- `deno check` passes.
- All listed tests pass.
