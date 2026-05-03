import { describe, it, beforeEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ProcessManager } from '../manager.js';
import { MemoryWasmModuleCache } from '../module-cache.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname!, '../../platform/__tests__/fixtures');

describe('ProcessManager', () => {
  let vfs: VFS;
  let mgr: ProcessManager;

  beforeEach(() => {
    vfs = new VFS();
    const adapter = new NodeAdapter();
    mgr = new ProcessManager(vfs, adapter);
    mgr.registerTool('hello', resolve(FIXTURES, 'hello.wasm'));
    mgr.registerTool('echo-args', resolve(FIXTURES, 'echo-args.wasm'));
  });

  it('spawns a process and captures stdout', async () => {
    const result = await mgr.spawn('hello', { args: [], env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from wasm\n');
    expect(result.stderr).toBe('');
  });

  it('passes args to the process', async () => {
    const result = await mgr.spawn('echo-args', {
      args: ['one', 'two'],
      env: {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('one\ntwo\n');
  });

  it('passes env to the process', async () => {
    const result = await mgr.spawn('hello', {
      args: [],
      env: { FOO: 'bar' },
    });
    expect(result.exitCode).toBe(0);
  });

  it('caches modules after first load', async () => {
    const r1 = await mgr.spawn('hello', { args: [], env: {} });
    const r2 = await mgr.spawn('hello', { args: [], env: {} });
    expect(r1.stdout).toBe('hello from wasm\n');
    expect(r2.stdout).toBe('hello from wasm\n');
  });

  it('deduplicates host tool compilation by digest while preserving path cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codepod-process-cache-'));
    const firstPath = join(dir, 'first.wasm');
    const secondPath = join(dir, 'second.wasm');
    await copyFile(resolve(FIXTURES, 'hello.wasm'), firstPath);
    await copyFile(resolve(FIXTURES, 'hello.wasm'), secondPath);
    let compiles = 0;
    const moduleCache = new MemoryWasmModuleCache(async (bytes) => {
      compiles++;
      return await WebAssembly.compile(bytes as BufferSource);
    });
    const localMgr = new ProcessManager(vfs, new NodeAdapter(), undefined, undefined, moduleCache);
    localMgr.registerTool('first', firstPath);
    localMgr.registerTool('second', secondPath);

    await localMgr.preloadModules();

    expect(compiles).toBe(1);
    expect(localMgr.spawnSync('first', [], {}, new Uint8Array(), '/').exit_code).toBe(0);
    expect(localMgr.spawnSync('second', [], {}, new Uint8Array(), '/').exit_code).toBe(0);
  });

  it('deduplicates runtime-installed VFS tool compilation by digest', async () => {
    const bytes = await new NodeAdapter().readBytes(resolve(FIXTURES, 'hello.wasm'));
    vfs.withWriteAccess(() => {
      vfs.mkdirp('/usr/share/pkg/bin');
      vfs.writeFile('/usr/share/pkg/bin/first.wasm', bytes);
      vfs.writeFile('/usr/share/pkg/bin/second.wasm', new Uint8Array(bytes));
    });
    let compiles = 0;
    const moduleCache = new MemoryWasmModuleCache(async (wasmBytes) => {
      compiles++;
      return await WebAssembly.compile(wasmBytes as BufferSource);
    });
    const localMgr = new ProcessManager(vfs, new NodeAdapter(), undefined, undefined, moduleCache);

    await localMgr.registerAndLoadTool('first', '/usr/share/pkg/bin/first.wasm');
    await localMgr.registerAndLoadTool('second', '/usr/share/pkg/bin/second.wasm');

    expect(compiles).toBe(1);
    expect(localMgr.spawnSync('first', [], {}, new Uint8Array(), '/').exit_code).toBe(0);
    expect(localMgr.spawnSync('second', [], {}, new Uint8Array(), '/').exit_code).toBe(0);
  });

  it('throws for unregistered tools', async () => {
    await expect(mgr.spawn('nonexistent', { args: [], env: {} }))
      .rejects.toThrow(/not found|not registered/i);
  });

  describe('spawnSync', () => {
    it('returns not-found for unregistered tool', async () => {
      await mgr.preloadModules();
      const result = mgr.spawnSync('no-such-tool', [], {}, new Uint8Array(), '/');
      expect(result.exit_code).toBe(127);
      expect(result.stderr).toContain('not found');
    });

    it('returns module-not-loaded for tool without preloaded module', () => {
      mgr.registerTool('unloaded', resolve(FIXTURES, 'hello.wasm'));
      // Don't call preloadModules — module is registered but not compiled
      const result = mgr.spawnSync('unloaded', [], {}, new Uint8Array(), '/');
      expect(result.exit_code).toBe(127);
      expect(result.stderr).toContain('module not loaded');
    });

    it('runs a preloaded module synchronously', async () => {
      await mgr.preloadModules();
      const result = mgr.spawnSync('hello', [], {}, new Uint8Array(), '/');
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toBe('hello from wasm\n');
    });

    it('returns graceful error on instantiation failure instead of throwing', async () => {
      await mgr.preloadModules();
      // Build a valid WASM module that requires an import the host won't provide.
      // (module (import "bad" "fn" (func)))
      const wat = `(module (import "bad" "fn" (func)))`;
      // Use a pre-built binary for this import-requiring module:
      const importWasm = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, // \0asm magic
        0x01, 0x00, 0x00, 0x00, // version 1
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: 1 type () -> ()
        0x02, 0x0a, 0x01,                   // import section: 1 import
        0x03, 0x62, 0x61, 0x64,             // module "bad"
        0x02, 0x66, 0x6e,                   // field "fn"
        0x00, 0x00,                         // func, type 0
      ]);
      const badModule = await WebAssembly.compile(importWasm);
      // Inject the bad module into the cache via the tool path
      const helloPath = resolve(FIXTURES, 'hello.wasm');
      (mgr as any).pathModuleCache.set(helloPath, badModule);

      const result = mgr.spawnSync('hello', [], {}, new Uint8Array(), '/');
      // Should return an error result, not throw
      expect(result.exit_code).toBe(1);
      expect(result.stderr).toContain('hello');
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });

  it('provides execution time', async () => {
    const result = await mgr.spawn('hello', { args: [], env: {} });
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.executionTimeMs).toBeLessThan(5000);
  });

  describe('tool files and symlinks', () => {
    it('registerTool creates an executable file in /usr/bin', () => {
      const st = vfs.stat('/usr/bin/hello');
      expect(st.type).toBe('file');
      expect(st.permissions & 0o111).toBeTruthy(); // executable
      expect(st.permissions & 0o100000).toBeTruthy(); // shell tool stub
    });

    it('tool file contains the wasm path', () => {
      const content = new TextDecoder().decode(vfs.readFile('/usr/bin/hello'));
      expect(content).toBe(resolve(FIXTURES, 'hello.wasm'));
    });

    it('tool files in /usr/bin are immutable (dir is 0o555)', () => {
      expect(() => {
        vfs.writeFile('/usr/bin/hello', new Uint8Array([1, 2, 3]));
      }).toThrow();
    });

    it('resolves a symlink alias to the original tool', async () => {
      // Create a symlink: /usr/bin/hi → /usr/bin/hello (absolute target)
      vfs.withWriteAccess(() => vfs.symlink('/usr/bin/hello', '/usr/bin/hi'));
      await mgr.preloadModules();

      // 'hi' is not in the registry, but /usr/bin/hi → /usr/bin/hello → wasm path
      const wasmPath = mgr.resolveTool('hi');
      expect(wasmPath).toBe(resolve(FIXTURES, 'hello.wasm'));
    });

    it('spawnSync works through a symlink alias', async () => {
      vfs.withWriteAccess(() => vfs.symlink('/usr/bin/hello', '/usr/bin/hi'));
      await mgr.preloadModules();

      const result = mgr.spawnSync('hi', [], {}, new Uint8Array(), '/');
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toBe('hello from wasm\n');
    });

    it('spawn works through a symlink alias', async () => {
      vfs.withWriteAccess(() => vfs.symlink('/usr/bin/echo-args', '/usr/bin/myecho'));
      await mgr.preloadModules();

      const result = await mgr.spawn('myecho', { args: ['foo'], env: {} });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('foo\n');
    });

    it('registered host stubs resolve through their registry entry', async () => {
      await mgr.preloadModules();
      const st = vfs.stat('/usr/bin/hello');
      expect(st.permissions & 0o100000).toBeTruthy();
      expect(mgr.resolveTool('hello')).toBe(resolve(FIXTURES, 'hello.wasm'));
    });

    it('VFS executable resolution uses normal executable files', () => {
      const helloWasmPath = resolve(FIXTURES, 'hello.wasm');
      vfs.withWriteAccess(() => {
        vfs.writeFile('/usr/bin/fake', new TextEncoder().encode(helloWasmPath));
        vfs.chmod('/usr/bin/fake', 0o555);
      });
      expect(mgr.resolveTool('fake')).toBe(helloWasmPath);
    });

    it('chained symlinks resolve correctly', async () => {
      vfs.withWriteAccess(() => {
        vfs.symlink('/usr/bin/hello', '/usr/bin/alias1');
        vfs.symlink('/usr/bin/alias1', '/usr/bin/alias2');
      });
      await mgr.preloadModules();

      const wasmPath = mgr.resolveTool('alias2');
      expect(wasmPath).toBe(resolve(FIXTURES, 'hello.wasm'));
    });
  });
});
