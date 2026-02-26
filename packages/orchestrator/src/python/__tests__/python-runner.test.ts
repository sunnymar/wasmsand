import { describe, it, expect, beforeEach } from 'bun:test';
import { resolve } from 'node:path';
import { PythonRunner } from '../python-runner.js';
import { ProcessManager } from '../../process/manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';
import { Sandbox } from '../../sandbox.js';

const FIXTURES = resolve(
  import.meta.dirname,
  '../../platform/__tests__/fixtures',
);
const SHELL_WASM = resolve(import.meta.dirname, '../../shell/__tests__/fixtures/codepod-shell.wasm');

describe('PythonRunner', () => {
  let vfs: VFS;
  let runner: PythonRunner;

  beforeEach(() => {
    vfs = new VFS();
    const adapter = new NodeAdapter();
    const mgr = new ProcessManager(vfs, adapter);
    mgr.registerTool('python3', resolve(FIXTURES, 'python3.wasm'));
    runner = new PythonRunner(mgr);
  });

  describe('basic execution', () => {
    it('evaluates simple expression', async () => {
      const result = await runner.run({
        args: ['-c', 'print(1 + 2)'],
        env: {},
      });
      expect(result.stdout).toBe('3\n');
      expect(result.exitCode).toBe(0);
    });

    it('evaluates multi-line code', async () => {
      const result = await runner.run({
        args: ['-c', 'x = 10\ny = 20\nprint(x + y)'],
        env: {},
      });
      expect(result.stdout).toBe('30\n');
    });

    it('captures multiple print calls', async () => {
      const result = await runner.run({
        args: ['-c', 'print("hello")\nprint("world")'],
        env: {},
      });
      expect(result.stdout).toBe('hello\nworld\n');
    });

    it('returns exit code 1 on runtime error', async () => {
      const result = await runner.run({
        args: ['-c', '1 / 0'],
        env: {},
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('ZeroDivisionError');
    });

    it('returns exit code 2 on syntax error', async () => {
      const result = await runner.run({
        args: ['-c', 'def foo('],
        env: {},
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('SyntaxError');
    });
  });

  describe('script file execution', () => {
    it('runs a .py script from VFS', async () => {
      vfs.writeFile(
        '/home/user/hello.py',
        new TextEncoder().encode('print("hello from script")'),
      );
      const result = await runner.run({
        args: ['/home/user/hello.py'],
        env: {},
      });
      expect(result.stdout).toBe('hello from script\n');
      expect(result.exitCode).toBe(0);
    });

    it('returns error for missing script', async () => {
      const result = await runner.run({
        args: ['/home/user/missing.py'],
        env: {},
      });
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('VFS file I/O via standard Python', () => {
    it('reads a file from VFS', async () => {
      vfs.writeFile(
        '/home/user/data.txt',
        new TextEncoder().encode('file content'),
      );
      const result = await runner.run({
        args: ['-c', 'print(open("/home/user/data.txt").read(), end="")'],
        env: {},
      });
      expect(result.stdout).toBe('file content');
    });

    it('writes a file to VFS', async () => {
      const result = await runner.run({
        args: ['-c', 'open("/home/user/out.txt", "w").write("from python")'],
        env: {},
      });
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(vfs.readFile('/home/user/out.txt'))).toBe(
        'from python',
      );
    });

    it('lists directory contents', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode(''));
      const result = await runner.run({
        args: [
          '-c',
          'import os\nfor f in sorted(os.listdir("/home/user")):\n  print(f)',
        ],
        env: {},
      });
      expect(result.stdout).toContain('a.txt');
      expect(result.stdout).toContain('b.txt');
    });

    it('checks file existence', async () => {
      vfs.writeFile('/home/user/exists.txt', new TextEncoder().encode(''));
      const result = await runner.run({
        args: [
          '-c',
          'import os.path\nprint(os.path.exists("/home/user/exists.txt"))\nprint(os.path.exists("/home/user/nope.txt"))',
        ],
        env: {},
      });
      expect(result.stdout).toBe('True\nFalse\n');
    });
  });

  describe('stdin piping', () => {
    it('reads stdin data', async () => {
      const result = await runner.run({
        args: ['-c', 'import sys\ndata = sys.stdin.read()\nprint(data.strip())'],
        env: {},
        stdinData: new TextEncoder().encode('piped input\n'),
      });
      expect(result.stdout).toBe('piped input\n');
    });

    it('handles empty stdin', async () => {
      const result = await runner.run({
        args: ['-c', 'import sys\nprint(len(sys.stdin.read()))'],
        env: {},
      });
      expect(result.stdout).toBe('0\n');
    });
  });

  describe('resource limits', () => {
    it('terminates infinite loops via worker hard-kill', { timeout: 10000 }, async () => {
      const adapter = new NodeAdapter();
      const sb = await Sandbox.create({
        wasmDir: FIXTURES,
        shellWasmPath: SHELL_WASM,
        adapter,
        security: { hardKill: true, limits: { timeoutMs: 3000 } },
      });
      const result = await sb.run('python3 -c "while True:\n  pass"');
      expect(result.errorClass).toBe('TIMEOUT');
      expect(result.exitCode).toBe(124);
      sb.destroy();
    });
  });
});
