import { describe, it, expect, beforeEach } from 'bun:test';
import { resolve } from 'node:path';

import { ShellInstance } from '../shell-instance.js';
import { ProcessManager } from '../../process/manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const SHELL_EXEC_WASM = resolve(
  import.meta.dirname,
  'fixtures/codepod-shell-exec.wasm',
);

describe('ShellInstance', () => {
  let vfs: VFS;
  let mgr: ProcessManager;
  let adapter: NodeAdapter;

  beforeEach(() => {
    vfs = new VFS();
    adapter = new NodeAdapter();
    mgr = new ProcessManager(vfs, adapter);
  });

  it('runs a simple command and returns result', async () => {
    const shell = await ShellInstance.create(vfs, mgr, adapter, SHELL_EXEC_WASM, {
      syncSpawn: (cmd, args) => {
        if (cmd === 'echo-args') {
          return { exit_code: 0, stdout: args.join(' ') + '\n', stderr: '' };
        }
        return { exit_code: 127, stdout: '', stderr: `${cmd}: not found\n` };
      },
    });

    const result = await shell.run('echo-args hello world');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world\n');
    expect(result.stderr).toBe('');
  });

  it('returns non-zero exit code for unknown commands', async () => {
    const shell = await ShellInstance.create(vfs, mgr, adapter, SHELL_EXEC_WASM, {
      syncSpawn: (cmd) => {
        return { exit_code: 127, stdout: '', stderr: `${cmd}: not found\n` };
      },
    });

    const result = await shell.run('nonexistent');
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('not found');
  });

  it('preserves state between commands', async () => {
    const shell = await ShellInstance.create(vfs, mgr, adapter, SHELL_EXEC_WASM, {
      syncSpawn: (cmd) => {
        if (cmd === 'true-cmd') return { exit_code: 0, stdout: '', stderr: '' };
        if (cmd === 'false-cmd') return { exit_code: 1, stdout: '', stderr: '' };
        return { exit_code: 127, stdout: '', stderr: `${cmd}: not found\n` };
      },
    });

    const r1 = await shell.run('true-cmd');
    expect(r1.exitCode).toBe(0);

    const r2 = await shell.run('false-cmd');
    expect(r2.exitCode).toBe(1);
  });

  it('handles commands with multiple arguments', async () => {
    const shell = await ShellInstance.create(vfs, mgr, adapter, SHELL_EXEC_WASM, {
      syncSpawn: (cmd, args) => {
        return {
          exit_code: 0,
          stdout: `cmd=${cmd} args=${JSON.stringify(args)}\n`,
          stderr: '',
        };
      },
    });

    const result = await shell.run('my-tool arg1 arg2 arg3');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('my-tool');
    expect(result.stdout).toContain('arg1');
    expect(result.stdout).toContain('arg2');
    expect(result.stdout).toContain('arg3');
  });
});
