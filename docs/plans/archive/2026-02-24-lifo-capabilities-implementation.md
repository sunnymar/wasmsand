# Lifo-Inspired Capabilities Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add four capabilities to wasmsand inspired by lifo: WASI-binary package manager (`pkg`), filesystem persistence modes, virtual providers (`/proc`, `/dev`), and shell ergonomics (history, completion, jobs).

**Architecture:** Each feature is a self-contained module under `packages/orchestrator/src/` that integrates with existing layers (VFS, ShellRunner, Sandbox, SecurityOptions). Features are exposed via shell builtins and/or Sandbox API methods, then surfaced through the RPC dispatcher and Python SDK. JS runtime (P2 from original spec) is dropped — it runs outside the WASM sandbox boundary, breaking the security model.

**Tech Stack:** TypeScript (orchestrator), Rust→WASM (shell parser), Python (SDK), bun:test (tests)

**Key decisions vs original spec:**
- `pkg` installs **WASI binaries** (`.wasm` files), not JS scripts — they run inside the sandbox with full WASI security boundary
- JS runtime feature is **dropped** — JS would execute outside the WASM sandbox, bypassing syscall controls, filesystem restrictions, and deadline enforcement
- Persistence builds on existing `snapshot()` infrastructure rather than being a parallel system

---

## Phase 1: Virtual Providers (`/proc`, `/dev`)

Lowest-effort feature. Establishes the VFS provider extension pattern that later features can reuse.

### Task 1: VFS Provider Interface + `/dev/null`

**Files:**
- Create: `packages/orchestrator/src/vfs/provider.ts`
- Modify: `packages/orchestrator/src/vfs/vfs.ts:57-193` (add provider routing in `resolve()` and write methods)
- Modify: `packages/orchestrator/src/vfs/vfs-like.ts` (no changes needed — providers are internal to VFS)
- Test: `packages/orchestrator/src/__tests__/providers.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'bun:test';
import { VFS } from '../vfs/vfs.js';

describe('VFS virtual providers', () => {
  it('/dev/null returns empty on read', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/dev/null');
    expect(data.byteLength).toBe(0);
  });

  it('/dev/null accepts writes silently', () => {
    const vfs = new VFS();
    // Should not throw
    vfs.writeFile('/dev/null', new TextEncoder().encode('discard me'));
    const data = vfs.readFile('/dev/null');
    expect(data.byteLength).toBe(0);
  });

  it('/dev/null stat returns file type', () => {
    const vfs = new VFS();
    const st = vfs.stat('/dev/null');
    expect(st.type).toBe('file');
  });

  it('/dev directory is listable', () => {
    const vfs = new VFS();
    const entries = vfs.readdir('/dev');
    expect(entries.some(e => e.name === 'null')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/providers.test.ts`
Expected: FAIL — `/dev/null` doesn't exist

**Step 3: Create the provider interface**

Create `packages/orchestrator/src/vfs/provider.ts`:

```typescript
/**
 * Virtual filesystem provider interface.
 *
 * Providers intercept VFS operations for paths under a mount prefix
 * (e.g. /dev, /proc). They generate content on-read rather than
 * storing real inodes.
 */

export interface VirtualProvider {
  /** Read file content. Throws VfsError('ENOENT') if subpath unknown. */
  readFile(subpath: string): Uint8Array;
  /** Write file content. Throws VfsError('EROFS') if not writable. */
  writeFile(subpath: string, data: Uint8Array): void;
  /** Check if a subpath exists. */
  exists(subpath: string): boolean;
  /** Stat a subpath. Throws VfsError('ENOENT') if unknown. */
  stat(subpath: string): { type: 'file' | 'dir'; size: number };
  /** List entries at a subpath (empty string = root of provider). */
  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }>;
}
```

Create `packages/orchestrator/src/vfs/dev-provider.ts`:

```typescript
import { VfsError } from './inode.js';
import type { VirtualProvider } from './provider.js';

export class DevProvider implements VirtualProvider {
  readFile(subpath: string): Uint8Array {
    switch (subpath) {
      case 'null': return new Uint8Array(0);
      case 'zero': return new Uint8Array(1024);
      case 'random':
      case 'urandom': {
        const buf = new Uint8Array(1024);
        crypto.getRandomValues(buf);
        return buf;
      }
      default: throw new VfsError('ENOENT', `no such device: /dev/${subpath}`);
    }
  }

  writeFile(subpath: string, _data: Uint8Array): void {
    if (subpath === 'null') return; // discard
    throw new VfsError('EROFS', `cannot write to /dev/${subpath}`);
  }

  exists(subpath: string): boolean {
    return ['null', 'zero', 'random', 'urandom'].includes(subpath);
  }

  stat(subpath: string): { type: 'file' | 'dir'; size: number } {
    if (subpath === '') return { type: 'dir', size: 4 };
    if (this.exists(subpath)) return { type: 'file', size: 0 };
    throw new VfsError('ENOENT', `no such device: /dev/${subpath}`);
  }

  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }> {
    if (subpath !== '') throw new VfsError('ENOTDIR', `/dev/${subpath}`);
    return [
      { name: 'null', type: 'file' },
      { name: 'zero', type: 'file' },
      { name: 'random', type: 'file' },
      { name: 'urandom', type: 'file' },
    ];
  }
}
```

**Step 4: Wire providers into VFS**

Modify `packages/orchestrator/src/vfs/vfs.ts`:

Add provider map and mount `/dev` during init:

```typescript
// Add import at top
import type { VirtualProvider } from './provider.js';
import { DevProvider } from './dev-provider.js';

// Add to VFS class fields (after `private initializing`)
private providers: Map<string, VirtualProvider> = new Map();

// Add provider routing helper
private matchProvider(path: string): { provider: VirtualProvider; subpath: string } | null {
  const normalized = '/' + parsePath(path).join('/');
  for (const [prefix, provider] of this.providers) {
    if (normalized === prefix) {
      return { provider, subpath: '' };
    }
    if (normalized.startsWith(prefix + '/')) {
      return { provider, subpath: normalized.slice(prefix.length + 1) };
    }
  }
  return null;
}
```

Add provider checks at the top of `readFile()`, `writeFile()`, `stat()`, `readdir()`:

In `readFile()` — add before existing logic:
```typescript
const match = this.matchProvider(path);
if (match) return match.provider.readFile(match.subpath);
```

In `writeFile()` — add before `this.assertWritable(path)`:
```typescript
const match = this.matchProvider(path);
if (match) { match.provider.writeFile(match.subpath, data); return; }
```

In `stat()` — add before existing logic:
```typescript
const match = this.matchProvider(path);
if (match) {
  const s = match.provider.stat(match.subpath);
  const now = new Date();
  return { type: s.type, size: s.size, permissions: 0o444, mtime: now, ctime: now, atime: now };
}
```

In `readdir()` — add before existing logic:
```typescript
const match = this.matchProvider(path);
if (match) {
  return match.provider.readdir(match.subpath).map(e => ({ name: e.name, type: e.type }));
}
```

Add method to register providers and mount `/dev` in constructor:
```typescript
registerProvider(mountPath: string, provider: VirtualProvider): void {
  this.providers.set(mountPath, provider);
}
```

In `constructor()`, after `this.initDefaultLayout()`:
```typescript
this.registerProvider('/dev', new DevProvider());
```

**Step 5: Run test to verify it passes**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/providers.test.ts`
Expected: PASS

**Step 6: Run existing tests for regression**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/sandbox.test.ts`
Expected: All existing tests PASS

**Step 7: Commit**

```bash
git add packages/orchestrator/src/vfs/provider.ts packages/orchestrator/src/vfs/dev-provider.ts packages/orchestrator/src/vfs/vfs.ts packages/orchestrator/src/__tests__/providers.test.ts
git commit -m "feat: add VFS virtual provider interface with /dev devices"
```

---

### Task 2: `/dev/zero`, `/dev/random`, `/dev/urandom` tests

**Files:**
- Modify: `packages/orchestrator/src/__tests__/providers.test.ts`

**Step 1: Add tests for remaining /dev devices**

Append to the existing test file:

```typescript
it('/dev/zero returns zero bytes', () => {
  const vfs = new VFS();
  const data = vfs.readFile('/dev/zero');
  expect(data.byteLength).toBeGreaterThan(0);
  expect(data.every(b => b === 0)).toBe(true);
});

it('/dev/random returns bytes', () => {
  const vfs = new VFS();
  const data = vfs.readFile('/dev/random');
  expect(data.byteLength).toBeGreaterThan(0);
});

it('/dev/urandom returns bytes', () => {
  const vfs = new VFS();
  const data = vfs.readFile('/dev/urandom');
  expect(data.byteLength).toBeGreaterThan(0);
});

it('writing to /dev/zero throws EROFS', () => {
  const vfs = new VFS();
  expect(() => vfs.writeFile('/dev/zero', new Uint8Array(1))).toThrow(/EROFS/);
});

it('reading nonexistent /dev/foo throws ENOENT', () => {
  const vfs = new VFS();
  expect(() => vfs.readFile('/dev/foo')).toThrow(/ENOENT/);
});
```

**Step 2: Run tests**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/providers.test.ts`
Expected: All PASS (implementation already covers these)

**Step 3: Commit**

```bash
git add packages/orchestrator/src/__tests__/providers.test.ts
git commit -m "test: add /dev/zero, /dev/random, /dev/urandom tests"
```

---

### Task 3: `/proc` Provider

**Files:**
- Create: `packages/orchestrator/src/vfs/proc-provider.ts`
- Modify: `packages/orchestrator/src/vfs/vfs.ts` (mount `/proc` in constructor)
- Modify: `packages/orchestrator/src/__tests__/providers.test.ts`

**Step 1: Write failing tests**

Add to `providers.test.ts`:

```typescript
describe('/proc provider', () => {
  it('/proc/uptime returns a number string', () => {
    const vfs = new VFS();
    const data = new TextDecoder().decode(vfs.readFile('/proc/uptime'));
    expect(parseFloat(data)).toBeGreaterThanOrEqual(0);
  });

  it('/proc/version returns a string', () => {
    const vfs = new VFS();
    const data = new TextDecoder().decode(vfs.readFile('/proc/version'));
    expect(data.length).toBeGreaterThan(0);
  });

  it('/proc/cpuinfo returns content', () => {
    const vfs = new VFS();
    const data = new TextDecoder().decode(vfs.readFile('/proc/cpuinfo'));
    expect(data).toContain('processor');
  });

  it('/proc/meminfo returns content', () => {
    const vfs = new VFS();
    const data = new TextDecoder().decode(vfs.readFile('/proc/meminfo'));
    expect(data.length).toBeGreaterThan(0);
  });

  it('/proc is listable', () => {
    const vfs = new VFS();
    const entries = vfs.readdir('/proc');
    const names = entries.map(e => e.name);
    expect(names).toContain('uptime');
    expect(names).toContain('version');
    expect(names).toContain('cpuinfo');
    expect(names).toContain('meminfo');
  });

  it('/proc files are read-only', () => {
    const vfs = new VFS();
    expect(() => vfs.writeFile('/proc/uptime', new Uint8Array(1))).toThrow(/EROFS/);
  });
});
```

**Step 2: Run to verify failure**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/providers.test.ts`
Expected: FAIL — `/proc` not mounted

**Step 3: Implement ProcProvider**

Create `packages/orchestrator/src/vfs/proc-provider.ts`:

```typescript
import { VfsError } from './inode.js';
import type { VirtualProvider } from './provider.js';

const FILES = ['uptime', 'version', 'cpuinfo', 'meminfo'];

export class ProcProvider implements VirtualProvider {
  private startTime = Date.now();

  private generate(name: string): string {
    switch (name) {
      case 'uptime': {
        const secs = (Date.now() - this.startTime) / 1000;
        return `${secs.toFixed(2)} ${secs.toFixed(2)}\n`;
      }
      case 'version':
        return 'wasmsand 1.0.0 (WASI sandbox)\n';
      case 'cpuinfo': {
        const cores = typeof navigator !== 'undefined'
          ? navigator.hardwareConcurrency ?? 1
          : 1;
        let out = '';
        for (let i = 0; i < cores; i++) {
          out += `processor\t: ${i}\nmodel name\t: wasmsand virtual cpu\n\n`;
        }
        return out;
      }
      case 'meminfo':
        return 'MemTotal:       262144 kB\nMemFree:        131072 kB\nMemAvailable:   196608 kB\n';
      default:
        throw new VfsError('ENOENT', `no such file: /proc/${name}`);
    }
  }

  readFile(subpath: string): Uint8Array {
    return new TextEncoder().encode(this.generate(subpath));
  }

  writeFile(subpath: string, _data: Uint8Array): void {
    throw new VfsError('EROFS', `read-only filesystem: /proc/${subpath}`);
  }

  exists(subpath: string): boolean {
    return subpath === '' || FILES.includes(subpath);
  }

  stat(subpath: string): { type: 'file' | 'dir'; size: number } {
    if (subpath === '') return { type: 'dir', size: FILES.length };
    if (FILES.includes(subpath)) return { type: 'file', size: this.generate(subpath).length };
    throw new VfsError('ENOENT', `no such file: /proc/${subpath}`);
  }

  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }> {
    if (subpath !== '') throw new VfsError('ENOTDIR', `/proc/${subpath}`);
    return FILES.map(name => ({ name, type: 'file' as const }));
  }
}
```

Mount in VFS constructor (after DevProvider mount):
```typescript
import { ProcProvider } from './proc-provider.js';

// In constructor, after DevProvider:
this.registerProvider('/proc', new ProcProvider());
```

**Step 4: Run tests**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/providers.test.ts`
Expected: PASS

**Step 5: Run regression tests**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/sandbox.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add packages/orchestrator/src/vfs/proc-provider.ts packages/orchestrator/src/vfs/vfs.ts packages/orchestrator/src/__tests__/providers.test.ts
git commit -m "feat: add /proc virtual provider with uptime, version, cpuinfo, meminfo"
```

---

### Task 4: Verify providers work through Sandbox.run()

**Files:**
- Modify: `packages/orchestrator/src/__tests__/providers.test.ts`

**Step 1: Add integration test**

```typescript
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';
import { resolve } from 'node:path';
import { afterEach } from 'bun:test';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../shell/__tests__/fixtures/wasmsand-shell.wasm');

describe('providers via Sandbox.run()', () => {
  let sandbox: Sandbox;

  afterEach(() => { sandbox?.destroy(); });

  it('cat /dev/null returns empty', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const result = await sandbox.run('cat /dev/null');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('cat /proc/version returns wasmsand', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const result = await sandbox.run('cat /proc/version');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('wasmsand');
  });

  it('ls /dev lists devices', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const result = await sandbox.run('ls /dev');
    expect(result.stdout).toContain('null');
  });
});
```

**Step 2: Run tests**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/providers.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/orchestrator/src/__tests__/providers.test.ts
git commit -m "test: verify /dev and /proc providers work through Sandbox.run()"
```

---

### Task 5: Ensure providers survive snapshot/restore and fork

**Files:**
- Modify: `packages/orchestrator/src/__tests__/providers.test.ts`

Providers are registered on VFS construction and are not part of the inode tree, so snapshot/restore should not break them. Fork creates a new VFS via `cowClone()` — need to ensure `VFS.fromRoot()` also mounts providers.

**Step 1: Write failing test**

```typescript
describe('providers after snapshot/restore', () => {
  it('/dev/null works after restore', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const snapId = sandbox.snapshot();
    sandbox.restore(snapId);
    const data = sandbox.readFile('/dev/null');
    expect(data.byteLength).toBe(0);
  });
});

describe('providers in forked sandbox', () => {
  it('/proc/version available in fork', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const child = await sandbox.fork();
    try {
      const data = new TextDecoder().decode(child.readFile('/proc/version'));
      expect(data).toContain('wasmsand');
    } finally {
      child.destroy();
    }
  });
});
```

**Step 2: Run to check if they pass or fail**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/providers.test.ts`

If `cowClone()` doesn't carry providers, the fork test will fail.

**Step 3: Fix `cowClone()` if needed**

In `VFS.fromRoot()` (vfs.ts), mount providers:

```typescript
private static fromRoot(root: DirInode, options?: { ... }): VFS {
  const vfs = Object.create(VFS.prototype) as VFS;
  // ... existing assignments ...
  vfs.providers = new Map();
  vfs.registerProvider('/dev', new DevProvider());
  vfs.registerProvider('/proc', new ProcProvider());
  return vfs;
}
```

**Step 4: Run tests**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/providers.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/orchestrator/src/vfs/vfs.ts packages/orchestrator/src/__tests__/providers.test.ts
git commit -m "fix: mount virtual providers in cowClone so forks have /dev and /proc"
```

---

## Phase 2: Package Manager (`pkg`)

### Task 6: PackagePolicy types and security integration

**Files:**
- Modify: `packages/orchestrator/src/security.ts:1-11`
- Test: `packages/orchestrator/src/__tests__/pkg.test.ts`

**Step 1: Write failing test**

Create `packages/orchestrator/src/__tests__/pkg.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import type { SecurityOptions } from '../security.js';

describe('PackagePolicy types', () => {
  it('PackagePolicy is accepted in SecurityOptions', () => {
    const opts: SecurityOptions = {
      packagePolicy: {
        enabled: true,
        allowedHosts: ['example.com'],
        maxPackageBytes: 1024 * 1024,
        maxInstalledPackages: 50,
      },
    };
    expect(opts.packagePolicy?.enabled).toBe(true);
  });
});
```

**Step 2: Run to verify it fails**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/pkg.test.ts`
Expected: FAIL — `packagePolicy` not in `SecurityOptions`

**Step 3: Add PackagePolicy to security.ts**

```typescript
export interface PackagePolicy {
  /** Whether pkg commands are enabled. Default false. */
  enabled: boolean;
  /** Allowed hosts for package downloads. Uses same matching as NetworkPolicy. */
  allowedHosts?: string[];
  /** Max bytes per individual package. Default 5MB. */
  maxPackageBytes?: number;
  /** Max number of installed packages. Default 100. */
  maxInstalledPackages?: number;
}

// Add to SecurityOptions:
export interface SecurityOptions {
  toolAllowlist?: string[];
  limits?: SecurityLimits;
  onAuditEvent?: AuditEventHandler;
  hardKill?: boolean;
  /** Package manager policy. Disabled by default. */
  packagePolicy?: PackagePolicy;
}
```

