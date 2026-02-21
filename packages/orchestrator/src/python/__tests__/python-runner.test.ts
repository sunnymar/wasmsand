import { describe, it, expect, beforeEach } from 'vitest';
import { PythonRunner } from '../python-runner.js';
import { VFS } from '../../vfs/vfs.js';

describe('PythonRunner', () => {
  let vfs: VFS;
  let runner: PythonRunner;

  beforeEach(() => {
    vfs = new VFS();
    runner = new PythonRunner(vfs);
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
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('ZeroDivisionError');
    });

    it('returns exit code 2 on syntax error', async () => {
      const result = await runner.run({
        args: ['-c', 'def foo('],
        env: {},
      });
      expect(result.exitCode).toBe(2);
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

  describe('VFS file I/O via external functions', () => {
    it('reads a file from VFS', async () => {
      vfs.writeFile(
        '/home/user/data.txt',
        new TextEncoder().encode('file content'),
      );
      const result = await runner.run({
        args: ['-c', 'content = read_file("/home/user/data.txt")\nprint(content)'],
        env: {},
      });
      expect(result.stdout).toBe('file content\n');
    });

    it('writes a file to VFS', async () => {
      const result = await runner.run({
        args: ['-c', 'write_file("/home/user/out.txt", "from python")'],
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
          'items = list_dir("/home/user")\nfor f in items:\n  print(f)',
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
          'print(file_exists("/home/user/exists.txt"))\nprint(file_exists("/home/user/nope.txt"))',
        ],
        env: {},
      });
      expect(result.stdout).toBe('True\nFalse\n');
    });
  });

  describe('stdin piping', () => {
    it('reads stdin data', async () => {
      const result = await runner.run({
        args: ['-c', 'data = read_stdin()\nprint(data.strip())'],
        env: {},
        stdinData: new TextEncoder().encode('piped input\n'),
      });
      expect(result.stdout).toBe('piped input\n');
    });

    it('handles empty stdin', async () => {
      const result = await runner.run({
        args: ['-c', 'data = read_stdin()\nprint(len(data))'],
        env: {},
      });
      expect(result.stdout).toBe('0\n');
    });
  });

  describe('resource limits', () => {
    it('terminates infinite loops', { timeout: 10000 }, async () => {
      const result = await runner.run({
        args: ['-c', 'while True:\n  pass'],
        env: {},
      });
      // Should fail with a resource limit error, not hang
      expect(result.exitCode).not.toBe(0);
    });
  });
});
