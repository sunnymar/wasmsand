# Layered VFS Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-sandbox in-memory base files with layered, content-addressed VFS storage so many sandboxes can share immutable startup data while each instance records only its changes.

**Architecture:** Keep `VfsLike` as the process-facing contract. Add a read-only lower layer backed by a content-addressed store, a writable upper layer for instance changes, and explicit whiteouts for deletions of lower-layer paths. Package installation will use the same layer writer, but the package manifest/repository/signing format is a follow-up plan.

**Tech Stack:** TypeScript, Deno tests, `packages/kernel/src/vfs`, `packages/kernel/src/persistence`, `packages/kernel/src/sandbox.ts`, Web Crypto / Node crypto.

---

## Current-State Notes

- The core package is `packages/kernel`; do not use the pre-rename package path in this plan.
- The current `VFS` stores every file as a `Uint8Array` in `packages/kernel/src/vfs/vfs.ts`.
- `Sandbox.create()` installs large immutable assets such as `/bin/bash`, `/bin/cpython3`, and CPython stdlib files into each sandbox VFS.
- Deletions must be durable. If `/usr/lib/python3.14/os.py` exists in the base layer and a sandbox deletes it, the upper layer needs a whiteout so lookup and export/import do not resurrect it.
- Package support is intentionally only a touchpoint here: this plan creates the VFS primitives that package install will consume. The package format, repository index, signatures, and install transaction language get their own package plan.

## File Map

- Create `packages/kernel/src/vfs/content-store.ts` — content-addressed blob store interfaces, in-memory store, Node filesystem store, SHA-256 helpers.
- Create `packages/kernel/src/vfs/layered-vfs.ts` — `VfsLike` implementation that overlays a writable `VFS` upper layer on a read-only lower `VfsLike`.
- Create `packages/kernel/src/vfs/__tests__/content-store.test.ts` — hash/store/stat coverage.
- Create `packages/kernel/src/vfs/__tests__/layered-vfs.test.ts` — read-through, copy-up, whiteout, readdir merge, stat/lstat coverage.
- Modify `packages/kernel/src/vfs/vfs-like.ts` — add optional `exists(path)` helper only if implementation proves it removes duplicated try/catch lookup code.
- Modify `packages/kernel/src/persistence/types.ts` — add whiteout state representation.
- Modify `packages/kernel/src/persistence/serializer.ts` — export/import upper layer entries and whiteouts without serializing lower-layer content.
- Modify `packages/kernel/src/sandbox.ts` — accept an optional base layer and route sandbox mutations through `LayeredVFS`.
- Modify `packages/kernel/src/index.ts` — export the new storage/layer types.
- Create `packages/kernel/src/__tests__/layered-sandbox.test.ts` — sandbox-level proof that shared base files are not copied per instance.

## Task 1: Content-Addressed Store

**Files:**
- Create: `packages/kernel/src/vfs/content-store.ts`
- Test: `packages/kernel/src/vfs/__tests__/content-store.test.ts`
- Modify: `packages/kernel/src/index.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/kernel/src/vfs/__tests__/content-store.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  MemoryContentStore,
  sha256Hex,
} from "../content-store.ts";

const enc = new TextEncoder();

describe("ContentStore", () => {
  it("stores blobs by sha256 digest and deduplicates identical content", async () => {
    const store = new MemoryContentStore();
    const a = enc.encode("same");
    const b = enc.encode("same");

    const digestA = await store.put(a);
    const digestB = await store.put(b);

    assertEquals(digestA, digestB);
    assertEquals(await sha256Hex(a), digestA);
    assertEquals(new TextDecoder().decode(await store.get(digestA)), "same");
    assertEquals(await store.stats(), { objects: 1, bytes: 4 });
  });

  it("returns defensive copies", async () => {
    const store = new MemoryContentStore();
    const digest = await store.put(enc.encode("abc"));
    const first = await store.get(digest);
    first[0] = 0x78;

    assertEquals(new TextDecoder().decode(await store.get(digest)), "abc");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/vfs/__tests__/content-store.test.ts
```

Expected: FAIL because `content-store.ts` does not exist.

- [ ] **Step 3: Implement the store**

Create `packages/kernel/src/vfs/content-store.ts`:

```ts
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ContentStoreStats {
  objects: number;
  bytes: number;
}

export interface ContentStore {
  put(bytes: Uint8Array): Promise<string>;
  get(digest: string): Promise<Uint8Array>;
  has(digest: string): Promise<boolean>;
  stats(): Promise<ContentStoreStats>;
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

export class MemoryContentStore implements ContentStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<string> {
    const digest = await sha256Hex(bytes);
    if (!this.blobs.has(digest)) {
      this.blobs.set(digest, new Uint8Array(bytes));
    }
    return digest;
  }

  async get(digest: string): Promise<Uint8Array> {
    const bytes = this.blobs.get(digest);
    if (!bytes) throw new Error(`content not found: ${digest}`);
    return new Uint8Array(bytes);
  }

  async has(digest: string): Promise<boolean> {
    return this.blobs.has(digest);
  }

  async stats(): Promise<ContentStoreStats> {
    let bytes = 0;
    for (const blob of this.blobs.values()) bytes += blob.byteLength;
    return { objects: this.blobs.size, bytes };
  }
}

export class NodeFsContentStore implements ContentStore {
  constructor(private readonly root: string) {}

  async put(bytes: Uint8Array): Promise<string> {
    const digest = await sha256Hex(bytes);
    const dir = join(this.root, digest.slice(0, 2));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, digest.slice(2)), bytes);
    return digest;
  }

  async get(digest: string): Promise<Uint8Array> {
    const bytes = await readFile(join(this.root, digest.slice(0, 2), digest.slice(2)));
    return new Uint8Array(bytes);
  }

  async has(digest: string): Promise<boolean> {
    try {
      await readFile(join(this.root, digest.slice(0, 2), digest.slice(2)));
      return true;
    } catch {
      return false;
    }
  }

  async stats(): Promise<ContentStoreStats> {
    let objects = 0;
    let bytes = 0;
    try {
      for (const shard of await readdir(this.root, { withFileTypes: true })) {
        if (!shard.isDirectory()) continue;
        for (const entry of await readdir(join(this.root, shard.name), { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          objects++;
          bytes += (await readFile(join(this.root, shard.name, entry.name))).byteLength;
        }
      }
    } catch {
      return { objects: 0, bytes: 0 };
    }
    return { objects, bytes };
  }
}
```

- [ ] **Step 4: Export the API**

Add to `packages/kernel/src/index.ts`:

```ts
export type { ContentStore, ContentStoreStats } from "./vfs/content-store.js";
export { MemoryContentStore, NodeFsContentStore, sha256Hex } from "./vfs/content-store.js";
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/vfs/__tests__/content-store.test.ts
git diff --check -- packages/kernel/src/vfs/content-store.ts packages/kernel/src/vfs/__tests__/content-store.test.ts packages/kernel/src/index.ts
git add packages/kernel/src/vfs/content-store.ts packages/kernel/src/vfs/__tests__/content-store.test.ts packages/kernel/src/index.ts
git commit -m "feat(vfs): add content addressed blob store"
```

Expected: tests pass and commit succeeds.

## Task 2: Layered VFS Read-Through And Copy-Up

**Files:**
- Create: `packages/kernel/src/vfs/layered-vfs.ts`
- Test: `packages/kernel/src/vfs/__tests__/layered-vfs.test.ts`
- Modify: `packages/kernel/src/index.ts`

- [ ] **Step 1: Write failing read/copy-up tests**

