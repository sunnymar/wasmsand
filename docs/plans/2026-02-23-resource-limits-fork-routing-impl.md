# Resource Limits + Fork RPC Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the two P0 gaps from code review: add resource limits (stdout/stderr/command byte caps, VFS file-count) and fix fork RPC routing so forked sandboxes are actually usable over RPC/SDK.

**Architecture:** Resource limits enforce in two layers — VFS tracks file count internally, Sandbox.run() handles output truncation and command length checks post/pre execution, server.ts handles RPC transport size. Fork routing adds an optional `sandboxId` param to every RPC request, resolved by the dispatcher before dispatch.

**Tech Stack:** TypeScript (Bun runtime), Python SDK, bun:test

---

### Task 1: Add file-count tracking to VFS

**Files:**
- Modify: `packages/orchestrator/src/vfs/vfs.ts`
- Test: `packages/orchestrator/src/vfs/__tests__/vfs.test.ts`

**Step 1: Write failing tests for file-count limit**

Add to `packages/orchestrator/src/vfs/__tests__/vfs.test.ts`:

```ts
describe('file count limit', () => {
  it('rejects file creation when file count limit reached', () => {
    const vfs = new VFS({ maxFileCount: 3 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(1));
    vfs.writeFile('/tmp/b.txt', new Uint8Array(1));
    vfs.writeFile('/tmp/c.txt', new Uint8Array(1));
    expect(() => {
      vfs.writeFile('/tmp/d.txt', new Uint8Array(1));
    }).toThrow(/ENOSPC/);
  });

  it('rejects mkdir when file count limit reached', () => {
    const vfs = new VFS({ maxFileCount: 1 });
    vfs.mkdir('/tmp/sub');
    expect(() => {
      vfs.mkdir('/tmp/sub2');
    }).toThrow(/ENOSPC/);
  });

  it('allows creation after deletion frees a slot', () => {
    const vfs = new VFS({ maxFileCount: 1 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(1));
    expect(() => {
      vfs.writeFile('/tmp/b.txt', new Uint8Array(1));
    }).toThrow(/ENOSPC/);
    vfs.unlink('/tmp/a.txt');
    vfs.writeFile('/tmp/b.txt', new Uint8Array(1)); // should succeed
    expect(vfs.readFile('/tmp/b.txt')).toEqual(new Uint8Array(1));
  });

  it('overwriting existing file does not increment count', () => {
    const vfs = new VFS({ maxFileCount: 1 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(1));
    vfs.writeFile('/tmp/a.txt', new Uint8Array(2)); // overwrite, no new inode
    expect(vfs.readFile('/tmp/a.txt')).toEqual(new Uint8Array(2));
  });

  it('no limit when maxFileCount is undefined', () => {
    const vfs = new VFS();
    for (let i = 0; i < 100; i++) {
      vfs.writeFile(`/tmp/f${i}.txt`, new Uint8Array(1));
    }
    // should not throw
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/orchestrator/src/vfs/__tests__/vfs.test.ts`
Expected: FAIL — `maxFileCount` is not a recognized option.

**Step 3: Implement file-count tracking in VFS**

In `packages/orchestrator/src/vfs/vfs.ts`:

1. Add `maxFileCount` to `VfsOptions`:
```ts
export interface VfsOptions {
  fsLimitBytes?: number;
  writablePaths?: string[] | undefined;
  maxFileCount?: number;
}
```

2. Add fields to VFS class:
```ts
private fileCount = 0;
private maxFileCount: number | undefined;
```

3. In constructor, store `maxFileCount`:
```ts
this.maxFileCount = options?.maxFileCount;
```

4. Add helper:
```ts
private assertFileCountLimit(): void {
  if (this.maxFileCount !== undefined && this.fileCount >= this.maxFileCount) {
    throw new VfsError('ENOSPC', `file count limit reached (max: ${this.maxFileCount})`);
  }
}
```

5. In `writeFile`, increment only for new files:
```ts
// After the existing ENOSPC byte check, before creating the inode:
if (existing !== undefined && existing.type === 'file') {
  existing.content = data;
  existing.metadata.mtime = new Date();
} else {
  this.assertFileCountLimit();
  parent.children.set(name, createFileInode(data));
  this.fileCount++;
}
```

