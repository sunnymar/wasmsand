# Layered VFS Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start sandboxes from one prepared read-only root filesystem directory and store only per-instance changes in the sandbox VFS.

**Architecture:** Treat `/` as a union root: a read-only base layer backed directly by host storage, plus an upper `VFS` for sandbox-instance changes. Reads check the upper layer first, then the base directory; writes copy up only when POSIX-style ownership and mode bits allow the current sandbox credential to mutate that path; deletions of permitted base files are represented by whiteouts. The base layer is created by install/build tooling and mounted at sandbox creation time; the layer code is generic and does not know which packages, languages, tools, or path conventions produced the files.

**Tech Stack:** TypeScript, Deno tests, `packages/kernel/src/vfs`, `packages/kernel/src/sandbox.ts`, `packages/kernel/src/persistence`, Node filesystem provider first; browser/custom storage providers later.

---

## Decisions

- Do **not** copy immutable base files into every `Sandbox.create()`.
- Do **not** make content-addressed storage the runtime read path for `/`.
- Do mount the base root as read-only host-backed storage.
- Do keep the sandbox's upper layer as normal `VFS` state.
- Do enforce UID/GID/mode metadata in VFS primitives. The sandbox runtime user is non-root and cannot escalate to root from inside the sandbox.
- Do let base-image manifests decide initial ownership and permissions in this slice. Package manifests will use the same idea later. The VFS/layer code must not hard-code `/bin`, `/tmp`, `/home`, or package paths.
- Do preserve whiteouts so deleting a writable base file stays deleted in snapshots/exports.
- Do keep package format, signing, repository metadata, and package layer creation for the package plan. This plan only creates the filesystem shape package install will later target.
- Do keep "full VFS export including base bytes" as an explicit optional mode for suspend/portable export. Default export records upper-layer changes plus the base image identity.

## File Map

- Create `packages/kernel/src/vfs/root-provider.ts` — pure read-only root provider interfaces and metadata helpers, with no Node imports.
- Create `packages/kernel/src/vfs/node-directory-root-provider.ts` — Node directory implementation of `RootProvider`.
- Create `packages/kernel/src/vfs/overlay-vfs.ts` — `VfsLike` implementation that overlays writable `VFS` on a read-only root provider.
- Modify `packages/kernel/src/vfs/inode.ts` and `packages/kernel/src/vfs/vfs.ts` — add UID/GID metadata and enforce permissions against a current filesystem credential.
- Modify `packages/kernel/src/vfs/vfs-like.ts` — expose credential-aware VFS behavior without encoding path policy.
- Create `packages/kernel/src/vfs/__tests__/root-provider.test.ts` — Node directory provider behavior and traversal protection.
- Create `packages/kernel/src/vfs/__tests__/overlay-vfs.test.ts` — read-through, copy-up, whiteouts, merged listings, symlink/readlink behavior.
- Create `packages/kernel/src/vfs/__tests__/helpers.ts` — shared `MemoryRoot` root-provider test helper.
- Modify `packages/kernel/src/persistence/types.ts` — add base image identity and whiteout metadata.
- Modify `packages/kernel/src/persistence/serializer.ts` — default export contains upper-layer changes and whiteouts; optional full export includes base bytes.
- Modify `packages/kernel/src/process/manager.ts` — store explicit host/VFS tool sources and load registered VFS executables from `VfsLike`.
- Modify `packages/kernel/src/sandbox.ts` — accept `baseRoot` options and register base-root executables without copying them into the upper layer.
- Create `packages/kernel/src/base-image/build-base-image.ts` — build a local base root directory from a generic file manifest.
- Create `packages/kernel/src/base-image/__tests__/build-base-image.test.ts` — verifies manifest-driven copying, metadata, and executable layout without hard-coding language runtime knowledge into VFS.
- Modify `packages/kernel/src/index.ts` and `packages/kernel/src/node-adapter.ts` — export the overlay/root provider types.

## Task 0: UID/GID Metadata And Permission Enforcement

**Files:**
- Modify: `packages/kernel/src/vfs/inode.ts`
- Modify: `packages/kernel/src/vfs/vfs.ts`
- Modify: `packages/kernel/src/vfs/vfs-like.ts`
- Modify: `packages/kernel/src/persistence/types.ts`
- Modify: `packages/kernel/src/persistence/serializer.ts`
- Modify: `packages/kernel/src/execution/vfs-proxy.ts`
- Test: `packages/kernel/src/vfs/__tests__/vfs.test.ts`
- Test: `packages/kernel/src/__tests__/persistence.test.ts`

- [x] **Step 1: Write failing permission tests**

Add tests that pin the generic security model:

```ts
it("non-root cannot write root-owned files without mode permission", () => {
  const vfs = new VFS({ credential: { uid: 1000, gid: 1000 } });
  vfs.withWriteAccess(() => {
    vfs.writeFile("/system.txt", enc.encode("root"));
    vfs.chown("/system.txt", 0, 0);
    vfs.chmod("/system.txt", 0o644);
  });

  assertThrows(() => vfs.writeFile("/system.txt", enc.encode("user")), /EACCES/);
});

it("non-root can write files it owns when mode permits it", () => {
  const vfs = new VFS({ credential: { uid: 1000, gid: 1000 } });
  vfs.withWriteAccess(() => {
    vfs.writeFile("/user.txt", enc.encode("old"));
    vfs.chown("/user.txt", 1000, 1000);
    vfs.chmod("/user.txt", 0o644);
  });

  vfs.writeFile("/user.txt", enc.encode("new"));
  assertEquals(dec.decode(vfs.readFile("/user.txt")), "new");
});

  it("non-root cannot chmod files it does not own", () => {
  const vfs = new VFS({ credential: { uid: 1000, gid: 1000 } });
  vfs.withWriteAccess(() => {
    vfs.writeFile("/system.txt", enc.encode("root"));
    vfs.chown("/system.txt", 0, 0);
  });

  assertThrows(() => vfs.chmod("/system.txt", 0o777), /EACCES/);
});

it("root credential can mutate root-owned files", () => {
  const vfs = new VFS({ credential: { uid: 0, gid: 0 } });
  vfs.withWriteAccess(() => {
    vfs.writeFile("/system.txt", enc.encode("root"));
    vfs.chown("/system.txt", 0, 0);
    vfs.chmod("/system.txt", 0o644);
  });

  vfs.writeFile("/system.txt", enc.encode("root-update"));
  vfs.chmod("/system.txt", 0o600);

  assertEquals(dec.decode(vfs.readFile("/system.txt")), "root-update");
  assertEquals(vfs.stat("/system.txt").permissions, 0o600);
});
```

- [x] **Step 2: Extend metadata types**

In `packages/kernel/src/vfs/inode.ts`, add:

```ts
export interface FsCredential {
  uid: number;
  gid: number;
  groups?: number[];
}
```

Extend `InodeMetadata` and `StatResult`:

```ts
uid: number;
gid: number;
```

`createMetadata()` should accept ownership and default to root ownership only for root/setup creation. Runtime-created files use the current VFS credential.

- [x] **Step 3: Enforce mode bits against credentials**

Update `VFS` so it stores a current credential:

```ts
export interface VFSOptions {
  credential?: FsCredential;
  // existing options...
}
```

Default runtime credential is `{ uid: 1000, gid: 1000 }`. `withWriteAccess()` remains setup/import authority and may bypass permission checks, but that authority is host-side only; no guest syscall or shell command can enter it. Do not implement `sudo`, setuid, or any in-sandbox root escalation.

Replace owner-bit-only checks with POSIX-style checks:

```ts
private canWrite(metadata: InodeMetadata): boolean {
  if (this.initializing) return true;
  const cred = this.credential;
  if (cred.uid === 0) return true;
  if (cred.uid === metadata.uid) return (metadata.permissions & 0o200) !== 0;
  if (cred.gid === metadata.gid || cred.groups?.includes(metadata.gid)) return (metadata.permissions & 0o020) !== 0;
  return (metadata.permissions & 0o002) !== 0;
}
```

`chmod` succeeds only for root or the owning uid. Add `chown(path, uid, gid)` to `VfsLike`/`VFS`; it must require setup/root authority.

- [x] **Step 4: Persist ownership**

Extend serialized file entries with optional `uid` and `gid`, and round-trip them in `serializer.ts`. Existing state without ownership fields should import as root-owned for setup files unless the caller explicitly supplies a different default.

- [x] **Step 5: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/vfs/__tests__/vfs.test.ts packages/kernel/src/__tests__/persistence.test.ts
git add packages/kernel/src/vfs/inode.ts packages/kernel/src/vfs/vfs.ts packages/kernel/src/vfs/vfs-like.ts packages/kernel/src/persistence/types.ts packages/kernel/src/persistence/serializer.ts packages/kernel/src/execution/vfs-proxy.ts packages/kernel/src/vfs/__tests__/vfs.test.ts packages/kernel/src/__tests__/persistence.test.ts
git commit -m "feat(vfs): enforce uid gid permissions"
```

Expected: tests pass and commit succeeds.

## Task 1: Read-Only Root Provider

**Files:**
- Create: `packages/kernel/src/vfs/root-provider.ts`
- Create: `packages/kernel/src/vfs/node-directory-root-provider.ts`
- Test: `packages/kernel/src/vfs/__tests__/root-provider.test.ts`
- Modify: `packages/kernel/src/node-adapter.ts`

- [x] **Step 1: Write failing tests**

Create `packages/kernel/src/vfs/__tests__/root-provider.test.ts`:

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { join } from "node:path";
import { mkdtemp, mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NodeDirectoryRootProvider } from "../node-directory-root-provider.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("NodeDirectoryRootProvider", () => {
  it("reads files and lists directories from a host directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "codepod-root-"));
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/bash"), enc.encode("wasm"));

    const provider = new NodeDirectoryRootProvider(root, { id: "test-root" });

    assertEquals(dec.decode(provider.readFile("/bin/bash")), "wasm");
    assertEquals(provider.readdir("/"), [{ name: "bin", type: "dir" }]);
    assertEquals(provider.stat("/bin/bash").type, "file");
    assertEquals(typeof provider.stat("/bin/bash").uid, "number");
    assertEquals(typeof provider.stat("/bin/bash").gid, "number");
    assertEquals(provider.id, "test-root");
  });

  it("blocks path traversal and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "codepod-root-"));
    await symlink("/etc/passwd", join(root, "escape"));
    const provider = new NodeDirectoryRootProvider(root, { id: "test-root" });

    assertThrows(() => provider.readFile("/../etc/passwd"), Error, "traversal");
    assertThrows(() => provider.readFile("/escape"), Error, "symlink");
  });

  it("returns symlink targets without exposing resolved host paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "codepod-root-"));
    await mkdir(join(root, "bin"));
    await symlink("../bin/tool", join(root, "tool-link"));
    const provider = new NodeDirectoryRootProvider(root, { id: "test-root" });

    assertEquals(provider.readlink("/tool-link"), "../bin/tool");
    assertEquals(await readlink(join(root, "tool-link")), "../bin/tool");
  });

  it("normalizes lookup paths before applying manifest metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "codepod-root-"));
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/bash"), enc.encode("wasm"));
    const provider = new NodeDirectoryRootProvider(root, {
      id: "test-root",
      metadata: { "/bin/bash": { uid: 0, gid: 0, mode: 0o755 } },
    });

    assertEquals(provider.stat("/bin/../bin/bash").uid, 0);
    assertEquals(provider.stat("/bin/../bin/bash").permissions, 0o755);
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/vfs/__tests__/root-provider.test.ts
```

