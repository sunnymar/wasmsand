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

  describe('snapshot and restore', () => {
    it('snapshot captures VFS + env state', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
      sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('v1'));
      sandbox.setEnv('MY_VAR', 'original');
      const snapId = sandbox.snapshot();

      sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('v2'));
      sandbox.setEnv('MY_VAR', 'changed');
      sandbox.writeFile('/tmp/new.txt', new TextEncoder().encode('new'));

      sandbox.restore(snapId);
      expect(new TextDecoder().decode(sandbox.readFile('/tmp/data.txt'))).toBe('v1');
      expect(sandbox.getEnv('MY_VAR')).toBe('original');
      expect(() => sandbox.stat('/tmp/new.txt')).toThrow();
    });

    it('snapshots are reusable', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
      sandbox.writeFile('/tmp/f.txt', new TextEncoder().encode('snap'));
      const snapId = sandbox.snapshot();

      sandbox.writeFile('/tmp/f.txt', new TextEncoder().encode('changed1'));
      sandbox.restore(snapId);
      expect(new TextDecoder().decode(sandbox.readFile('/tmp/f.txt'))).toBe('snap');

      sandbox.writeFile('/tmp/f.txt', new TextEncoder().encode('changed2'));
      sandbox.restore(snapId);
      expect(new TextDecoder().decode(sandbox.readFile('/tmp/f.txt'))).toBe('snap');
    });

    it('restore throws for invalid snapshot ID', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
      expect(() => sandbox.restore('nonexistent')).toThrow();
    });
  });

  describe('fork', () => {
    it('creates an independent sandbox with COW VFS', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
      sandbox.writeFile('/tmp/shared.txt', new TextEncoder().encode('original'));
      sandbox.setEnv('FORKED', 'yes');

      const child = await sandbox.fork();
      try {
        expect(new TextDecoder().decode(child.readFile('/tmp/shared.txt'))).toBe('original');
        expect(child.getEnv('FORKED')).toBe('yes');

        child.writeFile('/tmp/shared.txt', new TextEncoder().encode('child'));
        expect(new TextDecoder().decode(sandbox.readFile('/tmp/shared.txt'))).toBe('original');
        expect(new TextDecoder().decode(child.readFile('/tmp/shared.txt'))).toBe('child');

        child.writeFile('/tmp/child-only.txt', new TextEncoder().encode('x'));
        expect(() => sandbox.stat('/tmp/child-only.txt')).toThrow();
      } finally {
        child.destroy();
      }
    });

    it('forked sandbox can run commands independently', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
      const child = await sandbox.fork();
      try {
        const result = await child.run('echo hello from fork');
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('hello from fork');
      } finally {
        child.destroy();
      }
    });
  });

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
      // ShellRunner writes tool stubs to /bin and /usr/bin during init,
      // consuming ~130 file slots. Use a tight limit that allows one
      // more user file but not two.
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        shellWasmPath: SHELL_WASM,
        adapter: new NodeAdapter(),
        limits: { fileCount: 200 },
      });
      sandbox.writeFile('/tmp/a.txt', new Uint8Array(1));
      // Fill remaining slots to trigger the limit
      let hitLimit = false;
      for (let i = 0; i < 200; i++) {
        try {
          sandbox.writeFile(`/tmp/fill-${i}.txt`, new Uint8Array(1));
        } catch (e: unknown) {
          if (e instanceof Error && e.message.includes('ENOSPC')) {
            hitLimit = true;
            break;
          }
          throw e;
        }
      }
      expect(hitLimit).toBe(true);
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

  describe('socket shim bootstrap', () => {
    it('writes socket.py to VFS when network is configured', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        shellWasmPath: SHELL_WASM,
        adapter: new NodeAdapter(),
        network: { allowedHosts: ['example.com'] },
      });
      const data = sandbox.readFile('/usr/lib/python/socket.py');
      const content = new TextDecoder().decode(data);
      expect(content).toContain('CONTROL_FD');
      expect(content).toContain('class socket:');

      const siteData = sandbox.readFile('/usr/lib/python/sitecustomize.py');
      const siteContent = new TextDecoder().decode(siteData);
      expect(siteContent).toContain('sys.modules["socket"]');
    });

    it('sets PYTHONPATH when network is configured', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        shellWasmPath: SHELL_WASM,
        adapter: new NodeAdapter(),
        network: { allowedHosts: ['example.com'] },
      });
      expect(sandbox.getEnv('PYTHONPATH')).toBe('/usr/lib/python');
    });

    it('does not write socket.py when network is not configured', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        shellWasmPath: SHELL_WASM,
        adapter: new NodeAdapter(),
      });
      expect(() => sandbox.readFile('/usr/lib/python/socket.py')).toThrow();
    });

    it('forked sandbox inherits socket.py', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        shellWasmPath: SHELL_WASM,
        adapter: new NodeAdapter(),
        network: { allowedHosts: ['example.com'] },
      });
      const child = await sandbox.fork();
      try {
        const data = child.readFile('/usr/lib/python/socket.py');
        expect(new TextDecoder().decode(data)).toContain('CONTROL_FD');
      } finally {
        child.destroy();
      }
    });
  });
});
