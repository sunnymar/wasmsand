import { describe, it, expect } from 'vitest';
import { VFS } from '../vfs.js';

describe('VFS', () => {
  it('creates with default directory structure', () => {
    const vfs = new VFS();
    expect(vfs.stat('/')).toMatchObject({ type: 'dir' });
    expect(vfs.stat('/home/user')).toMatchObject({ type: 'dir' });
    expect(vfs.stat('/tmp')).toMatchObject({ type: 'dir' });
    expect(vfs.stat('/bin')).toMatchObject({ type: 'dir' });
    expect(vfs.stat('/usr/bin')).toMatchObject({ type: 'dir' });
  });

  it('creates and reads files', () => {
    const vfs = new VFS();
    const data = new TextEncoder().encode('hello world');
    vfs.writeFile('/home/user/test.txt', data);
    const read = vfs.readFile('/home/user/test.txt');
    expect(new TextDecoder().decode(read)).toBe('hello world');
  });

  it('creates directories', () => {
    const vfs = new VFS();
    vfs.mkdir('/home/user/src');
    expect(vfs.stat('/home/user/src')).toMatchObject({ type: 'dir' });
  });

  it('lists directory contents', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/a.txt', new Uint8Array());
    vfs.writeFile('/home/user/b.txt', new Uint8Array());
    vfs.mkdir('/home/user/sub');
    const entries = vfs.readdir('/home/user');
    expect(entries.map(e => e.name).sort()).toEqual(['a.txt', 'b.txt', 'sub']);
  });

  it('removes files', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/test.txt', new Uint8Array());
    vfs.unlink('/home/user/test.txt');
    expect(() => vfs.stat('/home/user/test.txt')).toThrow();
  });

  it('renames files', () => {
    const vfs = new VFS();
    const data = new TextEncoder().encode('content');
    vfs.writeFile('/home/user/old.txt', data);
    vfs.rename('/home/user/old.txt', '/home/user/new.txt');
    expect(new TextDecoder().decode(vfs.readFile('/home/user/new.txt'))).toBe('content');
    expect(() => vfs.stat('/home/user/old.txt')).toThrow();
  });

  it('handles nested paths with mkdirp', () => {
    const vfs = new VFS();
    vfs.mkdirp('/home/user/a/b/c');
    expect(vfs.stat('/home/user/a/b/c')).toMatchObject({ type: 'dir' });
  });

  it('returns correct stat metadata', () => {
    const vfs = new VFS();
    const data = new TextEncoder().encode('12345');
    vfs.writeFile('/home/user/test.txt', data);
    const s = vfs.stat('/home/user/test.txt');
    expect(s.size).toBe(5);
    expect(s.type).toBe('file');
    expect(s.mtime).toBeInstanceOf(Date);
  });

  it('throws ENOENT for missing paths', () => {
    const vfs = new VFS();
    expect(() => vfs.stat('/nonexistent')).toThrow(/ENOENT/);
    expect(() => vfs.readFile('/nonexistent')).toThrow(/ENOENT/);
  });

  it('throws EEXIST for duplicate mkdir', () => {
    const vfs = new VFS();
    vfs.mkdir('/home/user/dir');
    expect(() => vfs.mkdir('/home/user/dir')).toThrow(/EEXIST/);
  });

  it('throws ENOTDIR when path component is a file', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/file.txt', new Uint8Array());
    expect(() => vfs.mkdir('/home/user/file.txt/sub')).toThrow(/ENOTDIR/);
  });
});

describe('VFS size limit', () => {
  it('allows writes within limit', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    const data = new Uint8Array(500);
    vfs.writeFile('/tmp/a.txt', data);
    expect(vfs.stat('/tmp/a.txt').size).toBe(500);
  });

  it('rejects writes exceeding limit', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(800));
    expect(() => {
      vfs.writeFile('/tmp/b.txt', new Uint8Array(300));
    }).toThrow(/ENOSPC/);
  });

  it('reclaims space on overwrite', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(800));
    vfs.writeFile('/tmp/a.txt', new Uint8Array(100));
    vfs.writeFile('/tmp/b.txt', new Uint8Array(900));
    expect(vfs.stat('/tmp/b.txt').size).toBe(900);
  });

  it('reclaims space on unlink', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(800));
    vfs.unlink('/tmp/a.txt');
    vfs.writeFile('/tmp/b.txt', new Uint8Array(800));
    expect(vfs.stat('/tmp/b.txt').size).toBe(800);
  });

  it('no limit by default', () => {
    const vfs = new VFS();
    const data = new Uint8Array(10_000_000);
    vfs.writeFile('/tmp/big.txt', data);
    expect(vfs.stat('/tmp/big.txt').size).toBe(10_000_000);
  });
});