6. In `mkdir`:
```ts
mkdir(path: string): void {
  this.assertWritable(path);
  const { parent, name } = this.resolveParent(path);
  if (parent.children.has(name)) {
    throw new VfsError('EEXIST', `file exists: ${path}`);
  }
  this.assertFileCountLimit();
  parent.children.set(name, createDirInode());
  this.fileCount++;
}
```

7. In `mkdirp`, increment for each new dir created:
```ts
// In the else branch where a new dir is created:
} else {
  this.assertFileCountLimit();
  const newDir = createDirInode();
  current.children.set(segment, newDir);
  current = newDir;
  this.fileCount++;
}
```

8. In `symlink`:
```ts
symlink(target: string, path: string): void {
  this.assertWritable(path);
  const { parent, name } = this.resolveParent(path);
  if (parent.children.has(name)) {
    throw new VfsError('EEXIST', `file exists: ${path}`);
  }
  this.assertFileCountLimit();
  parent.children.set(name, createSymlinkInode(target));
  this.fileCount++;
}
```

9. In `unlink`, decrement:
```ts
// After removing from parent.children:
this.fileCount--;
```
Note: `fileCount--` goes after `parent.children.delete(name)`, but before the closing brace. The decrement happens for both files and symlinks (unlink already rejects dirs with EISDIR).

10. In `rmdir`, decrement:
```ts
// After parent.children.delete(name):
this.fileCount--;
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/orchestrator/src/vfs/__tests__/vfs.test.ts`
Expected: All pass including new file-count tests.

**Step 5: Commit**

```bash
git add packages/orchestrator/src/vfs/vfs.ts packages/orchestrator/src/vfs/__tests__/vfs.test.ts
git commit -m "feat(vfs): add file-count limit enforcement"
```

---

### Task 2: Fix cowClone to propagate VFS options

**Files:**
- Modify: `packages/orchestrator/src/vfs/vfs.ts`
- Test: `packages/orchestrator/src/vfs/__tests__/vfs.test.ts`

**Step 1: Write failing test for cowClone option propagation**

Add to `packages/orchestrator/src/vfs/__tests__/vfs.test.ts`:

```ts
describe('cowClone option propagation', () => {
  it('propagates fsLimitBytes to cloned VFS', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(800));
    const child = vfs.cowClone();
    // Child should inherit the 1024 byte limit and the ~800 bytes used
    expect(() => {
      child.writeFile('/tmp/b.txt', new Uint8Array(300));
    }).toThrow(/ENOSPC/);
  });

  it('propagates maxFileCount to cloned VFS', () => {
    const vfs = new VFS({ maxFileCount: 2 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(1));
    vfs.writeFile('/tmp/b.txt', new Uint8Array(1));
    const child = vfs.cowClone();
    expect(() => {
      child.writeFile('/tmp/c.txt', new Uint8Array(1));
    }).toThrow(/ENOSPC/);
  });

  it('propagates writablePaths to cloned VFS', () => {
    const vfs = new VFS({ writablePaths: ['/tmp'] });
    const child = vfs.cowClone();
    expect(() => {
      child.writeFile('/home/user/test.txt', new Uint8Array(1));
    }).toThrow(/EROFS/);
    child.writeFile('/tmp/test.txt', new Uint8Array(1)); // should succeed
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/orchestrator/src/vfs/__tests__/vfs.test.ts`
Expected: FAIL — cowClone's child doesn't enforce limits.

**Step 3: Fix cowClone and fromRoot**

Replace `fromRoot` and `cowClone` in `packages/orchestrator/src/vfs/vfs.ts`:

