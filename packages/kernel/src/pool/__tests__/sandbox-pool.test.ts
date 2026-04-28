import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SandboxPool } from '../sandbox-pool.js';
import type { PoolConfig } from '../types.js';
import type { SandboxOptions } from '../../sandbox.js';

// Helper: build minimal SandboxOptions for testing.
function testSandboxOptions(): SandboxOptions {
  const fixturesDir = new URL(
    '../../platform/__tests__/fixtures',
    import.meta.url,
  ).pathname;
  return {
    wasmDir: fixturesDir,
    shellExecWasmPath: `${fixturesDir}/codepod-shell-exec.wasm`,
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

  it('fills to minSize after init()', async () => {
    const config: PoolConfig = { minSize: 2, maxSize: 5 };
    pool = new SandboxPool(config, testSandboxOptions());
    await pool.init();
    expect(pool.stats.idle).toBe(2);
    expect(pool.stats.creating).toBe(0);
  });

  it('drain() destroys all idle sandboxes', async () => {
    const config: PoolConfig = { minSize: 3, maxSize: 5 };
    pool = new SandboxPool(config, testSandboxOptions());
    await pool.init();
    expect(pool.stats.idle).toBe(3);
    await pool.drain();
    expect(pool.stats.idle).toBe(0);
  });

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

  it('maxSize caps total sandboxes', async () => {
    const config: PoolConfig = { minSize: 1, maxSize: 2 };
    pool = new SandboxPool(config, testSandboxOptions());
    await pool.init();
    const sb1 = await pool.checkout();
    // idle=0, checkedOut=1, replenish will try to create 1 more (total=2=maxSize)
    // Wait for replenish
    await new Promise((r) => setTimeout(r, 200));
    const sb2 = await pool.checkout();
    expect(pool.stats.checkedOut).toBe(2);
    // Now at maxSize — replenish should not create more
    await new Promise((r) => setTimeout(r, 200));
    expect(pool.stats.idle).toBe(0);
    expect(pool.stats.creating).toBe(0);
    pool.release(sb1);
    pool.release(sb2);
  });

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
});
