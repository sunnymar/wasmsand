import { describe, it, expect, afterEach } from 'bun:test';
import { Sandbox } from '../sandbox';
import { NodeAdapter } from '../platform/node-adapter';
import { resolve } from 'path';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../shell/__tests__/fixtures/codepod-shell.wasm');

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

  it('numpy array operations work', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      packages: ['numpy'],
    });
    const result = await sandbox.run(
      'python3 -c "import numpy as np; a = np.array([1,2,3]); print(a.sum())"'
    );
    expect(result.stdout.trim()).toBe('6.0');
  }, 30000);

  it('numpy linalg works', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      packages: ['numpy'],
    });
    const result = await sandbox.run(
      'python3 -c "import numpy as np; a = np.eye(3); print(np.linalg.det(a))"'
    );
    expect(result.stdout.trim()).toBe('1.0');
  }, 30000);

  it('sqlite3 in-memory database CRUD', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      packages: ['sqlite3'],
    });
    const result = await sandbox.run(`python3 -c "
import sqlite3
conn = sqlite3.connect(':memory:')
cur = conn.cursor()
cur.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)')
cur.execute('INSERT INTO users (name, age) VALUES (?, ?)', ('Alice', 30))
cur.execute('INSERT INTO users (name, age) VALUES (?, ?)', ('Bob', 25))
conn.commit()
cur.execute('SELECT name, age FROM users ORDER BY name')
rows = cur.fetchall()
assert len(rows) == 2, f'Expected 2 rows, got {len(rows)}'
assert rows[0] == ('Alice', 30), f'Row 0: {rows[0]}'
assert rows[1] == ('Bob', 25), f'Row 1: {rows[1]}'
# Test fetchone
cur.execute('SELECT name FROM users WHERE age = ?', (30,))
row = cur.fetchone()
assert row == ('Alice',), f'fetchone: {row}'
assert cur.fetchone() is None
# Test description
cur.execute('SELECT id, name, age FROM users')
desc = cur.description
assert len(desc) == 3
assert desc[0][0] == 'id'
assert desc[1][0] == 'name'
assert desc[2][0] == 'age'
conn.close()
print('ok')
"`);
    expect(result.stdout.trim()).toBe('ok');
  }, 30000);

  it('sqlite3 connection.execute shortcut', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      shellWasmPath: SHELL_WASM,
      adapter: new NodeAdapter(),
      packages: ['sqlite3'],
    });
    const result = await sandbox.run(`python3 -c "
import sqlite3
conn = sqlite3.connect(':memory:')
cursor = conn.execute('CREATE TABLE t (x INTEGER)')
conn.execute('INSERT INTO t VALUES (?)', (42,))
cursor = conn.execute('SELECT x FROM t')
rows = cursor.fetchall()
assert rows == [(42,)], f'Got: {rows}'
conn.close()
print('ok')
"`);
    expect(result.stdout.trim()).toBe('ok');
  }, 30000);

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