**Step 4: Run test**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/pkg.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/orchestrator/src/security.ts packages/orchestrator/src/__tests__/pkg.test.ts
git commit -m "feat: add PackagePolicy type to SecurityOptions"
```

---

### Task 7: PackageManager core — install, list, info, remove

**Files:**
- Create: `packages/orchestrator/src/pkg/manager.ts`
- Modify: `packages/orchestrator/src/__tests__/pkg.test.ts`

The PackageManager operates on VFS only. It stores:
- WASM binaries at `/usr/share/pkg/bin/<name>.wasm`
- Metadata at `/usr/share/pkg/packages.json`

It delegates actual network fetching to a callback (injected by Sandbox), keeping the manager pure VFS logic.

**Step 1: Write failing tests**

```typescript
import { VFS } from '../vfs/vfs.js';
import { PackageManager } from '../pkg/manager.js';

describe('PackageManager', () => {
  function createMgr(opts?: { maxPackageBytes?: number; maxInstalledPackages?: number }) {
    const vfs = new VFS();
    return new PackageManager(vfs, {
      enabled: true,
      maxPackageBytes: opts?.maxPackageBytes,
      maxInstalledPackages: opts?.maxInstalledPackages,
    });
  }

  it('install stores wasm binary and metadata', () => {
    const vfs = new VFS();
    const mgr = new PackageManager(vfs, { enabled: true });
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d]); // WASM magic
    mgr.install('mytool', wasmBytes, 'https://example.com/mytool.wasm');
    const stored = vfs.readFile('/usr/share/pkg/bin/mytool.wasm');
    expect(stored).toEqual(wasmBytes);
  });

  it('list returns installed packages', () => {
    const mgr = createMgr();
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
    mgr.install('tool-a', wasm, 'https://example.com/a.wasm');
    mgr.install('tool-b', wasm, 'https://example.com/b.wasm');
    const list = mgr.list();
    expect(list).toHaveLength(2);
    expect(list.map(p => p.name).sort()).toEqual(['tool-a', 'tool-b']);
  });

  it('info returns package details', () => {
    const mgr = createMgr();
    const wasm = new Uint8Array(100);
    mgr.install('atool', wasm, 'https://example.com/atool.wasm');
    const info = mgr.info('atool');
    expect(info).not.toBeNull();
    expect(info!.name).toBe('atool');
    expect(info!.size).toBe(100);
    expect(info!.url).toBe('https://example.com/atool.wasm');
  });

  it('info returns null for unknown package', () => {
    const mgr = createMgr();
    expect(mgr.info('nope')).toBeNull();
  });

  it('remove deletes package files and metadata', () => {
    const vfs = new VFS();
    const mgr = new PackageManager(vfs, { enabled: true });
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
    mgr.install('removeme', wasm, 'https://example.com/removeme.wasm');
    mgr.remove('removeme');
    expect(mgr.list()).toHaveLength(0);
    expect(() => vfs.readFile('/usr/share/pkg/bin/removeme.wasm')).toThrow();
  });

  it('remove throws for unknown package', () => {
    const mgr = createMgr();
    expect(() => mgr.remove('nope')).toThrow(/E_PKG_NOT_FOUND/);
  });

  it('install rejects when disabled', () => {
    const vfs = new VFS();
    const mgr = new PackageManager(vfs, { enabled: false });
    expect(() => mgr.install('x', new Uint8Array(1), 'url')).toThrow(/E_PKG_DISABLED/);
  });

  it('install rejects duplicate name', () => {
    const mgr = createMgr();
    const wasm = new Uint8Array(1);
    mgr.install('dup', wasm, 'https://example.com/dup.wasm');
    expect(() => mgr.install('dup', wasm, 'https://example.com/dup.wasm')).toThrow(/E_PKG_EXISTS/);
  });

  it('install rejects oversized package', () => {
    const mgr = createMgr({ maxPackageBytes: 100 });
    expect(() => mgr.install('big', new Uint8Array(200), 'url')).toThrow(/E_PKG_TOO_LARGE/);
  });

  it('install rejects when max packages reached', () => {
    const mgr = createMgr({ maxInstalledPackages: 2 });
    mgr.install('a', new Uint8Array(1), 'url-a');
    mgr.install('b', new Uint8Array(1), 'url-b');
    expect(() => mgr.install('c', new Uint8Array(1), 'url-c')).toThrow(/E_PKG_LIMIT/);
  });
});
```

**Step 2: Run to verify failure**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/pkg.test.ts`
Expected: FAIL — module not found

**Step 3: Implement PackageManager**

Create `packages/orchestrator/src/pkg/manager.ts`:

