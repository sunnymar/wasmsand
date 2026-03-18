# Sandbox Pooling & Multi-Sandbox SDK Server — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `SandboxPool` to the orchestrator for pre-warming sandboxes, integrate it into both MCP and SDK servers, and upgrade the SDK server (TS + Python) to support multiple concurrent sandboxes.

**Architecture:** A new `SandboxPool` class in the orchestrator pre-creates homogeneous sandboxes and hands them out via `checkout()`. Both the MCP server and SDK server consume the pool. The SDK server dispatcher gains a `this.sandboxes` registry alongside the existing `this.forks` for multi-sandbox support. The Python SDK gets a `SandboxManager` class (`sb.sandboxes`) returning `SandboxRef` objects with bound `.commands`/`.files`.

**Tech Stack:** TypeScript (Deno runtime, `@std/testing/bdd` + `@std/expect` for tests), Python (pytest), WASM (WASI P1)

**Spec:** `docs/superpowers/specs/2026-03-18-sandbox-pooling-design.md`

---

### Task 1: Pool Types

**Files:**
- Create: `packages/orchestrator/src/pool/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// packages/orchestrator/src/pool/types.ts
import type { MountConfig, SandboxOptions } from '../sandbox.js';
import type { NetworkPolicy } from '../network/gateway.js';
import type { ExtensionConfig } from '../extension/types.js';

export interface PoolConfig {
  /** Minimum idle sandboxes to maintain. */
  minSize: number;
  /** Cap on total sandboxes (idle + creating + checked out). */
  maxSize: number;
  /** Health-check interval in ms. Default 1000. */
  replenishIntervalMs?: number;
}

export interface CheckoutOptions {
  files?: Array<{ path: string; content: Uint8Array }>;
  env?: Record<string, string>;
  mounts?: MountConfig[];
  networkPolicy?: NetworkPolicy;
  label?: string;
  extensions?: ExtensionConfig[];
}
```

**Important:** Verify these import paths before writing code:
- `grep -r 'export.*NetworkPolicy' packages/orchestrator/src/network/` to confirm the gateway export
- `grep -r 'export.*ExtensionConfig' packages/orchestrator/src/extension/` to confirm the types export
- Adjust if the actual export names or paths differ

- [ ] **Step 2: Verify it type-checks**

Run: `cd /Users/sunny/work/codepod/codepod && deno check packages/orchestrator/src/pool/types.ts`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/pool/types.ts
git commit -m "feat(pool): add PoolConfig and CheckoutOptions types"
```

---

### Task 2: SandboxPool Core — Constructor and Stats

**Files:**
- Create: `packages/orchestrator/src/pool/sandbox-pool.ts`
- Create: `packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`

- [ ] **Step 1: Write the failing test — pool initializes and reports stats**

```typescript
// packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts
import { describe, it, beforeEach, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SandboxPool } from '../sandbox-pool.js';
import type { PoolConfig } from '../types.js';
import type { SandboxOptions } from '../../sandbox.js';

// Helper: build minimal SandboxOptions for testing.
// You MUST check what fields SandboxOptions requires by reading
// packages/orchestrator/src/sandbox.ts:44-69. At minimum it needs
// wasmDir and shellWasmPath pointing to test fixtures.
function testSandboxOptions(): SandboxOptions {
  const fixturesDir = new URL(
    '../../platform/__tests__/fixtures',
    import.meta.url,
  ).pathname;
  return {
    wasmDir: fixturesDir,
    shellWasmPath: `${fixturesDir}/codepod-shell-exec.wasm`,
  };
}