Expected: FAIL because `root-provider.ts` does not exist.

- [x] **Step 3: Implement the provider**

Create pure `packages/kernel/src/vfs/root-provider.ts`:

```ts
import type { DirEntry, StatResult } from "./inode.js";

export interface RootProviderStat {
  type: "file" | "dir" | "symlink";
  size: number;
  permissions: number;
  uid: number;
  gid: number;
  mtime: Date;
  ctime: Date;
  atime: Date;
}

export interface RootProvider {
  readonly id: string;
  readFile(path: string): Uint8Array;
  stat(path: string): RootProviderStat;
  lstat(path: string): RootProviderStat;
  readdir(path: string): DirEntry[];
  readlink(path: string): string;
}

export interface NodeDirectoryRootProviderOptions {
  id: string;
  metadata?: Record<string, { uid: number; gid: number; mode: number }>;
}

export function rootStatToVfsStat(stat: RootProviderStat): StatResult {
  return {
    type: stat.type,
    size: stat.size,
    permissions: stat.permissions,
    uid: stat.uid,
    gid: stat.gid,
    mtime: stat.mtime,
    ctime: stat.ctime,
    atime: stat.atime,
  };
}
```

Create Node-only `packages/kernel/src/vfs/node-directory-root-provider.ts`:

```ts
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync } from "node:fs";
import { normalize, resolve } from "node:path";
import { VfsError, type DirEntry } from "./inode.js";
import type { NodeDirectoryRootProviderOptions, RootProvider, RootProviderStat } from "./root-provider.js";

function normalizeVfsPath(path: string): string {
  if (!path.startsWith("/")) throw new VfsError("ENOENT", `not absolute: ${path}`);
  const parts = path.split("/");
  let depth = 0;
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      depth--;
      if (depth < 0) throw new VfsError("ENOENT", `traversal blocked: ${path}`);
    } else {
      depth++;
    }
  }
  const normalized = normalize(path);
  return normalized;
}

export class NodeDirectoryRootProvider implements RootProvider {
  readonly id: string;
  private readonly root: string;
  private readonly realRoot: string;
  private readonly metadata: Record<string, { uid: number; gid: number; mode: number }>;

  constructor(root: string, options: NodeDirectoryRootProviderOptions) {
    this.root = resolve(root);
    this.realRoot = realpathSync(this.root);
    this.id = options.id;
    this.metadata = Object.fromEntries(
      Object.entries(options.metadata ?? {}).map(([path, value]) => [normalizeVfsPath(path), value]),
    );
  }

  readFile(path: string): Uint8Array {
    const full = this.resolveHost(path, true);
    const st = statSync(full);
    if (st.isDirectory()) throw new VfsError("EISDIR", `is a directory: ${path}`);
    return new Uint8Array(readFileSync(full));
  }

  stat(path: string): RootProviderStat {
    return this.toStat(path, true);
  }

  lstat(path: string): RootProviderStat {
    return this.toStat(path, false);
  }

  readdir(path: string): DirEntry[] {
    const full = this.resolveHost(path, true);
    const st = statSync(full);
    if (!st.isDirectory()) throw new VfsError("ENOTDIR", `not a directory: ${path}`);
    return readdirSync(full, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : "file",
    }));
  }

  readlink(path: string): string {
    const full = this.resolveHost(path, false);
    const st = lstatSync(full);
    if (!st.isSymbolicLink()) throw new VfsError("ENOENT", `not a symlink: ${path}`);
    return readlinkSync(full);
  }

  private toStat(path: string, follow: boolean): RootProviderStat {
    const normalized = normalizeVfsPath(path);
    const full = this.resolveHost(normalized, follow);
    const st = follow ? statSync(full) : lstatSync(full);
    const metadata = this.metadata[normalized];
    return {
      type: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file",
      size: st.isDirectory() ? readdirSync(full).length : st.size,
      permissions: metadata?.mode ?? (st.mode & 0o777),
      uid: metadata?.uid ?? st.uid,
      gid: metadata?.gid ?? st.gid,
      mtime: st.mtime,
      ctime: st.ctime,
      atime: st.atime,
    };
  }

  private resolveHost(path: string, follow: boolean): string {
    const normalized = normalizeVfsPath(path);
    const full = normalize(resolve(this.root, "." + normalized));
    if (!full.startsWith(this.root + "/") && full !== this.root) {
      throw new VfsError("ENOENT", `traversal blocked: ${path}`);
    }
    if (!follow) return full;
    const real = realpathSync(full);
    if (!real.startsWith(this.realRoot + "/") && real !== this.realRoot) {
      throw new VfsError("ENOENT", `symlink escape blocked: ${path}`);
    }
    return real;
  }
}
```

- [x] **Step 4: Export Node provider**

Add to `packages/kernel/src/node-adapter.ts`:

```ts
export { NodeDirectoryRootProvider } from "./vfs/node-directory-root-provider.js";
export type { RootProvider, NodeDirectoryRootProviderOptions } from "./vfs/root-provider.js";
```