```ts
private static fromRoot(root: DirInode, options?: {
  fsLimitBytes?: number;
  totalBytes?: number;
  maxFileCount?: number;
  fileCount?: number;
  writablePaths?: string[] | undefined;
}): VFS {
  const vfs = Object.create(VFS.prototype) as VFS;
  vfs.root = root;
  vfs.snapshots = new Map();
  vfs.nextSnapId = 1;
  vfs.totalBytes = options?.totalBytes ?? 0;
  vfs.fsLimitBytes = options?.fsLimitBytes;
  vfs.maxFileCount = options?.maxFileCount;
  vfs.fileCount = options?.fileCount ?? 0;
  vfs.writablePaths = options?.writablePaths !== undefined ? options.writablePaths : undefined;
  vfs.initializing = false;
  return vfs;
}

cowClone(): VFS {
  return VFS.fromRoot(deepCloneRoot(this.root), {
    fsLimitBytes: this.fsLimitBytes,
    totalBytes: this.totalBytes,
    maxFileCount: this.maxFileCount,
    fileCount: this.fileCount,
    writablePaths: this.writablePaths,
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/orchestrator/src/vfs/__tests__/vfs.test.ts`
Expected: All pass.

**Step 5: Commit**

```bash
git add packages/orchestrator/src/vfs/vfs.ts packages/orchestrator/src/vfs/__tests__/vfs.test.ts
git commit -m "fix(vfs): propagate limits and writablePaths through cowClone"
```

---

### Task 3: Extend RunResult with truncated and errorClass

**Files:**
- Modify: `packages/orchestrator/src/shell/shell-runner.ts` (RunResult type)
- Test: None (type-only change, tested via Task 4)

**Step 1: Update RunResult interface**

In `packages/orchestrator/src/shell/shell-runner.ts`, change the `RunResult` interface at line 80:

```ts
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  truncated?: { stdout: boolean; stderr: boolean };
  errorClass?: 'TIMEOUT' | 'CANCELLED' | 'CAPABILITY_DENIED' | 'LIMIT_EXCEEDED';
}
```

**Step 2: Run existing tests to verify nothing breaks**

Run: `bun test packages/orchestrator/src/shell/__tests__/shell-runner.test.ts`
Expected: All existing tests pass (new fields are optional).

**Step 3: Commit**

```bash
git add packages/orchestrator/src/shell/shell-runner.ts
git commit -m "feat: extend RunResult with truncated and errorClass fields"
```

---