Create `packages/kernel/src/vfs/__tests__/layered-vfs.test.ts`:

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { VFS } from "../vfs.ts";
import { LayeredVFS } from "../layered-vfs.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("LayeredVFS", () => {
  it("reads from lower layer until upper layer overrides the path", () => {
    const lower = new VFS();
    lower.withWriteAccess(() => lower.writeFile("/usr/lib/base.txt", enc.encode("base")));
    const vfs = new LayeredVFS({ lower, upper: new VFS() });

    assertEquals(dec.decode(vfs.readFile("/usr/lib/base.txt")), "base");

    vfs.withWriteAccess(() => vfs.writeFile("/usr/lib/base.txt", enc.encode("upper")));

    assertEquals(dec.decode(vfs.readFile("/usr/lib/base.txt")), "upper");
    assertEquals(dec.decode(lower.readFile("/usr/lib/base.txt")), "base");
  });

  it("merges directory entries with upper entries winning", () => {
    const lower = new VFS();
    lower.withWriteAccess(() => {
      lower.writeFile("/usr/lib/a.txt", enc.encode("a"));
      lower.writeFile("/usr/lib/b.txt", enc.encode("lower-b"));
    });
    const upper = new VFS();
    const vfs = new LayeredVFS({ lower, upper });
    vfs.withWriteAccess(() => {
      vfs.writeFile("/usr/lib/b.txt", enc.encode("upper-b"));
      vfs.writeFile("/usr/lib/c.txt", enc.encode("c"));
    });

    assertEquals(vfs.readdir("/usr/lib").map((e) => e.name).sort(), ["a.txt", "b.txt", "c.txt"]);
    assertEquals(dec.decode(vfs.readFile("/usr/lib/b.txt")), "upper-b");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/vfs/__tests__/layered-vfs.test.ts
```

Expected: FAIL because `layered-vfs.ts` does not exist.

- [ ] **Step 3: Implement the minimal overlay**

Create `packages/kernel/src/vfs/layered-vfs.ts` with a `LayeredVFS` class implementing `VfsLike`. Methods that mutate (`writeFile`, `mkdir`, `mkdirp`, `rename`, `symlink`, `chmod`) write only to `upper`. Methods that read first try `upper`, then `lower`. `readdir()` merges names from both layers and lets upper metadata win.

Use this helper shape in the implementation:

```ts
import type { DirEntry, StatResult } from "./inode.js";
import { VfsError } from "./inode.js";
import type { VfsLike } from "./vfs-like.js";

export interface LayeredVFSOptions {
  lower: VfsLike;
  upper: VfsLike;
}

export class LayeredVFS implements VfsLike {
  private readonly whiteouts = new Set<string>();

  constructor(private readonly options: LayeredVFSOptions) {}

  readFile(path: string): Uint8Array {
    if (this.whiteouts.has(path)) throw new VfsError("ENOENT", path);
    try {
      return this.options.upper.readFile(path);
    } catch {
      return this.options.lower.readFile(path);
    }
  }

  writeFile(path: string, data: Uint8Array): void {
    this.whiteouts.delete(path);
    this.options.upper.writeFile(path, data);
  }

  stat(path: string): StatResult {
    if (this.whiteouts.has(path)) throw new VfsError("ENOENT", path);
    try {
      return this.options.upper.stat(path);
    } catch {
      return this.options.lower.stat(path);
    }
  }

  lstat(path: string): StatResult {
    if (this.whiteouts.has(path)) throw new VfsError("ENOENT", path);
    try {
      return this.options.upper.lstat(path);
    } catch {
      return this.options.lower.lstat(path);
    }
  }

  readdir(path: string): DirEntry[] {
    const byName = new Map<string, DirEntry>();
    try {
      for (const entry of this.options.lower.readdir(path)) byName.set(entry.name, entry);
    } catch {
      // Upper-only directory.
    }
    for (const hidden of this.whiteouts) {
      const parent = hidden.slice(0, hidden.lastIndexOf("/")) || "/";
      if (parent === path) byName.delete(hidden.slice(hidden.lastIndexOf("/") + 1));
    }
    try {
      for (const entry of this.options.upper.readdir(path)) byName.set(entry.name, entry);
    } catch {
      if (byName.size === 0) throw new VfsError("ENOENT", path);
    }
    return Array.from(byName.values());
  }

  mkdir(path: string): void {
    this.whiteouts.delete(path);
    this.options.upper.mkdir(path);
  }

  mkdirp(path: string): void {
    this.whiteouts.delete(path);
    this.options.upper.mkdirp(path);
  }

  unlink(path: string): void {
    try {
      this.options.upper.unlink(path);
    } catch {
      this.options.lower.lstat(path);
    }
    this.whiteouts.add(path);
  }

  rmdir(path: string): void {
    this.unlink(path);
  }

  rename(oldPath: string, newPath: string): void {
    const data = this.readFile(oldPath);
    this.writeFile(newPath, data);
    this.unlink(oldPath);
  }

  symlink(target: string, path: string): void {
    this.whiteouts.delete(path);
    this.options.upper.symlink(target, path);
  }

  readlink(path: string): string {
    if (this.whiteouts.has(path)) throw new VfsError("ENOENT", path);
    try {
      return this.options.upper.readlink(path);
    } catch {
      return this.options.lower.readlink(path);
    }
  }

  chmod(path: string, mode: number): void {
    try {
      this.options.upper.chmod(path, mode);
    } catch {
      const data = this.options.lower.readFile(path);
      this.options.upper.writeFile(path, data);
      this.options.upper.chmod(path, mode);
    }
  }

  withWriteAccess(fn: () => void): void {
    this.options.upper.withWriteAccess(fn);
  }
}
```

- [ ] **Step 4: Export and verify**

Add to `packages/kernel/src/index.ts`:

```ts
export { LayeredVFS } from "./vfs/layered-vfs.js";
export type { LayeredVFSOptions } from "./vfs/layered-vfs.js";
```

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/vfs/__tests__/layered-vfs.test.ts
git add packages/kernel/src/vfs/layered-vfs.ts packages/kernel/src/vfs/__tests__/layered-vfs.test.ts packages/kernel/src/index.ts
git commit -m "feat(vfs): add layered read-through filesystem"
```

Expected: tests pass and commit succeeds.

## Task 3: Whiteouts Are Durable

**Files:**
- Modify: `packages/kernel/src/vfs/layered-vfs.ts`
- Modify: `packages/kernel/src/persistence/types.ts`
- Modify: `packages/kernel/src/persistence/serializer.ts`
- Test: `packages/kernel/src/vfs/__tests__/layered-vfs.test.ts`
- Test: `packages/kernel/src/__tests__/layered-sandbox.test.ts`

- [ ] **Step 1: Add whiteout tests**

Append to `packages/kernel/src/vfs/__tests__/layered-vfs.test.ts`:

```ts
it("whiteouts hide deleted lower-layer files", () => {
  const lower = new VFS();
  lower.withWriteAccess(() => lower.writeFile("/usr/lib/remove-me.txt", enc.encode("base")));
  const vfs = new LayeredVFS({ lower, upper: new VFS() });

  vfs.withWriteAccess(() => vfs.unlink("/usr/lib/remove-me.txt"));

  assertThrows(() => vfs.readFile("/usr/lib/remove-me.txt"), /ENOENT/);
  assertEquals(vfs.readdir("/usr/lib").some((e) => e.name === "remove-me.txt"), false);
});
```

- [ ] **Step 2: Add explicit whiteout API**

Extend `LayeredVFS` with:

```ts
export interface LayeredVFSState {
  whiteouts: string[];
}

export class LayeredVFS implements VfsLike {
  exportLayerState(): LayeredVFSState {
    return { whiteouts: Array.from(this.whiteouts).sort() };
  }

  importLayerState(state: LayeredVFSState): void {
    this.whiteouts.clear();
    for (const path of state.whiteouts) this.whiteouts.add(path);
  }
}
```

- [ ] **Step 3: Extend serialized state types**

Add to `packages/kernel/src/persistence/types.ts`:

```ts
export interface SerializedLayerState {
  whiteouts?: string[];
}
```

Add `layer?: SerializedLayerState;` to `SerializedState`.

- [ ] **Step 4: Serialize whiteouts when the VFS supports them**

In `packages/kernel/src/persistence/serializer.ts`, after building `state`, add:

```ts
const maybeLayered = vfs as VfsLike & {
  exportLayerState?: () => { whiteouts: string[] };
  importLayerState?: (state: { whiteouts: string[] }) => void;
};
if (maybeLayered.exportLayerState) {
  state.layer = maybeLayered.exportLayerState();
}
```

In `importState()`, after file restoration, add:

```ts
const maybeLayered = vfs as VfsLike & {
  importLayerState?: (state: { whiteouts: string[] }) => void;
};
if (state.layer && maybeLayered.importLayerState) {
  maybeLayered.importLayerState({ whiteouts: state.layer.whiteouts ?? [] });
}
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/vfs/__tests__/layered-vfs.test.ts packages/kernel/src/__tests__/persistence.test.ts
git add packages/kernel/src/vfs/layered-vfs.ts packages/kernel/src/vfs/__tests__/layered-vfs.test.ts packages/kernel/src/persistence/types.ts packages/kernel/src/persistence/serializer.ts
git commit -m "feat(vfs): persist layered whiteouts"
```

Expected: tests pass and commit succeeds.

## Task 4: Sandbox Base Layer Option

**Files:**
- Modify: `packages/kernel/src/sandbox.ts`
- Create: `packages/kernel/src/__tests__/layered-sandbox.test.ts`

- [ ] **Step 1: Write sandbox-level sharing test**

Create `packages/kernel/src/__tests__/layered-sandbox.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Sandbox } from "../sandbox.ts";
import { VFS } from "../vfs/vfs.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("Sandbox layered VFS", () => {
  it("shares base files and isolates instance writes", async () => {
    const base = new VFS();
    base.withWriteAccess(() => {
      base.writeFile("/usr/lib/shared.txt", enc.encode("base"));
    });

    const a = await Sandbox.create({ baseVfs: base, bootArgv: ["/bin/bash"] });
    const b = await Sandbox.create({ baseVfs: base, bootArgv: ["/bin/bash"] });

    assertEquals(dec.decode(a.readFile("/usr/lib/shared.txt")), "base");
    a.writeFile("/usr/lib/shared.txt", enc.encode("changed"));

    assertEquals(dec.decode(a.readFile("/usr/lib/shared.txt")), "changed");
    assertEquals(dec.decode(b.readFile("/usr/lib/shared.txt")), "base");
  });
});
```

- [ ] **Step 2: Add option to `SandboxOptions`**

In `packages/kernel/src/sandbox.ts`, add:

```ts
import { LayeredVFS } from "./vfs/layered-vfs.js";
```

Extend `SandboxOptions`:

```ts
/** Optional read-only base filesystem shared across sandbox instances. */
baseVfs?: VfsLike;
```

When constructing the sandbox VFS, replace direct `new VFS(...)` with:

```ts
const upper = new VFS({ fsLimitBytes: options.fsLimitBytes });
const vfs = options.baseVfs
  ? new LayeredVFS({ lower: options.baseVfs, upper })
  : upper;
```

Keep initialization writes routed through `vfs.withWriteAccess(...)` so default files land in the upper layer until a separate image-builder task moves them into a base image.

- [ ] **Step 3: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/__tests__/layered-sandbox.test.ts packages/kernel/src/__tests__/sandbox.test.ts
git add packages/kernel/src/sandbox.ts packages/kernel/src/__tests__/layered-sandbox.test.ts
git commit -m "feat(kernel): support sandbox base vfs layer"
```

Expected: tests pass and commit succeeds.

## Task 5: Package Installer Touchpoint

**Files:**
- Modify: `packages/kernel/src/pkg/manager.ts`
- Test: `packages/kernel/src/__tests__/pkg.test.ts`

- [ ] **Step 1: Add a package install path assertion**

Add a test proving the current package manager writes through the active VFS abstraction:

```ts
it("installs package files through the active VFS layer", () => {
  const base = new VFS();
  const layered = new LayeredVFS({ lower: base, upper: new VFS() });
  const manager = new PackageManager(layered, { enabled: true });
  const wasm = new Uint8Array([0, 0x61, 0x73, 0x6d]);

  manager.install("hello", wasm, "https://packages.example/hello.wasm");

  assertEquals(layered.readFile("/usr/share/pkg/bin/hello.wasm"), wasm);
  assertThrows(() => base.readFile("/usr/share/pkg/bin/hello.wasm"), /ENOENT/);
});
```

- [ ] **Step 2: Keep package format out of this slice**

Add this comment above `PackageManager.install()` in `packages/kernel/src/pkg/manager.ts`:

```ts
// Package format work is intentionally separate from layered VFS storage.
// This manager must write through VfsLike so runtime installs land in the
// sandbox upper layer, while creation-time package layers can later write
// directly to a base-image builder.
```

- [ ] **Step 3: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/__tests__/pkg.test.ts
git add packages/kernel/src/pkg/manager.ts packages/kernel/src/__tests__/pkg.test.ts
git commit -m "test(pkg): pin package writes to active vfs layer"
```

Expected: tests pass and commit succeeds.

## Final Verification

Run:

```bash
source scripts/dev-init.sh
deno check packages/kernel/src/sandbox.ts packages/kernel/src/vfs/content-store.ts packages/kernel/src/vfs/layered-vfs.ts packages/kernel/src/persistence/serializer.ts
deno test -A --no-check packages/kernel/src/vfs/__tests__/content-store.test.ts packages/kernel/src/vfs/__tests__/layered-vfs.test.ts packages/kernel/src/__tests__/layered-sandbox.test.ts packages/kernel/src/__tests__/persistence.test.ts packages/kernel/src/__tests__/pkg.test.ts
rg "pre-rename package path|old package path" docs/superpowers/plans/2026-05-02-layered-vfs-storage.md
```

Expected:
- `deno check` passes.
- All listed tests pass.
- The `rg` command returns no matches.