```typescript
/**
 * Sandbox-native package manager.
 *
 * Manages WASI binary packages in the VFS. Packages are stored as .wasm
 * files and tracked via a JSON metadata file. The manager does not perform
 * network fetching — callers provide the binary content.
 */

import type { VfsLike } from '../vfs/vfs-like.js';
import type { PackagePolicy } from '../security.js';

const PKG_BIN = '/usr/share/pkg/bin';
const PKG_META = '/usr/share/pkg/packages.json';

export interface PackageInfo {
  name: string;
  url: string;
  size: number;
  installedAt: number;
}

export class PkgError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PkgError';
  }
}

export class PackageManager {
  private vfs: VfsLike;
  private policy: PackagePolicy;
  private packages: Map<string, PackageInfo> = new Map();

  constructor(vfs: VfsLike, policy: PackagePolicy) {
    this.vfs = vfs;
    this.policy = policy;
    this.ensureDirs();
    this.loadMetadata();
  }

  install(name: string, wasmBytes: Uint8Array, sourceUrl: string): void {
    if (!this.policy.enabled) {
      throw new PkgError('E_PKG_DISABLED', 'package manager is disabled');
    }
    if (this.packages.has(name)) {
      throw new PkgError('E_PKG_EXISTS', `package already installed: ${name}`);
    }
    if (this.policy.maxPackageBytes && wasmBytes.byteLength > this.policy.maxPackageBytes) {
      throw new PkgError('E_PKG_TOO_LARGE', `package exceeds size limit: ${wasmBytes.byteLength} > ${this.policy.maxPackageBytes}`);
    }
    if (this.policy.maxInstalledPackages && this.packages.size >= this.policy.maxInstalledPackages) {
      throw new PkgError('E_PKG_LIMIT', `max installed packages reached: ${this.policy.maxInstalledPackages}`);
    }

    const info: PackageInfo = {
      name,
      url: sourceUrl,
      size: wasmBytes.byteLength,
      installedAt: Date.now(),
    };

    this.vfs.withWriteAccess(() => {
      this.vfs.writeFile(`${PKG_BIN}/${name}.wasm`, wasmBytes);
    });

    this.packages.set(name, info);
    this.saveMetadata();
  }

  remove(name: string): void {
    if (!this.packages.has(name)) {
      throw new PkgError('E_PKG_NOT_FOUND', `package not found: ${name}`);
    }
    this.vfs.withWriteAccess(() => {
      this.vfs.unlink(`${PKG_BIN}/${name}.wasm`);
    });
    this.packages.delete(name);
    this.saveMetadata();
  }

  list(): PackageInfo[] {
    return Array.from(this.packages.values());
  }

  info(name: string): PackageInfo | null {
    return this.packages.get(name) ?? null;
  }

  /** Return the VFS path to a package's wasm binary, or null. */
  getWasmPath(name: string): string | null {
    if (!this.packages.has(name)) return null;
    return `${PKG_BIN}/${name}.wasm`;
  }

  private ensureDirs(): void {
    this.vfs.withWriteAccess(() => {
      this.vfs.mkdirp('/usr/share/pkg');
      this.vfs.mkdirp(PKG_BIN);
    });
  }

  private loadMetadata(): void {
    try {
      const raw = this.vfs.readFile(PKG_META);
      const data = JSON.parse(new TextDecoder().decode(raw)) as PackageInfo[];
      for (const pkg of data) {
        this.packages.set(pkg.name, pkg);
      }
    } catch {
      // No metadata file yet — fresh install
    }
  }

  private saveMetadata(): void {
    const data = JSON.stringify(Array.from(this.packages.values()), null, 2);
    this.vfs.withWriteAccess(() => {
      this.vfs.writeFile(PKG_META, new TextEncoder().encode(data));
    });
  }
}
```

**Step 4: Run tests**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/pkg.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/orchestrator/src/pkg/manager.ts packages/orchestrator/src/__tests__/pkg.test.ts
git commit -m "feat: add PackageManager for WASI binary package install/remove/list/info"
```

---

### Task 8: `pkg` shell builtin + host-checking fetch

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-runner.ts:23,469-500` (add `pkg` to SHELL_BUILTINS and dispatch)
- Modify: `packages/orchestrator/src/sandbox.ts:98-184` (create PackageManager during Sandbox.create, pass to ShellRunner)
- Modify: `packages/orchestrator/src/__tests__/pkg.test.ts`

The `pkg` builtin subcommands:
- `pkg install <url> [--name <name>]` — fetch URL, validate host, install as WASI binary
- `pkg remove <name>` — remove package
- `pkg list` — list installed packages
- `pkg info <name>` — show package details

**Step 1: Write integration test**

Add to `pkg.test.ts`:

```typescript
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';
import { resolve } from 'node:path';
import { afterEach } from 'bun:test';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../shell/__tests__/fixtures/wasmsand-shell.wasm');

describe('pkg shell builtin', () => {
  let sandbox: Sandbox;

  afterEach(() => { sandbox?.destroy(); });

  it('pkg list returns empty initially', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter(),
      security: { packagePolicy: { enabled: true } },
    });
    const result = await sandbox.run('pkg list');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('pkg returns error when disabled', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter(),
    });
    const result = await sandbox.run('pkg list');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('disabled');
  });

  it('pkg install rejects denied host', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter(),
      security: { packagePolicy: { enabled: true, allowedHosts: ['trusted.example.com'] } },
    });
    const result = await sandbox.run('pkg install https://evil.com/malware.wasm');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('E_PKG_HOST_DENIED');
  });

  it('pkg info on unknown package returns not found', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter(),
      security: { packagePolicy: { enabled: true } },
    });
    const result = await sandbox.run('pkg info nonexistent');
    expect(result.exitCode).not.toBe(0);
  });

  it('pkg with no subcommand shows usage', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter(),
      security: { packagePolicy: { enabled: true } },
    });
    const result = await sandbox.run('pkg');
    expect(result.stderr).toContain('usage');
  });
});
```

**Step 2: Run to verify failure**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/pkg.test.ts`
Expected: FAIL — `pkg` not a known command

**Step 3: Wire PackageManager into Sandbox and ShellRunner**

In `shell-runner.ts`:
- Add `'pkg'` to `SHELL_BUILTINS` set
- Add `PackageManager` field and setter
- Add `builtinPkg()` method
- Add dispatch in the builtin chain

In `sandbox.ts`:
- Create `PackageManager` in `Sandbox.create()` when `packagePolicy` exists
- Pass to ShellRunner

Details left to implementation — follow existing builtin patterns (e.g. `builtinCurl`). Key points:

- Host checking: Extract hostname from URL, check against `packagePolicy.allowedHosts` using same logic as `NetworkGateway.matchesHostList()`. If `allowedHosts` is undefined and policy is enabled, allow all hosts.
- Fetch: Use `globalThis.fetch()` for the actual download (same as `builtinCurl`).
- After download: Call `PackageManager.install()`, then register tool with `ProcessManager.registerTool()` so the installed package is immediately runnable.
- Audit: Emit `package.install.start`, `package.install.complete`, `package.install.denied`, `package.remove` events.

**Step 4: Run tests**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/pkg.test.ts`
Expected: PASS