### Task 4: Add resource limits to Sandbox.run()

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts`
- Test: `packages/orchestrator/src/__tests__/sandbox.test.ts`

**Step 1: Write failing tests**

Add to `packages/orchestrator/src/__tests__/sandbox.test.ts`:

```ts
describe('resource limits', () => {
  it('rejects command exceeding commandBytes limit', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      limits: { commandBytes: 10 },
    });
    const result = await sandbox.run('echo this is a long command that exceeds the limit');
    expect(result.exitCode).toBe(1);
    expect(result.errorClass).toBe('LIMIT_EXCEEDED');
    expect(result.stderr).toContain('command too long');
  });

  it('truncates stdout exceeding stdoutBytes limit', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      limits: { stdoutBytes: 5 },
    });
    const result = await sandbox.run('echo hello world');
    expect(result.stdout.length).toBeLessThanOrEqual(5);
    expect(result.truncated).toEqual({ stdout: true, stderr: false });
  });

  it('truncates stderr exceeding stderrBytes limit', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      limits: { stderrBytes: 5 },
    });
    const result = await sandbox.run('echo error message >&2');
    expect(result.stderr.length).toBeLessThanOrEqual(5);
    expect(result.truncated).toEqual({ stdout: false, stderr: true });
  });

  it('passes fileCount limit to VFS', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      limits: { fileCount: 1 },
    });
    sandbox.writeFile('/tmp/a.txt', new Uint8Array(1));
    expect(() => {
      sandbox.writeFile('/tmp/b.txt', new Uint8Array(1));
    }).toThrow(/ENOSPC/);
  });

  it('sets errorClass TIMEOUT on timeout', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      timeoutMs: 1,
    });
    const result = await sandbox.run('yes hello | head -1000');
    expect(result.exitCode).toBe(124);
    expect(result.errorClass).toBe('TIMEOUT');
  });

  it('no truncation when output is within limits', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      limits: { stdoutBytes: 1_000_000 },
    });
    const result = await sandbox.run('echo hello');
    expect(result.truncated).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/orchestrator/src/__tests__/sandbox.test.ts`
Expected: FAIL — `limits` is not recognized, `errorClass` / `truncated` not set.

**Step 3: Implement limits in Sandbox**

In `packages/orchestrator/src/sandbox.ts`:

1. Add limits to `SandboxOptions`:
```ts
export interface SandboxOptions {
  wasmDir: string;
  adapter?: PlatformAdapter;
  timeoutMs?: number;
  fsLimitBytes?: number;
  shellWasmPath?: string;
  network?: NetworkPolicy;
  limits?: {
    stdoutBytes?: number;
    stderrBytes?: number;
    commandBytes?: number;
    fileCount?: number;
  };
}
```

2. Add defaults:
```ts
const DEFAULT_STDOUT_LIMIT = 1_048_576;  // 1 MB
const DEFAULT_STDERR_LIMIT = 1_048_576;  // 1 MB
const DEFAULT_COMMAND_LIMIT = 65_536;    // 64 KB
```

3. Store limits in the class:
```ts
private limits: {
  stdoutBytes: number;
  stderrBytes: number;
  commandBytes: number;
};
```

4. In `create()`, pass `fileCount` to VFS and store limits:
```ts
const vfs = new VFS({
  fsLimitBytes,
  maxFileCount: options.limits?.fileCount,
});
```
And pass limits to the constructor.

5. In constructor, store limits:
```ts
this.limits = {
  stdoutBytes: limits?.stdoutBytes ?? DEFAULT_STDOUT_LIMIT,
  stderrBytes: limits?.stderrBytes ?? DEFAULT_STDERR_LIMIT,
  commandBytes: limits?.commandBytes ?? DEFAULT_COMMAND_LIMIT,
};
```

6. Replace the `run()` method:
```ts
async run(command: string): Promise<RunResult> {
  this.assertAlive();

  // Command length check
  if (Buffer.byteLength(command) > this.limits.commandBytes) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `command too long (${Buffer.byteLength(command)} bytes, limit: ${this.limits.commandBytes})\n`,
      executionTimeMs: 0,
      errorClass: 'LIMIT_EXCEEDED',
    };
  }

  const timer = new Promise<RunResult>((resolve) => {
    setTimeout(() => resolve({
      exitCode: 124,
      stdout: '',
      stderr: 'command timed out\n',
      executionTimeMs: this.timeoutMs,
      errorClass: 'TIMEOUT',
    }), this.timeoutMs);
  });

  const result = await Promise.race([this.runner.run(command), timer]);
  return this.applyOutputLimits(result);
}

private applyOutputLimits(result: RunResult): RunResult {
  const stdoutOver = result.stdout.length > this.limits.stdoutBytes;
  const stderrOver = result.stderr.length > this.limits.stderrBytes;

  if (!stdoutOver && !stderrOver) return result;

  return {
    ...result,
    stdout: stdoutOver ? result.stdout.slice(0, this.limits.stdoutBytes) : result.stdout,
    stderr: stderrOver ? result.stderr.slice(0, this.limits.stderrBytes) : result.stderr,
    truncated: { stdout: stdoutOver, stderr: stderrOver },
  };
}
```

7. Propagate limits through `fork()` — add `limits` to constructor params and pass in fork:
```ts
// In fork(), when constructing child Sandbox:
// Pass this.limits to the child constructor
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/orchestrator/src/__tests__/sandbox.test.ts`
Expected: All pass including new resource limit tests.

**Step 5: Run full test suite**

Run: `bun test`
Expected: All existing tests still pass (new fields are optional, defaults are generous).

**Step 6: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/orchestrator/src/__tests__/sandbox.test.ts
git commit -m "feat(sandbox): add resource limits — command length, output truncation, file count"
```

---

### Task 5: Lower RPC max request size

**Files:**
- Modify: `packages/sdk-server/src/server.ts`
- Test: `packages/sdk-server/src/server.test.ts`

**Step 1: Write failing test**

