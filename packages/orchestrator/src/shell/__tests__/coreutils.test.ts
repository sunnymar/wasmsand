/**
 * Integration tests for real coreutils wasm binaries running through the ShellRunner.
 *
 * These tests exercise the full stack: shell parser → AST executor → ProcessManager → WASI host → coreutils wasm.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';

import { ShellRunner } from '../shell-runner.js';
import { ProcessManager } from '../../process/manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname, '../../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, 'fixtures/wasmsand-shell.wasm');

const TOOLS = [
  'cat', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep',
  'ls', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'tee', 'tr', 'cut',
  'basename', 'dirname', 'env', 'printf',
  'find', 'sed', 'awk', 'jq',
  'true', 'false',
];

/** Map tool name to wasm filename (true/false use special names). */
function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  return `${tool}.wasm`;
}

describe('Coreutils Integration', () => {
  let vfs: VFS;
  let runner: ShellRunner;

  beforeEach(() => {
    vfs = new VFS();
    const adapter = new NodeAdapter();
    const mgr = new ProcessManager(vfs, adapter);

    for (const tool of TOOLS) {
      mgr.registerTool(tool, resolve(FIXTURES, wasmName(tool)));
    }

    runner = new ShellRunner(vfs, mgr, adapter, SHELL_WASM);
  });

  describe('echo', () => {
    it('prints arguments', async () => {
      const result = await runner.run('echo hello world');
      expect(result.stdout).toBe('hello world\n');
      expect(result.exitCode).toBe(0);
    });

    it('supports -n (no newline)', async () => {
      const result = await runner.run('echo -n hello');
      expect(result.stdout).toBe('hello');
    });
  });

  describe('cat', () => {
    it('reads a file', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('file content'));
      const result = await runner.run('cat /home/user/data.txt');
      expect(result.stdout).toBe('file content');
    });

    it('reads stdin in pipeline', async () => {
      const result = await runner.run('echo hello | cat');
      expect(result.stdout).toBe('hello\n');
    });
  });

  describe('head', () => {
    it('shows first 10 lines by default', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode(lines));
      const result = await runner.run('head /home/user/data.txt');
      const outputLines = result.stdout.trimEnd().split('\n');
      expect(outputLines.length).toBe(10);
      expect(outputLines[0]).toBe('line1');
      expect(outputLines[9]).toBe('line10');
    });

    it('supports -n flag', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode(lines));
      const result = await runner.run('head -n 3 /home/user/data.txt');
      const outputLines = result.stdout.trimEnd().split('\n');
      expect(outputLines.length).toBe(3);
    });
  });

  describe('tail', () => {
    it('shows last 10 lines by default', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode(lines));
      const result = await runner.run('tail /home/user/data.txt');
      const outputLines = result.stdout.trimEnd().split('\n');
      expect(outputLines.length).toBe(10);
      expect(outputLines[0]).toBe('line11');
      expect(outputLines[9]).toBe('line20');
    });
  });

  describe('wc', () => {
    it('counts lines, words, bytes', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('hello world\nfoo bar\n'));
      const result = await runner.run('wc /home/user/data.txt');
      // Should contain 2 lines, 4 words, 20 bytes
      expect(result.stdout).toMatch(/2/);
      expect(result.stdout).toMatch(/4/);
      expect(result.stdout).toMatch(/20/);
    });

    it('counts lines only with -l', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a\nb\nc\n'));
      const result = await runner.run('wc -l /home/user/data.txt');
      expect(result.stdout).toMatch(/3/);
    });

    it('works in a pipeline', async () => {
      const result = await runner.run('echo hello world | wc -c');
      // "hello world\n" = 12 bytes
      expect(result.stdout.trim()).toBe('12');
    });
  });

  describe('sort', () => {
    it('sorts lines', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('banana\napple\ncherry\n'));
      const result = await runner.run('sort /home/user/data.txt');
      expect(result.stdout).toBe('apple\nbanana\ncherry\n');
    });

    it('supports -r for reverse', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a\nb\nc\n'));
      const result = await runner.run('sort -r /home/user/data.txt');
      expect(result.stdout).toBe('c\nb\na\n');
    });

    it('works in a pipeline', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('banana\napple\ncherry\n'));
      const result = await runner.run('cat /home/user/data.txt | sort');
      expect(result.stdout).toBe('apple\nbanana\ncherry\n');
    });
  });

  describe('uniq', () => {
    it('removes adjacent duplicates', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a\na\nb\nc\nc\n'));
      const result = await runner.run('uniq /home/user/data.txt');
      expect(result.stdout).toBe('a\nb\nc\n');
    });
  });

  describe('grep', () => {
    it('finds matching lines', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('hello world\nfoo bar\nhello again\n'));
      const result = await runner.run('grep hello /home/user/data.txt');
      expect(result.stdout).toBe('hello world\nhello again\n');
      expect(result.exitCode).toBe(0);
    });

    it('returns exit code 1 when no match', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('foo bar\n'));
      const result = await runner.run('grep notfound /home/user/data.txt');
      expect(result.exitCode).not.toBe(0);
    });

    it('works in a pipeline', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('ERROR: fail\nINFO: ok\nERROR: crash\n'));
      const result = await runner.run('cat /home/user/data.txt | grep ERROR');
      expect(result.stdout).toBe('ERROR: fail\nERROR: crash\n');
    });
  });

  describe('ls', () => {
    it('lists directory contents', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode(''));
      const result = await runner.run('ls /home/user');
      expect(result.stdout).toContain('a.txt');
      expect(result.stdout).toContain('b.txt');
    });
  });

  describe('mkdir + rm', () => {
    it('creates and removes a directory', async () => {
      await runner.run('mkdir /home/user/newdir');
      expect(vfs.stat('/home/user/newdir').type).toBe('dir');

      await runner.run('rm -r /home/user/newdir');
      expect(() => vfs.stat('/home/user/newdir')).toThrow();
    });

    it('creates nested dirs with -p', async () => {
      await runner.run('mkdir -p /home/user/a/b/c');
      expect(vfs.stat('/home/user/a/b/c').type).toBe('dir');
    });
  });

  describe('cp + mv', () => {
    it('copies a file', async () => {
      vfs.writeFile('/home/user/src.txt', new TextEncoder().encode('content'));
      await runner.run('cp /home/user/src.txt /home/user/dst.txt');
      expect(new TextDecoder().decode(vfs.readFile('/home/user/dst.txt'))).toBe('content');
    });

    it('moves a file', async () => {
      vfs.writeFile('/home/user/old.txt', new TextEncoder().encode('data'));
      await runner.run('mv /home/user/old.txt /home/user/new.txt');
      expect(new TextDecoder().decode(vfs.readFile('/home/user/new.txt'))).toBe('data');
      expect(() => vfs.stat('/home/user/old.txt')).toThrow();
    });
  });

  describe('touch', () => {
    it('creates a new empty file', async () => {
      await runner.run('touch /home/user/newfile.txt');
      expect(vfs.stat('/home/user/newfile.txt').type).toBe('file');
      expect(vfs.stat('/home/user/newfile.txt').size).toBe(0);
    });
  });

  describe('basename + dirname', () => {
    it('strips directory from path', async () => {
      const result = await runner.run('basename /home/user/file.txt');
      expect(result.stdout.trim()).toBe('file.txt');
    });

    it('strips last component from path', async () => {
      const result = await runner.run('dirname /home/user/file.txt');
      expect(result.stdout.trim()).toBe('/home/user');
    });
  });

  describe('tr', () => {
    it('translates characters in a pipeline', async () => {
      const result = await runner.run('echo hello | tr a-z A-Z');
      expect(result.stdout.trim()).toBe('HELLO');
    });
  });

  describe('cut', () => {
    it('extracts fields', async () => {
      vfs.writeFile('/home/user/data.csv', new TextEncoder().encode('alice,30\nbob,25\n'));
      const result = await runner.run('cut -d , -f 1 /home/user/data.csv');
      expect(result.stdout).toBe('alice\nbob\n');
    });
  });

  describe('find', () => {
    it('finds files by name', async () => {
      await runner.run('mkdir -p /home/user/docs');
      vfs.writeFile('/home/user/docs/readme.txt', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/docs/notes.txt', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/docs/image.png', new TextEncoder().encode(''));
      const result = await runner.run('find /home/user/docs -name *.txt');
      expect(result.stdout).toContain('readme.txt');
      expect(result.stdout).toContain('notes.txt');
      expect(result.stdout).not.toContain('image.png');
    });

    it('finds directories with -type d', async () => {
      await runner.run('mkdir -p /home/user/project/src');
      vfs.writeFile('/home/user/project/src/main.rs', new TextEncoder().encode(''));
      const result = await runner.run('find /home/user/project -type d');
      expect(result.stdout).toContain('/home/user/project');
      expect(result.stdout).toContain('src');
    });
  });

  describe('sed', () => {
    it('performs substitution', async () => {
      const result = await runner.run('echo hello world | sed s/hello/goodbye/');
      expect(result.stdout.trim()).toBe('goodbye world');
    });

    it('performs global substitution', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('aaa bbb aaa\n'));
      const result = await runner.run('sed s/aaa/xxx/g /home/user/data.txt');
      expect(result.stdout.trim()).toBe('xxx bbb xxx');
    });

    it('deletes matching lines', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('keep\ndelete this\nkeep too\n'));
      const result = await runner.run('sed /delete/d /home/user/data.txt');
      expect(result.stdout).toBe('keep\nkeep too\n');
    });
  });

  describe('awk', () => {
    it('prints specific field', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('alice 30\nbob 25\n'));
      const result = await runner.run("awk '{print $1}' /home/user/data.txt");
      expect(result.stdout).toBe('alice\nbob\n');
    });

    it('supports -F flag for field separator', async () => {
      vfs.writeFile('/home/user/data.csv', new TextEncoder().encode('alice,30\nbob,25\n'));
      const result = await runner.run("awk -F , '{print $2}' /home/user/data.csv");
      expect(result.stdout).toBe('30\n25\n');
    });

    it('supports pattern matching', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('alice 30\nbob 25\ncharlie 35\n'));
      const result = await runner.run("awk '$2 > 28 {print $1}' /home/user/data.txt");
      expect(result.stdout).toBe('alice\ncharlie\n');
    });

    it('supports BEGIN/END blocks', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('10\n20\n30\n'));
      const result = await runner.run("awk 'BEGIN {sum=0} {sum += $1} END {print sum}' /home/user/data.txt");
      expect(result.stdout.trim()).toBe('60');
    });

    it('works in a pipeline', async () => {
      const result = await runner.run("echo hello world | awk '{print $2}'");
      expect(result.stdout.trim()).toBe('world');
    });
  });

  describe('jq', () => {
    it('extracts a field', async () => {
      const result = await runner.run('echo \'{"name":"test","value":42}\' | jq .name');
      expect(result.stdout.trim()).toBe('"test"');
    });

    it('extracts nested field', async () => {
      const result = await runner.run('echo \'{"a":{"b":123}}\' | jq .a.b');
      expect(result.stdout.trim()).toBe('123');
    });

    it('filters array with select', async () => {
      vfs.writeFile('/home/user/data.json', new TextEncoder().encode('[{"n":1},{"n":2},{"n":3}]'));
      const result = await runner.run('cat /home/user/data.json | jq ".[] | select(.n > 1) | .n"');
      const lines = result.stdout.trim().split('\n');
      expect(lines).toEqual(['2', '3']);
    });

    it('supports keys', async () => {
      const result = await runner.run('echo \'{"b":2,"a":1}\' | jq keys');
      expect(result.stdout.trim()).toContain('"a"');
      expect(result.stdout.trim()).toContain('"b"');
    });

    it('supports map', async () => {
      const result = await runner.run('echo \'[1,2,3]\' | jq "map(. + 10)"');
      expect(result.stdout).toContain('11');
      expect(result.stdout).toContain('12');
      expect(result.stdout).toContain('13');
    });

    it('supports raw output with -r', async () => {
      const result = await runner.run('echo \'{"name":"test"}\' | jq -r .name');
      expect(result.stdout.trim()).toBe('test');
    });
  });

  describe('pipelines with real tools', () => {
    it('sort | uniq pipeline', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('b\na\nb\nc\na\n'));
      const result = await runner.run('sort /home/user/data.txt | uniq');
      expect(result.stdout).toBe('a\nb\nc\n');
    });

    it('grep | wc -l pipeline', async () => {
      vfs.writeFile('/home/user/log.txt', new TextEncoder().encode('ERROR: a\nINFO: b\nERROR: c\nINFO: d\n'));
      const result = await runner.run('grep ERROR /home/user/log.txt | wc -l');
      expect(result.stdout.trim()).toBe('2');
    });

    it('cat | sort | head pipeline', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('cherry\napple\nbanana\ndate\nelderberry\n'));
      const result = await runner.run('cat /home/user/data.txt | sort | head -n 3');
      expect(result.stdout).toBe('apple\nbanana\ncherry\n');
    });

    it('echo | sed | awk pipeline', async () => {
      const result = await runner.run("echo hello-world | sed s/hello-// | awk '{print $1}'");
      expect(result.stdout.trim()).toBe('world');
    });

    it('cat | awk | sort pipeline', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('charlie 35\nalice 30\nbob 25\n'));
      const result = await runner.run("cat /home/user/data.txt | awk '{print $1}' | sort");
      expect(result.stdout).toBe('alice\nbob\ncharlie\n');
    });
  });
});
