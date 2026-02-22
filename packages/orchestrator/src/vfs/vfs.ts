/**
 * In-memory VFS with POSIX semantics.
 *
 * Provides a tree of inodes (files, directories, symlinks) that can back
 * WASI syscalls and Pyodide's filesystem. Designed to be snapshotable
 * (for fork simulation) and extensible with pipes (for shell pipelines).
 */

import type { DirEntry, DirInode, Inode, StatResult } from './inode.js';
import {
  VfsError,
  createDirInode,
  createFileInode,
  createSymlinkInode,
} from './inode.js';
import { deepCloneRoot } from './snapshot.js';

const MAX_SYMLINK_DEPTH = 40;

export interface VfsOptions {
  /** Maximum total bytes stored in the VFS. Undefined = no limit. */
  fsLimitBytes?: number;
}

/**
 * Split an absolute path into its component segments,
 * resolving '.' and '..' along the way.
 */
function parsePath(path: string): string[] {
  if (!path.startsWith('/')) {
    throw new VfsError('ENOENT', `not an absolute path: ${path}`);
  }

  const segments: string[] = [];

  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }

  return segments;
}

export class VFS {
  private root: DirInode;
  private snapshots: Map<string, DirInode> = new Map();
  private nextSnapId = 1;
  private totalBytes = 0;
  private fsLimitBytes: number | undefined;

  constructor(options?: VfsOptions) {
    this.root = createDirInode();
    this.fsLimitBytes = options?.fsLimitBytes;
    this.initDefaultLayout();
  }

  /** Create a VFS from an already-populated root (used by cowClone). */
  private static fromRoot(root: DirInode): VFS {
    const vfs = Object.create(VFS.prototype) as VFS;
    vfs.root = root;
    vfs.snapshots = new Map();
    vfs.nextSnapId = 1;
    vfs.totalBytes = 0;
    vfs.fsLimitBytes = undefined;
    return vfs;
  }

  /** Populate the default directory tree. */
  private initDefaultLayout(): void {
    const dirs = ['/home', '/home/user', '/tmp', '/bin', '/usr', '/usr/bin', '/mnt'];
    for (const dir of dirs) {
      this.mkdirInternal(dir);
    }
  }

  /** Internal mkdir that silently skips existing directories. Used during init. */
  private mkdirInternal(path: string): void {
    const segments = parsePath(path);
    let current: DirInode = this.root;

    for (const segment of segments) {
      const existing = current.children.get(segment);
      if (existing !== undefined) {
        if (existing.type !== 'dir') {
          throw new VfsError('ENOTDIR', `not a directory: ${path}`);
        }
        current = existing;
      } else {
        const newDir = createDirInode();
        current.children.set(segment, newDir);
        current = newDir;
      }
    }
  }

  /**
   * Walk the inode tree to resolve a path.
   * Returns the parent directory and the final segment name,
   * or the resolved inode when `resolveLeaf` is true.
   */
  private resolve(path: string, followSymlinks = true): Inode {
    const segments = parsePath(path);

    if (segments.length === 0) {
      return this.root;
    }

    let current: Inode = this.root;
    let depth = 0;

    for (let i = 0; i < segments.length; i++) {
      // Follow symlinks for intermediate path components (and leaf if requested)
      if (current.type === 'symlink') {
        if (depth >= MAX_SYMLINK_DEPTH) {
          throw new VfsError('ENOENT', `too many symlinks: ${path}`);
        }
        depth++;
        current = this.resolve(current.target);
      }

      if (current.type !== 'dir') {
        throw new VfsError('ENOTDIR', `not a directory: ${path}`);
      }

      const child = current.children.get(segments[i]);
      if (child === undefined) {
        throw new VfsError('ENOENT', `no such file or directory: ${path}`);
      }

      current = child;
    }

    // Optionally follow symlink at the leaf
    if (followSymlinks && current.type === 'symlink') {
      if (depth >= MAX_SYMLINK_DEPTH) {
        throw new VfsError('ENOENT', `too many symlinks: ${path}`);
      }
      current = this.resolve(current.target);
    }

    return current;
  }

  /**
   * Resolve the parent directory and return it along with the leaf name.
   * Throws if the parent does not exist or is not a directory.
   */
  private resolveParent(path: string): { parent: DirInode; name: string } {
    const segments = parsePath(path);

    if (segments.length === 0) {
      throw new VfsError('EEXIST', `cannot operate on root: ${path}`);
    }

    const name = segments[segments.length - 1];
    const parentSegments = segments.slice(0, -1);

    let current: Inode = this.root;

    for (const segment of parentSegments) {
      if (current.type === 'symlink') {
        current = this.resolve(current.target);
      }
      if (current.type !== 'dir') {
        throw new VfsError('ENOTDIR', `not a directory: ${path}`);
      }
      const child = current.children.get(segment);
      if (child === undefined) {
        throw new VfsError('ENOENT', `no such file or directory: ${path}`);
      }
      current = child;
    }

    if (current.type === 'symlink') {
      current = this.resolve(current.target);
    }
    if (current.type !== 'dir') {
      throw new VfsError('ENOTDIR', `not a directory: ${path}`);
    }

    return { parent: current, name };
  }

  stat(path: string): StatResult {
    const inode = this.resolve(path);
    const { metadata } = inode;

    let size: number;
    if (inode.type === 'file') {
      size = inode.content.byteLength;
    } else if (inode.type === 'dir') {
      size = inode.children.size;
    } else {
      size = inode.target.length;
    }

    return {
      type: inode.type,
      size,
      permissions: metadata.permissions,
      mtime: metadata.mtime,
      ctime: metadata.ctime,
      atime: metadata.atime,
    };
  }

