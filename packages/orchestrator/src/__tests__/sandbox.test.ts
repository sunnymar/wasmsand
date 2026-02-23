/**
 * Integration tests for the Sandbox class.
 *
 * Exercises the full public API: create, run, file operations, env,
 * destroy, timeout, and VFS size limits.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../shell/__tests__/fixtures/wasmsand-shell.wasm');

describe('Sandbox', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('create and run a simple command', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('run a pipeline', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo hello world | wc -c');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('12');
  });

  it('writeFile and readFile', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const data = new TextEncoder().encode('test content');
    sandbox.writeFile('/tmp/test.txt', data);
    const read = sandbox.readFile('/tmp/test.txt');
    expect(new TextDecoder().decode(read)).toBe('test content');
  });

  it('writeFile then cat via run', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('hello from host'));
    const result = await sandbox.run('cat /tmp/data.txt');
    expect(result.stdout).toBe('hello from host');
  });

  it('mkdir and readDir', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    sandbox.mkdir('/tmp/mydir');
    const entries = sandbox.readDir('/tmp');
    expect(entries.some(e => e.name === 'mydir')).toBe(true);
  });

  it('stat returns file info', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/s.txt', new TextEncoder().encode('abc'));
    const s = sandbox.stat('/tmp/s.txt');
    expect(s.size).toBe(3);
    expect(s.type).toBe('file');
  });

  it('rm removes a file', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/del.txt', new TextEncoder().encode('x'));
    sandbox.rm('/tmp/del.txt');
    expect(() => sandbox.stat('/tmp/del.txt')).toThrow();
  });

  it('setEnv and getEnv', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    sandbox.setEnv('MY_VAR', 'hello');
    expect(sandbox.getEnv('MY_VAR')).toBe('hello');
    const result = await sandbox.run('printenv MY_VAR');
    expect(result.stdout.trim()).toBe('hello');
  });

  it('destroy prevents further use', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    sandbox.destroy();
    expect(() => sandbox.readFile('/tmp/x')).toThrow(/destroyed/);
    sandbox.destroy(); // double destroy is safe
  });

  it('timeout returns exit code 124', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter(), timeoutMs: 1 });
    const result = await sandbox.run('yes hello | head -1000');
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  });

  it('VFS size limit enforces ENOSPC', async () => {
    // Use a limit large enough to fit the tool stubs ShellRunner writes
    // to /bin and /usr/bin during init (~3KB) plus the first file, but
    // not the second.
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter(), fsLimitBytes: 16_384 });
    sandbox.writeFile('/tmp/a.txt', new Uint8Array(8_000));
    expect(() => {
      sandbox.writeFile('/tmp/b.txt', new Uint8Array(10_000));
    }).toThrow(/ENOSPC/);
  });

  it('discovers tools via scanTools', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const result = await sandbox.run('uname');
    expect(result.stdout.trim()).toBe('wasmsand');
  });
});
