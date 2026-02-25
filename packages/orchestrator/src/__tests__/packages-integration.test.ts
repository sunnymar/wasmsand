import { describe, it, expect, afterEach } from 'bun:test';
import { Sandbox } from '../sandbox';
import { NodeAdapter } from '../platform/node-adapter';
import { resolve } from 'path';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../shell/__tests__/fixtures/wasmsand-shell.wasm');

describe('Sandbox packages option', () => {
  let sandbox: Sandbox;
  afterEach(() => { sandbox?.destroy(); });

  it('installs requested packages into VFS', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      packages: ['requests'],
    });
    const result = await sandbox.run('python3 -c "import requests; print(requests.__version__)"');
    expect(result.stdout.trim()).toBe('2.31.0');
  });

  it('does not install packages not requested', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      packages: [],
    });
    const result = await sandbox.run('python3 -c "import requests"');
    expect(result.exitCode).not.toBe(0);
  });

  it('auto-installs dependencies', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      packages: ['pandas'],
    });
    // pandas depends on numpy — numpy should also be installed
    const result = await sandbox.run('python3 -c "import numpy; print(\'ok\')"');
    expect(result.stdout.trim()).toBe('ok');
  });

  it('requests module provides expected API surface', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      packages: ['requests'],
    });
    const result = await sandbox.run(`python3 -c "
import requests
# Check basic API exists
assert hasattr(requests, 'get')
assert hasattr(requests, 'post')
assert hasattr(requests, 'put')
assert hasattr(requests, 'delete')
assert hasattr(requests, 'head')
assert hasattr(requests, 'patch')
assert hasattr(requests, 'request')
assert hasattr(requests, 'Session')
assert hasattr(requests, 'Response')
assert hasattr(requests, 'RequestException')
assert hasattr(requests, 'HTTPError')
assert hasattr(requests, 'ConnectionError')
assert hasattr(requests, 'Timeout')
assert requests.__version__ == '2.31.0'
# Check Response class
r = requests.Response()
assert r.ok is None or r.ok == True or r.ok == False  # shouldn't crash
assert hasattr(r, 'status_code')
assert hasattr(r, 'headers')
assert hasattr(r, 'content')
assert hasattr(r, 'text')
assert hasattr(r, 'json')
assert hasattr(r, 'raise_for_status')
# Check Session class
s = requests.Session()
assert hasattr(s, 'headers')
assert hasattr(s, 'get')
assert hasattr(s, 'post')
print('ok')
"`);
    expect(result.stdout.trim()).toBe('ok');
  });

  it('works with no packages option', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
    });
    // Should work fine without packages option
    const result = await sandbox.run('echo hello');
    expect(result.stdout.trim()).toBe('hello');
  });
});
