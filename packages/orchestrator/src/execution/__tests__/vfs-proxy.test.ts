import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { VfsProxy } from '../vfs-proxy.js';
import { SAB_SIZE } from '../proxy-protocol.js';

describe('VfsProxy', () => {
  it('readFile returns binary content', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const proxy = new VfsProxy(sab, { skipAtomicsWait: true });
    const content = new TextEncoder().encode('hello world');

    proxy._setTestHandler((meta, bin) => {
      expect(meta.op).toBe('readFile');
      expect(meta.path).toBe('/tmp/foo');
      return { metadata: {}, binary: content };
    });

    const result = proxy.readFile('/tmp/foo');
    expect(new TextDecoder().decode(result)).toBe('hello world');
  });

  it('writeFile sends binary content', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const proxy = new VfsProxy(sab, { skipAtomicsWait: true });

    let receivedBinary: Uint8Array | null = null;
    proxy._setTestHandler((meta, bin) => {
      expect(meta.op).toBe('writeFile');
      expect(meta.path).toBe('/tmp/bar');
      receivedBinary = bin;
      return { metadata: { ok: true } };
    });

    proxy.writeFile('/tmp/bar', new TextEncoder().encode('test'));
    expect(new TextDecoder().decode(receivedBinary!)).toBe('test');
  });

  it('stat returns parsed metadata', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const proxy = new VfsProxy(sab, { skipAtomicsWait: true });

    proxy._setTestHandler(() => ({
      metadata: {
        type: 'file', size: 42, permissions: 0o644,
        mtime: new Date().toISOString(),
        ctime: new Date().toISOString(),
        atime: new Date().toISOString(),
      },
    }));

    const result = proxy.stat('/tmp/foo');
    expect(result.type).toBe('file');
    expect(result.size).toBe(42);
  });

  it('readdir returns entries array', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const proxy = new VfsProxy(sab, { skipAtomicsWait: true });

    proxy._setTestHandler(() => ({
      metadata: { entries: [{ name: 'a.txt', type: 'file' }, { name: 'b', type: 'dir' }] },
    }));

    const entries = proxy.readdir('/tmp');
    expect(entries).toEqual([{ name: 'a.txt', type: 'file' }, { name: 'b', type: 'dir' }]);
  });

  it('throws VfsError on ERROR status', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const proxy = new VfsProxy(sab, { skipAtomicsWait: true });

    proxy._setTestHandler(() => ({
      metadata: { error: true, code: 'ENOENT', message: 'no such file' },
      isError: true,
    }));

    expect(() => proxy.readFile('/tmp/missing')).toThrow(/ENOENT/);
  });

  it('mkdir, unlink, rmdir, rename, chmod send correct ops', () => {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const proxy = new VfsProxy(sab, { skipAtomicsWait: true });

    const ops: string[] = [];
    proxy._setTestHandler((meta) => {
      ops.push(meta.op as string);
      return { metadata: { ok: true } };
    });

    proxy.mkdir('/tmp/dir');
    proxy.unlink('/tmp/file');
    proxy.rmdir('/tmp/dir');
    proxy.rename('/tmp/a', '/tmp/b');
    proxy.chmod('/tmp/file', 0o755);

    expect(ops).toEqual(['mkdir', 'unlink', 'rmdir', 'rename', 'chmod']);
  });
});
