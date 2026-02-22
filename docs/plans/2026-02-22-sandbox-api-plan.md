# Sandbox API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a public `Sandbox` class that wraps VFS, ProcessManager, and ShellRunner behind a clean `create()` / `run()` / file I/O API with convention-based tool discovery, command timeout, and VFS size limits.

**Architecture:** Thin facade in `sandbox.ts` composing existing internals. `scanTools()` added to `PlatformAdapter` for cross-platform tool discovery. VFS gains size tracking for ENOSPC enforcement.

**Tech Stack:** TypeScript, vitest, wasm32-wasip1 fixtures.

---

### Task 1: Add `scanTools` to PlatformAdapter and Implement for Node

**Files:**
- Modify: `packages/orchestrator/src/platform/adapter.ts`
- Modify: `packages/orchestrator/src/platform/node-adapter.ts`
- Modify: `packages/orchestrator/src/platform/browser-adapter.ts`

**Context:** `scanTools` takes a directory path (Node) or URL base (browser) and returns a `Map<string, string>` mapping tool names to their wasm paths/URLs. The Node adapter reads the directory with `fs.readdir()`. The browser adapter returns a hardcoded list. Special cases: `true-cmd.wasm` → `true`, `false-cmd.wasm` → `false`, `wasmsand-shell.wasm` and `python3.wasm` are excluded (registered separately).

**Step 1: Update the interface**

In `packages/orchestrator/src/platform/adapter.ts`, add to the `PlatformAdapter` interface:

```typescript
export interface PlatformAdapter {
  /** Load a .wasm module from a path (Node: filesystem) or URL (Browser: fetch). */
  loadModule(pathOrUrl: string): Promise<WebAssembly.Module>;

  /** Instantiate a module with the given import object. */
  instantiate(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance>;

  /**
   * Scan a directory (Node) or URL base (browser) for .wasm tool binaries.
   * Returns a map of tool name → wasm path/URL.
   * Excludes shell parser and python binaries (registered separately).
   */
  scanTools(wasmDir: string): Promise<Map<string, string>>;
}
```

**Step 2: Implement for NodeAdapter**

In `packages/orchestrator/src/platform/node-adapter.ts`:

```typescript
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PlatformAdapter } from './adapter.js';

/** Wasm files that are not coreutils tools — registered separately. */
const EXCLUDED = new Set(['wasmsand-shell.wasm', 'python3.wasm']);

/** Map special wasm filenames to their tool names. */
function wasmToToolName(filename: string): string {
  if (filename === 'true-cmd.wasm') return 'true';
  if (filename === 'false-cmd.wasm') return 'false';
  return filename.replace(/\.wasm$/, '');
}

export class NodeAdapter implements PlatformAdapter {
  async loadModule(path: string): Promise<WebAssembly.Module> {
    const buffer = await readFile(path);
    return WebAssembly.compile(buffer);
  }

  async instantiate(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance> {
    return new WebAssembly.Instance(module, imports);
  }

  async scanTools(wasmDir: string): Promise<Map<string, string>> {
    const entries = await readdir(wasmDir);
    const tools = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.endsWith('.wasm') || EXCLUDED.has(entry)) continue;
      const name = wasmToToolName(entry);
      tools.set(name, resolve(wasmDir, entry));
    }
    return tools;
  }
}
```

**Step 3: Implement for BrowserAdapter**

In `packages/orchestrator/src/platform/browser-adapter.ts`:

```typescript
import type { PlatformAdapter } from './adapter.js';

const BROWSER_TOOLS = [
  'cat', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep',
  'ls', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'tee', 'tr', 'cut',
  'basename', 'dirname', 'env', 'printf', 'find', 'sed', 'awk', 'jq',
  'uname', 'whoami', 'id', 'printenv', 'yes', 'rmdir', 'sleep', 'seq',
  'ln', 'readlink', 'realpath', 'mktemp', 'tac',
  'xargs', 'expr', 'diff',
];

/** Map tool name to wasm filename. */
function toolToWasmFile(name: string): string {
  if (name === 'true') return 'true-cmd.wasm';
  if (name === 'false') return 'false-cmd.wasm';
  return `${name}.wasm`;
}

export class BrowserAdapter implements PlatformAdapter {
  async loadModule(url: string): Promise<WebAssembly.Module> {
    const response = await fetch(url);
    return WebAssembly.compileStreaming(response);
  }

  async instantiate(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance> {
    const result = await WebAssembly.instantiate(module, imports);
    return result;
  }

  async scanTools(wasmBase: string): Promise<Map<string, string>> {
    const tools = new Map<string, string>();
    for (const name of BROWSER_TOOLS) {
      tools.set(name, `${wasmBase}/${toolToWasmFile(name)}`);
    }
    tools.set('true', `${wasmBase}/true-cmd.wasm`);
    tools.set('false', `${wasmBase}/false-cmd.wasm`);
    return tools;
  }
}
```

