import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';

import { ShellRunner } from '../shell-runner.js';
import { ProcessManager } from '../../process/manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname, '../../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../__tests__/fixtures/wasmsand-shell.wasm');

describe('ShellRunner', () => {
  let vfs: VFS;
  let mgr: ProcessManager;
  let runner: ShellRunner;

  beforeEach(() => {
    vfs = new VFS();
    const adapter = new NodeAdapter();
    mgr = new ProcessManager(vfs, adapter);
    mgr.registerTool('echo-args', resolve(FIXTURES, 'echo-args.wasm'));
    mgr.registerTool('cat-stdin', resolve(FIXTURES, 'cat-stdin.wasm'));
    mgr.registerTool('wc-bytes', resolve(FIXTURES, 'wc-bytes.wasm'));
    mgr.registerTool('true', resolve(FIXTURES, 'true-cmd.wasm'));
    mgr.registerTool('false', resolve(FIXTURES, 'false-cmd.wasm'));
    runner = new ShellRunner(vfs, mgr, adapter, SHELL_WASM);
  });

  describe('simple commands', () => {
    it('runs a simple command', async () => {
      const result = await runner.run('echo-args hello');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello\n');
    });

    it('runs a command with multiple arguments', async () => {
      const result = await runner.run('echo-args hello world');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello\nworld\n');
    });

    it('returns non-zero exit code from false', async () => {
      const result = await runner.run('false');
      expect(result.exitCode).not.toBe(0);
    });

    it('returns zero exit code from true', async () => {
      const result = await runner.run('true');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('pipelines', () => {
    it('pipes stdout of one command to stdin of next', async () => {
      const result = await runner.run('echo-args hello | cat-stdin');
      expect(result.stdout).toBe('hello\n');
    });

    it('pipes through three commands', async () => {
      const result = await runner.run('echo-args hello | cat-stdin | wc-bytes');
      expect(result.stdout.trim()).toBe('6');
    });
  });

  describe('list operators (&&, ||, ;)', () => {
    it('runs second command when first succeeds with &&', async () => {
      const result = await runner.run('true && echo-args yes');
      expect(result.stdout).toBe('yes\n');
    });

    it('skips second command when first fails with &&', async () => {
      const result = await runner.run('false && echo-args yes');
      expect(result.stdout).toBe('');
      expect(result.exitCode).not.toBe(0);
    });

    it('runs second command when first fails with ||', async () => {
      const result = await runner.run('false || echo-args fallback');
      expect(result.stdout).toBe('fallback\n');
      expect(result.exitCode).toBe(0);
    });

    it('skips second command when first succeeds with ||', async () => {
      const result = await runner.run('true || echo-args fallback');
      expect(result.stdout).toBe('');
      expect(result.exitCode).toBe(0);
    });

    it('handles && and || chain', async () => {
      // (true && echo-args yes) || echo-args no
      const result = await runner.run('true && echo-args yes || echo-args no');
      expect(result.stdout).toBe('yes\n');
    });

    it('handles sequence with ;', async () => {
      const result = await runner.run('echo-args first ; echo-args second');
      expect(result.stdout).toBe('first\nsecond\n');
    });
  });

  describe('redirects', () => {
    it('redirects stdout to file with >', async () => {
      const result = await runner.run('echo-args hello > /home/user/out.txt');
      expect(result.stdout).toBe('');
      const content = new TextDecoder().decode(vfs.readFile('/home/user/out.txt'));
      expect(content).toBe('hello\n');
    });

    it('redirects stdin from file with <', async () => {
      vfs.writeFile('/home/user/in.txt', new TextEncoder().encode('from file'));
      const result = await runner.run('cat-stdin < /home/user/in.txt');
      expect(result.stdout).toBe('from file');
    });

    it('appends with >>', async () => {
      vfs.writeFile('/home/user/out.txt', new TextEncoder().encode('line1\n'));
      await runner.run('echo-args line2 >> /home/user/out.txt');
      const content = new TextDecoder().decode(vfs.readFile('/home/user/out.txt'));
      expect(content).toBe('line1\nline2\n');
    });
  });

  describe('variables', () => {
    it('expands environment variables', async () => {
      runner.setEnv('GREETING', 'hello');
      const result = await runner.run('echo-args $GREETING');
      expect(result.stdout).toBe('hello\n');
    });

    it('handles assignments that set env for session', async () => {
      await runner.run('FOO=bar');
      const result = await runner.run('echo-args $FOO');
      expect(result.stdout).toBe('bar\n');
    });
  });

  describe('if/else', () => {
    it('executes then branch when condition succeeds', async () => {
      const result = await runner.run('if true; then echo-args yes; fi');
      expect(result.stdout).toBe('yes\n');
    });

    it('executes else branch when condition fails', async () => {
      const result = await runner.run('if false; then echo-args yes; else echo-args no; fi');
      expect(result.stdout).toBe('no\n');
    });
  });

  describe('for loops', () => {
    it('iterates over literal words', async () => {
      const result = await runner.run('for x in a b c; do echo-args $x; done');
      expect(result.stdout).toBe('a\nb\nc\n');
    });
  });

  describe('subshells', () => {
    it('runs commands in a subshell', async () => {
      const result = await runner.run('( echo-args sub )');
      expect(result.stdout).toBe('sub\n');
    });
  });
});
