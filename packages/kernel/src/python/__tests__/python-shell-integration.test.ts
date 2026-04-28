import { describe, it, beforeEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../../sandbox.ts';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(
  import.meta.dirname!,
  '../../platform/__tests__/fixtures',
);
const SHELL_EXEC_WASM = resolve(
  import.meta.dirname!,
  '../../platform/__tests__/fixtures/codepod-shell-exec.wasm',
);

describe('Python via Sandbox shell', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      shellExecWasmPath: SHELL_EXEC_WASM,
    });
  });

  it('runs python3 -c', async () => {
    const result = await sandbox.run('python3 -c "print(1 + 2)"');
    expect(result.stdout).toBe('3\n');
    expect(result.exitCode).toBe(0);
  });

  it('runs python3 script.py', async () => {
    sandbox.writeFile(
      '/home/user/hello.py',
      new TextEncoder().encode('print("hello from python")'),
    );
    const result = await sandbox.run('python3 /home/user/hello.py');
    expect(result.stdout).toBe('hello from python\n');
  });

  it('python in a pipeline (stdin)', async () => {
    const result = await sandbox.run(
      'echo hello world | python3 -c "import sys; print(sys.stdin.read().upper().strip())"',
    );
    expect(result.stdout.trim()).toBe('HELLO WORLD');
  });

  it('python output piped to coreutils', async () => {
    const result = await sandbox.run(
      'python3 -c "print(\'banana\')\nprint(\'apple\')\nprint(\'cherry\')" | sort',
    );
    expect(result.stdout).toBe('apple\nbanana\ncherry\n');
  });

  it('python reads VFS file', async () => {
    sandbox.writeFile('/home/user/data.txt', new TextEncoder().encode('42'));
    const result = await sandbox.run(
      'python3 -c "val = open(\'/home/user/data.txt\').read(); print(int(val) * 2)"',
    );
    expect(result.stdout.trim()).toBe('84');
  });

  it('python writes VFS file', async () => {
    await sandbox.run(
      'python3 -c "open(\'/home/user/out.txt\', \'w\').write(\'written by python\')"',
    );
    expect(new TextDecoder().decode(sandbox.readFile('/home/user/out.txt'))).toBe(
      'written by python',
    );
  });
});