Add to `packages/sdk-server/src/server.test.ts` (if it tests the size cap directly; otherwise this is a config-only change). Check whether `server.test.ts` has an existing size test, and if not, this is a one-line change that existing tests cover implicitly.

**Step 2: Lower the constant**

In `packages/sdk-server/src/server.ts`, change line 47:

```ts
// Before:
const MAX_LINE_BYTES = 400 * 1024 * 1024;

// After:
const MAX_LINE_BYTES = 8 * 1024 * 1024; // 8 MB
```

**Step 3: Run tests**

Run: `bun test packages/sdk-server/`
Expected: All pass. No existing test sends >8MB payloads.

**Step 4: Commit**

```bash
git add packages/sdk-server/src/server.ts
git commit -m "fix(server): lower max RPC request size from 400MB to 8MB"
```

---

### Task 6: Add fork routing to dispatcher

**Files:**
- Modify: `packages/sdk-server/src/dispatcher.ts`
- Test: `packages/sdk-server/src/dispatcher.test.ts`

**Step 1: Write failing tests for fork routing**

Add to `packages/sdk-server/src/dispatcher.test.ts`:

```ts
describe('fork routing', () => {
  it('sandbox.fork returns a sandboxId', async () => {
    const result = await dispatcher.dispatch('sandbox.fork', {});
    expect(result).toHaveProperty('sandboxId');
    expect(typeof (result as { sandboxId: string }).sandboxId).toBe('string');
  });

  it('routes run to forked sandbox via sandboxId', async () => {
    const forkResult = await dispatcher.dispatch('sandbox.fork', {}) as { sandboxId: string };
    await dispatcher.dispatch('run', { command: 'echo hello', sandboxId: forkResult.sandboxId });
    // The forked sandbox's run should have been called, not the root
    const forkedSandbox = (sandbox.fork as ReturnType<typeof mock>).mock.results[0].value;
    // Verify the fork was used (we check the mock was called)
    expect(forkedSandbox.run).toHaveBeenCalledWith('echo hello');
  });

  it('routes files.read to forked sandbox via sandboxId', async () => {
    const forkResult = await dispatcher.dispatch('sandbox.fork', {}) as { sandboxId: string };
    await dispatcher.dispatch('files.read', { path: '/tmp/test.txt', sandboxId: forkResult.sandboxId });
    const forkedSandbox = (sandbox.fork as ReturnType<typeof mock>).mock.results[0].value;
    expect(forkedSandbox.readFile).toHaveBeenCalledWith('/tmp/test.txt');
  });

  it('routes to root sandbox when no sandboxId', async () => {
    await dispatcher.dispatch('run', { command: 'echo hello' });
    expect(sandbox.run).toHaveBeenCalledWith('echo hello');
  });

  it('rejects unknown sandboxId', async () => {
    await expect(
      dispatcher.dispatch('run', { command: 'echo hello', sandboxId: '999' }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('Unknown sandboxId'),
    });
  });

  it('sandbox.fork from a fork works', async () => {
    const fork1 = await dispatcher.dispatch('sandbox.fork', {}) as { sandboxId: string };
    const fork2 = await dispatcher.dispatch('sandbox.fork', { sandboxId: fork1.sandboxId }) as { sandboxId: string };
    expect(fork2.sandboxId).not.toBe(fork1.sandboxId);
  });

  it('sandbox.destroy removes a fork', async () => {
    const forkResult = await dispatcher.dispatch('sandbox.fork', {}) as { sandboxId: string };
    await dispatcher.dispatch('sandbox.destroy', { sandboxId: forkResult.sandboxId });
    await expect(
      dispatcher.dispatch('run', { command: 'echo hello', sandboxId: forkResult.sandboxId }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('Unknown sandboxId'),
    });
  });

  it('sandbox.destroy requires sandboxId', async () => {
    await expect(
      dispatcher.dispatch('sandbox.destroy', {}),
    ).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('kill destroys all forks', async () => {
    const forkResult = await dispatcher.dispatch('sandbox.fork', {}) as { sandboxId: string };
    await dispatcher.dispatch('kill', {});
    expect(dispatcher.isKilled()).toBe(true);
    // Root sandbox.destroy was called
    expect(sandbox.destroy).toHaveBeenCalled();
    // Forked sandbox.destroy was also called
    const forkedSandbox = (sandbox.fork as ReturnType<typeof mock>).mock.results[0].value;
    expect(forkedSandbox.destroy).toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/sdk-server/src/dispatcher.test.ts`