**Step 4: Run existing tests to verify no regressions**

Run: `cd packages/orchestrator && npx vitest run`

Expected: All 290 tests pass (interface addition is non-breaking).

**Step 5: Commit**

```bash
git add packages/orchestrator/src/platform/
git commit -m "feat: add scanTools to PlatformAdapter for convention-based tool discovery"
```

---

### Task 2: Add VFS Size Limit

**Files:**
- Modify: `packages/orchestrator/src/vfs/vfs.ts`
- Modify: `packages/orchestrator/src/vfs/__tests__/vfs.test.ts`

**Context:** VFS needs to track total bytes stored and reject writes that would exceed a configured limit. This prevents runaway scripts from consuming unbounded memory.

**Step 1: Write failing tests**

Add to `packages/orchestrator/src/vfs/__tests__/vfs.test.ts`:

```typescript
describe('VFS size limit', () => {
  it('allows writes within limit', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    const data = new Uint8Array(500);
    vfs.writeFile('/tmp/a.txt', data);
    expect(vfs.stat('/tmp/a.txt').size).toBe(500);
  });

  it('rejects writes exceeding limit', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(800));
    expect(() => {
      vfs.writeFile('/tmp/b.txt', new Uint8Array(300));
    }).toThrow(/ENOSPC/);
  });

  it('reclaims space on overwrite', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(800));
    // Overwrite with smaller file — should free space
    vfs.writeFile('/tmp/a.txt', new Uint8Array(100));
    // Now we have room for another 900 bytes
    vfs.writeFile('/tmp/b.txt', new Uint8Array(900));
    expect(vfs.stat('/tmp/b.txt').size).toBe(900);
  });

  it('reclaims space on rm', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(800));
    vfs.rm('/tmp/a.txt');
    vfs.writeFile('/tmp/b.txt', new Uint8Array(800));
    expect(vfs.stat('/tmp/b.txt').size).toBe(800);
  });

  it('no limit by default', () => {
    const vfs = new VFS();
    const data = new Uint8Array(10_000_000);
    vfs.writeFile('/tmp/big.txt', data);
    expect(vfs.stat('/tmp/big.txt').size).toBe(10_000_000);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/orchestrator && npx vitest run -t "VFS size limit"`

Expected: Fails — `VFS` constructor doesn't accept options.

**Step 3: Implement size tracking**

In `packages/orchestrator/src/vfs/vfs.ts`, modify the `VFS` class:

Add options interface and update constructor:
```typescript
export interface VfsOptions {
  /** Maximum total bytes stored in the VFS. Undefined = no limit. */
  fsLimitBytes?: number;
}

export class VFS {
  private root: DirInode;
  private snapshots: Map<string, DirInode> = new Map();
  private nextSnapId = 1;
  private totalBytes = 0;
  private fsLimitBytes: number | undefined;

  constructor(options?: VfsOptions) {
    this.root = createDirInode();
    this.fsLimitBytes = options?.fsLimitBytes;
    this.initDefaultLayout();
  }
```

Update `fromRoot` to preserve options:
```typescript
  private static fromRoot(root: DirInode): VFS {
    const vfs = Object.create(VFS.prototype) as VFS;
    vfs.root = root;
    vfs.snapshots = new Map();
    vfs.nextSnapId = 1;
    vfs.totalBytes = 0;
    vfs.fsLimitBytes = undefined;
    return vfs;
  }
```

Update `writeFile` to track size and enforce limit:
```typescript
  writeFile(path: string, data: Uint8Array): void {
    const { parent, name } = this.resolveParent(path);
    const existing = parent.children.get(name);

    if (existing !== undefined && existing.type === 'dir') {
      throw new VfsError('EISDIR', `is a directory: ${path}`);
    }

    const oldSize = (existing !== undefined && existing.type === 'file') ? existing.content.byteLength : 0;
    const newSize = data.byteLength;
    const delta = newSize - oldSize;

    if (this.fsLimitBytes !== undefined && this.totalBytes + delta > this.fsLimitBytes) {
      throw new VfsError('ENOSPC', `no space left on device (limit: ${this.fsLimitBytes} bytes)`);
    }

    if (existing !== undefined && existing.type === 'file') {
      existing.content = data;
      existing.metadata.mtime = new Date();
    } else {
      parent.children.set(name, createFileInode(data));
    }
    this.totalBytes += delta;
  }
```

Update `rm` to reclaim space (find the `rm` method and add size tracking):
```typescript
  // In the rm method, before deleting the inode:
  // if (inode.type === 'file') this.totalBytes -= inode.content.byteLength;
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/orchestrator && npx vitest run`

