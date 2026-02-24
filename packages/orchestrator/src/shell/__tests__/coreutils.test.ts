/**
 * Integration tests for real coreutils wasm binaries running through the ShellRunner.
 *
 * These tests exercise the full stack: shell parser → AST executor → ProcessManager → WASI host → coreutils wasm.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
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
  'uname', 'whoami', 'id', 'printenv', 'yes', 'rmdir', 'sleep', 'seq',
  'ln', 'readlink', 'realpath', 'mktemp', 'tac',
  'xargs', 'expr',
  'diff',
  'du', 'df',
  'gzip', 'gunzip', 'tar',
  'bc', 'dc',
  'sqlite3',
];

/** Map tool name to wasm filename (true/false use special names). */
function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  if (tool === 'gunzip') return 'gzip.wasm';
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
    mgr.registerTool('python3', resolve(FIXTURES, 'python3.wasm'));

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

    it('ls -l shows correct permissions for files and directories', async () => {
      vfs.writeFile('/home/user/hello.txt', new TextEncoder().encode('hi'));
      vfs.mkdir('/home/user/subdir');
      const result = await runner.run('ls -l /home/user');
      // Files default to 0o644 → -rw-r--r--
      expect(result.stdout).toMatch(/-rw-r--r--.*hello\.txt/);
      // Directories default to 0o755 → drwxr-xr-x
      expect(result.stdout).toMatch(/drwxr-xr-x.*subdir/);
    });

    it('ls -l shows executable permissions after chmod', async () => {
      vfs.writeFile('/home/user/script.sh', new TextEncoder().encode('#!/bin/sh'));
      vfs.chmod('/home/user/script.sh', 0o755);
      const result = await runner.run('ls -l /home/user');
      // Should show -rwxr-xr-x after chmod 755
      expect(result.stdout).toMatch(/-rwxr-xr-x.*script\.sh/);
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

  describe('cwd and path resolution', () => {
    let cwdRunner: ShellRunner;

    beforeEach(() => {
      // Create a runner with PWD set to /home/user
      const adapter = new NodeAdapter();
      const mgr = new ProcessManager(vfs, adapter);
      for (const tool of TOOLS) {
        mgr.registerTool(tool, resolve(FIXTURES, wasmName(tool)));
      }
      mgr.registerTool('python3', resolve(FIXTURES, 'python3.wasm'));
      cwdRunner = new ShellRunner(vfs, mgr, adapter, SHELL_WASM);
      cwdRunner.setEnv('PWD', '/home/user');
      cwdRunner.setEnv('HOME', '/home/user');
    });

    it('ls with no args lists cwd (/home/user)', async () => {
      vfs.writeFile('/home/user/hello.txt', new TextEncoder().encode('hi'));
      const result = await cwdRunner.run('ls');
      expect(result.stdout).toContain('hello.txt');
      expect(result.exitCode).toBe(0);
    });

    it('ls with absolute path /tmp works', async () => {
      vfs.writeFile('/tmp/tmpfile.txt', new TextEncoder().encode('data'));
      const result = await cwdRunner.run('ls /tmp');
      expect(result.stdout).toContain('tmpfile.txt');
      expect(result.exitCode).toBe(0);
    });

    it('ls / lists root directories', async () => {
      const result = await cwdRunner.run('ls /');
      expect(result.stdout).toContain('home');
      expect(result.stdout).toContain('tmp');
      expect(result.exitCode).toBe(0);
    });

    it('redirect > writes to cwd-relative path', async () => {
      await cwdRunner.run('echo hello > a.txt');
      const data = new TextDecoder().decode(vfs.readFile('/home/user/a.txt'));
      expect(data).toBe('hello\n');
    });

    it('redirect < reads from cwd-relative path', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('from file'));
      const result = await cwdRunner.run('cat < input.txt');
      expect(result.stdout).toBe('from file');
    });

    it('redirect >> appends to cwd-relative path', async () => {
      await cwdRunner.run('echo line1 > log.txt');
      await cwdRunner.run('echo line2 >> log.txt');
      const data = new TextDecoder().decode(vfs.readFile('/home/user/log.txt'));
      expect(data).toBe('line1\nline2\n');
    });

    it('cat reads a relative path in cwd', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('cwd content'));
      const result = await cwdRunner.run('cat data.txt');
      expect(result.stdout).toBe('cwd content');
    });

    it('cat reads an absolute path outside cwd', async () => {
      vfs.writeFile('/tmp/other.txt', new TextEncoder().encode('tmp content'));
      const result = await cwdRunner.run('cat /tmp/other.txt');
      expect(result.stdout).toBe('tmp content');
    });

    it('write to /tmp and read back with absolute path', async () => {
      await cwdRunner.run('echo tmpdata > /tmp/test.txt');
      const result = await cwdRunner.run('cat /tmp/test.txt');
      expect(result.stdout).toBe('tmpdata\n');
    });

    it('mkdir with relative path creates in cwd', async () => {
      await cwdRunner.run('mkdir mydir');
      expect(vfs.stat('/home/user/mydir').type).toBe('dir');
    });

    it('touch with relative path creates in cwd', async () => {
      await cwdRunner.run('touch newfile.txt');
      expect(vfs.stat('/home/user/newfile.txt').type).toBe('file');
    });

    it('python3 reads script from relative path in cwd', async () => {
      vfs.writeFile('/home/user/script.py', new TextEncoder().encode('print("from cwd")'));
      const result = await cwdRunner.run('python3 script.py');
      expect(result.stdout).toBe('from cwd\n');
    });
  });

  describe('command substitution', () => {
    it('backtick substitution in echo', async () => {
      vfs.writeFile('/tmp/a.txt', new TextEncoder().encode(''));
      vfs.writeFile('/tmp/b.txt', new TextEncoder().encode(''));
      const result = await runner.run('echo `ls /tmp`');
      expect(result.stdout).toContain('a.txt');
      expect(result.stdout).toContain('b.txt');
      expect(result.exitCode).toBe(0);
    });

    it('$() substitution in echo', async () => {
      const result = await runner.run('echo $(echo hello)');
      expect(result.stdout).toBe('hello\n');
    });

    it('command substitution as separate word in echo', async () => {
      // Note: inline word concatenation (e.g. "prefix$(cmd)suffix") requires
      // multi-part word support in the lexer, which is not yet implemented.
      // For now, command substitutions work as separate words.
      const result = await runner.run('echo before $(echo middle) after');
      expect(result.stdout).toBe('before middle after\n');
    });

    it('nested command substitution', async () => {
      const result = await runner.run('echo $(echo $(echo deep))');
      expect(result.stdout).toBe('deep\n');
    });

    it('command substitution in variable assignment', async () => {
      await runner.run('X=$(echo hello)');
      const result = await runner.run('echo $X');
      expect(result.stdout).toBe('hello\n');
    });
  });

  describe('which builtin', () => {
    it('finds a registered tool', async () => {
      const result = await runner.run('which cat');
      expect(result.stdout.trim()).toBe('/bin/cat');
      expect(result.exitCode).toBe(0);
    });

    it('finds python3', async () => {
      const result = await runner.run('which python3');
      expect(result.stdout.trim()).toBe('/bin/python3');
      expect(result.exitCode).toBe(0);
    });

    it('returns exit code 1 for unknown command', async () => {
      const result = await runner.run('which nonexistent');
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
    });

    it('handles multiple arguments', async () => {
      const result = await runner.run('which cat echo');
      expect(result.stdout).toContain('/bin/cat');
      expect(result.stdout).toContain('/bin/echo');
    });
  });

  describe('chmod builtin', () => {
    it('sets octal permissions', async () => {
      vfs.writeFile('/home/user/f.txt', new TextEncoder().encode('hi'));
      const result = await runner.run('chmod 755 /home/user/f.txt');
      expect(result.exitCode).toBe(0);
      expect(vfs.stat('/home/user/f.txt').permissions).toBe(0o755);
    });

    it('supports +x symbolic mode', async () => {
      vfs.writeFile('/home/user/script.sh', new TextEncoder().encode('#!/bin/sh'));
      // Default is 0o644
      const result = await runner.run('chmod +x /home/user/script.sh');
      expect(result.exitCode).toBe(0);
      expect(vfs.stat('/home/user/script.sh').permissions).toBe(0o755);
    });

    it('supports -x symbolic mode', async () => {
      vfs.writeFile('/home/user/run.sh', new TextEncoder().encode(''));
      vfs.chmod('/home/user/run.sh', 0o755);
      const result = await runner.run('chmod -x /home/user/run.sh');
      expect(result.exitCode).toBe(0);
      expect(vfs.stat('/home/user/run.sh').permissions).toBe(0o644);
    });

    it('supports u+x symbolic mode', async () => {
      vfs.writeFile('/home/user/a.sh', new TextEncoder().encode(''));
      // Default 0o644, u+x → 0o744
      const result = await runner.run('chmod u+x /home/user/a.sh');
      expect(result.exitCode).toBe(0);
      expect(vfs.stat('/home/user/a.sh').permissions).toBe(0o744);
    });

    it('supports go-w symbolic mode', async () => {
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode(''));
      vfs.chmod('/home/user/b.txt', 0o666);
      const result = await runner.run('chmod go-w /home/user/b.txt');
      expect(result.exitCode).toBe(0);
      expect(vfs.stat('/home/user/b.txt').permissions).toBe(0o644);
    });

    it('handles multiple files', async () => {
      vfs.writeFile('/home/user/x.sh', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/y.sh', new TextEncoder().encode(''));
      const result = await runner.run('chmod 755 /home/user/x.sh /home/user/y.sh');
      expect(result.exitCode).toBe(0);
      expect(vfs.stat('/home/user/x.sh').permissions).toBe(0o755);
      expect(vfs.stat('/home/user/y.sh').permissions).toBe(0o755);
    });

    it('errors on missing file', async () => {
      const result = await runner.run('chmod 755 /home/user/nonexistent.txt');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No such file or directory');
    });

    it('errors on missing operand', async () => {
      const result = await runner.run('chmod');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('missing operand');
    });

    it('errors on invalid mode', async () => {
      vfs.writeFile('/home/user/z.txt', new TextEncoder().encode(''));
      const result = await runner.run('chmod zzz /home/user/z.txt');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid mode');
    });

    it('is discoverable via which', async () => {
      const result = await runner.run('which chmod');
      expect(result.stdout.trim()).toBe('/bin/chmod');
      expect(result.exitCode).toBe(0);
    });

    it('ls -l reflects chmod +x', async () => {
      vfs.writeFile('/home/user/test.sh', new TextEncoder().encode('#!/bin/sh'));
      await runner.run('chmod +x /home/user/test.sh');
      const result = await runner.run('ls -l /home/user/test.sh');
      expect(result.stdout).toMatch(/-rwxr-xr-x/);
    });
  });

  describe('shebang execution', () => {
    it('runs a python script via ./path with #!/usr/bin/env python3', async () => {
      vfs.writeFile('/home/user/hello.py', new TextEncoder().encode(
        '#!/usr/bin/env python3\nprint("hello from python")\n',
      ));
      vfs.chmod('/home/user/hello.py', 0o755);
      runner.setEnv('PWD', '/home/user');
      const result = await runner.run('./hello.py');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello from python');
    });

    it('runs a python script via #!/usr/bin/python3', async () => {
      vfs.writeFile('/tmp/run.py', new TextEncoder().encode(
        '#!/usr/bin/python3\nprint(2 + 2)\n',
      ));
      const result = await runner.run('/tmp/run.py');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('4');
    });

    it('runs a shell script via ./path with #!/bin/sh', async () => {
      vfs.writeFile('/home/user/greet.sh', new TextEncoder().encode(
        '#!/bin/sh\necho "hello from shell"\n',
      ));
      vfs.chmod('/home/user/greet.sh', 0o755);
      runner.setEnv('PWD', '/home/user');
      const result = await runner.run('./greet.sh');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello from shell');
    });

    it('runs a script with no shebang as shell', async () => {
      vfs.writeFile('/home/user/noshebang.sh', new TextEncoder().encode(
        'echo "no shebang"\n',
      ));
      runner.setEnv('PWD', '/home/user');
      const result = await runner.run('./noshebang.sh');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('no shebang');
    });

    it('passes arguments to python scripts', async () => {
      vfs.writeFile('/tmp/greet.py', new TextEncoder().encode(
        '#!/usr/bin/env python3\nimport sys\nprint(f"Hi {sys.argv[1]}")\n',
      ));
      const result = await runner.run('/tmp/greet.py Alice');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Hi Alice');
    });

    it('returns exit 127 for nonexistent path', async () => {
      const result = await runner.run('./nonexistent.sh');
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('no such file or directory');
    });

    it('runs a multi-line shell script', async () => {
      vfs.writeFile('/tmp/multi.sh', new TextEncoder().encode(
        '#!/bin/sh\necho "line1"\necho "line2"\n',
      ));
      const result = await runner.run('/tmp/multi.sh');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('line1');
      expect(result.stdout).toContain('line2');
    });

    it('full LLM workflow: write, chmod, execute python', async () => {
      // Simulate the exact LLM workflow
      runner.setEnv('PWD', '/home/user');
      await runner.run('echo \'#!/usr/bin/env python3\nprint("it works")\' > /home/user/solve.py');
      await runner.run('chmod +x /home/user/solve.py');
      const result = await runner.run('./solve.py');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('it works');
    });

    it('full LLM workflow: write, chmod, execute shell', async () => {
      runner.setEnv('PWD', '/home/user');
      await runner.run('echo \'#!/bin/sh\necho "shell works"\' > /home/user/test.sh');
      await runner.run('chmod +x /home/user/test.sh');
      const result = await runner.run('./test.sh');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('shell works');
    });
  });

  describe('ls /bin lists registered tools', () => {
    it('ls /bin shows registered tools', async () => {
      const result = await runner.run('ls -1 /bin');
      expect(result.stdout).toContain('cat');
      expect(result.stdout).toContain('echo');
      expect(result.stdout).toContain('ls');
      expect(result.stdout).toContain('python3');
      expect(result.exitCode).toBe(0);
    });

    it('ls /bin/ with trailing slash also works', async () => {
      const result = await runner.run('ls /bin/');
      expect(result.stdout).toContain('cat');
      expect(result.exitCode).toBe(0);
    });

    it('which cat returns /bin/cat and file exists', async () => {
      const result = await runner.run('which cat');
      expect(result.stdout.trim()).toBe('/bin/cat');
      // The file should also be stat-able in VFS
      expect(vfs.stat('/bin/cat').type).toBe('file');
    });
  });

  describe('glob expansion', () => {
    it('expands * in for loop word list', async () => {
      vfs.writeFile('/tmp/a.txt', new TextEncoder().encode(''));
      vfs.writeFile('/tmp/b.txt', new TextEncoder().encode(''));
      vfs.writeFile('/tmp/c.log', new TextEncoder().encode(''));
      const result = await runner.run('for f in /tmp/*.txt; do echo $f; done');
      expect(result.stdout).toContain('/tmp/a.txt');
      expect(result.stdout).toContain('/tmp/b.txt');
      expect(result.stdout).not.toContain('c.log');
    });

    it('expands * in echo', async () => {
      vfs.writeFile('/tmp/x.md', new TextEncoder().encode(''));
      vfs.writeFile('/tmp/y.md', new TextEncoder().encode(''));
      const result = await runner.run('echo /tmp/*.md');
      expect(result.stdout).toContain('/tmp/x.md');
      expect(result.stdout).toContain('/tmp/y.md');
    });

    it('expands * without path prefix in cwd', async () => {
      const adapter = new NodeAdapter();
      const mgr = new ProcessManager(vfs, adapter);
      for (const tool of TOOLS) {
        mgr.registerTool(tool, resolve(FIXTURES, wasmName(tool)));
      }
      const cwdGlobRunner = new ShellRunner(vfs, mgr, adapter, SHELL_WASM);
      cwdGlobRunner.setEnv('PWD', '/home/user');
      cwdGlobRunner.setEnv('HOME', '/home/user');

      vfs.writeFile('/home/user/one.txt', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/two.txt', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/pic.png', new TextEncoder().encode(''));
      const result = await cwdGlobRunner.run('echo *.txt');
      expect(result.stdout).toContain('one.txt');
      expect(result.stdout).toContain('two.txt');
      expect(result.stdout).not.toContain('pic.png');
    });

    it('passes literal when no glob match', async () => {
      const result = await runner.run('echo /nonexistent/*.xyz');
      expect(result.stdout.trim()).toBe('/nonexistent/*.xyz');
    });
  });

  describe('test / [ builtin', () => {
    it('test -f on existing file', async () => {
      vfs.writeFile('/tmp/exists.txt', new TextEncoder().encode('hi'));
      const result = await runner.run('test -f /tmp/exists.txt && echo yes');
      expect(result.stdout.trim()).toBe('yes');
    });

    it('test -f on missing file', async () => {
      const result = await runner.run('test -f /tmp/nope.txt && echo yes || echo no');
      expect(result.stdout.trim()).toBe('no');
    });

    it('test -d on directory', async () => {
      const result = await runner.run('test -d /tmp && echo yes');
      expect(result.stdout.trim()).toBe('yes');
    });

    it('test -e on existing path', async () => {
      vfs.writeFile('/tmp/e.txt', new TextEncoder().encode(''));
      const result = await runner.run('test -e /tmp/e.txt && echo yes');
      expect(result.stdout.trim()).toBe('yes');
    });

    it('test -z on empty string', async () => {
      const result = await runner.run('test -z "" && echo yes');
      expect(result.stdout.trim()).toBe('yes');
    });

    it('test -n on non-empty string', async () => {
      const result = await runner.run('test -n "hello" && echo yes');
      expect(result.stdout.trim()).toBe('yes');
    });

    it('test string equality', async () => {
      const result = await runner.run('test "abc" = "abc" && echo yes');
      expect(result.stdout.trim()).toBe('yes');
    });

    it('test string inequality', async () => {
      const result = await runner.run('test "abc" != "xyz" && echo yes');
      expect(result.stdout.trim()).toBe('yes');
    });

    it('test integer -eq', async () => {
      const result = await runner.run('test 5 -eq 5 && echo yes');
      expect(result.stdout.trim()).toBe('yes');
    });

    it('test integer -gt', async () => {
      const result = await runner.run('test 10 -gt 5 && echo yes');
      expect(result.stdout.trim()).toBe('yes');
    });

    it('test integer -lt', async () => {
      const result = await runner.run('test 3 -lt 7 && echo yes');
      expect(result.stdout.trim()).toBe('yes');
    });

    it('test ! negation', async () => {
      const result = await runner.run('test ! -f /tmp/nope && echo yes');
      expect(result.stdout.trim()).toBe('yes');
    });

    it('[ ] bracket syntax', async () => {
      vfs.writeFile('/tmp/b.txt', new TextEncoder().encode('hi'));
      const result = await runner.run('[ -f /tmp/b.txt ] && echo yes');
      expect(result.stdout.trim()).toBe('yes');
    });

    it('[ ] missing closing bracket fails', async () => {
      const result = await runner.run('[ -f /tmp/b.txt && echo yes || echo no');
      expect(result.stdout.trim()).toBe('no');
    });
  });

  describe('pwd builtin', () => {
    it('prints default cwd', async () => {
      const result = await runner.run('pwd');
      expect(result.stdout.trim()).toBe('/home/user');
    });

    it('prints cwd when PWD is set', async () => {
      vfs.mkdir('/tmp/mydir');
      runner.setEnv('PWD', '/tmp/mydir');
      const result = await runner.run('pwd');
      expect(result.stdout.trim()).toBe('/tmp/mydir');
    });
  });

  describe('new coreutils', () => {
    it('uname returns wasmsand', async () => {
      const result = await runner.run('uname');
      expect(result.stdout.trim()).toBe('wasmsand');
    });

    it('uname -a returns full info', async () => {
      const result = await runner.run('uname -a');
      expect(result.stdout).toContain('wasmsand');
    });

    it('whoami returns user', async () => {
      const result = await runner.run('whoami');
      expect(result.stdout.trim()).toBe('user');
    });

    it('id returns uid info', async () => {
      const result = await runner.run('id');
      expect(result.stdout).toContain('uid=1000');
      expect(result.stdout).toContain('user');
    });

    it('printenv shows specific var', async () => {
      runner.setEnv('FOO', 'bar');
      const result = await runner.run('printenv FOO');
      expect(result.stdout.trim()).toBe('bar');
    });

    it('printenv missing var exits 1', async () => {
      const result = await runner.run('printenv NONEXISTENT');
      expect(result.exitCode).toBe(1);
    });

    it('yes outputs repeated lines', async () => {
      const result = await runner.run('yes hello | head -3');
      expect(result.stdout).toBe('hello\nhello\nhello\n');
    });

    it('rmdir removes empty directory', async () => {
      await runner.run('mkdir /tmp/emptydir');
      const result = await runner.run('rmdir /tmp/emptydir');
      expect(result.exitCode).toBe(0);
      const ls = await runner.run('ls /tmp');
      expect(ls.stdout).not.toContain('emptydir');
    });

    it('rmdir fails on non-empty directory', async () => {
      await runner.run('mkdir /tmp/notempty');
      await runner.run('touch /tmp/notempty/file');
      const result = await runner.run('rmdir /tmp/notempty');
      expect(result.exitCode).not.toBe(0);
    });

    it('sleep exits 0', async () => {
      const result = await runner.run('sleep 0');
      expect(result.exitCode).toBe(0);
    });

    it('seq generates range', async () => {
      const result = await runner.run('seq 1 5');
      expect(result.stdout).toBe('1\n2\n3\n4\n5\n');
    });

    it('seq single arg', async () => {
      const result = await runner.run('seq 3');
      expect(result.stdout).toBe('1\n2\n3\n');
    });

    it('seq with step', async () => {
      const result = await runner.run('seq 2 2 8');
      expect(result.stdout).toBe('2\n4\n6\n8\n');
    });
  });

  describe('file/path coreutils', () => {
    it('ln creates a copy', async () => {
      await runner.run('echo "content" > /tmp/orig.txt');
      const result = await runner.run('ln /tmp/orig.txt /tmp/link.txt');
      expect(result.exitCode).toBe(0);
      const cat = await runner.run('cat /tmp/link.txt');
      expect(cat.stdout).toContain('content');
    });

    it('readlink on non-link returns path', async () => {
      await runner.run('echo hi > /tmp/rfile.txt');
      const result = await runner.run('readlink -f /tmp/rfile.txt');
      expect(result.stdout.trim()).toBe('/tmp/rfile.txt');
    });

    it('realpath resolves absolute path', async () => {
      const result = await runner.run('realpath /tmp/../tmp/file.txt');
      expect(result.stdout.trim()).toBe('/tmp/file.txt');
    });

    it('mktemp creates a temp file', async () => {
      const result = await runner.run('mktemp');
      expect(result.exitCode).toBe(0);
      const path = result.stdout.trim();
      expect(path).toMatch(/^\/tmp\//);
      const check = await runner.run(`test -e ${path} && echo exists`);
      expect(check.stdout.trim()).toBe('exists');
    });

    it('tac reverses lines', async () => {
      await runner.run('printf "a\\nb\\nc\\n" > /tmp/lines.txt');
      const result = await runner.run('tac /tmp/lines.txt');
      expect(result.stdout).toBe('c\nb\na\n');
    });

    it('tac from stdin', async () => {
      const result = await runner.run('printf "1\\n2\\n3\\n" | tac');
      expect(result.stdout).toBe('3\n2\n1\n');
    });
  });

  describe('xargs and expr', () => {
    it('xargs concatenates stdin lines', async () => {
      const result = await runner.run('printf "a\\nb\\nc\\n" | xargs');
      expect(result.stdout.trim()).toBe('a b c');
    });

    it('xargs with echo', async () => {
      const result = await runner.run('printf "hello\\nworld\\n" | xargs echo');
      expect(result.stdout.trim()).toBe('echo hello world');
    });

    it('xargs -n 1 one per line', async () => {
      const result = await runner.run('printf "a\\nb\\nc\\n" | xargs -n 1');
      expect(result.stdout).toBe('a\nb\nc\n');
    });

    it('expr arithmetic', async () => {
      const result = await runner.run('expr 3 + 4');
      expect(result.stdout.trim()).toBe('7');
    });

    it('expr subtraction', async () => {
      const result = await runner.run('expr 10 - 3');
      expect(result.stdout.trim()).toBe('7');
    });

    it('expr string length', async () => {
      const result = await runner.run('expr length "hello"');
      expect(result.stdout.trim()).toBe('5');
    });

    it('expr equality', async () => {
      const result = await runner.run('expr 5 = 5');
      expect(result.stdout.trim()).toBe('1');
    });
  });

  describe('diff', () => {
    it('identical files show no output', async () => {
      await runner.run('echo "hello" > /tmp/a.txt');
      await runner.run('echo "hello" > /tmp/b.txt');
      const result = await runner.run('diff /tmp/a.txt /tmp/b.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('different files show differences', async () => {
      await runner.run('printf "a\\nb\\nc\\n" > /tmp/d1.txt');
      await runner.run('printf "a\\nB\\nc\\n" > /tmp/d2.txt');
      const result = await runner.run('diff /tmp/d1.txt /tmp/d2.txt');
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('< b');
      expect(result.stdout).toContain('> B');
    });
  });

  describe('df', () => {
    it('df shows wasmsand and Filesystem header', async () => {
      const result = await runner.run('df');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Filesystem');
      expect(result.stdout).toContain('wasmsand');
    });

    it('df -h shows human-readable output', async () => {
      const result = await runner.run('df -h');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Size');
      expect(result.stdout).toContain('wasmsand');
    });

    it('df reflects current usage', async () => {
      vfs.writeFile('/home/user/bigfile.txt', new TextEncoder().encode('x'.repeat(1000)));
      const result = await runner.run('df');
      expect(result.exitCode).toBe(0);
      // Parse the used value from the output - should include our 1000 bytes
      const lines = result.stdout.trim().split('\n');
      const dataLine = lines[1];
      const usedStr = dataLine.split(/\s+/)[2];
      const used = parseInt(usedStr, 10);
      expect(used).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('du', () => {
    it('du -a reports size of a single file', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('hello world!'));
      const result = await runner.run('du -a /home/user/data.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('12');
      expect(result.stdout).toContain('data.txt');
    });

    it('du -s gives summary', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('aaa'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('bbb'));
      const result = await runner.run('du -s /home/user');
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('/home/user');
    });

    it('du -sh gives human-readable summary', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('x'.repeat(2048)));
      const result = await runner.run('du -sh /home/user');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/K/);
    });

    it('du with no args works (defaults to .)', async () => {
      runner.setEnv('PWD', '/home/user');
      vfs.writeFile('/home/user/file.txt', new TextEncoder().encode('test'));
      const result = await runner.run('du -s');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).not.toBe('');
    });
  });

  describe('gzip / gunzip', () => {
    it('gzip file creates .gz and removes original', async () => {
      vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('hello gzip'));
      const result = await runner.run('gzip /home/user/test.txt');
      expect(result.exitCode).toBe(0);
      expect(() => vfs.stat('/home/user/test.txt')).toThrow();
      expect(vfs.stat('/home/user/test.txt.gz').type).toBe('file');
    });

    it('gunzip file.gz restores original', async () => {
      vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('hello gunzip'));
      await runner.run('gzip /home/user/test.txt');
      const result = await runner.run('gunzip /home/user/test.txt.gz');
      expect(result.exitCode).toBe(0);
      expect(() => vfs.stat('/home/user/test.txt.gz')).toThrow();
      const content = new TextDecoder().decode(vfs.readFile('/home/user/test.txt'));
      expect(content).toBe('hello gunzip');
    });

    it('gzip -d works like gunzip', async () => {
      vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('decompress test'));
      await runner.run('gzip /home/user/test.txt');
      const result = await runner.run('gzip -d /home/user/test.txt.gz');
      expect(result.exitCode).toBe(0);
      const content = new TextDecoder().decode(vfs.readFile('/home/user/test.txt'));
      expect(content).toBe('decompress test');
    });

    it('roundtrip via pipeline', async () => {
      // Compress to file, then decompress to stdout
      vfs.writeFile('/home/user/pipe.txt', new TextEncoder().encode('pipeline test'));
      await runner.run('gzip /home/user/pipe.txt');
      const result = await runner.run('gunzip -c /home/user/pipe.txt.gz');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('pipeline test');
    });

    it('gzip -k keeps original', async () => {
      vfs.writeFile('/home/user/keep.txt', new TextEncoder().encode('keep me'));
      const result = await runner.run('gzip -k /home/user/keep.txt');
      expect(result.exitCode).toBe(0);
      expect(vfs.stat('/home/user/keep.txt').type).toBe('file');
      expect(vfs.stat('/home/user/keep.txt.gz').type).toBe('file');
    });
  });

  describe('tar', () => {
    it('tar -cf creates archive and -tf lists contents', async () => {
      await runner.run('mkdir -p /home/user/mydir');
      vfs.writeFile('/home/user/mydir/a.txt', new TextEncoder().encode('aaa'));
      vfs.writeFile('/home/user/mydir/b.txt', new TextEncoder().encode('bbb'));
      const create = await runner.run('tar -cf /home/user/archive.tar /home/user/mydir');
      expect(create.exitCode).toBe(0);
      const list = await runner.run('tar -tf /home/user/archive.tar');
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain('a.txt');
      expect(list.stdout).toContain('b.txt');
    });

    it('tar -xf extracts and file contents match', async () => {
      await runner.run('mkdir -p /home/user/src');
      vfs.writeFile('/home/user/src/hello.txt', new TextEncoder().encode('hello tar'));
      await runner.run('tar -cf /home/user/src.tar /home/user/src');
      await runner.run('mkdir -p /tmp/dst');
      const extract = await runner.run('tar -xf /home/user/src.tar -C /tmp/dst');
      expect(extract.exitCode).toBe(0);
      // Archive stores relative path: home/user/src/hello.txt
      const cat = await runner.run('cat /tmp/dst/home/user/src/hello.txt');
      expect(cat.stdout).toBe('hello tar');
    });

    it('tar -czf and -xzf roundtrip with gzip', async () => {
      await runner.run('mkdir -p /home/user/zdir');
      vfs.writeFile('/home/user/zdir/data.txt', new TextEncoder().encode('gzip tar test'));
      const create = await runner.run('tar -czf /home/user/zdir.tar.gz /home/user/zdir');
      expect(create.exitCode).toBe(0);
      await runner.run('mkdir -p /tmp/zdst');
      const extract = await runner.run('tar -xzf /home/user/zdir.tar.gz -C /tmp/zdst');
      expect(extract.exitCode).toBe(0);
      const cat = await runner.run('cat /tmp/zdst/home/user/zdir/data.txt');
      expect(cat.stdout).toBe('gzip tar test');
    });

    it('tar with relative paths resolves against CWD', async () => {
      vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('hello tar'));
      const create = await runner.run('tar cf archive.tar test.txt');
      expect(create.exitCode).toBe(0);
      const list = await runner.run('tar tf archive.tar');
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain('test.txt');
    });

    it('tar -tvf shows verbose listing', async () => {
      await runner.run('mkdir -p /home/user/vdir');
      vfs.writeFile('/home/user/vdir/file.txt', new TextEncoder().encode('verbose'));
      await runner.run('tar -cf /home/user/v.tar /home/user/vdir');
      const result = await runner.run('tar -tvf /home/user/v.tar');
      expect(result.exitCode).toBe(0);
      // -t lists to stdout, -v adds detail to stderr
      expect(result.stdout).toContain('file.txt');
    });
  });

  describe('python stdlib', () => {
    it('import json', async () => {
      const result = await runner.run('python3 -c "import json; print(json.dumps({\'a\': 1}))"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('{"a": 1}');
    });

    it('import re', async () => {
      const result = await runner.run('python3 -c "import re; print(re.findall(r\'\\d+\', \'abc123def456\'))"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("['123', '456']");
    });

    it('import math', async () => {
      const result = await runner.run('python3 -c "import math; print(math.sqrt(144))"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('12.0');
    });

    it('import collections', async () => {
      const result = await runner.run('python3 -c "from collections import Counter; print(Counter(\'abracadabra\').most_common(1))"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("'a'");
      expect(result.stdout).toContain('5');
    });

    it('sys.argv with -c', async () => {
      const result = await runner.run('python3 -c "import sys; print(sys.argv)"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('-c');
    });

    it('os.environ reads shell env', async () => {
      runner.setEnv('MY_VAR', 'hello123');
      const result = await runner.run('python3 -c "import os; print(os.environ.get(\'MY_VAR\', \'missing\'))"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello123');
    });

    it('class definitions work', async () => {
      const script = [
        'class Point:',
        '    def __init__(self, x, y):',
        '        self.x = x',
        '        self.y = y',
        '    def __repr__(self):',
        '        return f"Point({self.x}, {self.y})"',
        'print(Point(3, 4))',
      ].join('\n');
      vfs.writeFile('/tmp/classes.py', new TextEncoder().encode(script));
      const result = await runner.run('python3 /tmp/classes.py');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Point(3, 4)');
    });

    it('file I/O via open()', async () => {
      vfs.writeFile('/tmp/data.txt', new TextEncoder().encode('hello world'));
      const script = [
        'f = open("/tmp/data.txt")',
        'print(f.read())',
        'f.close()',
      ].join('\n');
      vfs.writeFile('/tmp/read_test.py', new TextEncoder().encode(script));
      const result = await runner.run('python3 /tmp/read_test.py');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello world');
    });

    it('write file via open()', async () => {
      const script = [
        'f = open("/tmp/out.txt", "w")',
        'f.write("written by python")',
        'f.close()',
      ].join('\n');
      vfs.writeFile('/tmp/write_test.py', new TextEncoder().encode(script));
      await runner.run('python3 /tmp/write_test.py');
      const content = new TextDecoder().decode(vfs.readFile('/tmp/out.txt'));
      expect(content).toBe('written by python');
    });

    it('stdin piping works', async () => {
      vfs.writeFile('/tmp/input.txt', new TextEncoder().encode('line1\nline2\nline3\n'));
      const result = await runner.run('cat /tmp/input.txt | python3 -c "import sys; print(len(sys.stdin.read().splitlines()))"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('3');
    });

    it('json parse pipeline', async () => {
      vfs.writeFile('/tmp/data.json', new TextEncoder().encode('{"name": "Alice", "age": 30}'));
      const result = await runner.run('cat /tmp/data.json | python3 -c "import sys, json; d = json.load(sys.stdin); print(d[\'name\'])"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Alice');
    });

    it('ModuleNotFoundError for unavailable modules', async () => {
      const result = await runner.run('python3 -c "import numpy"');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('ModuleNotFoundError');
    });

    it('syntax error gives traceback', async () => {
      const result = await runner.run('python3 -c "def f(:"');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('SyntaxError');
    });
  });

  describe('dc', () => {
    it('basic arithmetic', async () => {
      const r = await runner.run('echo "3 4 + p" | dc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('7');
    });

    it('multiplication and subtraction', async () => {
      vfs.writeFile('/tmp/dc.txt', new TextEncoder().encode('5 3 * 2 - p'));
      const r = await runner.run('cat /tmp/dc.txt | dc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('13');
    });

    it('division with scale', async () => {
      const r = await runner.run('echo "2 k 10 3 / p" | dc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('3.33');
    });

    it('stack print', async () => {
      const r = await runner.run('echo "1 2 3 f" | dc');
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.trim().split('\n');
      expect(lines).toEqual(['3', '2', '1']);
    });

    it('duplicate and add', async () => {
      const r = await runner.run('echo "5 d + p" | dc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('10');
    });

    it('registers store and load', async () => {
      const r = await runner.run('echo "42 sa la p" | dc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('42');
    });

    it('power', async () => {
      const r = await runner.run('echo "2 10 ^ p" | dc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('1024');
    });
  });

  describe('bc', () => {
    it('basic arithmetic', async () => {
      const r = await runner.run('echo "3 + 4" | bc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('7');
    });

    it('operator precedence', async () => {
      const r = await runner.run('echo "2 + 3 * 4" | bc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('14');
    });

    it('parentheses', async () => {
      const r = await runner.run('echo "(2 + 3) * 4" | bc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('20');
    });

    it('scale for division', async () => {
      const r = await runner.run('echo "scale=2; 10/3" | bc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('3.33');
    });

    it('variables', async () => {
      const r = await runner.run('printf "x=5\\nx*3\\n" | bc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('15');
    });

    it('power operator', async () => {
      const r = await runner.run('echo "2^10" | bc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('1024');
    });

    it('comparison operators', async () => {
      const r = await runner.run('echo "3 > 2" | bc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('1');
    });

    it('user-defined function', async () => {
      const r = await runner.run('printf "define double(x) { return 2*x; }\\ndouble(21)\\n" | bc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('42');
    });

    it('math library with -l', async () => {
      const r = await runner.run('echo "e(1)" | bc -l');
      expect(r.exitCode).toBe(0);
      const val = parseFloat(r.stdout.trim());
      expect(val).toBeCloseTo(Math.E, 4);
    });
  });

  describe('sqlite3', () => {
    it('creates table and queries data', async () => {
      vfs.writeFile('/tmp/q.sql', new TextEncoder().encode(
        "CREATE TABLE t(id INTEGER, name TEXT); INSERT INTO t VALUES(1,'alice'); SELECT * FROM t;"
      ));
      const r = await runner.run('cat /tmp/q.sql | sqlite3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('alice');
    });

    it('persists data across queries in same session', async () => {
      // File-backed databases need journal_mode=OFF since WASI lacks fcntl locking
      vfs.writeFile('/tmp/multi.sql', new TextEncoder().encode(
        "CREATE TABLE nums(v INTEGER);\nINSERT INTO nums VALUES(42);\nSELECT v FROM nums;"
      ));
      const r = await runner.run('cat /tmp/multi.sql | sqlite3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('42');
    });

    it('handles aggregations', async () => {
      vfs.writeFile('/tmp/agg.sql', new TextEncoder().encode(
        'CREATE TABLE n(v); INSERT INTO n VALUES(10); INSERT INTO n VALUES(20); INSERT INTO n VALUES(30); SELECT SUM(v) FROM n;'
      ));
      const r = await runner.run('cat /tmp/agg.sql | sqlite3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('60');
    });
  });
});
