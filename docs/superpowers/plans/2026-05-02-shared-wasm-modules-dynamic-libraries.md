# Shared Wasm Modules And Dynamic Libraries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile immutable WebAssembly modules once per artifact digest and reuse them across sandbox instances, while adding a narrow dynamic-library loader path for ports that need shared memory/table imports.

**Architecture:** Module sharing is content-addressed and independent of path names. The kernel computes a SHA-256 digest for executable bytes, asks a process-wide `WasmModuleCache` for a compiled module, and instantiates that module with per-process imports. Dynamic-library support is limited to static dependency manifests and explicit shared `memory`/`table` imports; no ELF-style runtime linker is introduced.

**Tech Stack:** TypeScript, Deno tests, WebAssembly JS API, `packages/kernel/src/process/loader.ts`, `packages/kernel/src/platform`, `packages/kernel/src/vfs/content-store.ts`.

---

## Current-State Notes

- The current package is `packages/kernel`; do not use the pre-rename package path in this plan.
- `NodeAdapter` already has a path-keyed static compile cache, but the process loader reads executable bytes from VFS and calls `WebAssembly.compile(bytes)` directly.
- This plan depends on `sha256Hex()` from `packages/kernel/src/vfs/content-store.ts` in the layered VFS plan. If this plan is implemented first, create only the hash helper in this plan and let the layered VFS plan import it later.
- Sharing compiled `WebAssembly.Module` objects does not share linear memory, stacks, globals, or guest heap. Each process still gets its own instance and mutable runtime state.
- Dynamic-library support here means "instantiate a declared dependency module with the same shared imports as the main module." It does not mean dlopen, symbol interposition, relocation processing, or host-native dynamic libraries.

## File Map

- Create `packages/kernel/src/process/module-cache.ts` — digest-keyed cache interfaces and default in-memory implementation.
- Create `packages/kernel/src/process/__tests__/module-cache.test.ts` — cache hit/miss and defensive behavior tests.
- Modify `packages/kernel/src/process/loader.ts` — compute executable digest and compile through cache.
- Modify `packages/kernel/src/process/loader.ts` — optional dynamic dependency manifest support.
- Modify `packages/kernel/src/process/__tests__/loader.test.ts` — compile deduplication tests and shared memory/table import tests.
- Modify `packages/kernel/src/platform/adapter.ts` — no API change unless loader tests prove a platform hook is cleaner.
- Modify `packages/kernel/src/sandbox.ts` — own one `WasmModuleCache` per sandbox runtime, with optional process-wide default for many sandboxes.
- Modify `packages/kernel/src/index.ts` — export cache interfaces.

## Task 1: Digest-Keyed Module Cache

**Files:**
- Create: `packages/kernel/src/process/module-cache.ts`
- Test: `packages/kernel/src/process/__tests__/module-cache.test.ts`
- Modify: `packages/kernel/src/index.ts`

- [ ] **Step 1: Write failing cache tests**

Create `packages/kernel/src/process/__tests__/module-cache.test.ts`:

```ts
import { assertEquals, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { MemoryWasmModuleCache } from "../module-cache.ts";

const emptyModule = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
]);

describe("MemoryWasmModuleCache", () => {
  it("compiles once per digest", async () => {
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

  it("uses digest rather than object identity", async () => {
    const cache = new MemoryWasmModuleCache();
    const first = await cache.getOrCompile("digest", emptyModule);
    const second = await cache.getOrCompile("digest", new Uint8Array(emptyModule));
    assertStrictEquals(first, second);
  });
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
export { MemoryWasmModuleCache, defaultWasmModuleCache } from "./process/module-cache.js";
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

Add this test to `packages/kernel/src/process/__tests__/loader.test.ts` using the existing loader context helper in that file:

```ts
it("compiles identical executable bytes once through the module cache", async () => {
  let compiles = 0;
  const moduleCache = new MemoryWasmModuleCache(async (bytes) => {
    compiles++;
    return await WebAssembly.compile(bytes as BufferSource);
  });

  const ctx = makeLoaderContext({ moduleCache });

  await loadProcess(ctx, { argv: ["/bin/true.wasm"], mode: "cli" });
  await loadProcess(ctx, { argv: ["/bin/true.wasm"], mode: "cli" });

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
import { sha256Hex } from "../vfs/content-store.js";
import { defaultWasmModuleCache, type WasmModuleCache } from "./module-cache.js";
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

- [ ] **Step 4: Give each sandbox a cache**

In `packages/kernel/src/sandbox.ts`, add a `moduleCache` field that defaults to `defaultWasmModuleCache` unless tests need isolation:

```ts
import { defaultWasmModuleCache, type WasmModuleCache } from "./process/module-cache.js";
```

Extend `SandboxOptions`:

```ts
/** Optional wasm module cache. Defaults to the process-wide cache. */
moduleCache?: WasmModuleCache;
```

When building the loader context, pass:

```ts
moduleCache: options.moduleCache ?? defaultWasmModuleCache,
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

## Task 3: Dynamic Dependency Manifest

**Files:**
- Modify: `packages/kernel/src/process/loader.ts`
- Test: `packages/kernel/src/process/__tests__/loader.test.ts`

- [ ] **Step 1: Add manifest shape**

In `packages/kernel/src/process/loader.ts`, add:

```ts
export interface WasmDependencyManifest {
  imports: Record<string, string>;
}
```

The manifest path is `${argv[0]}.deps.json`. Example for `/bin/tool.wasm`:

```json
{
  "imports": {
    "libz": "/usr/lib/wasm/libz.wasm"
  }
}
```

- [ ] **Step 2: Add missing-dependency test**

Add to `loader.test.ts`:

```ts
it("fails clearly when a declared dynamic dependency is missing", async () => {
  const ctx = makeLoaderContext();
  ctx.vfs.withWriteAccess(() => {
    ctx.vfs.writeFile(
      "/bin/true.wasm.deps.json",
      new TextEncoder().encode(JSON.stringify({ imports: { libmissing: "/usr/lib/wasm/missing.wasm" } })),
    );
  });

  await assertRejects(
    () => loadProcess(ctx, { argv: ["/bin/true.wasm"], mode: "cli" }),
    Error,
    "dynamic dependency libmissing not found",
  );
});
```

- [ ] **Step 3: Implement manifest loading**

Add helper functions in `loader.ts`:

```ts
function readDependencyManifest(ctx: LoaderContext, path: string): WasmDependencyManifest | null {
  try {
    return JSON.parse(new TextDecoder().decode(ctx.vfs.readFile(`${path}.deps.json`)));
  } catch {
    return null;
  }
}

async function compileDependency(
  ctx: LoaderContext,
  name: string,
  path: string,
): Promise<WebAssembly.Module> {
  let bytes: Uint8Array;
  try {
    bytes = ctx.vfs.readFile(path);
  } catch (e) {
    throw new Error(`dynamic dependency ${name} not found at ${path}`, { cause: e });
  }
  const digest = await sha256Hex(bytes);
  return await (ctx.moduleCache ?? defaultWasmModuleCache).getOrCompile(digest, bytes);
}
```

Call `readDependencyManifest(ctx, path)` after compiling the main module and compile each dependency before main instantiation. Do not instantiate dependencies yet in this task.

- [ ] **Step 4: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/process/__tests__/loader.test.ts
git add packages/kernel/src/process/loader.ts packages/kernel/src/process/__tests__/loader.test.ts
git commit -m "feat(process): read wasm dependency manifests"
```

Expected: tests pass and commit succeeds.

## Task 4: Shared Memory/Table Imports For Dependencies

**Files:**
- Modify: `packages/kernel/src/process/loader.ts`
- Test: `packages/kernel/src/process/__tests__/loader.test.ts`

- [ ] **Step 1: Add shared import test**

Add a test fixture module pair to `loader.test.ts` using WebAssembly text converted by the existing test helper if available. If no helper exists, add checked-in binary fixtures under `packages/kernel/src/process/__tests__/fixtures/`.

Important fixture contract: the main module imports `env.memory` and `env.__indirect_function_table` when it has dynamic dependencies. The loader cannot first instantiate the main module and then lend its exported memory to libraries, because the main module's library imports must already exist at instantiation time.

```ts
it("instantiates dynamic dependencies with the main module memory and table", async () => {
  const ctx = makeLoaderContext();
  ctx.vfs.withWriteAccess(() => {
    ctx.vfs.mkdirp("/usr/lib/wasm");
    ctx.vfs.writeFile("/bin/uses-lib.wasm", USES_LIB_WASM);
    ctx.vfs.writeFile("/usr/lib/wasm/libcounter.wasm", LIBCOUNTER_WASM);
    ctx.vfs.writeFile(
      "/bin/uses-lib.wasm.deps.json",
      new TextEncoder().encode(JSON.stringify({ imports: { libcounter: "/usr/lib/wasm/libcounter.wasm" } })),
    );
  });

  const proc = await loadProcess(ctx, {
    argv: ["/bin/uses-lib.wasm"],
    mode: "resident",
    dynamicLinking: {
      memory: { initial: 2, maximum: 16 },
      table: { initial: 8, element: "anyfunc" },
    },
  });
  const mainMemory = proc.memory;
  const libMemory = await proc.callExport("__codepod_test_dep_memory_identity");

  assertEquals(Number(libMemory), 1);
  assertEquals(mainMemory instanceof WebAssembly.Memory, true);
});
```

The fixture contract is:

- Main module imports `env.memory`, `env.__indirect_function_table`, and `libcounter.bump`.
- Dependency module imports the same `env.memory` and `env.__indirect_function_table`.
- Dependency exports a test function that returns `1` only if it sees the shared memory/table supplied by the loader.

- [ ] **Step 2: Run the failing test**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/process/__tests__/loader.test.ts
```

Expected: FAIL because dependencies are compiled but not instantiated into imports.

- [ ] **Step 3: Instantiate dependencies with shared imports**

In `packages/kernel/src/process/loader.ts`, extend `LoadProcessOptions`:

```ts
dynamicLinking?: {
  memory?: WebAssembly.MemoryDescriptor;
  table?: WebAssembly.TableDescriptor;
};
```

When a dependency manifest is present, require `opts.dynamicLinking`. Create the shared imports before any dependency or main module is instantiated:

```ts
const sharedMemory = opts.dynamicLinking?.memory
  ? new WebAssembly.Memory(opts.dynamicLinking.memory)
  : undefined;
const sharedTable = opts.dynamicLinking?.table
  ? new WebAssembly.Table(opts.dynamicLinking.table)
  : undefined;
const sharedEnv: Record<string, WebAssembly.ImportValue> = {};
if (sharedMemory) sharedEnv.memory = sharedMemory;
if (sharedTable) sharedEnv.__indirect_function_table = sharedTable;
```

Use the same `sharedEnv` for every dependency:

```ts
const depInstance = await ctx.adapter.instantiate(depModule, {
  env: sharedEnv,
  wasi_snapshot_preview1: wasiImports,
  codepod: codepodImports,
});
dependencyImports[name] = depInstance.exports as Record<string, WebAssembly.ImportValue>;
```

For each manifest import entry:

```ts
dependencyImports[name] = depInstance.exports as Record<string, WebAssembly.ImportValue>;
```

Before the final main instantiation, include `env` and `dependencyImports` in the import object:

```ts
const imports: WebAssembly.Imports = {
  env: sharedEnv,
  wasi_snapshot_preview1: wasiImports,
  codepod: codepodImports,
  ...dependencyImports,
};
```

After instantiation, set `memoryRef` from `sharedMemory ?? instance.exports.memory`. This task must never instantiate dependencies with private memory/table objects.

- [ ] **Step 4: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/process/__tests__/loader.test.ts
git add packages/kernel/src/process/loader.ts packages/kernel/src/process/__tests__/loader.test.ts packages/kernel/src/process/__tests__/fixtures
git commit -m "feat(process): instantiate wasm dependencies with shared imports"
```

Expected: tests pass and commit succeeds.

## Task 5: Sandbox-Level Module Sharing Test

**Files:**
- Modify: `packages/kernel/src/__tests__/sandbox.test.ts`

- [ ] **Step 1: Add cross-sandbox cache test**

Add:

```ts
it("shares compiled modules across sandbox instances when using the same cache", async () => {
  let compiles = 0;
  const moduleCache = new MemoryWasmModuleCache(async (bytes) => {
    compiles++;
    return await WebAssembly.compile(bytes as BufferSource);
  });

  const a = await Sandbox.create({ moduleCache });
  const b = await Sandbox.create({ moduleCache });

  await a.spawn(["/bin/true"], { mode: "cli" });
  await b.spawn(["/bin/true"], { mode: "cli" });

  assertEquals(compiles, 1);
});
```

- [ ] **Step 2: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/__tests__/sandbox.test.ts
git add packages/kernel/src/__tests__/sandbox.test.ts
git commit -m "test(kernel): cover cross sandbox wasm module sharing"
```

Expected: tests pass and commit succeeds.

## Final Verification

Run:

```bash
source scripts/dev-init.sh
deno check packages/kernel/src/process/loader.ts packages/kernel/src/process/module-cache.ts packages/kernel/src/sandbox.ts
deno test -A --no-check packages/kernel/src/process/__tests__/module-cache.test.ts packages/kernel/src/process/__tests__/loader.test.ts packages/kernel/src/__tests__/sandbox.test.ts
rg "pre-rename package path|old package path" docs/superpowers/plans/2026-05-02-shared-wasm-modules-dynamic-libraries.md
```

Expected:
- `deno check` passes.
- All listed tests pass.
- The `rg` command returns no matches.