Expected: All tests pass including new VFS size limit tests.

**Step 5: Commit**

```bash
git add packages/orchestrator/src/vfs/
git commit -m "feat: add VFS size limit with ENOSPC enforcement"
```

---

### Task 3: Create the Sandbox Class

**Files:**
- Create: `packages/orchestrator/src/sandbox.ts`
- Modify: `packages/orchestrator/src/index.ts`

**Context:** The core of this phase. `Sandbox` is a facade class that wires VFS + ProcessManager + ShellRunner together and exposes a clean public API. `create()` uses the adapter's `scanTools()` to auto-register all tools.

**Step 1: Create the Sandbox class**

Create `packages/orchestrator/src/sandbox.ts`:

```typescript
import { VFS } from './vfs/vfs.js';
import type { VfsOptions } from './vfs/vfs.js';
import { ProcessManager } from './process/manager.js';
import { ShellRunner } from './shell/shell-runner.js';
import type { RunResult } from './shell/shell-runner.js';
import type { PlatformAdapter } from './platform/adapter.js';
import type { DirEntry, StatResult } from './vfs/inode.js';

export interface SandboxOptions {
  /** Directory (Node) or URL base (browser) containing .wasm files. */
  wasmDir: string;
  /** Platform adapter. Auto-detected if not provided (Node vs browser). */
  adapter?: PlatformAdapter;
  /** Per-command wall-clock timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Max VFS size in bytes. Default 256MB. */
  fsLimitBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FS_LIMIT = 256 * 1024 * 1024; // 256 MB

export class Sandbox {
  private vfs: VFS;
  private runner: ShellRunner;
  private timeoutMs: number;
  private destroyed = false;

  private constructor(vfs: VFS, runner: ShellRunner, timeoutMs: number) {
    this.vfs = vfs;
    this.runner = runner;
    this.timeoutMs = timeoutMs;
  }

  static async create(options: SandboxOptions): Promise<Sandbox> {
    const adapter = options.adapter ?? await Sandbox.detectAdapter();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fsLimitBytes = options.fsLimitBytes ?? DEFAULT_FS_LIMIT;

    const vfs = new VFS({ fsLimitBytes });
    const mgr = new ProcessManager(vfs, adapter);

    // Discover and register tools
    const tools = await adapter.scanTools(options.wasmDir);
    for (const [name, path] of tools) {
      mgr.registerTool(name, path);
    }

    // Register python3 separately
    const python3Path = tools.has('python3')
      ? undefined
      : `${options.wasmDir}/python3.wasm`;
    if (python3Path) {
      mgr.registerTool('python3', python3Path);
    }

    // Shell parser wasm
    const shellWasmPath = `${options.wasmDir}/wasmsand-shell.wasm`;
    const runner = new ShellRunner(vfs, mgr, adapter, shellWasmPath);

    return new Sandbox(vfs, runner, timeoutMs);
  }

  private static async detectAdapter(): Promise<PlatformAdapter> {
    if (typeof globalThis.process !== 'undefined' && globalThis.process.versions?.node) {
      const { NodeAdapter } = await import('./platform/node-adapter.js');
      return new NodeAdapter();
    }
    const { BrowserAdapter } = await import('./platform/browser-adapter.js');
    return new BrowserAdapter();
  }

  /** Run a shell command with timeout. */
  async run(command: string): Promise<RunResult> {
    this.assertAlive();
    const timer = new Promise<RunResult>((resolve) => {
      setTimeout(() => resolve({
        exitCode: 124,
        stdout: '',
        stderr: 'command timed out\n',
        executionTimeMs: this.timeoutMs,
      }), this.timeoutMs);
    });
    return Promise.race([this.runner.run(command), timer]);
  }

  readFile(path: string): Uint8Array {
    this.assertAlive();
    return this.vfs.readFile(path);
  }

  writeFile(path: string, data: Uint8Array): void {
    this.assertAlive();
    this.vfs.writeFile(path, data);
  }

  readDir(path: string): DirEntry[] {
    this.assertAlive();
    return this.vfs.readdir(path);
  }

  mkdir(path: string): void {
    this.assertAlive();
    this.vfs.mkdir(path);
  }

  stat(path: string): StatResult {
    this.assertAlive();
    return this.vfs.stat(path);
  }

  rm(path: string): void {
    this.assertAlive();
    this.vfs.rm(path);
  }

  setEnv(name: string, value: string): void {
    this.assertAlive();
    this.runner.setEnv(name, value);
  }

  getEnv(name: string): string | undefined {
    this.assertAlive();
    return this.runner.getEnv(name);
  }

  destroy(): void {
    this.destroyed = true;
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('Sandbox has been destroyed');
    }
  }
}
```

**Step 2: Export from barrel**

In `packages/orchestrator/src/index.ts`, add:

