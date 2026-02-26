/**
 * Tests for VFS virtual providers: DevProvider (/dev) and ProcProvider (/proc).
 *
 * Exercises the full provider interface through the VFS layer, verifying
 * that provider routing correctly intercepts before normal inode logic.
 * Also includes integration tests that verify providers work through the
 * full Sandbox.run() path (via WASM coreutils) and survive snapshot/restore
 * and fork operations.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { VFS } from '../vfs/vfs.js';
import { VfsError } from '../vfs/inode.js';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../shell/__tests__/fixtures/codepod-shell.wasm');

describe('DevProvider (/dev)', () => {
  it('/dev/null read returns empty bytes', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/dev/null');
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.byteLength).toBe(0);
  });

  it('/dev/null write is silent (no error)', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/dev/null', new TextEncoder().encode('discard me'));
    }).not.toThrow();
  });

  it('/dev/null stat returns file type', () => {
    const vfs = new VFS();
    const s = vfs.stat('/dev/null');
    expect(s.type).toBe('file');
    expect(s.size).toBe(0);
  });

  it('/dev directory is listable with all 4 devices', () => {
    const vfs = new VFS();
    const entries = vfs.readdir('/dev');
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(['null', 'random', 'urandom', 'zero']);
    // All entries are files
    for (const entry of entries) {
      expect(entry.type).toBe('file');
    }
  });

  it('/dev stat returns dir type', () => {
    const vfs = new VFS();
    const s = vfs.stat('/dev');
    expect(s.type).toBe('dir');
    expect(s.size).toBe(4);
  });

  it('/dev/zero returns zero bytes', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/dev/zero');
    expect(data.byteLength).toBeGreaterThan(0);
    for (let i = 0; i < data.byteLength; i++) {
      expect(data[i]).toBe(0);
    }
  });

  it('/dev/random returns bytes', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/dev/random');
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.byteLength).toBeGreaterThan(0);
  });

  it('/dev/urandom returns bytes', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/dev/urandom');
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.byteLength).toBeGreaterThan(0);
  });

  it('/dev/random and /dev/urandom return different bytes on separate reads', () => {
    const vfs = new VFS();
    const a = vfs.readFile('/dev/random');
    const b = vfs.readFile('/dev/random');
    // It's theoretically possible but astronomically unlikely for 4096 random bytes to match
    let same = true;
    for (let i = 0; i < a.byteLength; i++) {
      if (a[i] !== b[i]) { same = false; break; }
    }
    expect(same).toBe(false);
  });

  it('writing to /dev/zero throws EROFS', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/dev/zero', new Uint8Array(1));
    }).toThrow(/EROFS/);
  });

  it('writing to /dev/random throws EROFS', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/dev/random', new Uint8Array(1));
    }).toThrow(/EROFS/);
  });

  it('writing to /dev/urandom throws EROFS', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/dev/urandom', new Uint8Array(1));
    }).toThrow(/EROFS/);
  });

  it('reading nonexistent /dev/foo throws ENOENT', () => {
    const vfs = new VFS();
    try {
      vfs.readFile('/dev/foo');
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect(e).toBeInstanceOf(VfsError);
      expect((e as VfsError).errno).toBe('ENOENT');
    }
  });

  it('stat of nonexistent /dev/foo throws ENOENT', () => {
    const vfs = new VFS();
    try {
      vfs.stat('/dev/foo');
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(VfsError);
      expect((e as VfsError).errno).toBe('ENOENT');
    }
  });
});

describe('ProcProvider (/proc)', () => {
  it('/proc/uptime returns parseable number', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/proc/uptime');
    const text = new TextDecoder().decode(data);
    const parts = text.trim().split(' ');
    expect(parts.length).toBe(2);
    const uptime = parseFloat(parts[0]);
    expect(Number.isFinite(uptime)).toBe(true);
    expect(uptime).toBeGreaterThanOrEqual(0);
  });

  it('/proc/version contains expected content', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/proc/version');
    const text = new TextDecoder().decode(data);
    expect(text).toContain('codepod');
    expect(text).toContain('WASI sandbox');
  });

  it('/proc/cpuinfo contains "processor"', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/proc/cpuinfo');
    const text = new TextDecoder().decode(data);
    expect(text).toContain('processor');
    expect(text).toContain('WASI Virtual CPU');
  });

  it('/proc/meminfo has content', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/proc/meminfo');
    const text = new TextDecoder().decode(data);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('MemTotal');
    expect(text).toContain('MemFree');
  });

  it('/proc is listable with all 5 files', () => {
    const vfs = new VFS();
    const entries = vfs.readdir('/proc');
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(['cpuinfo', 'diskstats', 'meminfo', 'uptime', 'version']);
    for (const entry of entries) {
      expect(entry.type).toBe('file');
    }
  });

  it('/proc stat returns dir type', () => {
    const vfs = new VFS();
    const s = vfs.stat('/proc');
    expect(s.type).toBe('dir');
    expect(s.size).toBe(5);
  });

  it('/proc files are read-only (EROFS on write to uptime)', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/proc/uptime', new TextEncoder().encode('fake'));
    }).toThrow(/EROFS/);
  });

  it('/proc files are read-only (EROFS on write to version)', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/proc/version', new TextEncoder().encode('fake'));
    }).toThrow(/EROFS/);
  });

  it('/proc files are read-only (EROFS on write to cpuinfo)', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/proc/cpuinfo', new TextEncoder().encode('fake'));
    }).toThrow(/EROFS/);
  });

  it('/proc files are read-only (EROFS on write to meminfo)', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/proc/meminfo', new TextEncoder().encode('fake'));
    }).toThrow(/EROFS/);
  });

  it('reading nonexistent /proc/foo throws ENOENT', () => {
    const vfs = new VFS();
    try {
      vfs.readFile('/proc/foo');
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(VfsError);
      expect((e as VfsError).errno).toBe('ENOENT');
    }
  });

  it('/proc/uptime stat returns file type with correct size', () => {
    const vfs = new VFS();
    const s = vfs.stat('/proc/uptime');
    expect(s.type).toBe('file');
    expect(s.size).toBeGreaterThan(0);
  });
});

describe('Provider integration with VFS', () => {
  it('providers do not interfere with normal VFS operations', () => {
    const vfs = new VFS();
    vfs.writeFile('/tmp/test.txt', new TextEncoder().encode('hello'));
    expect(new TextDecoder().decode(vfs.readFile('/tmp/test.txt'))).toBe('hello');
    expect(vfs.stat('/tmp/test.txt').type).toBe('file');
  });

  it('providers are available after cowClone', () => {
    const vfs = new VFS();
    const clone = vfs.cowClone();

    // /dev should work in clone
    const nullData = clone.readFile('/dev/null');
    expect(nullData.byteLength).toBe(0);

    // /proc should work in clone
    const version = new TextDecoder().decode(clone.readFile('/proc/version'));
    expect(version).toContain('codepod');

    // Listing should work
    const devEntries = clone.readdir('/dev');
    expect(devEntries.length).toBe(4);
    const procEntries = clone.readdir('/proc');
    expect(procEntries.length).toBe(5);
  });

  it('root readdir still works (does not include virtual mounts)', () => {
    const vfs = new VFS();
    const entries = vfs.readdir('/');
    const names = entries.map(e => e.name).sort();
    // Should contain the default layout directories
    expect(names).toContain('home');
    expect(names).toContain('tmp');
    expect(names).toContain('bin');
  });

  it('provider stat returns correct permissions', () => {
    const vfs = new VFS();
    const devStat = vfs.stat('/dev');
    expect(devStat.permissions).toBe(0o755);

    const nullStat = vfs.stat('/dev/null');
    expect(nullStat.permissions).toBe(0o444);
  });
});

describe('providers via Sandbox.run()', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('cat /dev/null returns empty stdout with exit code 0', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const result = await sandbox.run('cat /dev/null');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('cat /proc/version returns codepod', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const result = await sandbox.run('cat /proc/version');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('codepod');
  });

  it('ls /dev lists devices including null', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const result = await sandbox.run('ls /dev');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('null');
  });
});

describe('providers after snapshot/restore and fork', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('/dev/null works after snapshot/restore', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const snapId = sandbox.snapshot();
    sandbox.restore(snapId);

    const data = sandbox.readFile('/dev/null');
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.byteLength).toBe(0);
  });

  it('/proc/version available in fork', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const child = await sandbox.fork();
    try {
      const data = child.readFile('/proc/version');
      const text = new TextDecoder().decode(data);
      expect(text).toContain('codepod');
    } finally {
      child.destroy();
    }
  });

  it('/dev devices are accessible in forked sandbox', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const child = await sandbox.fork();
    try {
      // /dev/null should return empty
      const nullData = child.readFile('/dev/null');
      expect(nullData.byteLength).toBe(0);

      // /dev/zero should return zero bytes
      const zeroData = child.readFile('/dev/zero');
      expect(zeroData.byteLength).toBeGreaterThan(0);
      for (let i = 0; i < zeroData.byteLength; i++) {
        expect(zeroData[i]).toBe(0);
      }

      // readdir /dev should list all devices
      const entries = child.readDir('/dev');
      const names = entries.map(e => e.name).sort();
      expect(names).toEqual(['null', 'random', 'urandom', 'zero']);
    } finally {
      child.destroy();
    }
  });

  it('/proc files are accessible after multiple snapshot/restore cycles', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });

    // First snapshot/restore
    const snap1 = sandbox.snapshot();
    sandbox.writeFile('/tmp/marker.txt', new TextEncoder().encode('modified'));
    sandbox.restore(snap1);

    // Providers should still work
    const version1 = new TextDecoder().decode(sandbox.readFile('/proc/version'));
    expect(version1).toContain('codepod');

    // Second snapshot/restore
    const snap2 = sandbox.snapshot();
    sandbox.restore(snap2);

    const version2 = new TextDecoder().decode(sandbox.readFile('/proc/version'));
    expect(version2).toContain('codepod');

    // /dev should also work
    const nullData = sandbox.readFile('/dev/null');
    expect(nullData.byteLength).toBe(0);
  });

  it('forked sandbox providers are independent from parent', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    const child = await sandbox.fork();
    try {
      // Both parent and child should have working providers
      const parentVersion = new TextDecoder().decode(sandbox.readFile('/proc/version'));
      const childVersion = new TextDecoder().decode(child.readFile('/proc/version'));
      expect(parentVersion).toContain('codepod');
      expect(childVersion).toContain('codepod');

      // Both should have working /dev/null
      expect(sandbox.readFile('/dev/null').byteLength).toBe(0);
      expect(child.readFile('/dev/null').byteLength).toBe(0);
    } finally {
      child.destroy();
    }
  });
});