- [x] **Step 5: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/vfs/__tests__/root-provider.test.ts
git diff --check -- packages/kernel/src/vfs/root-provider.ts packages/kernel/src/vfs/__tests__/root-provider.test.ts packages/kernel/src/node-adapter.ts
git add packages/kernel/src/vfs/root-provider.ts packages/kernel/src/vfs/node-directory-root-provider.ts packages/kernel/src/vfs/__tests__/root-provider.test.ts packages/kernel/src/node-adapter.ts
git commit -m "feat(vfs): add read-only root provider"
```

Expected: tests pass and commit succeeds.

## Task 2: Overlay Root VFS

**Files:**
- Create: `packages/kernel/src/vfs/overlay-vfs.ts`
- Test: `packages/kernel/src/vfs/__tests__/overlay-vfs.test.ts`
- Test helper: `packages/kernel/src/vfs/__tests__/helpers.ts`
- Modify: `packages/kernel/src/index.ts`

- [x] **Step 1: Write failing overlay tests**

Create `packages/kernel/src/vfs/__tests__/overlay-vfs.test.ts`:

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { VFS } from "../vfs.ts";
import { VfsError } from "../inode.ts";
import { OverlayVFS } from "../overlay-vfs.ts";
import type { RootProvider, RootProviderStat } from "../root-provider.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

interface MemoryRootMetadata {
  permissions?: number;
  uid?: number;
  gid?: number;
}

function stat(type: "file" | "dir" | "symlink", size = 0, metadata: MemoryRootMetadata = {}): RootProviderStat {
  const now = new Date(0);
  return {
    type,
    size,
    permissions: metadata.permissions ?? 0o555,
    uid: metadata.uid ?? 0,
    gid: metadata.gid ?? 0,
    mtime: now,
    ctime: now,
    atime: now,
  };
}

class MemoryRoot implements RootProvider {
  files = new Map<string, { data: Uint8Array; metadata: MemoryRootMetadata }>();
  dirs = new Map<string, MemoryRootMetadata>([["/", { permissions: 0o755, uid: 0, gid: 0 }]]);
  symlinks = new Map<string, { target: string; metadata: MemoryRootMetadata }>();

  constructor(readonly id = "memory-root") {}

  addDir(path: string, metadata: MemoryRootMetadata = {}): void {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      if (!this.dirs.has(current)) this.dirs.set(current, metadata);
    }
  }

  addFile(path: string, data: string, metadata: MemoryRootMetadata = {}): void {
    this.files.set(path, { data: enc.encode(data), metadata });
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    this.addDir(parent);
  }

  addSymlink(path: string, target: string, metadata: MemoryRootMetadata = {}): void {
    this.symlinks.set(path, { target, metadata });
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    this.addDir(parent);
  }

  readFile(path: string): Uint8Array {
    const file = this.files.get(path);
    if (!file) throw new VfsError("ENOENT", path);
    return file.data;
  }

  stat(path: string): RootProviderStat {
    const file = this.files.get(path);
    if (file) return stat("file", file.data.byteLength, file.metadata);
    const symlink = this.symlinks.get(path);
    if (symlink) return stat("symlink", symlink.target.length, symlink.metadata);
    const dir = this.dirs.get(path);
    if (dir) return stat("dir", 0, dir);
    throw new VfsError("ENOENT", path);
  }

  lstat(path: string): RootProviderStat {
    return this.stat(path);
  }

  readdir(path: string) {
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Map<string, "file" | "dir">();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const [name, ...tail] = rest.split("/");
      names.set(name, tail.length ? "dir" : "file");
    }
    for (const link of this.symlinks.keys()) {
      if (!link.startsWith(prefix)) continue;
      const rest = link.slice(prefix.length);
      const [name, ...tail] = rest.split("/");
      names.set(name, tail.length ? "dir" : "symlink");
    }
    return Array.from(names, ([name, type]) => ({ name, type }));
  }

  readlink(path: string): string {
    const symlink = this.symlinks.get(path);
    if (!symlink) throw new VfsError("ENOENT", path);
    return symlink.target;
  }
}

describe("OverlayVFS", () => {
  it("reads base files without copying them into the upper VFS", () => {
    const base = new MemoryRoot();
    base.addFile("/opt/base/readme.txt", "base");
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    assertEquals(dec.decode(vfs.readFile("/opt/base/readme.txt")), "base");
    assertThrows(() => upper.readFile("/opt/base/readme.txt"), /ENOENT/);
  });

  it("rejects writes to root-owned base files that the runtime user cannot modify", () => {
    const base = new MemoryRoot();
    base.addFile("/opt/base/readme.txt", "base", { uid: 0, gid: 0, permissions: 0o644 });
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    assertThrows(() => vfs.writeFile("/opt/base/readme.txt", enc.encode("upper")), /EACCES/);
    assertEquals(dec.decode(vfs.readFile("/opt/base/readme.txt")), "base");
    assertThrows(() => upper.readFile("/opt/base/readme.txt"), /ENOENT/);
  });

  it("non-root cannot shadow root-owned base entries in upper", () => {
    const base = new MemoryRoot();
    base.addDir("/bin", { uid: 0, gid: 0, permissions: 0o755 });
    base.addFile("/bin/python", "base", { uid: 0, gid: 0, permissions: 0o755 });
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    assertThrows(() => vfs.writeFile("/bin/python", enc.encode("shadow")), /EACCES/);
    assertThrows(() => vfs.unlink("/bin/python"), /EACCES/);
    assertThrows(() => vfs.symlink("/tmp/fake-python", "/bin/python"), /EACCES/);
    assertThrows(() => upper.readFile("/bin/python"), /ENOENT/);
    assertEquals(dec.decode(vfs.readFile("/bin/python")), "base");
  });

  it("copies up writable user-owned base files and leaves base unchanged", () => {
    const base = new MemoryRoot();
    base.addFile("/opt/base/readme.txt", "base", { uid: 1000, gid: 1000, permissions: 0o644 });
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    vfs.writeFile("/opt/base/readme.txt", enc.encode("upper"));

    assertEquals(dec.decode(vfs.readFile("/opt/base/readme.txt")), "upper");
    assertEquals(dec.decode(base.readFile("/opt/base/readme.txt")), "base");
    assertEquals(dec.decode(upper.readFile("/opt/base/readme.txt")), "upper");
  });

  it("materializes base parent directories in upper using setup authority", () => {
    const base = new MemoryRoot();
    base.addDir("/opt/base", { uid: 1000, gid: 1000, permissions: 0o755 });
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    vfs.writeFile("/opt/base/generated.txt", enc.encode("upper"));

    assertEquals(dec.decode(vfs.readFile("/opt/base/generated.txt")), "upper");
    assertEquals(dec.decode(upper.readFile("/opt/base/generated.txt")), "upper");
    assertEquals(upper.stat("/opt").uid, 0);
    assertEquals(upper.stat("/opt/base").uid, 1000);
  });

  it("creates directories and symlinks inside writable base-only parents", () => {
    const base = new MemoryRoot();
    base.addDir("/opt/base", { uid: 1000, gid: 1000, permissions: 0o755 });
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    vfs.mkdir("/opt/base/dir");
    vfs.symlink("dir", "/opt/base/link");

    assertEquals(vfs.stat("/opt/base/dir").type, "dir");
    assertEquals(vfs.readlink("/opt/base/link"), "dir");
    assertEquals(upper.stat("/opt/base").uid, 1000);
  });

  it("mutates upper-only files using upper metadata before consulting base", () => {
    const base = new MemoryRoot();
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });
    vfs.withWriteAccess(() => {
      vfs.mkdirp("/tmp");
      vfs.chown("/tmp", 1000, 1000);
      vfs.chmod("/tmp", 0o755);
      vfs.writeFile("/tmp/upper.txt", enc.encode("old"));
      vfs.chown("/tmp/upper.txt", 1000, 1000);
      vfs.chmod("/tmp/upper.txt", 0o644);
    });

    vfs.writeFile("/tmp/upper.txt", enc.encode("new"));

    assertEquals(dec.decode(vfs.readFile("/tmp/upper.txt")), "new");
  });

  it("does not assume upper-layer files are all user-owned", () => {
    const base = new MemoryRoot();
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });
    vfs.withWriteAccess(() => {
      vfs.mkdirp("/tmp");
      vfs.chown("/tmp", 1000, 1000);
      vfs.chmod("/tmp", 0o755);
      vfs.writeFile("/tmp/root-owned.txt", enc.encode("root"));
      vfs.chown("/tmp/root-owned.txt", 0, 0);
      vfs.chmod("/tmp/root-owned.txt", 0o644);
    });

    assertThrows(() => vfs.writeFile("/tmp/root-owned.txt", enc.encode("user")), /EACCES/);
    assertThrows(() => vfs.chmod("/tmp/root-owned.txt", 0o777), /EACCES/);
    assertEquals(dec.decode(vfs.readFile("/tmp/root-owned.txt")), "root");
  });

  it("mkdir and symlink reject existing base entries unless whiteouted", () => {
    const base = new MemoryRoot();
    base.addDir("/opt/base", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile("/opt/base/existing.txt", "base", { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    assertThrows(() => vfs.mkdir("/opt/base/existing.txt"), /EEXIST/);
    assertThrows(() => vfs.symlink("target", "/opt/base/existing.txt"), /EEXIST/);
    vfs.unlink("/opt/base/existing.txt");
    vfs.symlink("target", "/opt/base/existing.txt");
    assertEquals(vfs.readlink("/opt/base/existing.txt"), "target");
  });

  it("renames only after source and destination permissions are validated", () => {
    const base = new MemoryRoot();
    base.addDir("/src", { uid: 0, gid: 0, permissions: 0o755 });
    base.addFile("/src/root-owned.txt", "base", { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addDir("/dst", { uid: 1000, gid: 1000, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    assertThrows(() => vfs.rename("/src/root-owned.txt", "/dst/copied.txt"), /EACCES/);
    assertThrows(() => vfs.readFile("/dst/copied.txt"), /ENOENT/);
    assertEquals(dec.decode(vfs.readFile("/src/root-owned.txt")), "base");
  });

  it("renames files, symlinks, and empty directories from writable base paths", () => {
    const base = new MemoryRoot();
    base.addDir("/work", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile("/work/file.txt", "file", { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addDir("/work/empty", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addSymlink("/work/link", "file.txt", { uid: 1000, gid: 1000, permissions: 0o777 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.rename("/work/file.txt", "/work/file2.txt");
    vfs.rename("/work/link", "/work/link2");
    vfs.rename("/work/empty", "/work/empty2");

    assertEquals(dec.decode(vfs.readFile("/work/file2.txt")), "file");
    assertEquals(vfs.readlink("/work/link2"), "file.txt");
    assertEquals(vfs.stat("/work/empty2").type, "dir");
  });

  it("renames relative symlinks without following their target for metadata", () => {
    const base = new MemoryRoot();
    base.addDir("/work", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addSymlink("/work/link", "missing.txt", { uid: 1000, gid: 1000, permissions: 0o777 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.rename("/work/link", "/work/link2");

    assertEquals(vfs.readlink("/work/link2"), "missing.txt");
    assertThrows(() => vfs.readlink("/work/link"), /ENOENT/);
  });

  it("rename can replace a whiteouted destination", () => {
    const base = new MemoryRoot();
    base.addDir("/work", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile("/work/source.txt", "source", { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addFile("/work/dest.txt", "dest", { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.unlink("/work/dest.txt");
    vfs.rename("/work/source.txt", "/work/dest.txt");

    assertEquals(dec.decode(vfs.readFile("/work/dest.txt")), "source");
    assertThrows(() => vfs.readFile("/work/source.txt"), /ENOENT/);
  });

  it("rename replaces existing destination files and directories", () => {
    const base = new MemoryRoot();
    base.addDir("/work", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile("/work/a.txt", "a", { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addFile("/work/b.txt", "b", { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addDir("/work/src-dir", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addDir("/work/dst-dir", { uid: 1000, gid: 1000, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.rename("/work/a.txt", "/work/b.txt");
    vfs.rename("/work/src-dir", "/work/dst-dir");

    assertEquals(dec.decode(vfs.readFile("/work/b.txt")), "a");
    assertThrows(() => vfs.readFile("/work/a.txt"), /ENOENT/);
    assertEquals(vfs.stat("/work/dst-dir").type, "dir");
    assertThrows(() => vfs.stat("/work/src-dir"), /ENOENT/);
  });

  it("rename rejects incompatible replacement types", () => {
    const base = new MemoryRoot();
    base.addDir("/work", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile("/work/file.txt", "file", { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addDir("/work/dir", { uid: 1000, gid: 1000, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    assertThrows(() => vfs.rename("/work/file.txt", "/work/dir"), /EISDIR/);
    assertThrows(() => vfs.rename("/work/dir", "/work/file.txt"), /ENOTDIR/);
  });

  it("rename same path is a no-op", () => {
    const base = new MemoryRoot();
    base.addDir("/work", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile("/work/file.txt", "file", { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.rename("/work/file.txt", "/work/sub/../file.txt");

    assertEquals(dec.decode(vfs.readFile("/work/file.txt")), "file");
  });

  it("rename same missing path still reports ENOENT", () => {
    const vfs = new OverlayVFS({ base: new MemoryRoot(), upper: new VFS() });

    assertThrows(() => vfs.rename("/missing", "/missing"), /ENOENT/);
  });

  it("rename preflights non-empty source directories before replacing destination", () => {
    const base = new MemoryRoot();
    base.addDir("/work", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addDir("/work/src-dir", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile("/work/src-dir/file.txt", "x", { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addDir("/work/dst-dir", { uid: 1000, gid: 1000, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    assertThrows(() => vfs.rename("/work/src-dir", "/work/dst-dir"), /ENOTEMPTY/);
    assertEquals(vfs.stat("/work/dst-dir").type, "dir");
  });

  it("rejects new files inside root-owned non-writable base directories", () => {
    const base = new MemoryRoot();
    base.addDir("/opt/base", { uid: 0, gid: 0, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    assertThrows(() => vfs.writeFile("/opt/base/generated.txt", enc.encode("upper")), /EACCES/);
  });

  it("does not fall through to base when upper shadows with another type", () => {
    const base = new MemoryRoot();
    base.addFile("/opt/base/readme.txt", "base");
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    upper.withWriteAccess(() => upper.mkdirp("/opt/base/readme.txt"));

    assertThrows(() => vfs.readFile("/opt/base/readme.txt"), /EISDIR/);
    assertThrows(() => vfs.unlink("/opt/base/readme.txt"), /EISDIR/);
  });

  it("whiteouts hide deleted user-owned base files", () => {
    const base = new MemoryRoot();
    base.addFile("/user/file.txt", "base", { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.unlink("/user/file.txt");

    assertThrows(() => vfs.readFile("/user/file.txt"), /ENOENT/);
    assertEquals(vfs.readdir("/user").some((entry) => entry.name === "file.txt"), false);
  });

  it("can recreate a file at a whiteouted path when the parent permits creation", () => {
    const base = new MemoryRoot();
    base.addDir("/writable", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile("/writable/root-owned.txt", "base", { uid: 0, gid: 0, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.unlink("/writable/root-owned.txt");
    vfs.writeFile("/writable/root-owned.txt", enc.encode("new"));

    assertEquals(dec.decode(vfs.readFile("/writable/root-owned.txt")), "new");
  });

  it("does not recreate files below a whiteouted base directory", () => {
    const base = new MemoryRoot();
    base.addDir("/gone", { uid: 1000, gid: 1000, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.rmdir("/gone");

    assertThrows(() => vfs.writeFile("/gone/file.txt", enc.encode("x")), /ENOENT/);
    assertThrows(() => vfs.writeFile("/x/../gone/file.txt", enc.encode("x")), /ENOENT/);
    assertThrows(() => vfs.readdir("/gone"), /ENOENT/);
  });

  it("imports whiteouts canonically", () => {
    const base = new MemoryRoot("base:test");
    base.addDir("/gone", { uid: 1000, gid: 1000, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.importOverlayState({ baseId: "base:test", whiteouts: ["/x/../gone"] });

    assertThrows(() => vfs.stat("/gone"), /ENOENT/);
  });

  it("rejects deleting root-owned base files without write permission", () => {
    const base = new MemoryRoot();
    base.addFile("/bin/tool", "base", { uid: 0, gid: 0, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    assertThrows(() => vfs.unlink("/bin/tool"), /EACCES/);
    assertEquals(dec.decode(vfs.readFile("/bin/tool")), "base");
  });

  it("delete permission depends on the parent directory, not the file", () => {
    const base = new MemoryRoot();
    base.addDir("/writable", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile("/writable/root-owned.txt", "base", { uid: 0, gid: 0, permissions: 0o644 });
    base.addDir("/locked", { uid: 0, gid: 0, permissions: 0o755 });
    base.addFile("/locked/user-owned.txt", "base", { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.unlink("/writable/root-owned.txt");
    assertThrows(() => vfs.readFile("/writable/root-owned.txt"), /ENOENT/);
    assertThrows(() => vfs.unlink("/locked/user-owned.txt"), /EACCES/);
  });

  it("preserves POSIX directory deletion semantics for base directories", () => {
    const base = new MemoryRoot();
    base.addDir("/base-dir", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile("/base-dir/file.txt", "x", { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    assertThrows(() => vfs.unlink("/base-dir"), /EISDIR/);
    assertThrows(() => vfs.rmdir("/base-dir"), /ENOTEMPTY/);
  });

  it("rmdir sees merged base children after the directory is materialized in upper", () => {
    const base = new MemoryRoot();
    base.addDir("/base-dir", { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile("/base-dir/file.txt", "x", { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.writeFile("/base-dir/generated.txt", enc.encode("upper"));
    vfs.unlink("/base-dir/generated.txt");

    assertThrows(() => vfs.rmdir("/base-dir"), /ENOTEMPTY/);
  });

  it("chmod on base directories depends on ownership, not write bits", () => {
    const base = new MemoryRoot();
    base.addDir("/user-dir", { uid: 1000, gid: 1000, permissions: 0o555 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.chmod("/user-dir", 0o755);

    assertEquals(vfs.stat("/user-dir").permissions, 0o755);
  });

  it("can clone the upper layer while sharing the same base", () => {
    const base = new MemoryRoot();
    base.addFile("/base.txt", "base");
    const vfs = new OverlayVFS({ base, upper: new VFS() });
    vfs.withWriteAccess(() => vfs.writeFile("/upper.txt", enc.encode("upper")));

    const clone = vfs.cowClone();
    clone.withWriteAccess(() => clone.writeFile("/upper.txt", enc.encode("clone")));

    assertEquals(dec.decode(vfs.readFile("/upper.txt")), "upper");
    assertEquals(dec.decode(clone.readFile("/upper.txt")), "clone");
    assertEquals(dec.decode(clone.readFile("/base.txt")), "base");
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/vfs/__tests__/overlay-vfs.test.ts
```