```typescript
export { Sandbox } from './sandbox.js';
export type { SandboxOptions } from './sandbox.js';
```

**Step 3: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/orchestrator/src/index.ts
git commit -m "feat: add Sandbox class with create/run/file-io/timeout API"
```

---

### Task 4: Test the Sandbox Class

**Files:**
- Create: `packages/orchestrator/src/__tests__/sandbox.test.ts`

**Context:** Full integration tests for the Sandbox public API. Uses the existing test fixtures directory as `wasmDir`.

**Step 1: Write the tests**

Create `packages/orchestrator/src/__tests__/sandbox.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

// The fixtures dir contains all coreutils + shell + python wasm files
const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../shell/__tests__/fixtures/wasmsand-shell.wasm');

// We need the shell parser in the same dir as tools for scanTools to work,
// or we override wasmDir. Since shell wasm is in a different dir, we pass
// adapter explicitly and handle paths manually.

describe('Sandbox', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('create and run a simple command', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    const result = await sandbox.run('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('run a pipeline', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    const result = await sandbox.run('echo hello world | wc -c');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('12');
  });

  it('writeFile and readFile', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    const data = new TextEncoder().encode('test content');
    sandbox.writeFile('/tmp/test.txt', data);
    const read = sandbox.readFile('/tmp/test.txt');
    expect(new TextDecoder().decode(read)).toBe('test content');
  });

  it('writeFile then cat via run', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('hello from host'));
    const result = await sandbox.run('cat /tmp/data.txt');
    expect(result.stdout).toBe('hello from host');
  });

  it('mkdir and readDir', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    sandbox.mkdir('/tmp/mydir');
    const entries = sandbox.readDir('/tmp');
    expect(entries.some(e => e.name === 'mydir')).toBe(true);
  });

  it('stat returns file info', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    sandbox.writeFile('/tmp/s.txt', new TextEncoder().encode('abc'));
    const s = sandbox.stat('/tmp/s.txt');
    expect(s.size).toBe(3);
    expect(s.type).toBe('file');
  });

  it('rm removes a file', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    sandbox.writeFile('/tmp/del.txt', new TextEncoder().encode('x'));
    sandbox.rm('/tmp/del.txt');
    expect(() => sandbox.stat('/tmp/del.txt')).toThrow();
  });

  it('setEnv and getEnv', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    sandbox.setEnv('MY_VAR', 'hello');
    expect(sandbox.getEnv('MY_VAR')).toBe('hello');
    const result = await sandbox.run('printenv MY_VAR');
    expect(result.stdout.trim()).toBe('hello');
  });

  it('destroy prevents further use', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    sandbox.destroy();
    expect(() => sandbox.readFile('/tmp/x')).toThrow(/destroyed/);
    // Double destroy is safe
    sandbox.destroy();
  });

  it('timeout returns exit code 124', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      timeoutMs: 1, // 1ms — practically instant timeout
    });
    // yes is bounded (10k lines) but still slow enough to exceed 1ms
    const result = await sandbox.run('yes hello | head -1000');
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  });

  it('VFS size limit enforces ENOSPC', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      fsLimitBytes: 1024,
    });
    sandbox.writeFile('/tmp/a.txt', new Uint8Array(800));
    expect(() => {
      sandbox.writeFile('/tmp/b.txt', new Uint8Array(300));
    }).toThrow(/ENOSPC/);
  });

  it('discovers tools via scanTools', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    // Verify that auto-discovered tools work
    const result = await sandbox.run('uname');
    expect(result.stdout.trim()).toBe('wasmsand');
  });
});
```

**Step 2: Run tests**

Run: `cd packages/orchestrator && npx vitest run`

Expected: All tests pass. If the shell wasm path doesn't resolve correctly from `wasmDir`, adjust the Sandbox `create()` method to look for `wasmsand-shell.wasm` in the parent's shell fixtures directory, or copy the shell wasm to the fixtures dir. The test may need iteration here.

**Step 3: Commit**

```bash
git add packages/orchestrator/src/__tests__/sandbox.test.ts
git commit -m "test: add Sandbox API integration tests"
```

---

### Task 5: Wire Up and Final Verification

**Files:** None new.

**Context:** Run the full test suite, ensure no regressions, verify the barrel export works.

**Step 1: Run full test suite**

Run: `cd packages/orchestrator && npx vitest run`

Expected: All tests pass (290 existing + new sandbox tests + new VFS limit tests).

**Step 2: Verify barrel export**

```bash
node -e "import('@wasmsand/orchestrator').then(m => console.log(Object.keys(m)))" --input-type=module
```

Or simpler: check that `Sandbox` is exported from `index.ts`.

**Step 3: Commit if any final fixes needed**

```bash
git add -A
git commit -m "chore: final verification for Sandbox API"
```
