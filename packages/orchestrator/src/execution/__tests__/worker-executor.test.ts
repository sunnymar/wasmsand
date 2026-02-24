import { describe, it, expect, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { WorkerExecutor } from '../worker-executor.js';
import { VFS } from '../../vfs/vfs.js';

const WASM_DIR = resolve(import.meta.dirname, '../../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../../shell/__tests__/fixtures/wasmsand-shell.wasm');

/** Build a tool registry for the tests. */
function makeToolRegistry(...names: string[]): [string, string][] {
  return names.map((name) => {
    const file = name === 'true' ? 'true-cmd.wasm'
      : name === 'false' ? 'false-cmd.wasm'
      : `${name}.wasm`;
    return [name, resolve(WASM_DIR, file)];
  });
}

/** Poll until the executor reports it's running. */
async function waitForRunning(exec: WorkerExecutor, intervalMs = 5, maxMs = 10000): Promise<void> {
  const start = Date.now();
  while (!exec.isRunning()) {
    if (Date.now() - start > maxMs) throw new Error('Timed out waiting for executor to start running');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('WorkerExecutor', () => {
  let executor: WorkerExecutor;
  let vfs: VFS;

  afterEach(() => {
    executor?.dispose();
  });

  it('runs a simple echo command through the Worker', async () => {
    vfs = new VFS();
    executor = new WorkerExecutor({
      vfs,
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      toolRegistry: [],
    });
    const env = new Map([
      ['HOME', '/home/user'],
      ['PWD', '/home/user'],
      ['PATH', '/bin:/usr/bin'],
    ]);
    const result = await executor.run('echo hello from worker', env, 10000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello from worker');
  });

  it('VFS proxy roundtrip: Worker reads file written on main thread', async () => {
    vfs = new VFS();
    vfs.writeFile('/tmp/test.txt', new TextEncoder().encode('proxy works'));
    executor = new WorkerExecutor({
      vfs,
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      toolRegistry: makeToolRegistry('cat'),
    });
    const env = new Map([
      ['HOME', '/home/user'],
      ['PWD', '/home/user'],
      ['PATH', '/bin:/usr/bin'],
    ]);
    const result = await executor.run('cat /tmp/test.txt', env, 10000);
    expect(result.stdout).toBe('proxy works');
  });

  it('timeout kills Worker and returns TIMEOUT result', async () => {
    vfs = new VFS();
    executor = new WorkerExecutor({
      vfs,
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      toolRegistry: makeToolRegistry('seq'),
    });
    const env = new Map([
      ['HOME', '/home/user'],
      ['PWD', '/home/user'],
      ['PATH', '/bin:/usr/bin'],
    ]);
    const result = await executor.run('seq 1 999999999', env, 100);
    expect(result.exitCode).toBe(124);
    expect(result.errorClass).toBe('TIMEOUT');
  });

  it('kill() terminates Worker and returns CANCELLED', async () => {
    vfs = new VFS();
    executor = new WorkerExecutor({
      vfs,
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      toolRegistry: makeToolRegistry('seq'),
    });
    const env = new Map([
      ['HOME', '/home/user'],
      ['PWD', '/home/user'],
      ['PATH', '/bin:/usr/bin'],
    ]);
    const promise = executor.run('seq 1 999999999', env, 30000);
    await waitForRunning(executor);
    executor.kill();
    const result = await promise;
    expect(result.exitCode).toBe(125);
    expect(result.errorClass).toBe('CANCELLED');
  });

  it('next run after kill creates fresh Worker', { timeout: 15000 }, async () => {
    vfs = new VFS();
    executor = new WorkerExecutor({
      vfs,
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      toolRegistry: makeToolRegistry('seq'),
    });
    const env = new Map([
      ['HOME', '/home/user'],
      ['PWD', '/home/user'],
      ['PATH', '/bin:/usr/bin'],
    ]);

    // Kill first run
    const promise1 = executor.run('seq 1 999999999', env, 30000);
    await waitForRunning(executor);
    executor.kill();
    await promise1;

    // Second run should spin up a new Worker and succeed
    const result2 = await executor.run('echo recovered', env, 10000);
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout.trim()).toBe('recovered');
  });

  it('isRunning() returns correct state', async () => {
    vfs = new VFS();
    executor = new WorkerExecutor({
      vfs,
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      toolRegistry: [],
    });
    expect(executor.isRunning()).toBe(false);
    const env = new Map([
      ['HOME', '/home/user'],
      ['PWD', '/home/user'],
      ['PATH', '/bin:/usr/bin'],
    ]);
    const promise = executor.run('echo quick', env, 10000);
    const result = await promise;
    expect(executor.isRunning()).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});