Expected: FAIL because `overlay-vfs.ts` does not exist.

- [x] **Step 3: Implement overlay semantics**

Create `packages/kernel/src/vfs/overlay-vfs.ts`:

```ts
import { VfsError, type DirEntry, type FsCredential, type StatResult } from "./inode.js";
import type { RootProvider } from "./root-provider.js";
import { rootStatToVfsStat } from "./root-provider.js";
import type { VfsLike } from "./vfs-like.js";

export interface OverlayVFSOptions {
  base: RootProvider;
  upper: VfsLike;
  credential?: FsCredential;
}

export interface OverlayState {
  baseId: string;
  whiteouts: string[];
}

type RenameDestinationBackup =
  | { kind: "none" }
  | { kind: "base"; path: string; hadWhiteout: boolean }
  | { kind: "upper"; path: string; backupPath: string; stat: StatResult; hadWhiteout: boolean };

function parentPath(path: string): string {
  path = normalizeOverlayPath(path);
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function basename(path: string): string {
  path = normalizeOverlayPath(path);
  return path.slice(path.lastIndexOf("/") + 1);
}

function ancestorPaths(path: string): string[] {
  path = normalizeOverlayPath(path);
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    out.push(current);
  }
  return out;
}

function isEnoent(error: unknown): boolean {
  return error instanceof VfsError && error.errno === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return error instanceof VfsError && error.errno === "EEXIST";
}

function randomRenameId(): string {
  return crypto.randomUUID();
}

function normalizeOverlayPath(path: string): string {
  if (!path.startsWith("/")) throw new VfsError("ENOENT", `not absolute: ${path}`);
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) throw new VfsError("ENOENT", `traversal blocked: ${path}`);
      out.pop();
    } else {
      out.push(part);
    }
  }
  return `/${out.join("/")}`;
}

function canWrite(stat: StatResult, credential: FsCredential): boolean {
  if (credential.uid === 0) return true;
  if (credential.uid === stat.uid) return (stat.permissions & 0o200) !== 0;
  if (credential.gid === stat.gid || credential.groups?.includes(stat.gid)) return (stat.permissions & 0o020) !== 0;
  return (stat.permissions & 0o002) !== 0;
}

export class OverlayVFS implements VfsLike {
  private readonly whiteouts = new Set<string>();
  private readonly credential: FsCredential;
  private privileged = false;

  constructor(private readonly options: OverlayVFSOptions) {
    this.credential = options.credential ?? { uid: 1000, gid: 1000 };
  }

  exportOverlayState(): OverlayState {
    return { baseId: this.options.base.id, whiteouts: Array.from(this.whiteouts).sort() };
  }

  exportUpperVfs(): VfsLike {
    return this.options.upper;
  }

  importOverlayState(state: OverlayState): void {
    if (state.baseId !== this.options.base.id) {
      throw new Error(`base id mismatch: expected ${this.options.base.id}, got ${state.baseId}`);
    }
    this.whiteouts.clear();
    for (const path of state.whiteouts) this.whiteouts.add(normalizeOverlayPath(path));
  }

  readFile(path: string): Uint8Array {
    path = normalizeOverlayPath(path);
    if (this.whiteouts.has(path)) throw new VfsError("ENOENT", `whiteout: ${path}`);
    try {
      return this.options.upper.readFile(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      return this.options.base.readFile(path);
    }
  }

  writeFile(path: string, data: Uint8Array): void {
    path = normalizeOverlayPath(path);
    const wasWhiteouted = this.whiteouts.has(path);
    if (!this.privileged) this.assertCanWritePath(path, wasWhiteouted);
    this.ensureUpperParentDirectory(path);
    this.options.upper.writeFile(path, data);
    this.whiteouts.delete(path);
  }

  stat(path: string): StatResult {
    path = normalizeOverlayPath(path);
    if (this.whiteouts.has(path)) throw new VfsError("ENOENT", `whiteout: ${path}`);
    try {
      return this.options.upper.stat(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      return rootStatToVfsStat(this.options.base.stat(path));
    }
  }

  lstat(path: string): StatResult {
    path = normalizeOverlayPath(path);
    if (this.whiteouts.has(path)) throw new VfsError("ENOENT", `whiteout: ${path}`);
    try {
      return this.options.upper.lstat(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      return rootStatToVfsStat(this.options.base.lstat(path));
    }
  }

  readdir(path: string): DirEntry[] {
    path = normalizeOverlayPath(path);
    if (this.whiteouts.has(path)) throw new VfsError("ENOENT", `whiteout: ${path}`);
    const entries = new Map<string, DirEntry>();
    try {
      for (const entry of this.options.base.readdir(path)) entries.set(entry.name, entry);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      // Upper-only directory.
    }
    for (const whiteout of this.whiteouts) {
      if (parentPath(whiteout) === path) entries.delete(basename(whiteout));
    }
    try {
      for (const entry of this.options.upper.readdir(path)) entries.set(entry.name, entry);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      if (entries.size === 0) throw new VfsError("ENOENT", `no such directory: ${path}`);
    }
    return Array.from(entries.values());
  }

  mkdir(path: string): void {
    path = normalizeOverlayPath(path);
    const wasWhiteouted = this.whiteouts.has(path);
    if (!this.privileged) this.assertCanMutateDirectoryEntry(path);
    this.assertNoMergedEntry(path, wasWhiteouted);
    this.ensureUpperParentDirectory(path);
    this.options.upper.mkdir(path);
    this.whiteouts.delete(path);
  }

  mkdirp(path: string): void {
    path = normalizeOverlayPath(path);
    for (const dir of ancestorPaths(path)) {
      const existing = this.lookupMerged(dir);
      if (existing) {
        if (existing.type !== "dir") throw new VfsError("ENOTDIR", `not a directory: ${dir}`);
        continue;
      }
      const wasWhiteouted = this.whiteouts.has(dir);
      if (!this.privileged) this.assertCanMutateDirectoryEntry(dir);
      this.assertNoMergedEntry(dir, wasWhiteouted);
      this.ensureUpperParentDirectory(dir);
      try {
        this.options.upper.mkdir(dir);
        this.whiteouts.delete(dir);
      } catch (e) {
        if (!isEexist(e)) throw e;
      }
    }
  }

  unlink(path: string): void {
    path = normalizeOverlayPath(path);
    try {
      const st = this.options.upper.lstat(path);
      if (st.type === "dir") throw new VfsError("EISDIR", `is a directory: ${path}`);
      this.options.upper.unlink(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      if (!this.privileged) this.assertCanMutateDirectoryEntry(path);
      const st = this.options.base.lstat(path);
      if (st.type === "dir") throw new VfsError("EISDIR", `is a directory: ${path}`);
    }
    this.whiteouts.add(path);
  }

  rmdir(path: string): void {
    path = normalizeOverlayPath(path);
    if (this.readdir(path).length > 0) throw new VfsError("ENOTEMPTY", `directory not empty: ${path}`);
    try {
      this.options.upper.rmdir(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      if (!this.privileged) this.assertCanMutateDirectoryEntry(path);
      const st = this.options.base.lstat(path);
      if (st.type !== "dir") throw new VfsError("ENOTDIR", `not a directory: ${path}`);
    }
    this.whiteouts.add(path);
  }

  rename(oldPath: string, newPath: string): void {
    oldPath = normalizeOverlayPath(oldPath);
    newPath = normalizeOverlayPath(newPath);
    const st = this.lookupMerged(oldPath);
    if (!st) throw new VfsError("ENOENT", `no such file: ${oldPath}`);
    if (oldPath === newPath) return;
    const destination = this.lookupMerged(newPath);
    if (!this.privileged) {
      this.assertCanMutateDirectoryEntry(oldPath);
      this.assertCanMutateDirectoryEntry(newPath);
    }
    this.assertRenameReplacementAllowed(st, destination, newPath);
    this.assertRenameSourceCopyable(oldPath, st);
    this.assertCanRemoveSourceEntry(oldPath, st);

    const destinationWhiteoutBefore = this.whiteouts.has(newPath);
    const tempPath = this.renameTempPath(newPath);
    try {
      this.copyUpAny(oldPath, tempPath, st);
    } catch (e) {
      if (destinationWhiteoutBefore) this.whiteouts.add(newPath);
      throw e;
    }
    let destinationBackup: RenameDestinationBackup = { kind: "none" };
    try {
      destinationBackup = this.stageDestinationForRename(newPath, destination, destinationWhiteoutBefore);
      this.moveUpperTempIntoPlace(tempPath, newPath);
    } catch (e) {
      this.removeUpperTemp(tempPath, st);
      this.restoreDestinationAfterFailedRename(newPath, destinationBackup);
      throw e;
    }
    try {
      this.removeSourceEntry(oldPath, st);
    } catch (e) {
      this.restoreDestinationAfterFailedRename(newPath, destinationBackup);
      throw e;
    }
    this.discardRenameDestinationBackup(destinationBackup);
    this.whiteouts.delete(newPath);
  }

  symlink(target: string, path: string): void {
    path = normalizeOverlayPath(path);
    const wasWhiteouted = this.whiteouts.has(path);
    if (!this.privileged) this.assertCanMutateDirectoryEntry(path);
    this.assertNoMergedEntry(path, wasWhiteouted);
    this.ensureUpperParentDirectory(path);
    this.options.upper.symlink(target, path);
    this.whiteouts.delete(path);
  }

  link?(oldPath: string, newPath: string): void {
    if (!this.options.upper.link) throw new VfsError("EACCES", "hard link unsupported on overlay upper");
    this.options.upper.link(oldPath, newPath);
  }

  readlink(path: string): string {
    path = normalizeOverlayPath(path);
    if (this.whiteouts.has(path)) throw new VfsError("ENOENT", `whiteout: ${path}`);
    try {
      return this.options.upper.readlink(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      return this.options.base.readlink(path);
    }
  }

  chmod(path: string, mode: number): void {
    path = normalizeOverlayPath(path);
    try {
      this.options.upper.chmod(path, mode);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      if (!this.privileged) this.assertCanChmodPath(path);
      this.copyUpMetadataOnly(path);
      this.options.upper.chmod(path, mode);
    }
  }

  chown(path: string, uid: number, gid: number): void {
    path = normalizeOverlayPath(path);
    if (!this.options.upper.chown) throw new VfsError("EACCES", "chown unsupported on overlay upper");
    try {
      this.options.upper.chown(path, uid, gid);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      if (!this.privileged && this.credential.uid !== 0) throw new VfsError("EACCES", `permission denied: ${path}`);
      this.copyUpMetadataOnly(path);
      this.options.upper.chown(path, uid, gid);
    }
  }

  private copyUpMetadataOnly(path: string): void {
    path = normalizeOverlayPath(path);
    const st = rootStatToVfsStat(this.options.base.lstat(path));
    this.ensureUpperParentDirectory(path);
    try {
      this.options.upper.withWriteAccess(() => {
        if (st.type === "dir") {
          this.options.upper.mkdir(path);
        } else if (st.type === "symlink") {
          this.options.upper.symlink(this.options.base.readlink(path), path);
        } else {
          this.options.upper.writeFile(path, this.options.base.readFile(path));
        }
        // The current VFS has chmod/chown but no lchmod/lchown; applying either
        // to a symlink follows the target. Preserve symlink bytes and leave
        // symlink metadata at the upper's default until lchmod/lchown exists.
        if (st.type !== "symlink") {
          if (this.options.upper.chown) this.options.upper.chown(path, st.uid, st.gid);
          this.options.upper.chmod(path, st.permissions);
        }
      });
    } catch (e) {
      this.removeUpperTemp(path, st);
      throw e;
    }
  }

  private copyUpAny(oldPath: string, newPath: string, st: StatResult): void {
    oldPath = normalizeOverlayPath(oldPath);
    newPath = normalizeOverlayPath(newPath);
    this.ensureUpperParentDirectory(newPath);
    try {
      this.options.upper.withWriteAccess(() => {
        if (st.type === "dir") {
          this.options.upper.mkdir(newPath);
        } else if (st.type === "symlink") {
          this.options.upper.symlink(this.readlink(oldPath), newPath);
        } else {
          this.options.upper.writeFile(newPath, this.readFile(oldPath));
        }
        // The current VFS has chmod/chown but no lchmod/lchown; applying either
        // to a symlink follows the target. Preserve symlink bytes and leave
        // symlink metadata at the upper's default until lchmod/lchown exists.
        if (st.type !== "symlink") {
          if (this.options.upper.chown) this.options.upper.chown(newPath, st.uid, st.gid);
          this.options.upper.chmod(newPath, st.permissions);
        }
      });
    } catch (e) {
      this.removeUpperTemp(newPath, st);
      throw e;
    }
  }

  private renameTempPath(newPath: string): string {
    return `${parentPath(newPath)}/.codepod-rename-${randomRenameId()}`;
  }

  private moveUpperTempIntoPlace(tempPath: string, newPath: string): void {
    this.options.upper.withWriteAccess(() => {
      this.options.upper.rename(tempPath, newPath);
    });
  }

  private removeUpperTemp(tempPath: string, st: StatResult): void {
    try {
      if (st.type === "dir") this.options.upper.rmdir(tempPath);
      else this.options.upper.unlink(tempPath);
    } catch {
      // Best-effort cleanup. The important invariant is that destination state
      // was not modified by copy failure before replacement, and replacement
      // uses upper.rename() rather than a second byte-copy.
    }
  }

  private removeSourceEntry(path: string, st: StatResult): void {
    path = normalizeOverlayPath(path);
    if (st.type === "dir") this.rmdir(path);
    else this.unlink(path);
  }

  private assertCanRemoveSourceEntry(path: string, st: StatResult): void {
    path = normalizeOverlayPath(path);
    if (!this.privileged) this.assertCanMutateDirectoryEntry(path);
    if (st.type === "dir" && this.readdir(path).length > 0) {
      throw new VfsError("ENOTEMPTY", `directory not empty: ${path}`);
    }
  }

  private assertRenameReplacementAllowed(source: StatResult, destination: StatResult | null, path: string): void {
    path = normalizeOverlayPath(path);
    if (!destination) return;
    if (source.type === "dir" && destination.type !== "dir") {
      throw new VfsError("ENOTDIR", `not a directory: ${path}`);
    }
    if (source.type !== "dir" && destination.type === "dir") {
      throw new VfsError("EISDIR", `is a directory: ${path}`);
    }
    if (destination.type === "dir" && this.readdir(path).length > 0) {
      throw new VfsError("ENOTEMPTY", `directory not empty: ${path}`);
    }
  }

  private assertRenameSourceCopyable(path: string, source: StatResult): void {
    path = normalizeOverlayPath(path);
    if (source.type === "dir" && this.readdir(path).length > 0) {
      throw new VfsError("ENOTEMPTY", `directory not empty: ${path}`);
    }
  }

  private stageDestinationForRename(
    path: string,
    destination: StatResult | null,
    hadWhiteout: boolean,
  ): RenameDestinationBackup {
    path = normalizeOverlayPath(path);
    if (!destination) return { kind: "none" };

    try {
      const upperStat = this.options.upper.lstat(path);
      const backupPath = this.renameTempPath(path);
      this.options.upper.withWriteAccess(() => {
        this.options.upper.rename(path, backupPath);
      });
      return { kind: "upper", path, backupPath, stat: upperStat, hadWhiteout };
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }

    // Base-only destination: keep the base bytes in place and hide them while
    // the rename replacement is staged. Rollback only has to restore whiteout
    // state, not recopy bytes from the base root.
    this.whiteouts.add(path);
    return { kind: "base", path, hadWhiteout };
  }

  private restoreDestinationAfterFailedRename(path: string, backup: RenameDestinationBackup): void {
    path = normalizeOverlayPath(path);
    try {
      const current = this.options.upper.lstat(path);
      this.removeUpperTemp(path, current);
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }

    if (backup.kind === "upper") {
      this.options.upper.withWriteAccess(() => {
        this.options.upper.rename(backup.backupPath, backup.path);
      });
      if (backup.hadWhiteout) this.whiteouts.add(backup.path);
      else this.whiteouts.delete(backup.path);
    } else if (backup.kind === "base") {
      if (backup.hadWhiteout) this.whiteouts.add(backup.path);
      else this.whiteouts.delete(backup.path);
    }
  }

  private discardRenameDestinationBackup(backup: RenameDestinationBackup): void {
    if (backup.kind !== "upper") return;
    this.removeUpperTemp(backup.backupPath, backup.stat);
  }

  private assertCanWritePath(path: string, allowBaseWhiteout = false): void {
    path = normalizeOverlayPath(path);
    this.assertNoWhiteoutedAncestor(path);
    try {
      const st = this.options.upper.lstat(path);
      if (!canWrite(st, this.credential)) throw new VfsError("EACCES", `permission denied: ${path}`);
      return;
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }

    if (!allowBaseWhiteout) {
      try {
        const st = rootStatToVfsStat(this.options.base.lstat(path));
        if (!canWrite(st, this.credential)) throw new VfsError("EACCES", `permission denied: ${path}`);
        return;
      } catch (e) {
        if (!isEnoent(e)) throw e;
      }
    }

    try {
      const parent = this.options.upper.stat(parentPath(path));
      if (!canWrite(parent, this.credential)) throw new VfsError("EACCES", `permission denied: ${parentPath(path)}`);
      return;
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }

    const parent = rootStatToVfsStat(this.options.base.stat(parentPath(path)));
    if (!canWrite(parent, this.credential)) throw new VfsError("EACCES", `permission denied: ${parentPath(path)}`);
  }

  private assertCanMutateDirectoryEntry(path: string): void {
    path = normalizeOverlayPath(path);
    this.assertNoWhiteoutedAncestor(path);
    try {
      const parent = this.options.upper.stat(parentPath(path));
      if (!canWrite(parent, this.credential)) throw new VfsError("EACCES", `permission denied: ${parentPath(path)}`);
      return;
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
    const parent = rootStatToVfsStat(this.options.base.stat(parentPath(path)));
    if (!canWrite(parent, this.credential)) throw new VfsError("EACCES", `permission denied: ${parentPath(path)}`);
  }

  private assertCanChmodPath(path: string): void {
    path = normalizeOverlayPath(path);
    let st: StatResult;
    try {
      st = this.options.upper.lstat(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      st = rootStatToVfsStat(this.options.base.lstat(path));
    }
    if (this.credential.uid !== 0 && this.credential.uid !== st.uid) {
      throw new VfsError("EACCES", `permission denied: ${path}`);
    }
  }

  private lookupMerged(path: string): StatResult | null {
    path = normalizeOverlayPath(path);
    if (this.whiteouts.has(path)) return null;
    try {
      return this.options.upper.lstat(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
    try {
      return rootStatToVfsStat(this.options.base.lstat(path));
    } catch (e) {
      if (!isEnoent(e)) throw e;
      return null;
    }
  }

  private assertNoMergedEntry(path: string, allowBaseWhiteout = false): void {
    path = normalizeOverlayPath(path);
    try {
      this.options.upper.lstat(path);
      throw new VfsError("EEXIST", `file exists: ${path}`);
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
    if (!allowBaseWhiteout) {
      try {
        this.options.base.lstat(path);
        throw new VfsError("EEXIST", `file exists: ${path}`);
      } catch (e) {
        if (!isEnoent(e)) throw e;
      }
    }
  }

  private ensureUpperParentDirectory(path: string): void {
    path = normalizeOverlayPath(path);
    const parent = parentPath(path);
    if (parent === "/") return;
    this.assertNoWhiteoutedAncestor(path);
    try {
      const st = this.options.upper.stat(parent);
      if (st.type !== "dir") throw new VfsError("ENOTDIR", `not a directory: ${parent}`);
      return;
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }

    this.options.upper.withWriteAccess(() => {
      for (const dir of ancestorPaths(parent)) {
        try {
          const existing = this.options.upper.stat(dir);
          if (existing.type !== "dir") throw new VfsError("ENOTDIR", `not a directory: ${dir}`);
          continue;
        } catch (e) {
          if (!isEnoent(e)) throw e;
        }
        const st = rootStatToVfsStat(this.options.base.stat(dir));
        if (st.type !== "dir") throw new VfsError("ENOTDIR", `not a directory: ${dir}`);
        this.options.upper.mkdir(dir);
        if (this.options.upper.chown) this.options.upper.chown(dir, st.uid, st.gid);
        this.options.upper.chmod(dir, st.permissions);
      }
    });
  }

  private assertNoWhiteoutedAncestor(path: string): void {
    path = normalizeOverlayPath(path);
    for (const ancestor of ancestorPaths(parentPath(path))) {
      if (this.whiteouts.has(ancestor)) {
        throw new VfsError("ENOENT", `whiteout ancestor: ${ancestor}`);
      }
    }
  }

  withWriteAccess(fn: () => void): void {
    const previous = this.privileged;
    this.privileged = true;
    try {
      this.options.upper.withWriteAccess(fn);
    } finally {
      this.privileged = previous;
    }
  }

  cowClone(): OverlayVFS {
    const upper = this.options.upper as VfsLike & { cowClone?: () => VfsLike };
    if (!upper.cowClone) {
      throw new Error("OverlayVFS upper layer does not support cowClone()");
    }
    const clone = new OverlayVFS({ base: this.options.base, upper: upper.cowClone() });
    clone.importOverlayState(this.exportOverlayState());
    return clone;
  }
}
```