Expected: FAIL — `sandbox.destroy` method not found, fork routing doesn't work.

**Step 3: Implement fork routing in dispatcher**

In `packages/sdk-server/src/dispatcher.ts`:

1. Add `resolveSandbox` helper:
```ts
private resolveSandbox(params: Record<string, unknown>): SandboxLike {
  const id = params.sandboxId;
  if (id === undefined || id === null) return this.sandbox;
  if (typeof id !== 'string') throw this.rpcError(-32602, 'sandboxId must be a string');
  const fork = this.forks.get(id);
  if (!fork) throw this.rpcError(-32602, `Unknown sandboxId: ${id}`);
  return fork;
}
```

2. Add `sandbox.destroy` to the switch:
```ts
case 'sandbox.destroy':
  return this.sandboxDestroy(params);
```

3. Update every method that uses `this.sandbox` to use `resolveSandbox(params)`:

- `run`: `const sb = this.resolveSandbox(params); ... sb.run(command)`
- `filesWrite`: `const sb = this.resolveSandbox(params); ... sb.writeFile(...)`
- `filesRead`: `const sb = this.resolveSandbox(params); ... sb.readFile(...)`
- `filesList`: `const sb = this.resolveSandbox(params); ... sb.readDir(...), sb.stat(...)`
- `filesMkdir`: `const sb = this.resolveSandbox(params); ... sb.mkdir(...)`
- `filesRm`: `const sb = this.resolveSandbox(params); ... sb.rm(...)`
- `filesStat`: `const sb = this.resolveSandbox(params); ... sb.stat(...)`
- `envSet`: `const sb = this.resolveSandbox(params); ... sb.setEnv(...)`
- `envGet`: `const sb = this.resolveSandbox(params); ... sb.getEnv(...)`
- `snapshotCreate`: `const sb = this.resolveSandbox(params); ... sb.snapshot()`
- `snapshotRestore`: `const sb = this.resolveSandbox(params); ... sb.restore(...)`
- `sandboxFork`: fork from `this.resolveSandbox(params)` instead of `this.sandbox`

4. Implement `sandboxDestroy`:
```ts
private sandboxDestroy(params: Record<string, unknown>) {
  const id = this.requireString(params, 'sandboxId');
  const fork = this.forks.get(id);
  if (!fork) throw this.rpcError(-32602, `Unknown sandboxId: ${id}`);
  fork.destroy();
  this.forks.delete(id);
  return { ok: true };
}
```

5. Update `kill` to destroy all forks:
```ts
private kill() {
  for (const fork of this.forks.values()) {
    fork.destroy();
  }
  this.forks.clear();
  this.sandbox.destroy();
  this.killed = true;
  return { ok: true };
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/sdk-server/src/dispatcher.test.ts`
Expected: All pass.

**Step 5: Commit**

```bash
git add packages/sdk-server/src/dispatcher.ts packages/sdk-server/src/dispatcher.test.ts
git commit -m "feat(dispatcher): add per-request sandboxId routing and sandbox.destroy"
```

---

### Task 7: Update dispatcher RunResult passthrough

**Files:**
- Modify: `packages/sdk-server/src/dispatcher.ts`

The `run` method in dispatcher currently cherry-picks fields from RunResult. It needs to also pass through `truncated` and `errorClass`.

**Step 1: Write failing test**

Add to `packages/sdk-server/src/dispatcher.test.ts`:

