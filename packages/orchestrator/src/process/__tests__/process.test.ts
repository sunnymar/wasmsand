import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';

import { ProcessManager } from '../manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname, '../../platform/__tests__/fixtures');

describe('ProcessManager', () => {
  let vfs: VFS;
  let mgr: ProcessManager;

  beforeEach(() => {
    vfs = new VFS();
    const adapter = new NodeAdapter();
    mgr = new ProcessManager(vfs, adapter);
    mgr.registerTool('hello', resolve(FIXTURES, 'hello.wasm'));
    mgr.registerTool('echo-args', resolve(FIXTURES, 'echo-args.wasm'));
  });

  it('spawns a process and captures stdout', async () => {
    const result = await mgr.spawn('hello', { args: [], env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from wasm\n');
    expect(result.stderr).toBe('');
  });

  it('passes args to the process', async () => {
    const result = await mgr.spawn('echo-args', {
      args: ['one', 'two'],
      env: {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('one\ntwo\n');
  });

  it('passes env to the process', async () => {
    const result = await mgr.spawn('hello', {
      args: [],
      env: { FOO: 'bar' },
    });
    expect(result.exitCode).toBe(0);
  });

  it('caches modules after first load', async () => {
    const r1 = await mgr.spawn('hello', { args: [], env: {} });
    const r2 = await mgr.spawn('hello', { args: [], env: {} });
    expect(r1.stdout).toBe('hello from wasm\n');
    expect(r2.stdout).toBe('hello from wasm\n');
  });

  it('throws for unregistered tools', async () => {
    await expect(mgr.spawn('nonexistent', { args: [], env: {} }))
      .rejects.toThrow(/not found|not registered/i);
  });

  it('provides execution time', async () => {
    const result = await mgr.spawn('hello', { args: [], env: {} });
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.executionTimeMs).toBeLessThan(5000);
  });
});
