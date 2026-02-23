/**
 * Smoke tests from the shell-completeness plan verification section.
 * Each test corresponds to a command from the plan's manual smoke test list.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { resolve } from 'node:path';

import { ShellRunner } from '../shell-runner.js';
import { ProcessManager } from '../../process/manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname, '../../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../__tests__/fixtures/wasmsand-shell.wasm');

describe('Smoke tests (plan verification)', () => {
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

  it('# Comments: echo hello # this is a comment', async () => {
    const result = await runner.run('echo hello # this is a comment');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello\n');
  });

  it('# Exit status: false; echo $?', async () => {
    const result = await runner.run('false ; echo $?');
    expect(result.stdout).toContain('1');
  });

  it('# Tilde: echo ~', async () => {
    const result = await runner.run('echo ~');
    expect(result.stdout.trim()).toBe('/home/user');
  });

  it('# Case: case "hello" in h*) echo matched;; *) echo nope;; esac', async () => {
    const result = await runner.run('case hello in h*) echo matched;; *) echo nope;; esac');
    expect(result.stdout.trim()).toBe('matched');
  });

  it('# Functions: greet() { echo "hello $1"; }; greet world', async () => {
    const result = await runner.run('greet() { echo "hello $1"; } ; greet world');
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('# Parameter expansion: echo ${UNSET:-default}', async () => {
    const result = await runner.run('echo ${UNSET:-default}');
    expect(result.stdout.trim()).toBe('default');
  });

  it('# Arithmetic: echo $((2 + 2))', async () => {
    const result = await runner.run('echo $((2 + 2))');
    expect(result.stdout.trim()).toBe('4');
  });

  it('# Here-document: cat <<EOF\\nhello world\\nEOF', async () => {
    const result = await runner.run('cat-stdin <<EOF\nhello world\nEOF');
    expect(result.stdout).toBe('hello world\n');
  });

  it('# Break/continue: for i in 1 2 3 4 5; do if [ "$i" = "3" ]; then break; fi; echo $i; done', async () => {
    const result = await runner.run('for i in 1 2 3 4 5; do if [ "$i" = "3" ]; then break; fi; echo $i; done');
    expect(result.stdout).toBe('1\n2\n');
  });

  it('# Negation: ! false && echo "negation works"', async () => {
    const result = await runner.run('! false && echo "negation works"');
    expect(result.stdout.trim()).toBe('negation works');
  });
});