Keep `RootProvider` synchronous for this slice because WASI and `VfsLike` are synchronous today. Browser/custom storage providers should expose a synchronous facade over already-mounted data in a later task; do not make all VFS calls async in this plan.

- [x] **Step 4: Export overlay API**

Add to `packages/kernel/src/index.ts`:

```ts
export { OverlayVFS } from "./vfs/overlay-vfs.js";
export type { OverlayState, OverlayVFSOptions } from "./vfs/overlay-vfs.js";
export type { RootProvider, RootProviderStat } from "./vfs/root-provider.js";
```

- [x] **Step 5: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/vfs/__tests__/overlay-vfs.test.ts
git add packages/kernel/src/vfs/overlay-vfs.ts packages/kernel/src/vfs/__tests__/overlay-vfs.test.ts packages/kernel/src/index.ts
git commit -m "feat(vfs): add overlay root filesystem"
```

Expected: tests pass and commit succeeds.

## Task 3: Build A Local Base Root Once

**Files:**
- Create: `packages/kernel/src/base-image/build-base-image.ts`
- Test: `packages/kernel/src/base-image/__tests__/build-base-image.test.ts`
- Modify: `packages/kernel/src/sandbox.ts`

- [x] **Step 1: Write base image builder test**

Create `packages/kernel/src/base-image/__tests__/build-base-image.test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { join } from "node:path";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildBaseImage } from "../build-base-image.ts";