```ts
it('passes through truncated and errorClass fields', async () => {
  (sandbox.run as ReturnType<typeof mock>).mockImplementation(async () => ({
    exitCode: 124,
    stdout: 'trunc',
    stderr: '',
    executionTimeMs: 30000,
    truncated: { stdout: true, stderr: false },
    errorClass: 'TIMEOUT' as const,
  }));

  const result = await dispatcher.dispatch('run', { command: 'yes' });
  expect(result).toMatchObject({
    exitCode: 124,
    truncated: { stdout: true, stderr: false },
    errorClass: 'TIMEOUT',
  });
});

it('omits truncated when not present', async () => {
  const result = await dispatcher.dispatch('run', { command: 'echo hello' });
  expect(result).not.toHaveProperty('truncated');
  expect(result).not.toHaveProperty('errorClass');
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/sdk-server/src/dispatcher.test.ts`
Expected: FAIL — `truncated` and `errorClass` not in response.

**Step 3: Update the run method**

In `packages/sdk-server/src/dispatcher.ts`, update the `run` method:

```ts
private async run(params: Record<string, unknown>) {
  const command = this.requireString(params, 'command');
  const sb = this.resolveSandbox(params);
  const result = await sb.run(command);
  const response: Record<string, unknown> = {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    executionTimeMs: result.executionTimeMs,
  };
  if (result.truncated) response.truncated = result.truncated;
  if (result.errorClass) response.errorClass = result.errorClass;
  return response;
}
```

Also update the `SandboxLike.run` return type to include the new optional fields:
```ts
run(command: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  truncated?: { stdout: boolean; stderr: boolean };
  errorClass?: 'TIMEOUT' | 'CANCELLED' | 'CAPABILITY_DENIED' | 'LIMIT_EXCEEDED';
}>;
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/sdk-server/src/dispatcher.test.ts`
Expected: All pass.

**Step 5: Commit**

```bash
git add packages/sdk-server/src/dispatcher.ts packages/sdk-server/src/dispatcher.test.ts
git commit -m "feat(dispatcher): pass through truncated and errorClass from RunResult"
```

---

### Task 8: Fix Python SDK fork routing

**Files:**
- Modify: `packages/python-sdk/src/wasmsand/sandbox.py`
- Modify: `packages/python-sdk/src/wasmsand/commands.py`
- Modify: `packages/python-sdk/src/wasmsand/files.py`
- Modify: `packages/python-sdk/src/wasmsand/_types.py`

**Step 1: Update `_types.py` with new fields**

In `packages/python-sdk/src/wasmsand/_types.py`:

```python
@dataclass
class CommandResult:
    stdout: str
    stderr: str
    exit_code: int
    execution_time_ms: float
    truncated: dict[str, bool] | None = None
    error_class: str | None = None
```

**Step 2: Update `commands.py` to accept sandbox_id and map new fields**

```python
from wasmsand._rpc import RpcClient
from wasmsand._types import CommandResult


class Commands:
    def __init__(self, client: RpcClient, sandbox_id: str | None = None):
        self._client = client
        self._sandbox_id = sandbox_id

    def run(self, command: str) -> CommandResult:
        params: dict = {"command": command}
        if self._sandbox_id is not None:
            params["sandboxId"] = self._sandbox_id
        result = self._client.call("run", params)
        return CommandResult(
            stdout=result["stdout"],
            stderr=result["stderr"],
            exit_code=result["exitCode"],
            execution_time_ms=result["executionTimeMs"],
            truncated=result.get("truncated"),
            error_class=result.get("errorClass"),
        )
```

**Step 3: Update `files.py` to accept sandbox_id**