**Step 5: Run full regression**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/sandbox.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add packages/orchestrator/src/shell/shell-runner.ts packages/orchestrator/src/sandbox.ts packages/orchestrator/src/__tests__/pkg.test.ts
git commit -m "feat: add pkg shell builtin for WASI binary package management"
```

---

### Task 9: Audit events for package operations

**Files:**
- Modify: `packages/orchestrator/src/__tests__/pkg.test.ts`
- Modify: `packages/orchestrator/src/sandbox.ts` or `packages/orchestrator/src/shell/shell-runner.ts` (wherever audit calls live)

**Step 1: Write test**

```typescript
describe('pkg audit events', () => {
  it('emits package.install.denied for blocked host', async () => {
    const events: any[] = [];
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter(),
      security: {
        packagePolicy: { enabled: true, allowedHosts: ['trusted.com'] },
        onAuditEvent: (e) => events.push(e),
      },
    });
    await sandbox.run('pkg install https://evil.com/x.wasm');
    expect(events.find(e => e.type === 'package.install.denied')).toBeDefined();
  });
});
```

**Step 2: Run, verify the audit event is emitted (may already be implemented in Task 8)**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/pkg.test.ts`

**Step 3: Add audit calls if missing, run again**

**Step 4: Commit**

```bash
git add packages/orchestrator/src/__tests__/pkg.test.ts packages/orchestrator/src/shell/shell-runner.ts
git commit -m "feat: emit audit events for package install/remove/denied"
```

---

## Phase 3: Persistence Modes

### Task 10: Persistence types and export/import state

**Files:**
- Create: `packages/orchestrator/src/persistence/types.ts`
- Create: `packages/orchestrator/src/persistence/serializer.ts`
- Test: `packages/orchestrator/src/__tests__/persistence.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'bun:test';
import { VFS } from '../vfs/vfs.js';
import { exportState, importState } from '../persistence/serializer.js';

describe('persistence serializer', () => {
  it('export/import round-trips VFS state', () => {
    const vfs = new VFS();
    vfs.writeFile('/tmp/hello.txt', new TextEncoder().encode('hello'));
    vfs.mkdir('/tmp/subdir');
    vfs.writeFile('/tmp/subdir/nested.txt', new TextEncoder().encode('nested'));

    const blob = exportState(vfs);
    expect(blob.byteLength).toBeGreaterThan(0);

    const vfs2 = new VFS();
    importState(vfs2, blob);
    expect(new TextDecoder().decode(vfs2.readFile('/tmp/hello.txt'))).toBe('hello');
    expect(new TextDecoder().decode(vfs2.readFile('/tmp/subdir/nested.txt'))).toBe('nested');
  });

  it('export/import preserves env vars', () => {
    const env = new Map([['FOO', 'bar'], ['BAZ', 'qux']]);
    const vfs = new VFS();
    const blob = exportState(vfs, env);

    const vfs2 = new VFS();
    const restored = importState(vfs2, blob);
    expect(restored.env?.get('FOO')).toBe('bar');
    expect(restored.env?.get('BAZ')).toBe('qux');
  });

  it('import rejects corrupted data', () => {
    const vfs = new VFS();
    expect(() => importState(vfs, new Uint8Array([1, 2, 3]))).toThrow();
  });

  it('export does not include /proc or /dev contents', () => {
    const vfs = new VFS();
    vfs.writeFile('/tmp/real.txt', new TextEncoder().encode('real'));
    const blob = exportState(vfs);
    const text = new TextDecoder().decode(blob);
    expect(text).not.toContain('/proc/');
    expect(text).not.toContain('/dev/');
  });
});
```

**Step 2: Run to verify failure**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/persistence.test.ts`
Expected: FAIL — modules don't exist

**Step 3: Implement types and serializer**

Create `packages/orchestrator/src/persistence/types.ts`:

```typescript
export interface PersistenceOptions {
  mode: 'ephemeral' | 'session' | 'persistent';
  namespace?: string;
  autosaveMs?: number;
}
```

Create `packages/orchestrator/src/persistence/serializer.ts`:

```typescript
/**
 * VFS state serializer.
 *
 * Serializes the writable portions of the VFS (excluding virtual providers
 * at /dev and /proc) into a single Uint8Array blob. Format:
 *
 *   [4 bytes: magic "WSND"]
 *   [4 bytes: version = 1]
 *   [rest: JSON of { files: { path: base64content }[], env?: [k,v][] }]
 */

import type { VfsLike } from '../vfs/vfs-like.js';

const MAGIC = new Uint8Array([0x57, 0x53, 0x4E, 0x44]); // "WSND"
const VERSION = 1;
const EXCLUDED_PREFIXES = ['/dev', '/proc'];

interface SerializedState {
  version: number;
  files: Array<{ path: string; data: string; type: 'file' | 'dir' }>;
  env?: [string, string][];
}

