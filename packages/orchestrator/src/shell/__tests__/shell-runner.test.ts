import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';

import { ShellRunner } from '../shell-runner.js';
import { ProcessManager } from '../../process/manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';
import { NetworkGateway } from '../../network/gateway.js';

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

  describe('cd builtin', () => {
    it('changes PWD to an existing directory', async () => {
      vfs.mkdir('/home/user/projects');
      await runner.run('cd /home/user/projects');
      expect(runner.getEnv('PWD')).toBe('/home/user/projects');
    });

    it('cd with no args goes to /home/user', async () => {
      runner.setEnv('PWD', '/tmp');
      await runner.run('cd');
      expect(runner.getEnv('PWD')).toBe('/home/user');
    });

    it('cd - goes to OLDPWD', async () => {
      runner.setEnv('PWD', '/home/user');
      await runner.run('cd /tmp');
      expect(runner.getEnv('PWD')).toBe('/tmp');
      expect(runner.getEnv('OLDPWD')).toBe('/home/user');
      await runner.run('cd -');
      expect(runner.getEnv('PWD')).toBe('/home/user');
      expect(runner.getEnv('OLDPWD')).toBe('/tmp');
    });

    it('cd to non-existent dir returns exit code 1', async () => {
      const result = await runner.run('cd /nonexistent');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('no such file or directory');
    });

    it('cd to a file returns exit code 1', async () => {
      vfs.writeFile('/tmp/file.txt', new TextEncoder().encode('x'));
      const result = await runner.run('cd /tmp/file.txt');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not a directory');
    });

    it('cd .. resolves parent directory', async () => {
      runner.setEnv('PWD', '/home/user');
      await runner.run('cd ..');
      expect(runner.getEnv('PWD')).toBe('/home');
    });
  });

  describe('export builtin', () => {
    it('export FOO=bar sets the variable', async () => {
      await runner.run('export FOO=bar');
      expect(runner.getEnv('FOO')).toBe('bar');
    });

    it('export with no args lists all env vars', async () => {
      runner.setEnv('A', '1');
      runner.setEnv('B', '2');
      const result = await runner.run('export');
      expect(result.stdout).toContain('A=1');
      expect(result.stdout).toContain('B=2');
    });

    it('export FOO with no value is a no-op', async () => {
      runner.setEnv('FOO', 'existing');
      await runner.run('export FOO');
      expect(runner.getEnv('FOO')).toBe('existing');
    });
  });

  describe('unset builtin', () => {
    it('removes a variable from env', async () => {
      runner.setEnv('FOO', 'bar');
      await runner.run('unset FOO');
      expect(runner.getEnv('FOO')).toBeUndefined();
    });

    it('unset non-existent variable is a no-op', async () => {
      const result = await runner.run('unset NONEXISTENT');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('date builtin', () => {
    it('returns a date string with no args', async () => {
      const result = await runner.run('date');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBeTruthy();
      expect(result.stdout).toMatch(/\d{4}/);
    });

    it('supports +%Y-%m-%d format', async () => {
      const result = await runner.run('date +%Y-%m-%d');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('supports +%H:%M:%S format', async () => {
      const result = await runner.run('date +%H:%M:%S');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });
  });

  describe('curl builtin', () => {
    it('returns error when no NetworkGateway is configured', async () => {
      const result = await runner.run('curl https://example.com');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('network access not configured');
    });
  });

  describe('curl builtin with gateway', () => {
    let netRunner: ShellRunner;
    let savedFetch: typeof globalThis.fetch;

    beforeEach(() => {
      savedFetch = globalThis.fetch;
      globalThis.fetch = async (url: RequestInfo | URL) => {
        return new Response(`response from ${url}`, { status: 200 });
      };
      const gateway = new NetworkGateway({ allowedHosts: ['example.com'] });
      const adapter = new NodeAdapter();
      netRunner = new ShellRunner(vfs, mgr, adapter, SHELL_WASM, gateway);
    });

    afterEach(() => {
      globalThis.fetch = savedFetch;
    });

    it('GET request outputs response body', async () => {
      const result = await netRunner.run('curl https://example.com/data');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('response from');
    });

    it('-o writes output to VFS file', async () => {
      const result = await netRunner.run('curl -o /tmp/out.txt https://example.com/data');
      expect(result.exitCode).toBe(0);
      const content = new TextDecoder().decode(vfs.readFile('/tmp/out.txt'));
      expect(content).toContain('response from');
    });

    it('blocked host returns error', async () => {
      const result = await netRunner.run('curl https://evil.com/data');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('denied');
    });
  });

  describe('wget builtin with gateway', () => {
    let netRunner: ShellRunner;
    let savedFetch: typeof globalThis.fetch;

    beforeEach(() => {
      savedFetch = globalThis.fetch;
      globalThis.fetch = async (url: RequestInfo | URL) => {
        return new Response(`downloaded from ${url}`, { status: 200 });
      };
      const gateway = new NetworkGateway({ allowedHosts: ['example.com'] });
      const adapter = new NodeAdapter();
      netRunner = new ShellRunner(vfs, mgr, adapter, SHELL_WASM, gateway);
      netRunner.setEnv('PWD', '/home/user');
    });

    afterEach(() => {
      globalThis.fetch = savedFetch;
    });

    it('downloads to VFS file named from URL', async () => {
      const result = await netRunner.run('wget https://example.com/file.txt');
      expect(result.exitCode).toBe(0);
      const content = new TextDecoder().decode(vfs.readFile('/home/user/file.txt'));
      expect(content).toContain('downloaded from');
    });

    it('-O - outputs to stdout', async () => {
      const result = await netRunner.run('wget -O - https://example.com/file.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('downloaded from');
    });
  });
});