describe("buildBaseImage", () => {
  it("copies a generic manifest into a root directory", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "codepod-base-src-"));
    const outDir = await mkdtemp(join(tmpdir(), "codepod-base-"));
    await mkdir(join(sourceDir, "fixtures"), { recursive: true });
    await writeFile(join(sourceDir, "fixtures/tool.wasm"), new Uint8Array([0, 0x61, 0x73, 0x6d]));
    await writeFile(join(sourceDir, "fixtures/config.json"), "{}");
    await writeFile(join(sourceDir, "fixtures/cache.txt"), "cache");

    const manifest = await buildBaseImage({
      outDir,
      dirs: [{ path: "/var/tmp", uid: 1000, gid: 1000, mode: 0o777 }],
      files: [
        { src: join(sourceDir, "fixtures/tool.wasm"), dest: "/bin/tool", uid: 0, gid: 0, mode: 0o755 },
        { src: join(sourceDir, "fixtures/config.json"), dest: "/etc/tool/config.json", uid: 1000, gid: 1000, mode: 0o644 },
        { src: join(sourceDir, "fixtures/cache.txt"), dest: "/var/tmp/cache.txt", uid: 1000, gid: 1000, mode: 0o644 },
      ],
      tools: [{ name: "tool", path: "/bin/tool" }],
    });

    assertEquals(manifest.version, 1);
    assert(manifest.id.length >= 12);
    assertEquals((await stat(join(outDir, "bin/tool"))).mode & 0o777, 0o755);
    assertEquals((await stat(join(outDir, "etc/tool/config.json"))).mode & 0o777, 0o644);
    assertEquals(manifest.files.find((f) => f.path === "/bin/tool")?.uid, 0);
    assertEquals(manifest.files.find((f) => f.path === "/etc/tool/config.json")?.uid, 1000);
    assertEquals(manifest.files.find((f) => f.path === "/etc/tool")?.type, "dir");
    assertEquals(manifest.files.find((f) => f.path === "/etc")?.uid, 0);
    assertEquals(manifest.files.find((f) => f.path === "/var/tmp")?.uid, 1000);
    assertEquals(manifest.files.find((f) => f.path === "/var/tmp")?.mode, 0o777);
    assertEquals(manifest.tools, [{ name: "tool", path: "/bin/tool" }]);
    assertEquals(JSON.parse(await readFile(join(outDir, "etc/codepod/base-image.json"), "utf8")).id, manifest.id);
  });
});
```

- [x] **Step 2: Implement base image builder**

Create `packages/kernel/src/base-image/build-base-image.ts`:

```ts
import { chmod, chown, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export interface BaseImageFile {
  src: string;
  dest: string;
  uid?: number;
  gid?: number;
  mode?: number;
}

export interface BaseImageTool {
  name: string;
  path: string;
}

export interface BuildBaseImageOptions {
  outDir: string;
  dirs?: Array<{ path: string; uid?: number; gid?: number; mode?: number }>;
  files: BaseImageFile[];
  tools?: BaseImageTool[];
}

export interface BaseImageManifest {
  version: 1;
  id: string;
  files: Array<{ path: string; type: "file" | "dir"; uid: number; gid: number; mode: number }>;
  tools: BaseImageTool[];
}

function ancestors(path: string): string[] {
  const parts = dirname(path).split("/").filter(Boolean);
  const out: string[] = ["/"];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    out.push(current);
  }
  return out;
}

