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
});
