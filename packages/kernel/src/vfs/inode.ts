/** Inode types and metadata for the in-memory VFS. */

export type InodeType = 'file' | 'dir' | 'symlink';

/**
 * System-tool flag — stored in the permissions field as a high bit.
 * Marks a file as a tool stub (content = wasm path).
 * chmod strips this bit so sandbox users cannot forge tool files.
 */
export const S_TOOL = 0o100000;

export interface InodeMetadata {
  permissions: number;
  uid: number;
  gid: number;
  mtime: Date;
  ctime: Date;
  atime: Date;
}

export interface FsCredential {
  uid: number;
  gid: number;
  groups?: number[];
}

export interface FileInode {
  type: 'file';
  metadata: InodeMetadata;
  content: Uint8Array;
}

export interface DirInode {
  type: 'dir';
  metadata: InodeMetadata;
  children: Map<string, Inode>;
}

export interface SymlinkInode {
  type: 'symlink';
  metadata: InodeMetadata;
  target: string;
}

export type Inode = FileInode | DirInode | SymlinkInode;

export type Errno = 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY' | 'ENOSPC' | 'EROFS' | 'EACCES';

export class VfsError extends Error {
  errno: Errno;

  constructor(errno: Errno, message: string) {
    super(`${errno}: ${message}`);
    this.name = 'VfsError';
    this.errno = errno;
  }
}

export interface StatResult {
  type: InodeType;
  size: number;
  permissions: number;
  uid: number;
  gid: number;
  mtime: Date;
  ctime: Date;
  atime: Date;
}

export interface DirEntry {
  name: string;
  type: InodeType;
}

function createMetadata(permissions: number, uid = 0, gid = 0): InodeMetadata {
  const now = new Date();
  return { permissions, uid, gid, mtime: now, ctime: now, atime: now };
}

export function createDirInode(permissions = 0o755, uid = 0, gid = 0): DirInode {
  return {
    type: 'dir',
    metadata: createMetadata(permissions, uid, gid),
    children: new Map(),
  };
}

export function createFileInode(content: Uint8Array, permissions = 0o644, uid = 0, gid = 0): FileInode {
  return {
    type: 'file',
    metadata: createMetadata(permissions, uid, gid),
    content,
  };
}

export function createSymlinkInode(target: string, uid = 0, gid = 0): SymlinkInode {
  return {
    type: 'symlink',
    metadata: createMetadata(0o777, uid, gid),
    target,
  };
}