async function materializeDir(
  root: string,
  path: string,
  files: Map<string, BaseImageManifest["files"][number]>,
  metadata: { uid?: number; gid?: number; mode?: number } = {},
  explicit = false,
): Promise<void> {
  if (files.has(path) && !explicit) return;
  const hostPath = join(root, "." + path);
  await mkdir(hostPath, { recursive: true });
  await chmod(hostPath, metadata.mode ?? 0o755);
  try {
    await chown(hostPath, metadata.uid ?? 0, metadata.gid ?? 0);
  } catch {
    // Manifest metadata is authoritative when local chown is unavailable.
  }
  files.set(path, {
    path,
    type: "dir",
    uid: metadata.uid ?? 0,
    gid: metadata.gid ?? 0,
    mode: metadata.mode ?? 0o755,
  });
}

async function copy(root: string, src: string, dst: string, file: BaseImageFile, files: Map<string, BaseImageManifest["files"][number]>): Promise<void> {
  for (const dir of ancestors(dst)) await materializeDir(root, dir, files);
  const hostPath = join(root, "." + dst);
  await copyFile(src, hostPath);
  await chmod(hostPath, file.mode ?? 0o644);
  try {
    await chown(hostPath, file.uid ?? 0, file.gid ?? 0);
  } catch {
    // Non-root local development may be unable to chown. The manifest still
    // records intended ownership; NodeDirectoryRootProvider should prefer
    // manifest metadata when available in a later implementation step.
  }
  files.set(dst, {
    path: dst,
    type: "file",
    uid: file.uid ?? 0,
    gid: file.gid ?? 0,
    mode: file.mode ?? 0o644,
  });
}

export async function buildBaseImage(options: BuildBaseImageOptions): Promise<BaseImageManifest> {
  await rm(options.outDir, { recursive: true, force: true });
  await mkdir(options.outDir, { recursive: true });

  const copied = new Map<string, BaseImageManifest["files"][number]>();
  for (const dir of options.dirs ?? []) {
    if (!dir.path.startsWith("/") || dir.path.includes("..")) {
      throw new Error(`invalid base image directory: ${dir.path}`);
    }
    for (const ancestor of ancestors(`${dir.path}/.keep`).slice(0, -1)) {
      await materializeDir(options.outDir, ancestor, copied);
    }
    await materializeDir(options.outDir, dir.path, copied, dir, true);
  }
  for (const file of options.files) {
    if (!file.dest.startsWith("/") || file.dest.includes("..")) {
      throw new Error(`invalid base image destination: ${file.dest}`);
    }
    await copy(options.outDir, file.src, file.dest, file, copied);
  }

  const hash = createHash("sha256");
  for (const file of Array.from(copied.values()).sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update(JSON.stringify({ type: file.type, uid: file.uid, gid: file.gid, mode: file.mode }));
    if (file.type === "file") hash.update(await readFile(join(options.outDir, "." + file.path)));
  }
  const manifest: BaseImageManifest = {
    version: 1,
    id: hash.digest("hex"),
    files: Array.from(copied.values()).sort((a, b) => a.path.localeCompare(b.path)),
    tools: options.tools ?? [],
  };
  await mkdir(join(options.outDir, "etc/codepod"), { recursive: true });
  await writeFile(join(options.outDir, "etc/codepod/base-image.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
```

- [x] **Step 3: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/base-image/__tests__/build-base-image.test.ts
git add packages/kernel/src/base-image/build-base-image.ts packages/kernel/src/base-image/__tests__/build-base-image.test.ts
git commit -m "feat(vfs): build reusable base root image"
```

Expected: tests pass. Runtime/language-specific manifests are assembled by packaging/build scripts outside this generic VFS layer.

## Task 4: Sandbox Uses Base Root

**Files:**
- Modify: `packages/kernel/src/sandbox.ts`
- Modify: `packages/kernel/src/process/manager.ts`
- Test: `packages/kernel/src/__tests__/sandbox-base-root.test.ts`

- [ ] **Step 1: Add sandbox test**

Create `packages/kernel/src/__tests__/sandbox-base-root.test.ts`:

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { join } from "node:path";
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Sandbox } from "../sandbox.ts";
import { NodeAdapter } from "../platform/node-adapter.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("Sandbox base root", () => {
  it("reads base files from host root and writes changes to upper layer", async () => {
    const baseRoot = await mkdtemp(join(tmpdir(), "codepod-base-"));
    const fixtureDir = join(Deno.cwd(), "packages/kernel/src/platform/__tests__/fixtures");
    await mkdir(join(baseRoot, "bin"), { recursive: true });
    await mkdir(join(baseRoot, "etc/codepod"), { recursive: true });
    await copyFile(join(fixtureDir, "codepod-shell-exec.wasm"), join(baseRoot, "bin/bash"));
    await writeFile(join(baseRoot, "etc/base-marker.txt"), enc.encode("base"));
    await writeFile(join(baseRoot, "etc/codepod/base-image.json"), JSON.stringify({
      version: 1,
      id: "test-base",
      files: [
        { path: "/bin/bash", uid: 0, gid: 0, mode: 0o755 },
        { path: "/etc/base-marker.txt", uid: 1000, gid: 1000, mode: 0o644 },
      ],
      tools: [{ name: "bash", path: "/bin/bash" }],
    }));

    const sandbox = await Sandbox.create({
      wasmDir: fixtureDir,
      adapter: new NodeAdapter(),
      baseRoot,
    });

    assertEquals(dec.decode(sandbox.readFile("/etc/base-marker.txt")), "base");
    sandbox.writeFile("/etc/base-marker.txt", enc.encode("upper"));
    assertEquals(dec.decode(sandbox.readFile("/etc/base-marker.txt")), "upper");
    assertEquals(dec.decode(await readFile(join(baseRoot, "etc/base-marker.txt"))), "base");
    assertThrows(() => sandbox.writeFile("/bin/bash", enc.encode("not wasm")), /EACCES/);
  });
});
```

- [ ] **Step 2: Extend sandbox options**

In `packages/kernel/src/sandbox.ts`, add:

```ts
import { NodeDirectoryRootProvider } from "./vfs/node-directory-root-provider.js";
import { OverlayVFS } from "./vfs/overlay-vfs.js";
```

Extend `SandboxOptions`:

```ts
/** Host directory mounted as the read-only base root layer. Node only in this slice. */
baseRoot?: string;
/** Filesystem credential for guest/runtime operations. Defaults to uid/gid 1000. */
credential?: FsCredential;
```

Change `SandboxParts.vfs`, `Sandbox.vfs`, and helper signatures that only need the common filesystem contract from `VFS` to `VfsLike`. Keep methods that specifically require in-memory `VFS` (`cowClone`, snapshots, root initialization) behind explicit interfaces:

```ts
type ForkableVfsLike = VfsLike & { cowClone(): VfsLike };
type OverlayAwareVfsLike = VfsLike & {
  snapshot?: () => string;
  restore?: (id: string) => void;
  getProviderPaths?: () => string[];
  clearFileContents?: () => void;
  exportUpperVfs?: () => VfsLike;
  exportOverlayState?: () => { baseId: string; whiteouts: string[] };
  importOverlayState?: (state: { baseId: string; whiteouts: string[] }) => void;
};
```

When creating the VFS:

```ts
const baseManifest = options.baseRoot ? await Sandbox.readBaseRootManifest(options.baseRoot) : undefined;
const upper = new VFS({ fsLimitBytes: options.fsLimitBytes, credential: options.credential });
const vfs = options.baseRoot
  ? new OverlayVFS({
      base: new NodeDirectoryRootProvider(options.baseRoot, {
        id: baseManifest?.id ?? `dir:${options.baseRoot}`,
        metadata: Object.fromEntries((baseManifest?.files ?? []).map((f) => [
          f.path,
          { uid: f.uid, gid: f.gid, mode: f.mode },
        ])),
      }),
      upper,
      credential: options.credential,
    })
  : upper;