function walkAndSerialize(vfs: VfsLike, dir: string): Array<{ path: string; data: string; type: 'file' | 'dir' }> {
  const results: Array<{ path: string; data: string; type: 'file' | 'dir' }> = [];

  if (EXCLUDED_PREFIXES.some(p => dir === p || dir.startsWith(p + '/'))) {
    return results;
  }

  let entries;
  try {
    entries = vfs.readdir(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
    if (EXCLUDED_PREFIXES.some(p => fullPath === p || fullPath.startsWith(p + '/'))) {
      continue;
    }
    if (entry.type === 'dir') {
      results.push({ path: fullPath, data: '', type: 'dir' });
      results.push(...walkAndSerialize(vfs, fullPath));
    } else if (entry.type === 'file') {
      const content = vfs.readFile(fullPath);
      const b64 = btoa(String.fromCharCode(...content));
      results.push({ path: fullPath, data: b64, type: 'file' });
    }
  }

  return results;
}

export function exportState(vfs: VfsLike, env?: Map<string, string>): Uint8Array {
  const state: SerializedState = {
    version: VERSION,
    files: walkAndSerialize(vfs, '/'),
    env: env ? Array.from(env.entries()) : undefined,
  };

  const json = JSON.stringify(state);
  const jsonBytes = new TextEncoder().encode(json);
  const result = new Uint8Array(8 + jsonBytes.byteLength);
  result.set(MAGIC, 0);
  new DataView(result.buffer).setUint32(4, VERSION, true);
  result.set(jsonBytes, 8);
  return result;
}

export function importState(vfs: VfsLike, blob: Uint8Array): { env?: Map<string, string> } {
  if (blob.byteLength < 8) throw new Error('Invalid state blob: too short');
  for (let i = 0; i < 4; i++) {
    if (blob[i] !== MAGIC[i]) throw new Error('Invalid state blob: bad magic');
  }
  const version = new DataView(blob.buffer, blob.byteOffset).getUint32(4, true);
  if (version !== VERSION) throw new Error(`Unsupported state version: ${version}`);

  const json = new TextDecoder().decode(blob.slice(8));
  const state: SerializedState = JSON.parse(json);

  vfs.withWriteAccess(() => {
    // Create directories first (sorted by depth)
    for (const entry of state.files) {
      if (entry.type === 'dir') {
        vfs.mkdirp(entry.path);
      }
    }
    // Then write files
    for (const entry of state.files) {
      if (entry.type === 'file') {
        const bytes = Uint8Array.from(atob(entry.data), c => c.charCodeAt(0));
        vfs.writeFile(entry.path, bytes);
      }
    }
  });

  const env = state.env ? new Map(state.env) : undefined;
  return { env };
}
```

**Step 4: Run tests**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/persistence.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/orchestrator/src/persistence/types.ts packages/orchestrator/src/persistence/serializer.ts packages/orchestrator/src/__tests__/persistence.test.ts
git commit -m "feat: add VFS state export/import serializer with env support"
```

---

### Task 11: Sandbox.exportState() and Sandbox.importState()

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts` (add `exportState`, `importState` methods)
- Modify: `packages/orchestrator/src/__tests__/persistence.test.ts`

**Step 1: Write failing test**

```typescript
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';
import { resolve } from 'node:path';
import { afterEach } from 'bun:test';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../shell/__tests__/fixtures/wasmsand-shell.wasm');

describe('Sandbox persistence', () => {
  let sandbox: Sandbox;
  afterEach(() => { sandbox?.destroy(); });

  it('exportState and importState round-trip', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/persist.txt', new TextEncoder().encode('persisted'));
    sandbox.setEnv('PERSIST_VAR', 'saved');

    const blob = sandbox.exportState();

    const sandbox2 = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    sandbox2.importState(blob);

    expect(new TextDecoder().decode(sandbox2.readFile('/tmp/persist.txt'))).toBe('persisted');
    expect(sandbox2.getEnv('PERSIST_VAR')).toBe('saved');
    sandbox2.destroy();
  });
});
```

**Step 2: Run to verify failure**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/persistence.test.ts`
Expected: FAIL — `exportState` not on Sandbox

**Step 3: Add methods to Sandbox**

```typescript
import { exportState, importState } from './persistence/serializer.js';

// In Sandbox class:
exportState(): Uint8Array {
  this.assertAlive();
  return exportState(this.vfs, this.runner.getEnvMap());
}

importState(blob: Uint8Array): void {
  this.assertAlive();
  const { env } = importState(this.vfs, blob);
  if (env) {
    this.runner.setEnvMap(env);
  }
}
```

**Step 4: Run tests**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/persistence.test.ts`
Expected: PASS

**Step 5: Run regression**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/sandbox.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/orchestrator/src/__tests__/persistence.test.ts
git commit -m "feat: add Sandbox.exportState() and Sandbox.importState()"
```

---

### Task 12: RPC dispatcher — persistence + pkg methods

**Files:**
- Modify: `packages/sdk-server/src/dispatcher.ts`
- Modify: `packages/sdk-server/src/dispatcher.test.ts` (or create if not exists)

**Step 1: Update SandboxLike interface and add dispatch methods**

Add to `SandboxLike`:
```typescript
exportState(): Uint8Array;
importState(blob: Uint8Array): void;
```

Add dispatch cases:
```typescript
case 'persistence.export':
  return this.persistenceExport(params);
case 'persistence.import':
  return this.persistenceImport(params);
```

Implementation:
```typescript
private persistenceExport(params: Record<string, unknown>) {
  const sb = this.resolveSandbox(params);
  const blob = sb.exportState();
  return { data: Buffer.from(blob).toString('base64') };
}

private persistenceImport(params: Record<string, unknown>) {
  const sb = this.resolveSandbox(params);
  const data = this.requireString(params, 'data');
  const blob = new Uint8Array(Buffer.from(data, 'base64'));
  sb.importState(blob);
  return { ok: true };
}
```

**Step 2: Test and commit**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/sdk-server/`
Expected: PASS

```bash
git add packages/sdk-server/src/dispatcher.ts
git commit -m "feat: add persistence.export and persistence.import RPC methods"
```

---

### Task 13: Python SDK — persistence methods

**Files:**
- Modify: `packages/python-sdk/src/wasmsand/sandbox.py`
- Modify: `packages/python-sdk/tests/test_sandbox.py`

**Step 1: Add methods to Sandbox class**

```python
def export_state(self) -> bytes:
    """Export VFS + env as a binary blob."""
    result = self._client.call("persistence.export", self._with_id({}))
    import base64
    return base64.b64decode(result["data"])

def import_state(self, blob: bytes) -> None:
    """Import a previously exported state blob."""
    import base64
    data = base64.b64encode(blob).decode("ascii")
    self._client.call("persistence.import", self._with_id({"data": data}))
```

**Step 2: Add test**

```python
def test_export_import_roundtrip(sandbox):
    sandbox.files.write("/tmp/persist.txt", b"persisted data")
    blob = sandbox.export_state()
    assert len(blob) > 0
    # Import into a fresh state (after writing something else)
    sandbox.files.write("/tmp/persist.txt", b"overwritten")
    sandbox.import_state(blob)
    content = sandbox.files.read("/tmp/persist.txt")
    assert content == b"persisted data"
```

**Step 3: Run tests**

Run: `cd /Users/sunny/work/wasmsand && python -m pytest packages/python-sdk/tests/test_sandbox.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/python-sdk/src/wasmsand/sandbox.py packages/python-sdk/tests/test_sandbox.py
git commit -m "feat: add export_state/import_state to Python SDK"
```

---

## Phase 4: Shell Ergonomics

### Task 14: Command history tracking

**Files:**
- Create: `packages/orchestrator/src/shell/history.ts`
- Modify: `packages/orchestrator/src/shell/shell-runner.ts` (record commands in history)
- Test: `packages/orchestrator/src/__tests__/shell-ergonomics.test.ts`

**Step 1: Write failing test**

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';
import { resolve } from 'node:path';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../shell/__tests__/fixtures/wasmsand-shell.wasm');

describe('shell history', () => {
  let sandbox: Sandbox;
  afterEach(() => { sandbox?.destroy(); });

  it('history list returns executed commands', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    await sandbox.run('echo hello');
    await sandbox.run('echo world');
    const result = await sandbox.run('history list');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('echo hello');
    expect(result.stdout).toContain('echo world');
  });

  it('history clear empties history', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    await sandbox.run('echo hello');
    await sandbox.run('history clear');
    const result = await sandbox.run('history list');
    // Only 'history clear' and 'history list' should be present, not 'echo hello'
    expect(result.stdout).not.toContain('echo hello');
  });
});
```

