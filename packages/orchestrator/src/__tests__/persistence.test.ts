/**
 * Tests for VFS state persistence: serializer unit tests + Sandbox integration.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { VFS } from '../vfs/vfs.js';
import { exportState, importState } from '../persistence/serializer.js';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../shell/__tests__/fixtures/wasmsand-shell.wasm');

/** Helper: encode a string as UTF-8 bytes. */
const enc = (s: string) => new TextEncoder().encode(s);
/** Helper: decode UTF-8 bytes as a string. */
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('Persistence serializer', () => {
  describe('exportState / importState round-trip', () => {
    it('round-trips VFS files and directories', () => {
      const src = new VFS({ writablePaths: undefined });
      src.withWriteAccess(() => {
        src.mkdirp('/home/user/project');
        src.writeFile('/home/user/project/main.ts', enc('console.log("hello")'));
        src.writeFile('/tmp/data.bin', new Uint8Array([0, 1, 2, 255]));
      });

      const blob = exportState(src);

      const dst = new VFS({ writablePaths: undefined });
      importState(dst, blob);

      // Verify files were restored
      expect(dec(dst.readFile('/home/user/project/main.ts'))).toBe('console.log("hello")');
      const binData = dst.readFile('/tmp/data.bin');
      expect(Array.from(binData)).toEqual([0, 1, 2, 255]);

      // Verify directory exists
      const stat = dst.stat('/home/user/project');
      expect(stat.type).toBe('dir');
    });

    it('round-trips env vars', () => {
      const src = new VFS({ writablePaths: undefined });
      const env = new Map([['PATH', '/bin:/usr/bin'], ['HOME', '/home/user'], ['LANG', 'en_US.UTF-8']]);

      const blob = exportState(src, env);

      const dst = new VFS({ writablePaths: undefined });
      const result = importState(dst, blob);

      expect(result.env).toBeDefined();
      expect(result.env!.get('PATH')).toBe('/bin:/usr/bin');
      expect(result.env!.get('HOME')).toBe('/home/user');
      expect(result.env!.get('LANG')).toBe('en_US.UTF-8');
    });

    it('returns empty object when no env was stored', () => {
      const src = new VFS({ writablePaths: undefined });
      const blob = exportState(src);
      const dst = new VFS({ writablePaths: undefined });
      const result = importState(dst, blob);
      expect(result.env).toBeUndefined();
    });
  });

  describe('validation', () => {
    it('rejects blob that is too short', () => {
      expect(() => importState(new VFS({ writablePaths: undefined }), new Uint8Array(4))).toThrow(/too short/);
    });

    it('rejects blob with bad magic bytes', () => {
      const bad = new Uint8Array(16);
      bad[0] = 0x00; // wrong magic
      expect(() => importState(new VFS({ writablePaths: undefined }), bad)).toThrow(/bad magic/);
    });

    it('rejects blob with unsupported version', () => {
      // Valid magic, but version = 99
      const buf = new Uint8Array(16);
      buf.set([0x57, 0x53, 0x4e, 0x44], 0); // "WSND"
      const view = new DataView(buf.buffer);
      view.setUint32(4, 99, true);
      // Add minimal valid JSON
      const json = enc('{"version":99,"files":[]}');
      const full = new Uint8Array(8 + json.byteLength);
      full.set(buf.subarray(0, 8), 0);
      full.set(json, 8);
      expect(() => importState(new VFS({ writablePaths: undefined }), full)).toThrow(/Unsupported state version/);
    });
  });

  describe('exclusions', () => {
    it('does not include /proc or /dev contents', () => {
      const vfs = new VFS({ writablePaths: undefined });
      // VFS constructor registers /dev and /proc providers.
      // Write a normal file so the blob isn't empty.
      vfs.withWriteAccess(() => {
        vfs.writeFile('/tmp/keep.txt', enc('keep'));
      });

      const blob = exportState(vfs);
      const json = dec(blob.subarray(8));
      const state = JSON.parse(json);

      // No entry should have a path starting with /dev or /proc
      for (const entry of state.files) {
        expect(entry.path).not.toMatch(/^\/(dev|proc)(\/|$)/);
      }

      // But our file should be present
      expect(state.files.some((f: any) => f.path === '/tmp/keep.txt')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles empty VFS gracefully', () => {
      const src = new VFS({ writablePaths: undefined });
      const blob = exportState(src);

      const dst = new VFS({ writablePaths: undefined });
      const result = importState(dst, blob);

      // Should not throw; env should be absent
      expect(result.env).toBeUndefined();
    });

    it('handles binary file content (all byte values)', () => {
      const src = new VFS({ writablePaths: undefined });
      const allBytes = new Uint8Array(256);
      for (let i = 0; i < 256; i++) allBytes[i] = i;

      src.withWriteAccess(() => {
        src.writeFile('/tmp/binary.bin', allBytes);
      });

      const blob = exportState(src);
      const dst = new VFS({ writablePaths: undefined });
      importState(dst, blob);

      const restored = dst.readFile('/tmp/binary.bin');
      expect(Array.from(restored)).toEqual(Array.from(allBytes));
    });

    it('blob has correct magic bytes and version', () => {
      const vfs = new VFS({ writablePaths: undefined });
      const blob = exportState(vfs);

      expect(blob[0]).toBe(0x57); // W
      expect(blob[1]).toBe(0x53); // S
      expect(blob[2]).toBe(0x4e); // N
      expect(blob[3]).toBe(0x44); // D

      const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      expect(view.getUint32(4, true)).toBe(1);
    });
  });
});

describe('Sandbox exportState / importState', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('round-trips files and env via Sandbox', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });

    sandbox.writeFile('/tmp/hello.txt', enc('world'));
    sandbox.setEnv('MY_KEY', 'my_value');

    const blob = sandbox.exportState();

    // Create a second sandbox and import
    const sandbox2 = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    try {
      sandbox2.importState(blob);

      expect(dec(sandbox2.readFile('/tmp/hello.txt'))).toBe('world');
      expect(sandbox2.getEnv('MY_KEY')).toBe('my_value');
    } finally {
      sandbox2.destroy();
    }
  });

  it('importState overwrites existing files', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });

    sandbox.writeFile('/tmp/overwrite.txt', enc('original'));
    const blob = sandbox.exportState();

    // Create second sandbox with different content
    const sandbox2 = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    try {
      sandbox2.writeFile('/tmp/overwrite.txt', enc('should-be-overwritten'));
      sandbox2.importState(blob);

      expect(dec(sandbox2.readFile('/tmp/overwrite.txt'))).toBe('original');
    } finally {
      sandbox2.destroy();
    }
  });

  it('throws on destroyed sandbox', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM, adapter: new NodeAdapter() });
    sandbox.destroy();
    expect(() => sandbox.exportState()).toThrow(/destroyed/);
    expect(() => sandbox.importState(new Uint8Array(0))).toThrow(/destroyed/);
  });
});