```python
import base64
from wasmsand._rpc import RpcClient
from wasmsand._types import FileInfo


class Files:
    def __init__(self, client: RpcClient, sandbox_id: str | None = None):
        self._client = client
        self._sandbox_id = sandbox_id

    def _params(self, **kwargs) -> dict:
        if self._sandbox_id is not None:
            kwargs["sandboxId"] = self._sandbox_id
        return kwargs

    def read(self, path: str) -> bytes:
        result = self._client.call("files.read", self._params(path=path))
        return base64.b64decode(result["data"])

    def write(self, path: str, data: bytes | str) -> None:
        if isinstance(data, str):
            data = data.encode("utf-8")
        encoded = base64.b64encode(data).decode("ascii")
        self._client.call("files.write", self._params(path=path, data=encoded))

    def list(self, path: str) -> list[FileInfo]:
        result = self._client.call("files.list", self._params(path=path))
        return [FileInfo(name=e["name"], type=e["type"], size=e["size"]) for e in result["entries"]]

    def mkdir(self, path: str) -> None:
        self._client.call("files.mkdir", self._params(path=path))

    def rm(self, path: str) -> None:
        self._client.call("files.rm", self._params(path=path))

    def stat(self, path: str) -> FileInfo:
        result = self._client.call("files.stat", self._params(path=path))
        return FileInfo(name=result["name"], type=result["type"], size=result["size"])
```

**Step 4: Update `sandbox.py` fork method**

```python
class Sandbox:
    def __init__(self, *, timeout_ms: int = 30_000, fs_limit_bytes: int = 256 * 1024 * 1024,
                 _sandbox_id: str | None = None, _client: RpcClient | None = None):
        if _client is not None:
            # Internal constructor for forked sandboxes
            self._client = _client
            self._sandbox_id = _sandbox_id
            self.commands = Commands(self._client, self._sandbox_id)
            self.files = Files(self._client, self._sandbox_id)
            return

        if _is_bundled():
            runtime, server, wasm_dir, shell_wasm = _bundled_paths()
        else:
            runtime, server, wasm_dir, shell_wasm = _dev_paths()

        self._client = RpcClient(runtime, server)
        self._client.start()
        self._sandbox_id = None

        self._client.call("create", {
            "wasmDir": wasm_dir,
            "shellWasmPath": shell_wasm,
            "timeoutMs": timeout_ms,
            "fsLimitBytes": fs_limit_bytes,
        })

        self.commands = Commands(self._client)
        self.files = Files(self._client)

    def _with_id(self, params: dict) -> dict:
        if self._sandbox_id is not None:
            params["sandboxId"] = self._sandbox_id
        return params

    def snapshot(self) -> str:
        result = self._client.call("snapshot.create", self._with_id({}))
        return result["id"]

    def restore(self, snapshot_id: str) -> None:
        self._client.call("snapshot.restore", self._with_id({"id": snapshot_id}))

    def fork(self) -> "Sandbox":
        result = self._client.call("sandbox.fork", self._with_id({}))
        return Sandbox(
            _sandbox_id=result["sandboxId"],
            _client=self._client,
        )

    def destroy(self) -> None:
        """Destroy this forked sandbox. Only valid on forked instances."""
        if self._sandbox_id is None:
            raise RuntimeError("Cannot destroy root sandbox; use kill() instead")
        self._client.call("sandbox.destroy", {"sandboxId": self._sandbox_id})

    def kill(self) -> None:
        try:
            self._client.call("kill", {})
        except Exception:
            pass
        self._client.stop()

    def __enter__(self) -> "Sandbox":
        return self

    def __exit__(self, *exc) -> None:
        if self._sandbox_id is not None:
            try:
                self.destroy()
            except Exception:
                pass
        else:
            self.kill()
```

**Step 5: Run full test suite**

Run: `bun test`
Expected: All pass. Python SDK changes are structural but maintain the same RPC protocol (just adding optional params).

**Step 6: Commit**

```bash
git add packages/python-sdk/src/wasmsand/sandbox.py packages/python-sdk/src/wasmsand/commands.py packages/python-sdk/src/wasmsand/files.py packages/python-sdk/src/wasmsand/_types.py
git commit -m "feat(python-sdk): fix fork routing with per-request sandboxId, add truncated/errorClass"
```

---

### Task 9: Final integration verification

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass.

**Step 2: Verify no regressions in existing sandbox tests**

Run: `bun test packages/orchestrator/src/__tests__/sandbox.test.ts`
Expected: All pass, including existing timeout, fork, and snapshot tests.

**Step 3: Verify dispatcher tests**

Run: `bun test packages/sdk-server/src/dispatcher.test.ts`
Expected: All pass.

**Step 4: Commit any fixups if needed, then done**