describe('SandboxPool', () => {
  let pool: SandboxPool;

  afterEach(async () => {
    if (pool) await pool.drain();
  });

  it('reports initial stats as all zeros before init', () => {
    const config: PoolConfig = { minSize: 2, maxSize: 5 };
    pool = new SandboxPool(config, testSandboxOptions());
    expect(pool.stats).toEqual({ idle: 0, creating: 0, checkedOut: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sunny/work/codepod/codepod && deno test -A --no-check packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the SandboxPool constructor with stats**

```typescript
// packages/orchestrator/src/pool/sandbox-pool.ts
import { Sandbox } from '../sandbox.js';
import type { SandboxOptions } from '../sandbox.js';
import type { PoolConfig, CheckoutOptions } from './types.js';

export class SandboxPool {
  private readonly config: PoolConfig;
  private readonly sandboxOptions: SandboxOptions;
  private readonly idle: Sandbox[] = [];
  private creatingCount = 0;
  private checkedOutCount = 0;
  private replenishTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(config: PoolConfig, sandboxOptions: SandboxOptions) {
    this.config = config;
    this.sandboxOptions = sandboxOptions;
  }

  get stats() {
    return {
      idle: this.idle.length,
      creating: this.creatingCount,
      checkedOut: this.checkedOutCount,
    };
  }

  async drain(): Promise<void> {
    this.draining = true;
    if (this.replenishTimer !== null) {
      clearInterval(this.replenishTimer);
      this.replenishTimer = null;
    }
    for (const sb of this.idle) {
      sb.destroy();
    }
    this.idle.length = 0;
    // Wait for in-flight creates to complete (they will self-destroy
    // because this.draining is true)
    while (this.creatingCount > 0) {
      await new Promise(r => setTimeout(r, 50));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/sunny/work/codepod/codepod && deno test -A --no-check packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/pool/sandbox-pool.ts packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts
git commit -m "feat(pool): SandboxPool constructor with stats and drain"
```

---

### Task 3: SandboxPool — init() and Replenishment

**Files:**
- Modify: `packages/orchestrator/src/pool/sandbox-pool.ts`
- Modify: `packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`

- [ ] **Step 1: Write the failing test — pool fills to minSize after init()**

```typescript
it('fills to minSize after init()', async () => {
  const config: PoolConfig = { minSize: 2, maxSize: 5 };
  pool = new SandboxPool(config, testSandboxOptions());
  await pool.init();
  expect(pool.stats.idle).toBe(2);
  expect(pool.stats.creating).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sunny/work/codepod/codepod && deno test -A --no-check packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`
Expected: FAIL — `pool.init is not a function`.

- [ ] **Step 3: Implement init() and replenish()**

Add to `SandboxPool`:

```typescript
async init(): Promise<void> {
  // Create minSize sandboxes serially
  for (let i = 0; i < this.config.minSize; i++) {
    if (this.draining) return;
    await this.createOne();
  }
  // Start periodic health check
  const interval = this.config.replenishIntervalMs ?? 1000;
  this.replenishTimer = setInterval(() => this.replenishIfNeeded(), interval);
}

private async createOne(): Promise<void> {
  const total = this.idle.length + this.creatingCount + this.checkedOutCount;
  if (total >= this.config.maxSize) return;
  this.creatingCount++;
  try {
    const sb = await Sandbox.create(this.sandboxOptions);
    if (this.draining) {
      sb.destroy();
    } else {
      this.idle.push(sb);
    }
  } finally {
    this.creatingCount--;
  }
}

private replenishIfNeeded(): void {
  if (this.draining) return;
  if (this.idle.length < this.config.minSize) {
    this.createOne().catch((err) => {
      console.error('[SandboxPool] replenish failed:', err);
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/sunny/work/codepod/codepod && deno test -A --no-check packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`
Expected: PASS.

- [ ] **Step 5: Write test — drain() cleans up idle sandboxes**

```typescript
it('drain() destroys all idle sandboxes', async () => {
  const config: PoolConfig = { minSize: 3, maxSize: 5 };
  pool = new SandboxPool(config, testSandboxOptions());
  await pool.init();
  expect(pool.stats.idle).toBe(3);
  await pool.drain();
  expect(pool.stats.idle).toBe(0);
});
```

- [ ] **Step 6: Run tests**

Run: `cd /Users/sunny/work/codepod/codepod && deno test -A --no-check packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`
Expected: PASS.

- [ ] **Step 7: Write test — failed creation during replenish does not crash pool**

```typescript
it('failed creation during replenish does not crash pool', async () => {
  const config: PoolConfig = { minSize: 1, maxSize: 5 };
  pool = new SandboxPool(config, testSandboxOptions());
  await pool.init();
  expect(pool.stats.idle).toBe(1);
  // Pool survives — further operations still work
  const sb = await pool.checkout();
  expect(sb).toBeDefined();
  pool.release(sb);
});
```

Note: A more thorough test would mock `Sandbox.create` to throw during replenishment — but that requires the codebase to support dependency injection or test doubles for `Sandbox.create`. If that's not feasible, this basic test confirms the pool doesn't crash under normal conditions. Add a mock-based test if the project supports DI.

- [ ] **Step 8: Run tests**

Run: `cd /Users/sunny/work/codepod/codepod && deno test -A --no-check packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/orchestrator/src/pool/sandbox-pool.ts packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts
git commit -m "feat(pool): init() with serial replenishment and periodic health check"
```

---

### Task 4: SandboxPool — checkout() and release()

**Files:**
- Modify: `packages/orchestrator/src/pool/sandbox-pool.ts`
- Modify: `packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`

- [ ] **Step 1: Write the failing test — checkout returns a sandbox**

```typescript
it('checkout() returns a sandbox and decrements idle', async () => {
  const config: PoolConfig = { minSize: 2, maxSize: 5 };
  pool = new SandboxPool(config, testSandboxOptions());
  await pool.init();
  const sb = await pool.checkout();
  expect(sb).toBeDefined();
  expect(pool.stats.idle).toBe(1);
  expect(pool.stats.checkedOut).toBe(1);
  pool.release(sb);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `pool.checkout is not a function`.

- [ ] **Step 3: Implement checkout() and release()**

```typescript
async checkout(overrides?: CheckoutOptions): Promise<Sandbox> {
  if (this.draining) throw new Error('Pool is draining');

  // Increment synchronously to prevent maxSize races
  this.checkedOutCount++;

  let sb: Sandbox;
  try {
    if (this.idle.length > 0) {
      sb = this.idle.pop()!;
    } else {
      // Fallback: create on demand
      this.creatingCount++;
      try {
        sb = await Sandbox.create(this.sandboxOptions);
      } finally {
        this.creatingCount--;
      }
    }

    // Apply overrides
    if (overrides) {
      if (overrides.env) {
        for (const [k, v] of Object.entries(overrides.env)) {
          sb.setEnv(k, v);
        }
      }
      if (overrides.files) {
        for (const f of overrides.files) {
          sb.writeFile(f.path, f.content);
        }
      }
      if (overrides.mounts) {
        for (const mc of overrides.mounts) {
          sb.mount(mc.path, mc.files);
        }
      }
      // networkPolicy and extensions: check if Sandbox exposes public
      // methods for these. If not, skip for now and document as limitation.
    }
  } catch (err) {
    this.checkedOutCount--;
    throw err;
  }

  // Trigger background replenish
  this.replenishIfNeeded();

  return sb;
}

release(sandbox: Sandbox): void {
  sandbox.destroy();
  this.checkedOutCount--;
  this.replenishIfNeeded();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/sunny/work/codepod/codepod && deno test -A --no-check packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`
Expected: PASS.

- [ ] **Step 5: Write test — checkout on empty pool falls back to direct create**

```typescript
it('checkout() on empty pool creates on demand', async () => {
  const config: PoolConfig = { minSize: 0, maxSize: 5 };
  pool = new SandboxPool(config, testSandboxOptions());
  await pool.init();
  expect(pool.stats.idle).toBe(0);
  const sb = await pool.checkout();
  expect(sb).toBeDefined();
  expect(pool.stats.checkedOut).toBe(1);
  pool.release(sb);
});
```

- [ ] **Step 6: Write test — maxSize is respected**

```typescript
it('maxSize caps total sandboxes', async () => {
  const config: PoolConfig = { minSize: 1, maxSize: 2 };
  pool = new SandboxPool(config, testSandboxOptions());
  await pool.init();
  const sb1 = await pool.checkout();
  // idle=0, checkedOut=1, replenish will try to create 1 more (total=2=maxSize)
  // Wait for replenish
  await new Promise(r => setTimeout(r, 200));
  const sb2 = await pool.checkout();
  expect(pool.stats.checkedOut).toBe(2);
  // Now at maxSize — replenish should not create more
  await new Promise(r => setTimeout(r, 200));
  expect(pool.stats.idle).toBe(0);
  expect(pool.stats.creating).toBe(0);
  pool.release(sb1);
  pool.release(sb2);
});
```

- [ ] **Step 7: Write test — checkout applies overrides**

```typescript
it('checkout() applies env and file overrides', async () => {
  const config: PoolConfig = { minSize: 1, maxSize: 5 };
  pool = new SandboxPool(config, testSandboxOptions());
  await pool.init();
  const sb = await pool.checkout({
    env: { MY_VAR: 'hello' },
    files: [{ path: '/tmp/test.txt', content: new TextEncoder().encode('data') }],
  });
  const result = await sb.run('echo $MY_VAR');
  expect(result.stdout.trim()).toBe('hello');
  const file = await sb.run('cat /tmp/test.txt');
  expect(file.stdout).toBe('data');
  pool.release(sb);
});
```

- [ ] **Step 8: Run all pool tests**

Run: `cd /Users/sunny/work/codepod/codepod && deno test -A --no-check packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`
Expected: All PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/orchestrator/src/pool/sandbox-pool.ts packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts
git commit -m "feat(pool): checkout() with overrides and release()"
```

---

### Task 5: Pool index and re-exports

**Files:**
- Create: `packages/orchestrator/src/pool/index.ts`

- [ ] **Step 1: Create the barrel export**

```typescript
// packages/orchestrator/src/pool/index.ts
export { SandboxPool } from './sandbox-pool.js';
export type { PoolConfig, CheckoutOptions } from './types.js';
```

- [ ] **Step 2: Verify type-check**

Run: `cd /Users/sunny/work/codepod/codepod && deno check packages/orchestrator/src/pool/index.ts`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/pool/index.ts
git commit -m "feat(pool): add barrel index for pool exports"
```

---

### Task 6: MCP Server — Pool Integration

**Files:**
- Modify: `packages/mcp-server/src/config.ts:26-34` (add pool fields to McpConfig)
- Modify: `packages/mcp-server/src/config.ts:111-180` (add --pool-min/--pool-max CLI args)
- Modify: `packages/mcp-server/src/index.ts:39-46` (create pool from config)
- Modify: `packages/mcp-server/src/index.ts:137-151` (create_sandbox uses pool)
- Modify: `packages/mcp-server/src/index.ts:167-185` (destroy_sandbox uses pool)

- [ ] **Step 1: Add pool config fields to McpConfig**

In `packages/mcp-server/src/config.ts`, add to the `McpConfig` interface (line 26-34):

```typescript
pool?: { minSize: number; maxSize: number };
```

Also add to `JsonConfig` (line 36-43):

```typescript
pool?: { minSize?: number; maxSize?: number };
```

- [ ] **Step 2: Add --pool-min and --pool-max CLI args**

In `parseCli()` (line 111-180), add cases before the `default`:

```typescript
case '--pool-min':
  if (!next) throw new Error('--pool-min requires a value');
  result.poolMin = Number(next);
  i++;
  break;
case '--pool-max':
  if (!next) throw new Error('--pool-max requires a value');
  result.poolMax = Number(next);
  i++;
  break;
```

Add `poolMin?: number` and `poolMax?: number` to the `CliResult` interface.

In `loadConfig()`, after all layers are merged, add pool config resolution at the end (before the return):

```typescript
// Pool config: CLI args > JSON config > undefined
const poolMin = cli.poolMin ?? json?.pool?.minSize;
const poolMax = cli.poolMax ?? json?.pool?.maxSize;
if (poolMin !== undefined && poolMax !== undefined) {
  config.pool = { minSize: poolMin, maxSize: poolMax };
}
```

This requires reading `loadConfig()` in `config.ts` to find the exact insertion point — it's near the end of the function before `return config`.

- [ ] **Step 3: Update index.ts — create pool on startup if configured**

In `packages/mcp-server/src/index.ts`, after config is loaded (~line 46):

```typescript
import { SandboxPool } from '../../orchestrator/src/pool/index.js';
import type { PoolConfig } from '../../orchestrator/src/pool/index.js';

// After config loading:
let pool: SandboxPool | null = null;
if (config.pool) {
  pool = new SandboxPool(config.pool, sandboxOptionsFromConfig(config));
  await pool.init();
}
```

Check: `sandboxOptionsFromConfig` may not exist — you may need to extract the `SandboxOptions` construction that currently happens inline in the `create_sandbox` handler into a helper function.

- [ ] **Step 4: Update create_sandbox to use pool**

In the `create_sandbox` tool handler (~line 137-151), replace the direct `Sandbox.create()` call:

```typescript
const sandbox = pool
  ? await pool.checkout({ label })
  : await Sandbox.create(sandboxOptions);
```

The rest of the handler (storing in registry, returning sandbox_id) stays the same.

- [ ] **Step 5: Update destroy_sandbox to use pool**

In the `destroy_sandbox` tool handler (~line 167-185), replace the direct `sandbox.destroy()` call:

```typescript
if (pool) {
  pool.release(entry.sandbox);
} else {
  entry.sandbox.destroy();
}
sandboxes.delete(sandbox_id);
```

- [ ] **Step 6: Add cleanup on server shutdown**

Find or add the shutdown handler (SIGINT/SIGTERM). Add `pool?.drain()` before process exit.

- [ ] **Step 7: Verify type-check**

Run: `cd /Users/sunny/work/codepod/codepod && deno check packages/mcp-server/src/index.ts`
Expected: No errors.

- [ ] **Step 8: Run existing MCP server tests**

Run: `cd /Users/sunny/work/codepod/codepod && deno test -A --no-check packages/mcp-server/src/*.test.ts packages/mcp-server/src/__tests__/*.test.ts`
Expected: All existing tests PASS. No regressions.

- [ ] **Step 9: Commit**

```bash
git add packages/mcp-server/src/config.ts packages/mcp-server/src/index.ts
git commit -m "feat(mcp): integrate SandboxPool into create/destroy_sandbox"
```

---

### Task 7: SDK Server — Multi-Sandbox Dispatcher

**Files:**
- Modify: `packages/sdk-server/src/dispatcher.ts:53-61` (add sandboxes map)
- Modify: `packages/sdk-server/src/dispatcher.ts:63-115` (add new cases to dispatch)
- Modify: `packages/sdk-server/src/dispatcher.ts:135-142` (update resolveSandbox)
- Modify: `packages/sdk-server/src/dispatcher.ts:241-248` (update kill)
- Modify: `packages/sdk-server/src/dispatcher.test.ts`

- [ ] **Step 1: Write failing test — sandbox.create RPC returns sandboxId**

In `packages/sdk-server/src/dispatcher.test.ts`, add a test. Read the existing test file first to follow conventions.

```typescript
it('sandbox.create returns a sandboxId', async () => {
  const result = await dispatcher.dispatch('sandbox.create', {});
  expect(result).toHaveProperty('sandboxId');
  expect(typeof (result as any).sandboxId).toBe('string');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sunny/work/codepod/codepod && deno test -A --no-check packages/sdk-server/src/dispatcher.test.ts`
Expected: FAIL — `Method not found: sandbox.create`.

- [ ] **Step 3: Add sandboxes map and createSandbox/pool fields to Dispatcher**

In `packages/sdk-server/src/dispatcher.ts`, add to the class (after line 56):

```typescript
interface SandboxEntry {
  sandbox: SandboxLike;
  label?: string;
  createdAt: string;  // ISO timestamp
}

private sandboxes: Map<string, SandboxEntry> = new Map();
private nextSandboxId = 1;
private pool: SandboxPool | null = null;
private sandboxOptions: SandboxOptions | null = null;
```

Update constructor to accept optional pool:

```typescript
constructor(
  sandbox: SandboxLike | null,
  options?: { pool?: SandboxPool; sandboxOptions?: SandboxOptions },
) {
  this.sandbox = sandbox!;  // null for multi-sandbox mode (backward compat handled below)
  this.pool = options?.pool ?? null;
  this.sandboxOptions = options?.sandboxOptions ?? null;
}
```

Check existing constructor call sites to ensure backward compatibility. The current constructor takes just `(sandbox: SandboxLike)` — adding an optional second param is backward compatible.

- [ ] **Step 4: Add sandbox.create, sandbox.list, sandbox.remove to dispatch switch**

In the `dispatch()` method's switch statement (line 65-106), add before `default`:

```typescript
case 'sandbox.create':
  return await this.sandboxCreate(params);
case 'sandbox.list':
  return this.sandboxList();
case 'sandbox.remove':
  return this.sandboxRemove(params);
```

- [ ] **Step 5: Implement the three new methods**

```typescript
private async sandboxCreate(params: Record<string, unknown>) {
  const MAX_SANDBOXES = 64;
  if (this.sandboxes.size >= MAX_SANDBOXES) {
    throw this.rpcError(-32602, `Maximum of ${MAX_SANDBOXES} concurrent sandboxes reached`);
  }

  let sb: SandboxLike;
  if (this.pool) {
    const label = params.label as string | undefined;
    sb = await this.pool.checkout({ label });
  } else if (this.sandboxOptions) {
    const { Sandbox } = await import('../../orchestrator/src/sandbox.js');
    sb = await Sandbox.create(this.sandboxOptions);
  } else {
    throw this.rpcError(1, 'No pool or sandbox options configured');
  }

  const sandboxId = String(this.nextSandboxId++);
  const label = params.label as string | undefined;
  this.sandboxes.set(sandboxId, {
    sandbox: sb,
    label,
    createdAt: new Date().toISOString(),
  });
  return { sandboxId };
}

private sandboxList() {
  return [...this.sandboxes.entries()].map(([id, entry]) => ({
    sandboxId: id,
    label: entry.label,
    createdAt: entry.createdAt,
  }));
}

private sandboxRemove(params: Record<string, unknown>) {
  const id = this.requireString(params, 'sandboxId');
  const entry = this.sandboxes.get(id);
  if (!entry) throw this.rpcError(-32602, `Unknown sandboxId: ${id}`);
  if (this.pool) {
    // pool.release() accepts Sandbox — the pool created this instance,
    // so the cast is safe. SandboxLike is a subset of Sandbox's public API.
    this.pool.release(entry.sandbox as any);
  } else {
    entry.sandbox.destroy();
  }
  this.sandboxes.delete(id);
  return { ok: true };
}
```

- [ ] **Step 6: Update resolveSandbox() to check both maps**

Replace `resolveSandbox()` (lines 135-142):

```typescript
private resolveSandbox(params: Record<string, unknown>): SandboxLike {
  const id = params.sandboxId;
  if (id === undefined || id === null) {
    // Backward compat: return root sandbox if set (old single-sandbox mode)
    if (this.sandbox) return this.sandbox;
    // Multi-sandbox mode: return the "default" sandbox if it exists
    const def = this.sandboxes.get('default');
    if (def) return def.sandbox;
    // No sandbox available — caller must use sandbox.create first
    throw this.rpcError(1, 'No sandbox available. Call sandbox.create first.');
  }
  if (typeof id !== 'string') throw this.rpcError(-32602, 'sandboxId must be a string');
  const entry = this.sandboxes.get(id);
  if (entry) return entry.sandbox;
  const fork = this.forks.get(id);
  if (fork) return fork;
  throw this.rpcError(-32602, `Unknown sandboxId: ${id}`);
}
```

**Backward compat auto-create:** The `server.ts` create handler (Task 8) must auto-create a sandbox with id `"default"` and store it in `this.sandboxes` when pool is NOT configured — matching current behavior where `create` RPC also created a sandbox. When pool IS configured, clients must explicitly call `sandbox.create`.

- [ ] **Step 7: Update kill() to destroy all sandboxes**

Replace `kill()` (lines 241-248):

```typescript
private async kill() {
  for (const entry of this.sandboxes.values()) entry.sandbox.destroy();
  this.sandboxes.clear();
  for (const fork of this.forks.values()) fork.destroy();
  this.forks.clear();
  if (this.sandbox) this.sandbox.destroy();
  if (this.pool) await this.pool.drain();
  this.killed = true;
  return { ok: true };
}
```

Note: `kill()` becomes `async` — update the dispatch case to `await this.kill()`.

- [ ] **Step 8: Run all dispatcher tests**

Run: `cd /Users/sunny/work/codepod/codepod && deno test -A --no-check packages/sdk-server/src/dispatcher.test.ts`
Expected: All PASS, including existing tests (backward compat).

- [ ] **Step 9: Commit**

```bash
git add packages/sdk-server/src/dispatcher.ts packages/sdk-server/src/dispatcher.test.ts
git commit -m "feat(sdk-server): multi-sandbox dispatcher with sandbox.create/list/remove"
```

---

### Task 8: SDK Server — Pool Initialization in server.ts

**Files:**
- Modify: `packages/sdk-server/src/server.ts:105-204` (create RPC handler)

- [ ] **Step 1: Read server.ts fully to understand the create flow**

Read `packages/sdk-server/src/server.ts` in its entirety before making changes.

- [ ] **Step 2: Update the create handler to accept pool config**

In the `create` handler (~line 105), after building sandbox options, check for `pool` param:

```typescript
// Inside the create handler, after building sandboxOptions:
if (params.pool) {
  const { SandboxPool } = await import('../../orchestrator/src/pool/index.js');
  const poolConfig = params.pool as { minSize: number; maxSize: number };
  const pool = new SandboxPool(poolConfig, sandboxOptions);
  await pool.init();
  dispatcher = new Dispatcher(null, { pool, sandboxOptions });
} else {
  // Existing behavior: create sandbox directly
  const sandbox = await Sandbox.create(sandboxOptions);
  dispatcher = new Dispatcher(sandbox);
}
```

The exact integration depends on how `dispatcher` is set up — read the full `server.ts` to find where it's assigned and adapt accordingly.

- [ ] **Step 3: Run existing server tests**

Run: `cd /Users/sunny/work/codepod/codepod && deno test -A --no-check packages/sdk-server/src/server.test.ts`
Expected: All PASS — no regressions.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-server/src/server.ts
git commit -m "feat(sdk-server): pool initialization from create RPC params"
```

---

### Task 9: Python SDK — SandboxRef and SandboxManager

**Files:**
- Create: `packages/python-sdk/src/codepod/sandbox_manager.py`
- Modify: `packages/python-sdk/src/codepod/sandbox.py:67-137` (add sandboxes attr)
- Create: `packages/python-sdk/tests/test_sandbox_manager.py`

- [ ] **Step 1: Write the failing test**

```python
# packages/python-sdk/tests/test_sandbox_manager.py
import pytest
from codepod import Sandbox


class TestSandboxManager:
    def test_create_and_list(self):
        with Sandbox() as sb:
            s1 = sb.sandboxes.create()
            assert s1.sandbox_id is not None
            listing = sb.sandboxes.list()
            assert len(listing) >= 1
            assert any(s.sandbox_id == s1.sandbox_id for s in listing)

    def test_create_and_remove(self):
        with Sandbox() as sb:
            s1 = sb.sandboxes.create()
            sid = s1.sandbox_id
            sb.sandboxes.remove(sid)
            listing = sb.sandboxes.list()
            assert all(s.sandbox_id != sid for s in listing)

    def test_sandbox_ref_commands(self):
        with Sandbox() as sb:
            s1 = sb.sandboxes.create()
            result = s1.commands.run("echo hello")
            assert result.exit_code == 0
            assert result.stdout.strip() == "hello"

    def test_sandbox_ref_files(self):
        with Sandbox() as sb:
            s1 = sb.sandboxes.create()
            s1.files.write("/tmp/test.txt", "hello world")
            data = s1.files.read("/tmp/test.txt")
            assert data == b"hello world"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sunny/work/codepod/codepod/packages/python-sdk && pytest tests/test_sandbox_manager.py -v`
Expected: FAIL — `AttributeError: 'Sandbox' object has no attribute 'sandboxes'`.

- [ ] **Step 3: Create sandbox_manager.py**

```python
# packages/python-sdk/src/codepod/sandbox_manager.py
from __future__ import annotations

from dataclasses import dataclass
from codepod._rpc import RpcClient
from codepod.commands import Commands
from codepod.files import Files


@dataclass
class SandboxInfo:
    sandbox_id: str
    label: str | None = None
    created_at: str | None = None


class SandboxRef:
    """Handle to a single sandbox with bound commands/files access."""

    def __init__(self, sandbox_id: str, client: RpcClient):
        self.sandbox_id = sandbox_id
        self.commands = Commands(client, sandbox_id)
        self.files = Files(client, sandbox_id)


class SandboxManager:
    """Manages multiple sandboxes within a single server process."""

    def __init__(self, client: RpcClient):
        self._client = client

    def create(self, label: str | None = None) -> SandboxRef:
        params: dict = {}
        if label is not None:
            params["label"] = label
        result = self._client.call("sandbox.create", params)
        return SandboxRef(result["sandboxId"], self._client)

    def list(self) -> list[SandboxInfo]:
        result = self._client.call("sandbox.list", {})
        return [
            SandboxInfo(
                sandbox_id=entry["sandboxId"],
                label=entry.get("label"),
                created_at=entry.get("createdAt"),
            )
            for entry in result
        ]

    def remove(self, sandbox_id: str) -> None:
        self._client.call("sandbox.remove", {"sandboxId": sandbox_id})
```

- [ ] **Step 4: Add sandboxes attribute to Sandbox.__init__**

In `packages/python-sdk/src/codepod/sandbox.py`, add after line 137 (after `self.files = Files(self._client)`):

```python
from codepod.sandbox_manager import SandboxManager
self.sandboxes = SandboxManager(self._client)
```

Also add it in the forked constructor branch (after line 83):

```python
self.sandboxes = SandboxManager(self._client)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/sunny/work/codepod/codepod/packages/python-sdk && pytest tests/test_sandbox_manager.py -v`
Expected: PASS (once SDK server multi-sandbox support from Task 7-8 is in place).

Note: These tests are end-to-end — they require the SDK server changes from Tasks 7-8. If running tests incrementally, these will fail until the server-side work is done. That's expected.

- [ ] **Step 6: Run all existing Python SDK tests for regression**

Run: `cd /Users/sunny/work/codepod/codepod/packages/python-sdk && pytest -v`
Expected: All existing tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/python-sdk/src/codepod/sandbox_manager.py packages/python-sdk/src/codepod/sandbox.py packages/python-sdk/tests/test_sandbox_manager.py
git commit -m "feat(python-sdk): SandboxManager with create/list/remove and SandboxRef"
```

---

### Task 10: Full Integration Test

**Files:**
- Modify: `packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`

- [ ] **Step 1: Run all tests across all packages**

```bash
cd /Users/sunny/work/codepod/codepod
deno test -A --no-check packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts
deno test -A --no-check packages/sdk-server/src/dispatcher.test.ts
deno test -A --no-check packages/sdk-server/src/server.test.ts
deno test -A --no-check packages/mcp-server/src/*.test.ts packages/mcp-server/src/__tests__/*.test.ts
cd packages/python-sdk && pytest -v
```

Expected: All PASS.

- [ ] **Step 2: Run type-check on all modified packages**

```bash
cd /Users/sunny/work/codepod/codepod
deno check packages/orchestrator/src/pool/index.ts
deno check packages/mcp-server/src/index.ts
deno check packages/sdk-server/src/server.ts
```

Expected: No errors.

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: integration test fixes for sandbox pooling"
```
