/**
 * Common interface for VFS and VfsProxy.
 *
 * Used by WasiHost, ProcessManager, and ShellInstance so they can
 * accept either the real VFS (main thread) or VfsProxy (Worker thread).
 */
import type { DirEntry, StatResult } from './inode.js';

export interface VfsLike {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  stat(path: string): StatResult;
  lstat(path: string): StatResult;
  readdir(path: string): DirEntry[];
  mkdir(path: string): void;
  mkdirp(path: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  rename(oldPath: string, newPath: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  chmod(path: string, mode: number): void;
  withWriteAccess(fn: () => void): void;
}
