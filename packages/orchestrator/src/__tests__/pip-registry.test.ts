import { describe, it, expect, afterEach } from 'bun:test';
import { Sandbox } from '../sandbox';
import { NodeAdapter } from '../platform/node-adapter';
import { resolve } from 'path';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../shell/__tests__/fixtures/codepod-shell.wasm');

describe('pip with PackageRegistry', () => {
  let sandbox: Sandbox;
  afterEach(() => { sandbox?.destroy(); });

  it('pip install writes package files to VFS', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
    });
    const install = await sandbox.run('pip install requests');
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain('Successfully installed requests');

    const check = await sandbox.run('python3 -c "import requests; print(requests.__version__)"');
    expect(check.stdout.trim()).toBe('2.31.0');
  });

  it('pip uninstall removes package files', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      packages: ['requests'],
    });
    const uninstall = await sandbox.run('pip uninstall requests -y');
    expect(uninstall.exitCode).toBe(0);

    const check = await sandbox.run('python3 -c "import requests"');
    expect(check.exitCode).not.toBe(0);
  });

  it('pip list shows installed packages', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      packages: ['requests'],
    });
    const result = await sandbox.run('pip list');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('requests');
    expect(result.stdout).toContain('2.31.0');
  });

  it('pip install unknown package fails with helpful message', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
    });
    const result = await sandbox.run('pip install nonexistent-pkg');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not found');
    expect(result.stderr).toContain('Available');
  });

  it('pip install auto-installs dependencies', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
    });
    const result = await sandbox.run('pip install pandas');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('numpy');
    expect(result.stdout).toContain('pandas');
  });

  it('pip show displays package metadata', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
    });
    const result = await sandbox.run('pip show requests');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Name: requests');
    expect(result.stdout).toContain('Version: 2.31.0');
    expect(result.stdout).toContain('Status: available');
  });
});