```

Add helper:

```ts
private static async readBaseRootManifest(baseRoot: string): Promise<{
  id: string;
  files?: Array<{ path: string; type: "file" | "dir"; uid: number; gid: number; mode: number }>;
} | undefined> {
  try {
    const raw = await Deno.readTextFile(`${baseRoot}/etc/codepod/base-image.json`);
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
```

When `baseRoot` is supplied, do not run any code path that writes base-owned files to the upper layer. Specifically:

```ts
if (options.baseRoot) {
  await Sandbox.registerBaseRootTools(mgr, vfs);
} else {
  await Sandbox.populateLegacyStartupVfs(mgr, adapter, options.wasmDir, vfs, bootArgv[0], bootWasmPath);
}
```

`populateLegacyStartupVfs()` is a temporary wrapper around today's non-layered startup population. It may install tools, runtime files, boot programs, manifests, or other existing fixtures, but it is not part of the layer abstraction and must not be called when a base root is mounted.

Add `registerBaseRootTools()` that reads `/etc/codepod/base-image.json` from the active VFS and registers every manifest tool path directly:

```ts
private static registerBaseRootTools(mgr: ProcessManager, vfs: VfsLike): void {
  const manifest = JSON.parse(new TextDecoder().decode(vfs.readFile("/etc/codepod/base-image.json"))) as {
    tools?: Array<{ name: string; path: string }>;
  };
  for (const tool of manifest.tools ?? []) {
    mgr.registerTool(tool.name, { kind: "vfs", path: tool.path });
  }
}
```

Modify `ProcessManager` so registered tools carry an explicit source instead of overloading path shape:

```ts
type ToolSource =
  | { kind: "host"; path: string }
  | { kind: "vfs"; path: string };
```

`registerTool(name, source)` stores `ToolSource`. Existing legacy registration from `NodeAdapter.scanTools()` must wrap absolute host paths as `{ kind: "host", path }`; base-root manifest registration uses `{ kind: "vfs", path }`. Do not infer source from whether a path starts with `/`, because host paths are absolute too.

Modify `ProcessManager.loadModule()` to use the source marker:

```ts
private async loadModule(source: ToolSource): Promise<WebAssembly.Module> {
  const cacheKey = `${source.kind}:${source.path}`;
  const cached = this.moduleCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const module = source.kind === "vfs"
    ? await WebAssembly.compile(this.vfs.readFile(source.path) as BufferSource)
    : await this.adapter.loadModule(source.path);
  this.moduleCache.set(cacheKey, module);
  return module;
}
```

Update `fork()` to call `(this.vfs as ForkableVfsLike).cowClone()` and rely on `OverlayVFS.cowClone()` from Task 2. Do not re-run `registerTools()` on a fork with a base root; re-register the base manifest tools instead.

Add explicit state API handling instead of assuming every `VfsLike` is a concrete `VFS`:

```ts
snapshot(): string {
  const vfs = this.vfs as OverlayAwareVfsLike;
  if (!vfs.snapshot) throw new Error("snapshot unsupported by this VFS");
  const id = vfs.snapshot();
  this.envSnapshots.set(id, this.getEnvMap());
  return id;
}

restore(id: string): void {
  const vfs = this.vfs as OverlayAwareVfsLike;
  if (!vfs.restore) throw new Error("restore unsupported by this VFS");
  vfs.restore(id);
  const envSnap = this.envSnapshots.get(id);
  if (envSnap) this.setEnvMap(envSnap);
}

exportState(): Uint8Array {
  const vfs = this.vfs as OverlayAwareVfsLike;
  return serializerExportState(this.vfs, this.getEnvMap(), vfs.getProviderPaths?.() ?? []);
}

clearFileContents(): void {
  const vfs = this.vfs as OverlayAwareVfsLike;
  if (!vfs.clearFileContents) throw new Error("clearFileContents unsupported by this VFS");
  vfs.clearFileContents();
}
```

`OverlayVFS.snapshot()`/`restore()` should delegate to the upper `VFS` snapshot/restore and snapshot/restore overlay whiteouts alongside it. `OverlayVFS.getProviderPaths()` delegates to upper if present. `OverlayVFS.clearFileContents()` delegates to upper only and never touches base bytes. Add sandbox-level tests covering `snapshot`/`restore`, `fork`, `exportState`/`importState`, and clear/offload behavior with `baseRoot`.

- [ ] **Step 3: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/__tests__/sandbox-base-root.test.ts packages/kernel/src/__tests__/sandbox.test.ts packages/kernel/src/process/__tests__/process.test.ts
git add packages/kernel/src/sandbox.ts packages/kernel/src/process/manager.ts packages/kernel/src/__tests__/sandbox-base-root.test.ts
git commit -m "feat(kernel): boot sandbox with read-only base root"
```

Expected: tests pass and commit succeeds.

## Task 5: Persistence Records Upper Layer By Default

**Files:**
- Modify: `packages/kernel/src/persistence/types.ts`
- Modify: `packages/kernel/src/persistence/serializer.ts`
- Test: `packages/kernel/src/__tests__/persistence.test.ts`
- Test helper: `packages/kernel/src/vfs/__tests__/helpers.ts`

- [ ] **Step 1: Add persistence test**

Move the `MemoryRoot` helper from `overlay-vfs.test.ts` into `packages/kernel/src/vfs/__tests__/helpers.ts`, export it, and import it in both overlay and persistence tests. Then add to `packages/kernel/src/__tests__/persistence.test.ts`:

```ts
it("exports overlay state without base file bytes by default", () => {
  const base = new MemoryRoot();
  base.addFile("/opt/base/readme.txt", "base", { uid: 1000, gid: 1000, permissions: 0o644 });
  const vfs = new OverlayVFS({ base, upper: new VFS() });
  vfs.withWriteAccess(() => vfs.writeFile("/tmp/upper.txt", new TextEncoder().encode("upper")));
  vfs.unlink("/opt/base/readme.txt");

  const blob = exportState(vfs);
  const json = new TextDecoder().decode(blob.slice(12));

  assertEquals(json.includes('"data":"YmFzZQ=="'), false);
  assertEquals(json.includes("/tmp/upper.txt"), true);
  assertEquals(json.includes("/opt/base/readme.txt"), true);
});

it("imports overlay whiteouts and validates the base id", () => {
  const base = new MemoryRoot("base:test");
  base.addFile("/opt/base/readme.txt", "base", { uid: 1000, gid: 1000, permissions: 0o644 });
  const original = new OverlayVFS({ base, upper: new VFS() });
  original.unlink("/opt/base/readme.txt");

  const blob = exportState(original);

  const restored = new OverlayVFS({ base, upper: new VFS() });
  importState(restored, blob);
  assertThrows(() => restored.readFile("/opt/base/readme.txt"), /ENOENT/);

  const wrongBase = new OverlayVFS({ base: new MemoryRoot("base:other"), upper: new VFS() });
  assertThrows(() => importState(wrongBase, blob), /base id mismatch/);
});
```

- [ ] **Step 2: Extend serialized types**

Add to `packages/kernel/src/persistence/types.ts`:

```ts
export interface SerializedOverlay {
  baseId: string;
  whiteouts: string[];
}
```

Add to `SerializedState`:

```ts
overlay?: SerializedOverlay;
```

- [ ] **Step 3: Serialize overlay metadata**

In `packages/kernel/src/persistence/serializer.ts`, detect overlay support:

```ts
const overlay = (vfs as VfsLike & {
  exportOverlayState?: () => { baseId: string; whiteouts: string[] };
}).exportOverlayState?.();
if (overlay) state.overlay = overlay;
```

Keep `walkTree()` walking only the upper layer for overlay VFS. If the implementation cannot expose upper-only walking cleanly, add `exportUpperVfs(): VfsLike` to `OverlayVFS` and have `serializer.ts` walk that.

On import, validate overlay metadata before writing files:

```ts
const targetIsOverlay = Boolean(state.overlay);
const files = targetIsOverlay ? state.files : state.files.filter(entry => isSafeImportPath(entry.path));
const overlay = (vfs as VfsLike & {
  importOverlayState?: (state: SerializedOverlay) => void;
}).importOverlayState;
if (state.overlay) {
  if (!overlay) throw new Error("state requires overlay VFS support");
  overlay.call(vfs, state.overlay);
}
```

`OverlayVFS.importOverlayState()` must compare `state.baseId` with the mounted base provider id and throw a clear `base id mismatch` error when the state belongs to a different base root. This protects the common export shape, where base bytes are intentionally omitted.

When `state.overlay` is present, do **not** apply the legacy `isSafeImportPath()` prefix filter. Overlay exports contain upper-layer changes that may legitimately live anywhere the base metadata allowed the runtime credential to write. Import should validate against the mounted base id and then replay the serialized upper VFS through normal VFS operations/metadata. Keep the legacy safe-prefix filter only for old non-overlay imports that lack base identity.

- [ ] **Step 4: Add optional full export mode**

Add an export option:

```ts
export interface ExportStateOptions {
  includeBase?: boolean;
}
```

`includeBase: true` walks the full overlay view. Default remains `false`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/kernel/src/__tests__/persistence.test.ts packages/kernel/src/vfs/__tests__/overlay-vfs.test.ts
git add packages/kernel/src/persistence/types.ts packages/kernel/src/persistence/serializer.ts packages/kernel/src/__tests__/persistence.test.ts
git commit -m "feat(persistence): serialize overlay upper layer by default"
```

Expected: tests pass and commit succeeds.

## Final Verification

Run:

```bash
source scripts/dev-init.sh
deno check packages/kernel/src/sandbox.ts packages/kernel/src/vfs/root-provider.ts packages/kernel/src/vfs/node-directory-root-provider.ts packages/kernel/src/vfs/overlay-vfs.ts packages/kernel/src/persistence/serializer.ts
deno test -A --no-check packages/kernel/src/vfs/__tests__/root-provider.test.ts packages/kernel/src/vfs/__tests__/overlay-vfs.test.ts packages/kernel/src/base-image/__tests__/build-base-image.test.ts packages/kernel/src/__tests__/sandbox-base-root.test.ts packages/kernel/src/__tests__/persistence.test.ts
```

Expected:
- `deno check` passes.
- All listed tests pass.
- Starting an MCP/SDK sandbox with `baseRoot` does not copy base-owned files into the writable upper VFS.
