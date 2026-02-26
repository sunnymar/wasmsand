import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';

import { ShellRunner } from '../shell-runner.js';
import { ProcessManager } from '../../process/manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';
import { NetworkGateway } from '../../network/gateway.js';

const FIXTURES = resolve(import.meta.dirname, '../../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../__tests__/fixtures/codepod-shell.wasm');

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

    it('expands variables inside double quotes', async () => {
      const result = await runner.run('for i in a b c; do echo-args "$i - x"; done');
      expect(result.stdout).toBe('a - x\nb - x\nc - x\n');
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

  describe('comments', () => {
    it('ignores comments after command', async () => {
      const result = await runner.run('echo-args hello # this is a comment');
      expect(result.stdout).toBe('hello\n');
    });

    it('ignores full line comments', async () => {
      const result = await runner.run('# full line comment\necho-args hi');
      expect(result.stdout).toBe('hi\n');
    });
  });

  describe('$? exit code', () => {
    it('tracks $? after command', async () => {
      await runner.run('false');
      const result = await runner.run('echo-args $?');
      expect(result.stdout).toBe('1\n');
    });

    it('tracks $? as 0 after success', async () => {
      await runner.run('true');
      const result = await runner.run('echo-args $?');
      expect(result.stdout).toBe('0\n');
    });

    it('$? reflects intermediate exit code in a sequence', async () => {
      const result = await runner.run('false ; echo $?');
      expect(result.stdout).toContain('1');
    });
  });

  describe('subshell isolation', () => {
    it('subshell does not leak env to parent', async () => {
      runner.setEnv('X', 'outer');
      await runner.run('( X=inner )');
      expect(runner.getEnv('X')).toBe('outer');
    });
  });

  describe('tilde expansion', () => {
    it('expands ~ to HOME', async () => {
      const result = await runner.run('echo-args ~');
      expect(result.stdout).toBe('/home/user\n');
    });

    it('expands ~/path to HOME/path', async () => {
      const result = await runner.run('echo-args ~/docs');
      expect(result.stdout).toBe('/home/user/docs\n');
    });
  });

  describe('stderr redirects', () => {
    it('redirects stderr with 2>', async () => {
      const result = await runner.run('echo-args hello 2> /tmp/err.txt');
      expect(result.stdout).toBe('hello\n');
    });
  });

  describe('PYTHONPATH', () => {
    it('has PYTHONPATH set', async () => {
      const result = await runner.run('echo-args $PYTHONPATH');
      expect(result.stdout).toContain('/usr/lib/python');
    });
  });

  describe('break and continue', () => {
    it('break exits for loop early', async () => {
      const result = await runner.run('for x in a b c d; do if [ "$x" = "c" ]; then break; fi; echo-args $x; done');
      expect(result.stdout).toBe('a\nb\n');
    });

    it('continue skips iteration', async () => {
      const result = await runner.run('for x in a b c d; do if [ "$x" = "b" ]; then continue; fi; echo-args $x; done');
      expect(result.stdout).toBe('a\nc\nd\n');
    });
  });

  describe('pipeline negation', () => {
    it('negates exit code of true', async () => {
      const result = await runner.run('! true');
      expect(result.exitCode).toBe(1);
    });

    it('negates exit code of false', async () => {
      const result = await runner.run('! false');
      expect(result.exitCode).toBe(0);
    });

    it('negation composes with &&', async () => {
      const result = await runner.run('! false && echo "negation works"');
      expect(result.stdout.trim()).toBe('negation works');
    });
  });

  describe('exit builtin', () => {
    it('exit stops script execution', async () => {
      const result = await runner.run('echo-args before ; exit 42 ; echo-args after');
      expect(result.stdout).toBe('before\n');
      expect(result.exitCode).toBe(42);
    });

    it('exit with no args uses last exit code', async () => {
      await runner.run('false');
      const result = await runner.run('exit');
      expect(result.exitCode).toBe(1);
    });
  });

  describe('parameter expansion', () => {
    it('${var:-default} returns default when unset', async () => {
      const result = await runner.run('echo-args ${UNSET:-fallback}');
      expect(result.stdout).toBe('fallback\n');
    });

    it('${var:-default} returns value when set', async () => {
      runner.setEnv('FOO', 'bar');
      const result = await runner.run('echo-args ${FOO:-fallback}');
      expect(result.stdout).toBe('bar\n');
    });

    it('${var:+alt} returns alt when set', async () => {
      runner.setEnv('FOO', 'bar');
      const result = await runner.run('echo-args ${FOO:+alternate}');
      expect(result.stdout).toBe('alternate\n');
    });

    it('${var:+alt} returns empty when unset', async () => {
      const result = await runner.run('echo ${UNSET:+alternate}');
      expect(result.stdout).toBe('\n');
    });
  });

  describe('case/esac', () => {
    it('case matches literal', async () => {
      const result = await runner.run('case hello in hello) echo-args matched;; esac');
      expect(result.stdout).toBe('matched\n');
    });

    it('case matches wildcard', async () => {
      const result = await runner.run('case hello in h*) echo-args glob;; esac');
      expect(result.stdout).toBe('glob\n');
    });

    it('case falls through to default', async () => {
      const result = await runner.run('case xyz in a) echo-args a;; *) echo-args default;; esac');
      expect(result.stdout).toBe('default\n');
    });
  });

  describe('here-documents', () => {
    it('here-document provides stdin', async () => {
      const result = await runner.run('cat-stdin <<EOF\nhello world\nEOF');
      expect(result.stdout).toBe('hello world\n');
    });
  });

  describe('function definitions', () => {
    it('defines and calls a function', async () => {
      await runner.run('greet() { echo-args hello $1; }');
      const result = await runner.run('greet world');
      expect(result.stdout).toBe('hello\nworld\n');
    });

    it('defines and calls in a single command', async () => {
      const result = await runner.run('greet() { echo "hello $1"; } ; greet world');
      expect(result.stdout.trim()).toBe('hello world');
    });
  });

  describe('arithmetic expansion', () => {
    it('evaluates arithmetic expansion', async () => {
      const result = await runner.run('echo-args $((2 + 3))');
      expect(result.stdout).toBe('5\n');
    });

    it('arithmetic with variables', async () => {
      runner.setEnv('X', '10');
      const result = await runner.run('echo-args $((X * 2))');
      expect(result.stdout).toBe('20\n');
    });

    it('arithmetic with subtraction and division', async () => {
      const result = await runner.run('echo-args $((10 - 3))');
      expect(result.stdout).toBe('7\n');
    });
  });

  describe('$@, $*, $# positional parameters', () => {
    it('$@ expands to script arguments', async () => {
      vfs.writeFile('/home/user/script.sh', new TextEncoder().encode('#!/bin/sh\necho $@\n'));
      vfs.chmod('/home/user/script.sh', 0o755);
      const result = await runner.run('./script.sh arg1 arg2');
      expect(result.stdout.trim()).toBe('arg1 arg2');
    });

    it('$* expands to script arguments', async () => {
      vfs.writeFile('/home/user/script.sh', new TextEncoder().encode('#!/bin/sh\necho $*\n'));
      vfs.chmod('/home/user/script.sh', 0o755);
      const result = await runner.run('./script.sh arg1 arg2');
      expect(result.stdout.trim()).toBe('arg1 arg2');
    });

    it('$# reflects argument count', async () => {
      vfs.writeFile('/home/user/script.sh', new TextEncoder().encode('#!/bin/sh\necho $#\n'));
      vfs.chmod('/home/user/script.sh', 0o755);
      const result = await runner.run('./script.sh a b c');
      expect(result.stdout.trim()).toBe('3');
    });

    it('$# is 0 when no arguments', async () => {
      vfs.writeFile('/home/user/script.sh', new TextEncoder().encode('#!/bin/sh\necho $#\n'));
      vfs.chmod('/home/user/script.sh', 0o755);
      const result = await runner.run('./script.sh');
      expect(result.stdout.trim()).toBe('0');
    });

    it('function calls with $@ and $#', async () => {
      await runner.run('myfunc() { echo $# $@; }');
      const result = await runner.run('myfunc x y z');
      expect(result.stdout.trim()).toBe('3 x y z');
    });
  });

  describe('source builtin', () => {
    it('sources a file and executes commands', async () => {
      vfs.writeFile('/home/user/lib.sh', new TextEncoder().encode('echo hello from source\n'));
      const result = await runner.run('source /home/user/lib.sh');
      expect(result.stdout.trim()).toBe('hello from source');
    });

    it('. works as alias for source', async () => {
      vfs.writeFile('/home/user/lib.sh', new TextEncoder().encode('echo dotted\n'));
      const result = await runner.run('. /home/user/lib.sh');
      expect(result.stdout.trim()).toBe('dotted');
    });

    it('variables persist after source', async () => {
      vfs.writeFile('/home/user/vars.sh', new TextEncoder().encode('MY_VAR=sourced_value\n'));
      await runner.run('source /home/user/vars.sh');
      expect(runner.getEnv('MY_VAR')).toBe('sourced_value');
    });

    it('functions persist after source', async () => {
      vfs.writeFile('/home/user/funcs.sh', new TextEncoder().encode('greet() { echo hi $1; }\n'));
      await runner.run('source /home/user/funcs.sh');
      const result = await runner.run('greet world');
      expect(result.stdout.trim()).toBe('hi world');
    });

    it('positional params with extra args', async () => {
      vfs.writeFile('/home/user/args.sh', new TextEncoder().encode('echo $1 $2\n'));
      const result = await runner.run('source /home/user/args.sh foo bar');
      expect(result.stdout.trim()).toBe('foo bar');
    });

    it('positional params restore after source with args', async () => {
      // Set up outer positional params via a script
      vfs.writeFile('/home/user/inner.sh', new TextEncoder().encode('echo $1\n'));
      vfs.writeFile('/home/user/outer.sh', new TextEncoder().encode(
        'echo $1\nsource /home/user/inner.sh x\necho $1\n'
      ));
      const result = await runner.run('./outer.sh outer_arg');
      expect(result.stdout).toBe('outer_arg\nx\nouter_arg\n');
    });

    it('error on file not found', async () => {
      const result = await runner.run('source /nonexistent.sh');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No such file or directory');
    });

    it('error on no args', async () => {
      const result = await runner.run('source');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('filename argument required');
    });

    it('strips shebang from sourced file', async () => {
      vfs.writeFile('/home/user/shebang.sh', new TextEncoder().encode('#!/bin/bash\necho no shebang error\n'));
      const result = await runner.run('source /home/user/shebang.sh');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('no shebang error');
    });
  });

  describe('string parameter expansion', () => {
    it('${var#pattern} removes shortest prefix', async () => {
      const result = await runner.run('X=/usr/local/bin; echo ${X#*/}');
      expect(result.stdout).toBe('usr/local/bin\n');
    });

    it('${var##pattern} removes longest prefix', async () => {
      const result = await runner.run('X=/usr/local/bin; echo ${X##*/}');
      expect(result.stdout).toBe('bin\n');
    });

    it('${var%pattern} removes shortest suffix', async () => {
      const result = await runner.run('X=/usr/local/bin; echo ${X%/*}');
      expect(result.stdout).toBe('/usr/local\n');
    });

    it('${var%%pattern} removes longest suffix', async () => {
      const result = await runner.run('X=/usr/local/bin; echo ${X%%/*}');
      expect(result.stdout).toBe('\n');
    });

    it('${var/pattern/replacement} replaces first match', async () => {
      const result = await runner.run('X=hello_world_hello; echo ${X/hello/goodbye}');
      expect(result.stdout).toBe('goodbye_world_hello\n');
    });

    it('${var//pattern/replacement} replaces all matches', async () => {
      const result = await runner.run('X=hello_world_hello; echo ${X//hello/goodbye}');
      expect(result.stdout).toBe('goodbye_world_goodbye\n');
    });

    it('returns empty when var is unset', async () => {
      const result = await runner.run('echo ${UNSET_VAR#pattern}');
      expect(result.stdout).toBe('\n');
    });
  });

  describe('set flags', () => {
    it('set -e aborts on non-zero exit', async () => {
      const result = await runner.run('set -e; echo before; false; echo after');
      expect(result.stdout).toContain('before');
      expect(result.stdout).not.toContain('after');
      expect(result.exitCode).not.toBe(0);
    });

    it('set -e does not abort in if condition', async () => {
      const result = await runner.run('set -e; if false; then echo no; else echo yes; fi; echo after');
      expect(result.stdout).toContain('yes');
      expect(result.stdout).toContain('after');
    });

    it('set -e does not abort in || chain', async () => {
      const result = await runner.run('set -e; false || echo fallback; echo after');
      expect(result.stdout).toContain('fallback');
      expect(result.stdout).toContain('after');
    });

    it('set -u errors on undefined variable', async () => {
      const result = await runner.run('set -u; echo $UNDEFINED_VAR_XYZ');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('UNDEFINED_VAR_XYZ');
    });

    it('set +e disables errexit', async () => {
      const result = await runner.run('set -e; set +e; false; echo still-here');
      expect(result.stdout).toContain('still-here');
    });
  });

  describe('brace expansion', () => {
    it('expands comma-separated braces', async () => {
      const result = await runner.run('echo {a,b,c}');
      expect(result.stdout).toBe('a b c\n');
    });

    it('expands braces with prefix and suffix', async () => {
      const result = await runner.run('echo file.{txt,md,rs}');
      expect(result.stdout).toBe('file.txt file.md file.rs\n');
    });

    it('expands numeric range', async () => {
      const result = await runner.run('echo {1..5}');
      expect(result.stdout).toBe('1 2 3 4 5\n');
    });

    it('expands reverse numeric range', async () => {
      const result = await runner.run('echo {5..1}');
      expect(result.stdout).toBe('5 4 3 2 1\n');
    });

    it('expands alpha range', async () => {
      const result = await runner.run('echo {a..e}');
      expect(result.stdout).toBe('a b c d e\n');
    });

    it('does not expand single item in braces', async () => {
      const result = await runner.run('echo {solo}');
      expect(result.stdout).toBe('{solo}\n');
    });
  });

  describe('read builtin', () => {
    it('reads from here-document into variable', async () => {
      await runner.run('read NAME <<EOF\nalice\nEOF');
      const result = await runner.run('echo "name is $NAME"');
      expect(result.stdout).toBe('name is alice\n');
    });

    it('splits into multiple variables', async () => {
      await runner.run('read A B C <<EOF\none two three four\nEOF');
      const result = await runner.run('echo "$A $B $C"');
      expect(result.stdout).toBe('one two three four\n');
    });

    it('uses REPLY when no variable given', async () => {
      await runner.run('read <<EOF\nhello world\nEOF');
      const result = await runner.run('echo "$REPLY"');
      expect(result.stdout).toBe('hello world\n');
    });

    it('returns 1 on empty input', async () => {
      // read with no stdin data should fail
      const result = await runner.run('read X <<EOF\nEOF');
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('eval builtin', () => {
    it('evaluates a simple command', async () => {
      const result = await runner.run('eval echo hello');
      expect(result.stdout).toBe('hello\n');
    });

    it('evaluates concatenated args', async () => {
      const result = await runner.run('eval echo "hello world"');
      expect(result.stdout).toBe('hello world\n');
    });

    it('evaluates dynamically constructed commands', async () => {
      await runner.run('export CMD=echo');
      const result = await runner.run('eval $CMD hi');
      expect(result.stdout).toBe('hi\n');
    });

    it('returns 0 with no arguments', async () => {
      const result = await runner.run('eval');
      expect(result.exitCode).toBe(0);
    });

    it('preserves exit codes', async () => {
      const result = await runner.run('eval false');
      expect(result.exitCode).toBe(1);
    });
  });

  describe('getopts builtin', () => {
    it('parses simple options', async () => {
      const result = await runner.run('getopts "ab" opt -a && echo "opt=$opt"');
      expect(result.stdout).toContain('opt=a');
    });

    it('parses options with arguments', async () => {
      const result = await runner.run('getopts "f:" opt -f myfile && echo "opt=$opt arg=$OPTARG"');
      expect(result.stdout).toContain('opt=f');
      expect(result.stdout).toContain('arg=myfile');
    });

    it('handles attached option arguments', async () => {
      const result = await runner.run('getopts "f:" opt -fmyfile && echo "opt=$opt arg=$OPTARG"');
      expect(result.stdout).toContain('opt=f');
      expect(result.stdout).toContain('arg=myfile');
    });

    it('returns 1 when no more options', async () => {
      const result = await runner.run('getopts "a" opt noopt');
      expect(result.exitCode).toBe(1);
    });
  });

  describe('sh/bash command', () => {
    it('sh -c runs a command', async () => {
      const result = await runner.run("sh -c 'echo hello from sh'");
      expect(result.stdout).toContain('hello from sh');
    });

    it('bash -c runs a command', async () => {
      const result = await runner.run("bash -c 'echo hello from bash'");
      expect(result.stdout).toContain('hello from bash');
    });

    it('which sh finds /bin/sh', async () => {
      const result = await runner.run('which sh');
      expect(result.stdout.trim()).toBe('/bin/sh');
    });
  });
});