  readFile(path: string): Uint8Array {
    const inode = this.resolve(path);

    if (inode.type === 'dir') {
      throw new VfsError('EISDIR', `is a directory: ${path}`);
    }
    if (inode.type === 'symlink') {
      // Should not happen after resolve with followSymlinks, but guard anyway
      return this.readFile(inode.target);
    }

    inode.metadata.atime = new Date();
    return inode.content;
  }

  writeFile(path: string, data: Uint8Array): void {
    const { parent, name } = this.resolveParent(path);
    const existing = parent.children.get(name);

    if (existing !== undefined && existing.type === 'dir') {
      throw new VfsError('EISDIR', `is a directory: ${path}`);
    }

    const oldSize = (existing !== undefined && existing.type === 'file') ? existing.content.byteLength : 0;
    const newSize = data.byteLength;
    const delta = newSize - oldSize;

    if (this.fsLimitBytes !== undefined && this.totalBytes + delta > this.fsLimitBytes) {
      throw new VfsError('ENOSPC', `no space left on device (limit: ${this.fsLimitBytes} bytes)`);
    }

    if (existing !== undefined && existing.type === 'file') {
      existing.content = data;
      existing.metadata.mtime = new Date();
    } else {
      parent.children.set(name, createFileInode(data));
    }
    this.totalBytes += delta;
  }

  mkdir(path: string): void {
    const { parent, name } = this.resolveParent(path);

    if (parent.children.has(name)) {
      throw new VfsError('EEXIST', `file exists: ${path}`);
    }

    parent.children.set(name, createDirInode());
  }

  mkdirp(path: string): void {
    const segments = parsePath(path);
    let current: DirInode = this.root;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const existing = current.children.get(segment);

      if (existing !== undefined) {
        if (existing.type !== 'dir') {
          const partial = '/' + segments.slice(0, i + 1).join('/');
          throw new VfsError('ENOTDIR', `not a directory: ${partial}`);
        }
        current = existing;
      } else {
        const newDir = createDirInode();
        current.children.set(segment, newDir);
        current = newDir;
      }
    }
  }

  readdir(path: string): DirEntry[] {
    const inode = this.resolve(path);

    if (inode.type !== 'dir') {
      throw new VfsError('ENOTDIR', `not a directory: ${path}`);
    }

    inode.metadata.atime = new Date();
    const entries: DirEntry[] = [];

    for (const [name, child] of inode.children) {
      entries.push({ name, type: child.type });
    }

    return entries;
  }

  unlink(path: string): void {
    const { parent, name } = this.resolveParent(path);
    const child = parent.children.get(name);

    if (child === undefined) {
      throw new VfsError('ENOENT', `no such file or directory: ${path}`);
    }
    if (child.type === 'dir') {
      throw new VfsError('EISDIR', `is a directory: ${path}`);
    }

    if (child.type === 'file') {
      this.totalBytes -= child.content.byteLength;
    }
    parent.children.delete(name);
  }

  rmdir(path: string): void {
    const { parent, name } = this.resolveParent(path);
    const child = parent.children.get(name);

    if (child === undefined) {
      throw new VfsError('ENOENT', `no such file or directory: ${path}`);
    }
    if (child.type !== 'dir') {
      throw new VfsError('ENOTDIR', `not a directory: ${path}`);
    }
    if (child.children.size > 0) {
      throw new VfsError('ENOTEMPTY', `directory not empty: ${path}`);
    }

    parent.children.delete(name);
  }

  rename(oldPath: string, newPath: string): void {
    const { parent: oldParent, name: oldName } = this.resolveParent(oldPath);
    const child = oldParent.children.get(oldName);

    if (child === undefined) {
      throw new VfsError('ENOENT', `no such file or directory: ${oldPath}`);
    }

    const { parent: newParent, name: newName } = this.resolveParent(newPath);

    oldParent.children.delete(oldName);
    newParent.children.set(newName, child);
  }

  symlink(target: string, path: string): void {
    const { parent, name } = this.resolveParent(path);

    if (parent.children.has(name)) {
      throw new VfsError('EEXIST', `file exists: ${path}`);
    }

    parent.children.set(name, createSymlinkInode(target));
  }

  chmod(path: string, mode: number): void {
    const inode = this.resolve(path);
    inode.metadata.permissions = mode;
    inode.metadata.ctime = new Date();
  }

  readlink(path: string): string {
    const inode = this.resolve(path, false);

    if (inode.type !== 'symlink') {
      throw new VfsError('ENOENT', `not a symlink: ${path}`);
    }

    return inode.target;
  }

  /**
   * Capture a snapshot of the current filesystem state.
   * Returns a snapshot ID that can be passed to restore().
   */
  snapshot(): string {
    const id = String(this.nextSnapId++);
    this.snapshots.set(id, deepCloneRoot(this.root));
    return id;
  }

  /**
   * Restore the filesystem to a previously captured snapshot.
   * The snapshot remains available for future restores.
   */
  restore(id: string): void {
    const saved = this.snapshots.get(id);
    if (saved === undefined) {
      throw new Error(`no such snapshot: ${id}`);
    }
    this.root = deepCloneRoot(saved);
  }

  /**
   * Create an independent copy-on-write clone of this VFS.
   *
   * The clone shares file content by reference but has its own
   * directory structure. Since writeFile replaces (rather than
   * mutates) content arrays, writes in either VFS are invisible
   * to the other — natural COW semantics.
   */
  cowClone(): VFS {
    return VFS.fromRoot(deepCloneRoot(this.root));
  }
}