**Step 2: Run to verify failure**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/shell-ergonomics.test.ts`
Expected: FAIL

**Step 3: Implement CommandHistory**

Create `packages/orchestrator/src/shell/history.ts`:

```typescript
export interface HistoryEntry {
  index: number;
  command: string;
  timestamp: number;
}

export class CommandHistory {
  private entries: HistoryEntry[] = [];
  private nextIndex = 1;

  add(command: string): void {
    this.entries.push({
      index: this.nextIndex++,
      command,
      timestamp: Date.now(),
    });
  }

  list(): HistoryEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    // Don't reset nextIndex — matches bash behavior
  }
}
```

Wire into ShellRunner:
- Add `history` field, initialize in constructor
- Call `this.history.add(command)` at start of `run()`
- Add `'history'` to `SHELL_BUILTINS`
- Implement `builtinHistory(args)`:
  - `list`: format entries as `  N  command`
  - `clear`: call `this.history.clear()`

**Step 4: Run tests**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/shell-ergonomics.test.ts`
Expected: PASS

**Step 5: Run regression**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/sandbox.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/orchestrator/src/shell/history.ts packages/orchestrator/src/shell/shell-runner.ts packages/orchestrator/src/__tests__/shell-ergonomics.test.ts
git commit -m "feat: add command history tracking with history list/clear builtins"
```

---

### Task 15: Shell history + persistence RPC methods

**Files:**
- Modify: `packages/sdk-server/src/dispatcher.ts`
- Modify: `packages/orchestrator/src/sandbox.ts` (expose history API)

**Step 1: Add history methods to Sandbox**

```typescript
getHistory(): Array<{ index: number; command: string; timestamp: number }> {
  this.assertAlive();
  return this.runner.getHistory();
}

clearHistory(): void {
  this.assertAlive();
  this.runner.clearHistory();
}
```

(And corresponding methods on ShellRunner that delegate to CommandHistory.)

**Step 2: Add dispatch cases**

```typescript
case 'shell.history.list':
  return this.shellHistoryList(params);
case 'shell.history.clear':
  return this.shellHistoryClear(params);
```

**Step 3: Update SandboxLike interface, implement, test, commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/sdk-server/src/dispatcher.ts packages/orchestrator/src/shell/shell-runner.ts
git commit -m "feat: add shell.history.list and shell.history.clear RPC methods"
```

---

### Task 16: Export orchestrator types

**Files:**
- Modify: `packages/orchestrator/src/index.ts`

**Step 1: Add new exports**

```typescript
export type { VirtualProvider } from './vfs/provider.js';
export { DevProvider } from './vfs/dev-provider.js';
export { ProcProvider } from './vfs/proc-provider.js';
export { PackageManager, PkgError } from './pkg/manager.js';
export type { PackageInfo } from './pkg/manager.js';
export type { PackagePolicy } from './security.js';
export type { PersistenceOptions } from './persistence/types.js';
export { exportState, importState } from './persistence/serializer.js';
```

**Step 2: Verify build**

Run: `cd /Users/sunny/work/wasmsand && bun build packages/orchestrator/src/index.ts --target=node`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/orchestrator/src/index.ts
git commit -m "feat: export new types and modules from orchestrator package index"
```

---

### Task 17: Full integration test suite

**Files:**
- Modify: `packages/orchestrator/src/__tests__/sandbox.test.ts` (add end-to-end tests)

**Step 1: Add integration tests covering cross-feature scenarios**

```typescript
describe('integrated features', () => {
  it('installed package survives export/import', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter(),
      security: { packagePolicy: { enabled: true } },
    });
    // Manually inject a fake wasm to simulate install
    sandbox.writeFile('/usr/share/pkg/bin/faketool.wasm', new Uint8Array([0, 0x61, 0x73, 0x6d]));
    const blob = sandbox.exportState();

    const sandbox2 = await Sandbox.create({
      wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter(),
      security: { packagePolicy: { enabled: true } },
    });
    sandbox2.importState(blob);
    const data = sandbox2.readFile('/usr/share/pkg/bin/faketool.wasm');
    expect(data[1]).toBe(0x61); // 'a' from wasm magic
    sandbox2.destroy();
  });

  it('/proc/uptime increases between reads', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const r1 = await sandbox.run('cat /proc/uptime');
    await new Promise(r => setTimeout(r, 50));
    const r2 = await sandbox.run('cat /proc/uptime');
    const t1 = parseFloat(r1.stdout);
    const t2 = parseFloat(r2.stdout);
    expect(t2).toBeGreaterThan(t1);
  });
});
```

**Step 2: Run all tests**

Run: `cd /Users/sunny/work/wasmsand && bun test packages/orchestrator/src/__tests__/`
Expected: All PASS

**Step 3: Commit**

```bash
git add packages/orchestrator/src/__tests__/sandbox.test.ts
git commit -m "test: add integrated feature tests for pkg persistence and providers"
```

---

## Summary

| Task | Feature | Effort |
|------|---------|--------|
| 1-5 | `/dev` + `/proc` virtual providers | ~1-2 hours |
| 6-9 | `pkg` package manager (WASI binaries) | ~2-3 hours |
| 10-13 | Persistence export/import + RPC + Python SDK | ~1-2 hours |
| 14-15 | Shell history tracking | ~1 hour |
| 16-17 | Exports + integration tests | ~30 min |

Total: ~17 tasks, 5-8 hours of implementation.

**Dropped from original spec:**
- JS runtime (P2) — breaks sandbox security boundary
- Job control (`fg`/`bg`/`jobs`) — wasmsand executes commands synchronously via WASM; there's no background process model to manage. Could be added later if async execution is added.
- Tab completion API — low value for LLM consumers who don't use interactive shells
