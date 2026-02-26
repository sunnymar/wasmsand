/**
 * Conformance tests for shell features — exercises POSIX and bash-like functionality.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { resolve } from 'node:path';

import { ShellRunner } from '../../shell-runner.js';
import { ProcessManager } from '../../../process/manager.js';
import { VFS } from '../../../vfs/vfs.js';
import { NodeAdapter } from '../../../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname, '../../../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../fixtures/codepod-shell.wasm');

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
  'hostname', 'base64', 'sha256sum', 'md5sum', 'stat', 'xxd', 'rev', 'nproc',
  'fmt', 'fold', 'nl', 'expand', 'unexpand', 'paste', 'comm', 'join',
  'split', 'strings', 'od', 'cksum', 'truncate',
  'tree', 'patch', 'file', 'column', 'cmp', 'timeout', 'numfmt', 'csplit', 'zip', 'unzip',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  if (tool === 'gunzip') return 'gzip.wasm';
  return `${tool}.wasm`;
}

describe('shell conformance', () => {
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

  // ---------------------------------------------------------------------------
  // Parameter expansion
  // ---------------------------------------------------------------------------
  describe('parameter expansion', () => {
    it('${var:-default} returns default when variable is unset', async () => {
      const result = await runner.run('echo ${UNSET_VAR:-fallback}');
      expect(result.stdout).toBe('fallback\n');
    });

    it('${var:-default} returns value when variable is set', async () => {
      await runner.run('MY_VAR=hello');
      const result = await runner.run('echo ${MY_VAR:-fallback}');
      expect(result.stdout).toBe('hello\n');
    });

    it('${var:=default} assigns default when variable is unset', async () => {
      const result = await runner.run('echo ${NEW_VAR:=assigned}');
      expect(result.stdout).toBe('assigned\n');
      // The variable should now be set in the environment
      expect(runner.getEnv('NEW_VAR')).toBe('assigned');
    });

    it('${var:+alternate} returns alternate when variable is set', async () => {
      await runner.run('MY_VAR=hello');
      const result = await runner.run('echo ${MY_VAR:+alternate}');
      expect(result.stdout).toBe('alternate\n');
    });

    it('${var:+alternate} returns empty when variable is unset', async () => {
      const result = await runner.run('echo ${UNSET_VAR:+alternate}');
      expect(result.stdout).toBe('\n');
    });

    it('${var:?error} prints error and fails when variable is unset', async () => {
      const result = await runner.run('echo ${UNSET_VAR:?variable is required}');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('variable is required');
    });

    it('${#var} returns string length', async () => {
      await runner.run('MY_VAR=hello');
      const result = await runner.run('echo ${#MY_VAR}');
      expect(result.stdout).toBe('5\n');
    });

    it('${var%pattern} removes shortest suffix match', async () => {
      const result = await runner.run('X=file.tar.gz; echo ${X%.*}');
      expect(result.stdout).toBe('file.tar\n');
    });

    it('${var%%pattern} removes longest suffix match', async () => {
      const result = await runner.run('X=file.tar.gz; echo ${X%%.*}');
      expect(result.stdout).toBe('file\n');
    });

    it('${var#pattern} removes shortest prefix match', async () => {
      const result = await runner.run('X=/usr/local/bin; echo ${X#*/}');
      expect(result.stdout).toBe('usr/local/bin\n');
    });

    it('${var##pattern} removes longest prefix match', async () => {
      const result = await runner.run('X=/usr/local/bin; echo ${X##*/}');
      expect(result.stdout).toBe('bin\n');
    });

    it('${var^^} uppercases', async () => {
      const r = await runner.run(`x=hello; echo \${x^^}`);
      expect(r.stdout).toBe('HELLO\n');
    });

    it('${var,,} lowercases', async () => {
      const r = await runner.run(`x=HELLO; echo \${x,,}`);
      expect(r.stdout).toBe('hello\n');
    });

    it('${var^} uppercases first char', async () => {
      const r = await runner.run(`x=hello; echo \${x^}`);
      expect(r.stdout).toBe('Hello\n');
    });

    it('${var:offset:length} substring', async () => {
      const r = await runner.run(`x=hello; echo \${x:1:3}`);
      expect(r.stdout).toBe('ell\n');
    });

    it('${var:offset} substring to end', async () => {
      const r = await runner.run(`x=hello; echo \${x:2}`);
      expect(r.stdout).toBe('llo\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Arithmetic expansion
  // ---------------------------------------------------------------------------
  describe('arithmetic', () => {
    it('evaluates simple addition $((1+2))', async () => {
      const result = await runner.run('echo $((1+2))');
      expect(result.stdout).toBe('3\n');
    });

    it('evaluates multiplication with variables $((a*b))', async () => {
      await runner.run('A=6');
      await runner.run('B=7');
      const result = await runner.run('echo $((A*B))');
      expect(result.stdout).toBe('42\n');
    });

    it('evaluates modulo $((10%3))', async () => {
      const result = await runner.run('echo $((10%3))');
      expect(result.stdout).toBe('1\n');
    });

    it('evaluates nested arithmetic $(( $((1+2)) * 3 ))', async () => {
      const result = await runner.run('echo $(( $((1+2)) * 3 ))');
      expect(result.stdout).toBe('9\n');
    });

    it('evaluates comparison $((1>0)) returns 1', async () => {
      const result = await runner.run('echo $((1>0))');
      expect(result.stdout).toBe('1\n');
    });

    it('evaluates assignment in arithmetic $((x=5))', async () => {
      const result = await runner.run('echo $((x=5))');
      // In POSIX shell, $((x=5)) should assign 5 to x and produce 5
      expect(result.stdout).toBe('5\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Quoting edge cases
  // ---------------------------------------------------------------------------
  describe('quoting edge cases', () => {
    it('handles nested single quote inside double quotes', async () => {
      const result = await runner.run("echo \"it's a test\"");
      expect(result.stdout).toBe("it's a test\n");
    });

    it('handles empty string argument ""', async () => {
      const result = await runner.run('echo ""');
      expect(result.stdout).toBe('\n');
    });

    it('preserves whitespace inside double quotes', async () => {
      const result = await runner.run('echo "hello   world"');
      expect(result.stdout).toBe('hello   world\n');
    });

    it('single quotes prevent variable expansion', async () => {
      await runner.run('export HOME=/home/user');
      const result = await runner.run("echo '$HOME'");
      expect(result.stdout).toBe('$HOME\n');
    });

    it('backslash in double quotes escapes special characters', async () => {
      const result = await runner.run('echo "hello\\nworld"');
      // In POSIX echo, backslash-n inside double quotes stays literal
      // (echo builtin does not interpret escape sequences by default)
      expect(result.stdout).toContain('hello');
    });

    it('dollar-sign escaping with backslash \\$', async () => {
      const result = await runner.run('echo "price is \\$5"');
      expect(result.stdout).toBe('price is $5\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Functions
  // ---------------------------------------------------------------------------
  describe('functions', () => {
    it('defines and calls a basic function', async () => {
      const result = await runner.run('greet() { echo hello; }; greet');
      expect(result.stdout).toBe('hello\n');
    });

    it('passes arguments to function via $1 $2', async () => {
      const result = await runner.run('add() { echo "$1 + $2"; }; add foo bar');
      expect(result.stdout).toBe('foo + bar\n');
    });

    it('supports local variables inside functions', async () => {
      // "local" is a bash extension; test whether it isolates variables
      await runner.run('OUTER=original');
      const result = await runner.run('myfn() { local OUTER=changed; echo $OUTER; }; myfn');
      expect(result.stdout).toBe('changed\n');
      // After the function call, OUTER should still be "original"
      const check = await runner.run('echo $OUTER');
      expect(check.stdout).toBe('original\n');
    });

    it('captures return value via $?', async () => {
      await runner.run('myfn() { return 42; }');
      await runner.run('myfn');
      const result = await runner.run('echo $?');
      expect(result.stdout).toBe('42\n');
    });

    it('captures function output via command substitution $(func)', async () => {
      const result = await runner.run('getval() { echo computed; }; RESULT=$(getval); echo $RESULT');
      expect(result.stdout).toBe('computed\n');
    });

    it('supports recursive function calls', async () => {
      // Countdown from 3 to 1
      const script = [
        'countdown() {',
        '  if [ "$1" -le 0 ]; then return; fi',
        '  echo $1',
        '  countdown $(( $1 - 1 ))',
        '}',
        'countdown 3',
      ].join('\n');
      const result = await runner.run(script);
      expect(result.stdout).toBe('3\n2\n1\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Control flow
  // ---------------------------------------------------------------------------
  describe('control flow', () => {
    it('if with test command [ -f file ]', async () => {
      vfs.writeFile('/home/user/exists.txt', new TextEncoder().encode('data'));
      const result = await runner.run('if [ -f /home/user/exists.txt ]; then echo found; fi');
      expect(result.stdout).toBe('found\n');
    });

    it('elif chain selects correct branch', async () => {
      await runner.run('VAL=2');
      const result = await runner.run(
        'if [ "$VAL" = "1" ]; then echo one; elif [ "$VAL" = "2" ]; then echo two; else echo other; fi'
      );
      expect(result.stdout).toBe('two\n');
    });

    it('for loop iterates over words', async () => {
      const result = await runner.run('for x in alpha beta gamma; do echo $x; done');
      expect(result.stdout).toBe('alpha\nbeta\ngamma\n');
    });

    it('for loop with command substitution using seq', async () => {
      const result = await runner.run('for i in $(seq 1 4); do echo $i; done');
      expect(result.stdout).toBe('1\n2\n3\n4\n');
    });

    it('while loop with counter', async () => {
      const script = [
        'I=0',
        'while [ "$I" -lt 3 ]; do',
        '  echo $I',
        '  I=$(( I + 1 ))',
        'done',
      ].join('\n');
      const result = await runner.run(script);
      expect(result.stdout).toBe('0\n1\n2\n');
    });

    it('case statement with multiple patterns', async () => {
      const result = await runner.run(
        'case "hello" in bye) echo no;; hello|hi) echo matched;; *) echo default;; esac'
      );
      expect(result.stdout).toBe('matched\n');
    });

    it('case with glob patterns', async () => {
      const result = await runner.run(
        'case "file.txt" in *.sh) echo shell;; *.txt) echo text;; *) echo unknown;; esac'
      );
      expect(result.stdout).toBe('text\n');
    });

    it('nested if inside for loop', async () => {
      const script = [
        'for x in 1 2 3 4 5; do',
        '  if [ "$x" = "3" ]; then',
        '    echo "found $x"',
        '  fi',
        'done',
      ].join('\n');
      const result = await runner.run(script);
      expect(result.stdout).toBe('found 3\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Arrays / variables
  // ---------------------------------------------------------------------------
  describe('arrays and variables', () => {
    // Arrays are a bash extension not currently implemented.
    it.skip('indexed assignment arr[0]=val and echo ${arr[0]}', async () => {
      const result = await runner.run('arr[0]=hello; echo ${arr[0]}');
      expect(result.stdout).toBe('hello\n');
    });

    it.skip('${arr[@]} expands all array elements', async () => {
      const result = await runner.run('arr[0]=a; arr[1]=b; arr[2]=c; echo ${arr[@]}');
      expect(result.stdout).toBe('a b c\n');
    });

    it.skip('${#arr[@]} returns count of array elements', async () => {
      const result = await runner.run('arr[0]=x; arr[1]=y; arr[2]=z; echo ${#arr[@]}');
      expect(result.stdout).toBe('3\n');
    });

    it.skip('unset removes an array element', async () => {
      const result = await runner.run('arr[0]=a; arr[1]=b; unset arr[1]; echo ${arr[@]}');
      expect(result.stdout).toBe('a\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Subshells and scope
  // ---------------------------------------------------------------------------
  describe('subshells and scope', () => {
    it('subshell variable changes do not leak to parent', async () => {
      await runner.run('OUTER=parent');
      await runner.run('( OUTER=child )');
      const result = await runner.run('echo $OUTER');
      expect(result.stdout).toBe('parent\n');
    });

    it('subshell exit code is captured', async () => {
      const result = await runner.run('( exit 42 )');
      expect(result.exitCode).toBe(42);
    });

    it('nested subshells work correctly', async () => {
      const result = await runner.run('( echo $(( 1 + ( 2 + 3 ) )) )');
      expect(result.stdout).toBe('6\n');
    });

    it('pipeline does not affect parent variable scope', async () => {
      // In POSIX, commands in a pipeline may run in subshells
      await runner.run('X=before');
      await runner.run('echo hello | X=after');
      const result = await runner.run('echo $X');
      // X should remain "before" because the pipeline right side runs in a subshell
      // (or the assignment in the pipeline segment is isolated)
      expect(result.stdout).toBe('before\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Redirects
  // ---------------------------------------------------------------------------
  describe('redirects', () => {
    it('redirects stdout to file with >', async () => {
      await runner.run('echo "hello world" > /tmp/out.txt');
      const content = new TextDecoder().decode(vfs.readFile('/tmp/out.txt'));
      expect(content).toBe('hello world\n');
    });

    it('appends to file with >>', async () => {
      vfs.writeFile('/tmp/log.txt', new TextEncoder().encode('line1\n'));
      await runner.run('echo "line2" >> /tmp/log.txt');
      const content = new TextDecoder().decode(vfs.readFile('/tmp/log.txt'));
      expect(content).toBe('line1\nline2\n');
    });

    it('reads stdin from file with <', async () => {
      vfs.writeFile('/tmp/data.txt', new TextEncoder().encode('file content here'));
      const result = await runner.run('cat < /tmp/data.txt');
      expect(result.stdout).toBe('file content here');
    });

    it('redirects stderr with 2>', async () => {
      // Use a command that produces stderr (nonexistent file for cat)
      await runner.run('cat /nonexistent 2> /tmp/err.txt');
      const content = new TextDecoder().decode(vfs.readFile('/tmp/err.txt'));
      expect(content.length).toBeGreaterThan(0);
    });

    it('merges stderr into stdout with 2>&1', async () => {
      // Run a command and merge stderr to stdout, redirect combined to file
      await runner.run('cat /nonexistent > /tmp/combined.txt 2>&1');
      const content = new TextDecoder().decode(vfs.readFile('/tmp/combined.txt'));
      // The error message about the nonexistent file should appear in the file
      expect(content.length).toBeGreaterThan(0);
    });

    it('here document provides stdin to command', async () => {
      const result = await runner.run('cat <<EOF\nhello from heredoc\nEOF');
      expect(result.stdout).toBe('hello from heredoc\n');
    });

    it('cat > file with heredoc', async () => {
      const r = await runner.run(`cat > /tmp/hd_test.txt <<EOF\nhello heredoc\nEOF\ncat /tmp/hd_test.txt`);
      expect(r.stdout).toBe('hello heredoc\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Test expressions
  // ---------------------------------------------------------------------------
  describe('test expressions', () => {
    it('[ -f file ] returns true for existing file', async () => {
      vfs.writeFile('/tmp/test.txt', new TextEncoder().encode('data'));
      const result = await runner.run('[ -f /tmp/test.txt ]');
      expect(result.exitCode).toBe(0);
    });

    it('[ -d dir ] returns true for existing directory', async () => {
      vfs.mkdir('/tmp/mydir');
      const result = await runner.run('[ -d /tmp/mydir ]');
      expect(result.exitCode).toBe(0);
    });

    it('[ -z "" ] returns true for empty string', async () => {
      const result = await runner.run('[ -z "" ]');
      expect(result.exitCode).toBe(0);
    });

    it('[ str1 = str2 ] string comparison', async () => {
      const result = await runner.run('[ "abc" = "abc" ]');
      expect(result.exitCode).toBe(0);
      const result2 = await runner.run('[ "abc" = "def" ]');
      expect(result2.exitCode).toBe(1);
    });

    it('[ num1 -eq num2 ] numeric comparison', async () => {
      const result = await runner.run('[ 42 -eq 42 ]');
      expect(result.exitCode).toBe(0);
      const result2 = await runner.run('[ 42 -eq 99 ]');
      expect(result2.exitCode).toBe(1);
    });

    it('compound test [ cond1 -a cond2 ] with AND', async () => {
      vfs.writeFile('/tmp/a.txt', new TextEncoder().encode('a'));
      vfs.writeFile('/tmp/b.txt', new TextEncoder().encode('b'));
      const result = await runner.run('[ -f /tmp/a.txt -a -f /tmp/b.txt ]');
      expect(result.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Miscellaneous
  // ---------------------------------------------------------------------------
  describe('miscellaneous', () => {
    it('nested command substitution $(echo $(echo hello))', async () => {
      const result = await runner.run('echo $(echo $(echo hello))');
      expect(result.stdout).toBe('hello\n');
    });

    it('eval executes a dynamically constructed command', async () => {
      await runner.run('CMD="echo hello"');
      const result = await runner.run('eval $CMD');
      expect(result.stdout).toBe('hello\n');
    });

    // Brace group in pipeline (e.g. echo | { read; echo; }) not yet supported.
    it.skip('read from echo pipe assigns to variable', async () => {
      const result = await runner.run('echo "bob" | { read NAME; echo "got $NAME"; }');
      expect(result.stdout).toBe('got bob\n');
    });

    it('set -- assigns positional parameters', async () => {
      const result = await runner.run('set -- x y z; echo $1 $2 $3');
      expect(result.stdout).toBe('x y z\n');
    });

    it('getopts parses options in a while loop', async () => {
      const script = [
        'OPTIND=1',
        'while getopts "a:b" opt -a val -b; do',
        '  echo "opt=$opt"',
        'done',
      ].join('\n');
      const result = await runner.run(script);
      expect(result.stdout).toContain('opt=a');
      expect(result.stdout).toContain('opt=b');
    });

    it('exit status of last command in pipeline is returned', async () => {
      const result = await runner.run('true | false');
      // POSIX: exit status of pipeline is exit status of last command
      expect(result.exitCode).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Pipeline stdin for compound commands
  // ---------------------------------------------------------------------------
  describe('pipeline stdin for compound commands', () => {
    it('pipe into while read loop', async () => {
      const r = await runner.run(`printf "a\\nb\\nc\\n" | while read line; do echo "got: $line"; done`);
      expect(r.stdout).toBe('got: a\ngot: b\ngot: c\n');
    });

    it('pipe seq into while read with arithmetic', async () => {
      const r = await runner.run(`seq 1 3 | while read n; do echo $((n * n)); done`);
      expect(r.stdout).toBe('1\n4\n9\n');
    });

    it('2>&1 merges stderr into stdout in pipeline', async () => {
      const r = await runner.run(`ls /nonexistent_path_xyz 2>&1 | head -1`);
      expect(r.stdout).toContain('No such file');
    });

    it('pipe into for loop via cat', async () => {
      // For loops don't read from stdin directly, but subshell + cat should work
      const r = await runner.run(`printf "hello\\n" | cat`);
      expect(r.stdout).toBe('hello\n');
    });

    it('pipe into while read with multiple fields', async () => {
      const r = await runner.run(`printf "a b\\nc d\\n" | while read x y; do echo "$y $x"; done`);
      expect(r.stdout).toBe('b a\nd c\n');
    });

    it('pipe into while read -r preserves backslashes', async () => {
      const r = await runner.run(`printf "%s\\n" "a\\\\b" | while read -r line; do echo "$line"; done`);
      expect(r.stdout).toBe('a\\b\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Word splitting
  // ---------------------------------------------------------------------------
  describe('word splitting', () => {
    it('word splitting on unquoted command substitution', async () => {
      const r = await runner.run(`for w in $(echo "a b c"); do echo "item: $w"; done`);
      expect(r.stdout).toBe('item: a\nitem: b\nitem: c\n');
    });

    it('no word splitting inside double quotes with literal prefix', async () => {
      // Note: the parser cannot distinguish "$x" from $x (both produce identical ASTs).
      // However when there is literal text alongside the variable (e.g. "val: $x"),
      // the QuotedLiteral part signals that splitting should be suppressed.
      const r = await runner.run(`x="a b c"; for w in "val: $x"; do echo "item: $w"; done`);
      expect(r.stdout).toBe('item: val: a b c\n');
    });

    it('word splitting on unquoted variable', async () => {
      const r = await runner.run(`x="a b c"; for w in $x; do echo $w; done`);
      expect(r.stdout).toBe('a\nb\nc\n');
    });
  });

  // ---------------------------------------------------------------------------
  // echo -e
  // ---------------------------------------------------------------------------
  describe('echo -e', () => {
    it('echo -e interprets backslash escapes', async () => {
      const r = await runner.run(`echo -e "hello\\nworld"`);
      expect(r.stdout).toBe('hello\nworld\n');
    });

    it('echo -e interprets tab', async () => {
      const r = await runner.run(`echo -e "a\\tb"`);
      expect(r.stdout).toBe('a\tb\n');
    });

    it('echo -en combines flags', async () => {
      const r = await runner.run(`echo -en "hi\\n"`);
      expect(r.stdout).toBe('hi\n');
    });

    it('echo without -e does not interpret escapes', async () => {
      const r = await runner.run(`echo "hello\\nworld"`);
      expect(r.stdout).toBe('hello\\nworld\n');
    });
  });

  // ---------------------------------------------------------------------------
  // $RANDOM
  // ---------------------------------------------------------------------------
  describe('$RANDOM', () => {
    it('$RANDOM produces a number', async () => {
      const r = await runner.run(`echo $RANDOM`);
      const n = parseInt(r.stdout.trim());
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(32768);
    });
  });

  // ---------------------------------------------------------------------------
  // trap builtin
  // ---------------------------------------------------------------------------
  describe('trap', () => {
    it('trap EXIT runs handler on exit', async () => {
      const r = await runner.run(`trap "echo cleanup" EXIT; echo running`);
      expect(r.stdout).toBe('running\ncleanup\n');
    });

    it('trap with empty string removes handler', async () => {
      const r = await runner.run(`trap "echo cleanup" EXIT; trap "" EXIT; echo finished`);
      expect(r.stdout).toBe('finished\n');
    });
  });

  // ---------------------------------------------------------------------------
  // process substitution
  // ---------------------------------------------------------------------------
  describe('process substitution', () => {
    it('process substitution <(cmd)', async () => {
      const r = await runner.run(`cat <(echo hello)`);
      expect(r.stdout).toBe('hello\n');
    });
  });

  // ---------------------------------------------------------------------------
  // arrays
  // ---------------------------------------------------------------------------
  describe('arrays', () => {
    it('array assignment and indexed access', async () => {
      const r = await runner.run(`arr=(one two three); echo \${arr[1]}`);
      expect(r.stdout).toBe('two\n');
    });

    it('array length ${#arr[@]}', async () => {
      const r = await runner.run(`arr=(a b c d); echo \${#arr[@]}`);
      expect(r.stdout).toBe('4\n');
    });

    it('array all elements ${arr[@]}', async () => {
      const r = await runner.run(`arr=(x y z); echo \${arr[@]}`);
      expect(r.stdout).toBe('x y z\n');
    });

    it('array ${arr[0]} first element', async () => {
      const r = await runner.run(`arr=(first second); echo \${arr[0]}`);
      expect(r.stdout).toBe('first\n');
    });
  });

  // ---------------------------------------------------------------------------
  // $SHELL
  // ---------------------------------------------------------------------------
  describe('$SHELL', () => {
    it('$SHELL is set', async () => {
      const r = await runner.run(`echo $SHELL`);
      expect(r.stdout).toBe('/bin/sh\n');
    });
  });
});
