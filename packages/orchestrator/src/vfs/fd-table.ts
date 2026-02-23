/**
 * File descriptor table for WASI syscall support.
 *
 * WASI syscalls (fd_read, fd_write, fd_seek, etc.) operate on integer
 * file descriptors rather than paths. This module maps fd numbers to
 * open file state (path, content buffer, offset, mode) and mediates
 * all I/O through the underlying VFS.
 *
 * Fds 0, 1, 2 are reserved for stdin, stdout, stderr and are not
 * allocated by open().
 */

import type { VFS } from './vfs.js';

export type OpenMode = 'r' | 'w' | 'a' | 'rw';
export type SeekWhence = 'set' | 'cur' | 'end';

interface FdEntry {
  path: string;
  mode: OpenMode;
  buffer: Uint8Array;
  offset: number;
  dirty: boolean;
}

const FIRST_FD = 3; // 0 = stdin, 1 = stdout, 2 = stderr

/**
 * File descriptor table that maps integer fds to open file state.
 *
 * Reads snapshot file content at open time and serve reads from
 * that buffer. Writes are buffered in memory and flushed to the
 * VFS when the fd is closed.
 */
export class FdTable {
  private vfs: VFS;
  private entries: Map<number, FdEntry> = new Map();
  private nextFd: number = FIRST_FD;

  constructor(vfs: VFS) {
    this.vfs = vfs;
  }

  /** Open a file and return its fd number. */
  open(path: string, mode: OpenMode): number {
    let buffer: Uint8Array;

    if (mode === 'r' || mode === 'rw') {
      buffer = new Uint8Array(this.vfs.readFile(path));
    } else if (mode === 'a') {
      // Append: load existing content so writes go after it
      try {
        const existing = this.vfs.readFile(path);
        buffer = new Uint8Array(existing);
      } catch {
        buffer = new Uint8Array(0);
      }
    } else {
      // Write mode: truncate (start with empty buffer)
      buffer = new Uint8Array(0);
    }

    const offset = mode === 'a' ? buffer.byteLength : 0;

    let fd = this.nextFd++;
    // Skip fd 1023 — reserved as CONTROL_FD for the Python socket shim
    if (fd === 1023) fd = this.nextFd++;
    this.entries.set(fd, {
      path,
      mode,
      buffer,
      offset,
      dirty: mode === 'w' || mode === 'a',
    });

    return fd;
  }

  /** Read from an open fd into buf. Returns the number of bytes read. */
  read(fd: number, buf: Uint8Array): number {
    const entry = this.getEntry(fd);
    const available = entry.buffer.byteLength - entry.offset;

    if (available <= 0) {
      return 0;
    }

    const toRead = Math.min(buf.byteLength, available);
    buf.set(entry.buffer.subarray(entry.offset, entry.offset + toRead));
    entry.offset += toRead;
    return toRead;
  }

  /** Write data to an open fd. Returns the number of bytes written. */
  write(fd: number, data: Uint8Array): number {
    const entry = this.getEntry(fd);
    const newLength = Math.max(entry.buffer.byteLength, entry.offset + data.byteLength);

    if (newLength > entry.buffer.byteLength) {
      const grown = new Uint8Array(newLength);
      grown.set(entry.buffer);
      entry.buffer = grown;
    }

    entry.buffer.set(data, entry.offset);
    entry.offset += data.byteLength;
    entry.dirty = true;
    return data.byteLength;
  }

  /** Seek to a position in the file. Returns the new offset. */
  seek(fd: number, offset: number, whence: SeekWhence): number {
    const entry = this.getEntry(fd);

    if (whence === 'set') {
      entry.offset = offset;
    } else if (whence === 'cur') {
      entry.offset += offset;
    } else {
      entry.offset = entry.buffer.byteLength + offset;
    }

    entry.offset = Math.max(0, entry.offset);
    return entry.offset;
  }

  /** Return the current offset for an fd. */
  tell(fd: number): number {
    return this.getEntry(fd).offset;
  }

  /** Close an fd, flushing buffered writes to the VFS. */
  close(fd: number): void {
    const entry = this.getEntry(fd);

    if (entry.dirty) {
      this.vfs.writeFile(entry.path, entry.buffer);
    }

    this.entries.delete(fd);
  }

  /** Duplicate an fd, returning a new fd with independent offset. */
  dup(fd: number): number {
    const entry = this.getEntry(fd);
    const newFd = this.nextFd++;

    this.entries.set(newFd, {
      path: entry.path,
      mode: entry.mode,
      buffer: entry.buffer,
      offset: 0,
      dirty: entry.dirty,
    });

    return newFd;
  }

  /** Check whether an fd is currently open. */
  isOpen(fd: number): boolean {
    return this.entries.has(fd);
  }

  /** Return the VFS path for an open fd, or undefined if not open. */
  getPath(fd: number): string | undefined {
    return this.entries.get(fd)?.path;
  }

  /** Clone the entire fd table (for fork simulation). Returns a new independent table. */
  clone(): FdTable {
    const cloned = new FdTable(this.vfs);
    cloned.nextFd = this.nextFd;

    for (const [fd, entry] of this.entries) {
      cloned.entries.set(fd, {
        path: entry.path,
        mode: entry.mode,
        buffer: new Uint8Array(entry.buffer),
        offset: entry.offset,
        dirty: entry.dirty,
      });
    }

    return cloned;
  }

  /** Look up an fd entry, throwing if the fd is not open. */
  private getEntry(fd: number): FdEntry {
    const entry = this.entries.get(fd);
    if (entry === undefined) {
      throw new Error(`EBADF: bad file descriptor ${fd}`);
    }
    return entry;
  }
}
