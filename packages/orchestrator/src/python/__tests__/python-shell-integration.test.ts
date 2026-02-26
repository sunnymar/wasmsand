import { describe, it, expect, beforeEach } from 'bun:test';
import { resolve } from 'node:path';
import { ShellRunner } from '../../shell/shell-runner.js';
import { ProcessManager } from '../../process/manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(
  import.meta.dirname,
  '../../platform/__tests__/fixtures',
);
const SHELL_WASM = resolve(
  import.meta.dirname,
  '../../shell/__tests__/fixtures/codepod-shell.wasm',
);

const TOOLS = ['cat', 'echo', 'grep', 'sort', 'wc', 'head'];

describe('Python via ShellRunner', () => {
  let vfs: VFS;
  let runner: ShellRunner;

  beforeEach(() => {
    vfs = new VFS();
    const adapter = new NodeAdapter();
    const mgr = new ProcessManager(vfs, adapter);
    for (const tool of TOOLS) {
      mgr.registerTool(tool, resolve(FIXTURES, `${tool}.wasm`));
    }
    mgr.registerTool('python3', resolve(FIXTURES, 'python3.wasm'));
    runner = new ShellRunner(vfs, mgr, adapter, SHELL_WASM);
  });

  it('runs python3 -c', async () => {
    const result = await runner.run('python3 -c "print(1 + 2)"');
    expect(result.stdout).toBe('3\n');
    expect(result.exitCode).toBe(0);
  });

  it('runs python3 script.py', async () => {
    vfs.writeFile(
      '/home/user/hello.py',
      new TextEncoder().encode('print("hello from python")'),
    );
    const result = await runner.run('python3 /home/user/hello.py');
    expect(result.stdout).toBe('hello from python\n');
  });

  it('python in a pipeline (stdin)', async () => {
    const result = await runner.run(
      'echo hello world | python3 -c "import sys; print(sys.stdin.read().upper().strip())"',
    );
    expect(result.stdout.trim()).toBe('HELLO WORLD');
  });

  it('python output piped to coreutils', async () => {
    const result = await runner.run(
      'python3 -c "print(\'banana\')\nprint(\'apple\')\nprint(\'cherry\')" | sort',
    );
    expect(result.stdout).toBe('apple\nbanana\ncherry\n');
  });

  it('python reads VFS file', async () => {
    vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('42'));
    const result = await runner.run(
      'python3 -c "val = open(\'/home/user/data.txt\').read(); print(int(val) * 2)"',
    );
    expect(result.stdout.trim()).toBe('84');
  });

  it('python writes VFS file', async () => {
    await runner.run(
      'python3 -c "open(\'/home/user/out.txt\', \'w\').write(\'written by python\')"',
    );
    expect(new TextDecoder().decode(vfs.readFile('/home/user/out.txt'))).toBe(
      'written by python',
    );
  });
});
