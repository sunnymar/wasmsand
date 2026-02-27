/**
 * Dual-runner conformance tests.
 *
 * Runs the same set of shell-language tests against both:
 *   1. ShellRunner  (TypeScript executor, parses via WASM, executes in TS)
 *   2. ShellInstance (Rust WASM executor, both parsing AND execution in Rust)
 *
 * Only shell-internal features are tested here (builtins, variable expansion,
 * arithmetic, control flow, functions, redirects to VFS, etc.).  External tool
 * spawning (cat, grep, sed, ...) is intentionally omitted because ShellInstance
 * needs a syncSpawn callback for external tools and wiring that up is outside
 * the scope of this conformance harness.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { resolve } from 'node:path';

import { ShellRunner } from '../../shell-runner.js';
import { ShellInstance } from '../../shell-instance.js';
import type { ShellLike } from '../../shell-like.js';
import { ProcessManager } from '../../../process/manager.js';
import { VFS } from '../../../vfs/vfs.js';
import { NodeAdapter } from '../../../platform/node-adapter.js';

const SHELL_WASM = resolve(import.meta.dirname, '../fixtures/codepod-shell.wasm');
const SHELL_EXEC_WASM = resolve(import.meta.dirname, '../fixtures/codepod-shell-exec.wasm');

// ---------------------------------------------------------------------------
// Shared conformance test suite
// ---------------------------------------------------------------------------

function defineConformanceTests(
  createRunner: () => Promise<{ runner: ShellLike; vfs: VFS }>,
) {
  let runner: ShellLike;
  let vfs: VFS;

  beforeEach(async () => {
    const ctx = await createRunner();
    runner = ctx.runner;
    vfs = ctx.vfs;
  });

  // =========================================================================
  // 1. Builtins
  // =========================================================================
  describe('builtins', () => {
    it('echo outputs text', async () => {
      const r = await runner.run('echo hello world');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello world\n');
    });

    it('echo with no args produces empty line', async () => {
      const r = await runner.run('echo');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\n');
    });

    it('echo -n suppresses trailing newline', async () => {
      const r = await runner.run('echo -n hello');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello');
    });

    it('true returns exit code 0', async () => {
      const r = await runner.run('true');
      expect(r.exitCode).toBe(0);
    });

    it('false returns exit code 1', async () => {
      const r = await runner.run('false');
      expect(r.exitCode).toBe(1);
    });

    it('pwd returns current directory', async () => {
      const r = await runner.run('pwd');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('/home/user');
    });

    it('cd changes directory', async () => {
      // /home/user and /tmp already exist in VFS; use a sub-directory
      await runner.run('cd /tmp');
      const r = await runner.run('pwd');
      expect(r.stdout.trim()).toBe('/tmp');
    });

    it('export makes variable available', async () => {
      await runner.run('export MY_VAR=hello');
      const r = await runner.run('echo $MY_VAR');
      expect(r.stdout).toBe('hello\n');
    });

    it('unset removes variable', async () => {
      await runner.run('MY_VAR=hello');
      await runner.run('unset MY_VAR');
      const r = await runner.run('echo ">${MY_VAR}<"');
      expect(r.stdout).toBe('><\n');
    });

    it('test -z returns 0 for empty string', async () => {
      const r = await runner.run('test -z ""; echo $?');
      expect(r.stdout).toBe('0\n');
    });

    it('test -n returns 0 for non-empty string', async () => {
      const r = await runner.run('test -n "hello"; echo $?');
      expect(r.stdout).toBe('0\n');
    });

    it('[ string equality ] works', async () => {
      const r = await runner.run('[ "abc" = "abc" ]; echo $?');
      expect(r.stdout).toBe('0\n');
    });

    it('[ string inequality ] works', async () => {
      const r = await runner.run('[ "abc" != "def" ]; echo $?');
      expect(r.stdout).toBe('0\n');
    });

    it('[ numeric -eq ] works', async () => {
      const r = await runner.run('[ 5 -eq 5 ]; echo $?');
      expect(r.stdout).toBe('0\n');
    });

    it('[ numeric -gt ] works', async () => {
      const r = await runner.run('[ 10 -gt 5 ]; echo $?');
      expect(r.stdout).toBe('0\n');
    });

    it('[ numeric -lt ] works', async () => {
      const r = await runner.run('[ 3 -lt 5 ]; echo $?');
      expect(r.stdout).toBe('0\n');
    });

    // Note: colon (:) is a POSIX builtin but not yet implemented in TS backend.
    // Skipped from dual-runner tests until both backends support it.
  });

  // =========================================================================
  // 2. Variable expansion
  // =========================================================================
  describe('variables', () => {
    it('simple assignment and expansion', async () => {
      await runner.run('FOO=bar');
      const r = await runner.run('echo $FOO');
      expect(r.stdout).toBe('bar\n');
    });

    it('assignment with spaces in value', async () => {
      await runner.run('FOO="hello world"');
      const r = await runner.run('echo $FOO');
      expect(r.stdout).toBe('hello world\n');
    });

    it('${var:-default} returns default when unset', async () => {
      const r = await runner.run('echo ${UNSET_VAR:-fallback}');
      expect(r.stdout).toBe('fallback\n');
    });

    it('${var:-default} returns value when set', async () => {
      await runner.run('MY_VAR=hello');
      const r = await runner.run('echo ${MY_VAR:-fallback}');
      expect(r.stdout).toBe('hello\n');
    });

    it('${var:+alternate} returns alternate when set', async () => {
      await runner.run('MY_VAR=hello');
      const r = await runner.run('echo ${MY_VAR:+alternate}');
      expect(r.stdout).toBe('alternate\n');
    });

    it('${var:+alternate} returns empty when unset', async () => {
      const r = await runner.run('echo ">${UNSET_VAR:+alternate}<"');
      expect(r.stdout).toBe('><\n');
    });

    it('${var:?error} fails when unset', async () => {
      const r = await runner.run('echo ${UNSET_VAR:?variable is required}');
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('variable is required');
    });

    it('${#var} returns string length', async () => {
      await runner.run('MY_VAR=hello');
      const r = await runner.run('echo ${#MY_VAR}');
      expect(r.stdout).toBe('5\n');
    });

    it('${var%pattern} removes shortest suffix', async () => {
      const r = await runner.run('X=file.tar.gz; echo ${X%.*}');
      expect(r.stdout).toBe('file.tar\n');
    });

    it('${var%%pattern} removes longest suffix', async () => {
      const r = await runner.run('X=file.tar.gz; echo ${X%%.*}');
      expect(r.stdout).toBe('file\n');
    });

    it('${var#pattern} removes shortest prefix', async () => {
      const r = await runner.run('X=/usr/local/bin; echo ${X#*/}');
      expect(r.stdout).toBe('usr/local/bin\n');
    });

    it('${var##pattern} removes longest prefix', async () => {
      const r = await runner.run('X=/usr/local/bin; echo ${X##*/}');
      expect(r.stdout).toBe('bin\n');
    });

    it('${var^^} uppercases', async () => {
      const r = await runner.run('x=hello; echo ${x^^}');
      expect(r.stdout).toBe('HELLO\n');
    });

    it('${var,,} lowercases', async () => {
      const r = await runner.run('x=HELLO; echo ${x,,}');
      expect(r.stdout).toBe('hello\n');
    });

    it('${var:offset:length} substring', async () => {
      const r = await runner.run('x=hello; echo ${x:1:3}');
      expect(r.stdout).toBe('ell\n');
    });

    it('${var:offset} substring to end', async () => {
      const r = await runner.run('x=hello; echo ${x:2}');
      expect(r.stdout).toBe('llo\n');
    });

    it('$? captures last exit code', async () => {
      await runner.run('true');
      const r = await runner.run('echo $?');
      expect(r.stdout).toBe('0\n');
    });

    it('$? after false is 1', async () => {
      await runner.run('false');
      const r = await runner.run('echo $?');
      expect(r.stdout).toBe('1\n');
    });
  });

  // =========================================================================
  // 3. Arithmetic
  // =========================================================================
  describe('arithmetic', () => {
    it('simple addition $((1+2))', async () => {
      const r = await runner.run('echo $((1+2))');
      expect(r.stdout).toBe('3\n');
    });

    it('multiplication $((6*7))', async () => {
      const r = await runner.run('echo $((6*7))');
      expect(r.stdout).toBe('42\n');
    });

    it('subtraction $((10-3))', async () => {
      const r = await runner.run('echo $((10-3))');
      expect(r.stdout).toBe('7\n');
    });

    it('division $((10/3))', async () => {
      const r = await runner.run('echo $((10/3))');
      expect(r.stdout).toBe('3\n');
    });

    it('modulo $((10%3))', async () => {
      const r = await runner.run('echo $((10%3))');
      expect(r.stdout).toBe('1\n');
    });

    it('comparison $((1>0)) returns 1', async () => {
      const r = await runner.run('echo $((1>0))');
      expect(r.stdout).toBe('1\n');
    });

    it('comparison $((0>1)) returns 0', async () => {
      const r = await runner.run('echo $((0>1))');
      expect(r.stdout).toBe('0\n');
    });

    it('variables in arithmetic $((A*B))', async () => {
      await runner.run('A=6');
      await runner.run('B=7');
      const r = await runner.run('echo $((A*B))');
      expect(r.stdout).toBe('42\n');
    });

    it('parentheses in arithmetic $((( 2+3 )*4))', async () => {
      const r = await runner.run('echo $(( (2+3)*4 ))');
      expect(r.stdout).toBe('20\n');
    });
  });

  // =========================================================================
  // 4. Control flow
  // =========================================================================
  describe('control flow', () => {
    it('if/then/fi with true condition', async () => {
      const r = await runner.run('if true; then echo yes; fi');
      expect(r.stdout).toBe('yes\n');
    });

    it('if/then/else/fi with false condition', async () => {
      const r = await runner.run('if false; then echo yes; else echo no; fi');
      expect(r.stdout).toBe('no\n');
    });

    it('elif chain', async () => {
      await runner.run('VAL=2');
      const r = await runner.run(
        'if [ "$VAL" = "1" ]; then echo one; elif [ "$VAL" = "2" ]; then echo two; else echo other; fi',
      );
      expect(r.stdout).toBe('two\n');
    });

    it('for loop over word list', async () => {
      const r = await runner.run('for x in a b c; do echo $x; done');
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('while loop with counter', async () => {
      const r = await runner.run(
        'i=0; while [ "$i" -lt 3 ]; do echo $i; i=$(( i + 1 )); done',
      );
      expect(r.stdout).toBe('0\n1\n2\n');
    });

    it('&& short-circuit: runs second on success', async () => {
      const r = await runner.run('true && echo reached');
      expect(r.stdout).toBe('reached\n');
    });

    it('&& short-circuit: skips second on failure', async () => {
      const r = await runner.run('false && echo reached');
      expect(r.stdout).toBe('');
    });

    it('|| short-circuit: skips second on success', async () => {
      const r = await runner.run('true || echo reached');
      expect(r.stdout).toBe('');
    });

    it('|| short-circuit: runs second on failure', async () => {
      const r = await runner.run('false || echo reached');
      expect(r.stdout).toBe('reached\n');
    });

    it('semicolon chains', async () => {
      const r = await runner.run('echo a; echo b; echo c');
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('case/esac selects correct branch', async () => {
      await runner.run('FRUIT=apple');
      const r = await runner.run(
        'case "$FRUIT" in apple) echo red;; banana) echo yellow;; *) echo unknown;; esac',
      );
      expect(r.stdout).toBe('red\n');
    });

    it('case/esac wildcard fallthrough', async () => {
      await runner.run('FRUIT=kiwi');
      const r = await runner.run(
        'case "$FRUIT" in apple) echo red;; banana) echo yellow;; *) echo unknown;; esac',
      );
      expect(r.stdout).toBe('unknown\n');
    });
  });

  // =========================================================================
  // 5. Functions
  // =========================================================================
  describe('functions', () => {
    it('defines and calls a basic function', async () => {
      const r = await runner.run('greet() { echo hello; }; greet');
      expect(r.stdout).toBe('hello\n');
    });

    it('passes arguments to function via $1 $2', async () => {
      const r = await runner.run('add() { echo "$1 + $2"; }; add foo bar');
      expect(r.stdout).toBe('foo + bar\n');
    });

    it('captures return value via $?', async () => {
      const r = await runner.run('myfn() { return 42; }; myfn; echo $?');
      expect(r.stdout).toBe('42\n');
    });

    it('function captures output via command substitution', async () => {
      const r = await runner.run(
        'getval() { echo computed; }; RESULT=$(getval); echo $RESULT',
      );
      expect(r.stdout).toBe('computed\n');
    });

    it('local variables in functions', async () => {
      await runner.run('OUTER=original');
      const r = await runner.run(
        'myfn() { local OUTER=changed; echo $OUTER; }; myfn',
      );
      expect(r.stdout).toBe('changed\n');
      // After function returns, OUTER should be original
      const check = await runner.run('echo $OUTER');
      expect(check.stdout).toBe('original\n');
    });

    it('recursive function call', async () => {
      const script = [
        'countdown() {',
        '  if [ "$1" -le 0 ]; then return; fi',
        '  echo $1',
        '  countdown $(( $1 - 1 ))',
        '}',
        'countdown 3',
      ].join('\n');
      const r = await runner.run(script);
      expect(r.stdout).toBe('3\n2\n1\n');
    });
  });

  // =========================================================================
  // 6. Quoting
  // =========================================================================
  describe('quoting', () => {
    it('double quotes preserve spaces', async () => {
      const r = await runner.run('echo "hello   world"');
      expect(r.stdout).toBe('hello   world\n');
    });

    it('single quotes prevent variable expansion', async () => {
      await runner.run('FOO=bar');
      const r = await runner.run("echo '$FOO'");
      expect(r.stdout).toBe('$FOO\n');
    });

    it('double quotes allow variable expansion', async () => {
      await runner.run('FOO=bar');
      const r = await runner.run('echo "$FOO"');
      expect(r.stdout).toBe('bar\n');
    });

    it('backslash escapes dollar sign', async () => {
      const r = await runner.run('echo "price is \\$5"');
      expect(r.stdout).toBe('price is $5\n');
    });

    it('nested single quote inside double quotes', async () => {
      const r = await runner.run("echo \"it's a test\"");
      expect(r.stdout).toBe("it's a test\n");
    });

    it('empty string argument', async () => {
      const r = await runner.run('echo ""');
      expect(r.stdout).toBe('\n');
    });
  });

  // =========================================================================
  // 7. Redirects (VFS-based)
  // =========================================================================
  describe('redirects', () => {
    it('> writes stdout to VFS file', async () => {
      await runner.run('echo hello > /tmp/out.txt');
      const data = new TextDecoder().decode(vfs.readFile('/tmp/out.txt'));
      expect(data).toBe('hello\n');
    });

    it('>> appends to VFS file', async () => {
      await runner.run('echo line1 > /tmp/out.txt');
      await runner.run('echo line2 >> /tmp/out.txt');
      const data = new TextDecoder().decode(vfs.readFile('/tmp/out.txt'));
      expect(data).toBe('line1\nline2\n');
    });

    it('< reads stdin from VFS file', async () => {
      vfs.writeFile('/tmp/in.txt', new TextEncoder().encode('file-content'));
      const r = await runner.run('read LINE < /tmp/in.txt; echo $LINE');
      expect(r.stdout).toBe('file-content\n');
    });

    it('heredoc provides stdin', async () => {
      const r = await runner.run('read LINE <<EOF\nhello heredoc\nEOF\necho $LINE');
      expect(r.stdout).toBe('hello heredoc\n');
    });

    it('here-string provides stdin', async () => {
      const r = await runner.run('read LINE <<< "hello here-string"; echo $LINE');
      expect(r.stdout).toBe('hello here-string\n');
    });
  });

  // =========================================================================
  // 8. Command substitution
  // =========================================================================
  describe('command substitution', () => {
    it('$(echo hello) captures stdout', async () => {
      const r = await runner.run('echo $(echo hello)');
      expect(r.stdout).toBe('hello\n');
    });

    it('nested command substitution', async () => {
      const r = await runner.run('echo $(echo $(echo deep))');
      expect(r.stdout).toBe('deep\n');
    });

    it('command substitution in variable assignment', async () => {
      await runner.run('RESULT=$(echo computed)');
      const r = await runner.run('echo $RESULT');
      expect(r.stdout).toBe('computed\n');
    });

    it('command substitution strips trailing newlines', async () => {
      const r = await runner.run('X=$(echo hello); echo ">$X<"');
      expect(r.stdout).toBe('>hello<\n');
    });
  });

  // =========================================================================
  // 9. Multiline / compound commands
  // =========================================================================
  describe('compound commands', () => {
    it('subshell ( ) groups commands', async () => {
      const r = await runner.run('(echo a; echo b)');
      expect(r.stdout).toBe('a\nb\n');
    });

    it('brace group { } runs in current shell', async () => {
      const r = await runner.run('{ echo a; echo b; }');
      expect(r.stdout).toBe('a\nb\n');
    });

    it('brace group shares variable scope', async () => {
      const r = await runner.run('{ X=set_inside; }; echo $X');
      expect(r.stdout).toBe('set_inside\n');
    });
  });

  // =========================================================================
  // 10. Miscellaneous builtins
  // =========================================================================
  describe('miscellaneous builtins', () => {
    it('set -- sets positional parameters', async () => {
      const r = await runner.run('set -- a b c; echo $1 $2 $3');
      expect(r.stdout).toBe('a b c\n');
    });

    it('shift removes first positional parameter', async () => {
      const r = await runner.run('set -- a b c; shift; echo $1 $2');
      expect(r.stdout).toBe('b c\n');
    });

    it('eval executes string as command', async () => {
      const r = await runner.run('eval "echo hello from eval"');
      expect(r.stdout).toBe('hello from eval\n');
    });

    it('type identifies builtins', async () => {
      const r = await runner.run('type echo');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('builtin');
    });
  });
}

// ===========================================================================
// Backend: TypeScript (ShellRunner)
// ===========================================================================

describe('Dual-runner conformance: TypeScript backend', () => {
  defineConformanceTests(async () => {
    const vfs = new VFS();
    const adapter = new NodeAdapter();
    const mgr = new ProcessManager(vfs, adapter);
    // No external tools registered -- tests only use builtins
    const runner = new ShellRunner(vfs, mgr, adapter, SHELL_WASM);
    return { runner, vfs };
  });
});

// ===========================================================================
// Backend: Rust WASM (ShellInstance)
// ===========================================================================

describe('Dual-runner conformance: Rust WASM backend', () => {
  defineConformanceTests(async () => {
    const vfs = new VFS();
    const adapter = new NodeAdapter();
    const mgr = new ProcessManager(vfs, adapter);
    // No external tools registered -- tests only use builtins
    const runner = await ShellInstance.create(vfs, mgr, adapter, SHELL_EXEC_WASM);
    return { runner, vfs };
  });
});
