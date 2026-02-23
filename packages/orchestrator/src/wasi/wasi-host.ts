/**
 * WASI Preview 1 host implementation backed by VFS.
 *
 * Implements the ~40 wasi_snapshot_preview1 import functions that WASI
 * binaries expect. Each function reads/writes from WebAssembly linear
 * memory via DataView and delegates to the VFS and FdTable.
 */

import { FdTable } from '../vfs/fd-table.js';
import type { OpenMode, SeekWhence } from '../vfs/fd-table.js';
import { VfsError } from '../vfs/inode.js';
import type { InodeType } from '../vfs/inode.js';
import type { VFS } from '../vfs/vfs.js';
import { fdErrorToWasi, vfsErrnoToWasi } from './errors.js';
import type { NetworkBridge } from '../network/bridge.js';
import {
  WASI_EBADF,
  WASI_EINVAL,
  WASI_ENOSYS,
  WASI_ESUCCESS,
  WASI_FDFLAGS_APPEND,
  WASI_FILETYPE_CHARACTER_DEVICE,
  WASI_FILETYPE_DIRECTORY,
  WASI_FILETYPE_REGULAR_FILE,
  WASI_FILETYPE_SYMBOLIC_LINK,
  WASI_OFLAGS_CREAT,
  WASI_OFLAGS_DIRECTORY,
  WASI_OFLAGS_TRUNC,
  WASI_PREOPENTYPE_DIR,
  WASI_RIGHTS_ALL,
  WASI_WHENCE_CUR,
  WASI_WHENCE_END,
  WASI_WHENCE_SET,
} from './types.js';

/** Control fd for Python socket shim communication.
 *  Must fit in a signed 32-bit int (RustPython's os.write uses i32 for fd).
 *  Must not collide with fds allocated by FdTable (which start at 3) or
 *  directory pseudo-fds (which start at 100). */
const CONTROL_FD = 1023;

export class WasiExitError extends Error {
  code: number;

  constructor(code: number) {
    super(`WASI exit: ${code}`);
    this.name = 'WasiExitError';
    this.code = code;
  }
}

export interface WasiHostOptions {
  vfs: VFS;
  args: string[];
  env: Record<string, string>;
  preopens: Record<string, string>;
  stdin?: Uint8Array;
  networkBridge?: NetworkBridge;
}

interface PreopenEntry {
  vfsPath: string;
  label: string;
  fd: number;
}

/**
 * Decode an iovec array from Wasm linear memory.
 * Each iovec is 8 bytes: u32 buf_ptr + u32 buf_len.
 */
function readIovecs(
  view: DataView,
  ptr: number,
  count: number,
): Array<{ buf: number; len: number }> {
  const iovecs: Array<{ buf: number; len: number }> = [];
  for (let i = 0; i < count; i++) {
    iovecs.push({
      buf: view.getUint32(ptr + i * 8, true),
      len: view.getUint32(ptr + i * 8 + 4, true),
    });
  }
  return iovecs;
}

function inodeTypeToWasiFiletype(type: InodeType): number {
  switch (type) {
    case 'file':
      return WASI_FILETYPE_REGULAR_FILE;
    case 'dir':
      return WASI_FILETYPE_DIRECTORY;
    case 'symlink':
      return WASI_FILETYPE_SYMBOLIC_LINK;
    default:
      return 0;
  }
}

function wasiWhenceToVfs(whence: number): SeekWhence {
  switch (whence) {
    case WASI_WHENCE_SET:
      return 'set';
    case WASI_WHENCE_CUR:
      return 'cur';
    case WASI_WHENCE_END:
      return 'end';
    default:
      return 'set';
  }
}

export class WasiHost {
  private vfs: VFS;
  private fdTable: FdTable;
  private args: string[];
  private envPairs: string[];
  private preopens: PreopenEntry[];
  private memory: WebAssembly.Memory | null = null;
  private stdoutBuf: Uint8Array[] = [];
  private stderrBuf: Uint8Array[] = [];
  private stdinData: Uint8Array | undefined;
  private stdinOffset = 0;
  private exitCode: number | null = null;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  /** Map from fd number to the directory path it represents (for preopens + opened dirs). */
  private dirFds: Map<number, string> = new Map();

  private networkBridge: NetworkBridge | null;
  private controlConnections: Map<string, { host: string; port: number; scheme: string }> = new Map();
  private controlResponseBuf: Uint8Array | null = null;
  private nextControlConnId = 0;

  constructor(options: WasiHostOptions) {
    this.vfs = options.vfs;
    this.fdTable = new FdTable(options.vfs);
    this.args = options.args;
    this.envPairs = Object.entries(options.env).map(
      ([k, v]) => `${k}=${v}`,
    );
    this.stdinData = options.stdin;
    this.networkBridge = options.networkBridge ?? null;
    this.preopens = [];

    // Set up preopened directories starting at fd 3.
    // We must also reserve these fd numbers in the FdTable so it
    // doesn't allocate them for regular file opens. We do this by
    // opening a sentinel file for each preopen slot and immediately
    // recording the fd. The sentinel file is never read/written.
    const sentinelPath = '/.wasi-preopen-sentinel';
    this.vfs.writeFile(sentinelPath, new Uint8Array(0));

    for (const [vfsPath, label] of Object.entries(options.preopens)) {
      const fd = this.fdTable.open(sentinelPath, 'r');
      this.preopens.push({ vfsPath, label, fd });
      this.dirFds.set(fd, vfsPath);
    }

    this.vfs.unlink(sentinelPath);
  }

  setMemory(memory: WebAssembly.Memory): void {
    this.memory = memory;
  }

  getStdout(): string {
    return this.decoder.decode(concatBuffers(this.stdoutBuf));
  }

  getStderr(): string {
    return this.decoder.decode(concatBuffers(this.stderrBuf));
  }

  getExitCode(): number | null {
    return this.exitCode;
  }

  /** Handle a control fd command. Public for testing. */
  handleControlCommand(cmd: Record<string, unknown>): Record<string, unknown> {
    if (!this.networkBridge) {
      return { ok: false, error: 'networking not configured' };
    }

    switch (cmd.cmd) {
      case 'connect': {
        const host = cmd.host as string;
        const port = cmd.port as number;
        const scheme = port === 443 ? 'https' : 'http';
        const id = `c${this.nextControlConnId++}`;
        this.controlConnections.set(id, { host, port, scheme });
        return { ok: true, id };
      }
      case 'request': {
        const conn = this.controlConnections.get(cmd.id as string);
        if (!conn) return { ok: false, error: 'unknown connection id' };
        const url = `${conn.scheme}://${conn.host}:${conn.port}${cmd.path as string}`;
        const result = this.networkBridge.fetchSync(
          url, cmd.method as string, (cmd.headers as Record<string, string>) ?? {}, (cmd.body as string) || undefined,
        );
        return {
          ok: true,
          status: result.status,
          headers: result.headers,
          body: result.body,
          error: result.error,
        };
      }
      case 'close': {
        this.controlConnections.delete(cmd.id as string);
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown command: ${cmd.cmd}` };
    }
  }

  /**
   * Run a WASI instance's _start export.
   *
   * Handles the two possible outcomes:
   * - _start returns normally (exit code 0)
   * - _start calls proc_exit which throws WasiExitError
   *
   * Non-zero exit codes are returned without throwing. Other errors
   * (e.g. traps) are re-thrown to the caller.
   */
  start(instance: WebAssembly.Instance): number {
    this.setMemory(instance.exports.memory as WebAssembly.Memory);
    try {
      (instance.exports._start as Function)();
      // Normal return from _start means exit code 0
      this.exitCode = 0;
      return 0;
    } catch (e: unknown) {
      if (e instanceof WasiExitError) {
        return e.code;
      }
      throw e;
    }
  }

  /** Return the import object to pass to WebAssembly.instantiate(). */
  getImports(): { wasi_snapshot_preview1: Record<string, Function> } {
    return {
      wasi_snapshot_preview1: {
        args_get: this.argsGet.bind(this),
        args_sizes_get: this.argsSizesGet.bind(this),
        environ_get: this.environGet.bind(this),
        environ_sizes_get: this.environSizesGet.bind(this),
        fd_write: this.fdWrite.bind(this),
        fd_read: this.fdRead.bind(this),
        fd_close: this.fdClose.bind(this),
        fd_seek: this.fdSeek.bind(this),
        fd_tell: this.fdTell.bind(this),
        fd_prestat_get: this.fdPrestatGet.bind(this),
        fd_prestat_dir_name: this.fdPrestatDirName.bind(this),
        fd_fdstat_get: this.fdFdstatGet.bind(this),
        fd_filestat_get: this.fdFilestatGet.bind(this),
        fd_readdir: this.fdReaddir.bind(this),
        path_open: this.pathOpen.bind(this),
        path_filestat_get: this.pathFilestatGet.bind(this),
        path_create_directory: this.pathCreateDirectory.bind(this),
        path_remove_directory: this.pathRemoveDirectory.bind(this),
        path_unlink_file: this.pathUnlinkFile.bind(this),
        path_rename: this.pathRename.bind(this),
        clock_time_get: this.clockTimeGet.bind(this),
        random_get: this.randomGet.bind(this),
        proc_exit: this.procExit.bind(this),
        sched_yield: this.schedYield.bind(this),
        // Stubs
        fd_advise: this.stub.bind(this),
        fd_allocate: this.stub.bind(this),
        fd_datasync: this.stub.bind(this),
        fd_sync: this.stub.bind(this),
        fd_fdstat_set_flags: this.stub.bind(this),
        fd_fdstat_set_rights: this.stub.bind(this),
        fd_filestat_set_size: this.stub.bind(this),
        fd_filestat_set_times: this.stub.bind(this),
        fd_pread: this.stub.bind(this),
        fd_pwrite: this.stub.bind(this),
        fd_renumber: this.stub.bind(this),
        path_filestat_set_times: this.stub.bind(this),
        path_link: this.stub.bind(this),
        path_readlink: this.stub.bind(this),
        path_symlink: this.stub.bind(this),
        poll_oneoff: this.stub.bind(this),
        proc_raise: this.stub.bind(this),
        sock_accept: this.stub.bind(this),
        sock_recv: this.stub.bind(this),
        sock_send: this.stub.bind(this),
        sock_shutdown: this.stub.bind(this),
        clock_res_get: this.stub.bind(this),
      },
    };
  }

  // ---- Memory helpers ----

  private getView(): DataView {
    return new DataView(this.memory!.buffer);
  }

  private getBytes(): Uint8Array {
    return new Uint8Array(this.memory!.buffer);
  }

  private readString(ptr: number, len: number): string {
    return this.decoder.decode(
      new Uint8Array(this.memory!.buffer, ptr, len),
    );
  }

  // ---- Path resolution ----

  /**
   * Resolve a relative path from a directory fd to an absolute VFS path.
   * Handles both preopened dirs and opened directory fds.
   */
  private resolvePath(dirFd: number, relativePath: string): string {
    const dirPath = this.dirFds.get(dirFd);
    if (dirPath === undefined) {
      throw new Error(`EBADF: not a directory fd: ${dirFd}`);
    }

    if (dirPath === '/') {
      return '/' + relativePath;
    }
    return dirPath + '/' + relativePath;
  }

  // ---- Syscall implementations ----

  private argsSizesGet(argcPtr: number, argvBufSizePtr: number): number {
    const view = this.getView();
    view.setUint32(argcPtr, this.args.length, true);

    let bufSize = 0;
    for (const arg of this.args) {
      bufSize += this.encoder.encode(arg).byteLength + 1; // +1 for null terminator
    }
    view.setUint32(argvBufSizePtr, bufSize, true);
    return WASI_ESUCCESS;
  }

  private argsGet(argvPtr: number, argvBufPtr: number): number {
    const view = this.getView();
    const bytes = this.getBytes();
    let bufOffset = argvBufPtr;

    for (let i = 0; i < this.args.length; i++) {
      view.setUint32(argvPtr + i * 4, bufOffset, true);
      const encoded = this.encoder.encode(this.args[i]);
      bytes.set(encoded, bufOffset);
      bytes[bufOffset + encoded.byteLength] = 0; // null terminator
      bufOffset += encoded.byteLength + 1;
    }

    return WASI_ESUCCESS;
  }

  private environSizesGet(
    environCountPtr: number,
    environBufSizePtr: number,
  ): number {
    const view = this.getView();
    view.setUint32(environCountPtr, this.envPairs.length, true);

    let bufSize = 0;
    for (const pair of this.envPairs) {
      bufSize += this.encoder.encode(pair).byteLength + 1;
    }
    view.setUint32(environBufSizePtr, bufSize, true);
    return WASI_ESUCCESS;
  }

  private environGet(environPtr: number, environBufPtr: number): number {
    const view = this.getView();
    const bytes = this.getBytes();
    let bufOffset = environBufPtr;

    for (let i = 0; i < this.envPairs.length; i++) {
      view.setUint32(environPtr + i * 4, bufOffset, true);
      const encoded = this.encoder.encode(this.envPairs[i]);
      bytes.set(encoded, bufOffset);
      bytes[bufOffset + encoded.byteLength] = 0;
      bufOffset += encoded.byteLength + 1;
    }

    return WASI_ESUCCESS;
  }

  private fdWrite(
    fd: number,
    iovsPtr: number,
    iovsLen: number,
    nwrittenPtr: number,
  ): number {
    const view = this.getView();
    const bytes = this.getBytes();
    const iovecs = readIovecs(view, iovsPtr, iovsLen);

    let totalWritten = 0;

    for (const iov of iovecs) {
      const data = bytes.slice(iov.buf, iov.buf + iov.len);

      if (fd === 1) {
        this.stdoutBuf.push(data);
        totalWritten += data.byteLength;
      } else if (fd === 2) {
        this.stderrBuf.push(data);
        totalWritten += data.byteLength;
      } else if (fd === CONTROL_FD) {
        // Control fd: parse JSON command, buffer response
        const cmdStr = this.decoder.decode(data).trim();
        if (cmdStr) {
          try {
            const cmd = JSON.parse(cmdStr);
            const resp = this.handleControlCommand(cmd);
            this.controlResponseBuf = this.encoder.encode(JSON.stringify(resp));
          } catch {
            this.controlResponseBuf = this.encoder.encode(JSON.stringify({ ok: false, error: 'invalid JSON' }));
          }
        }
        totalWritten += data.byteLength;
      } else {
        try {
          totalWritten += this.fdTable.write(fd, data);
        } catch (err) {
          return fdErrorToWasi(err);
        }
      }
    }

    // Re-fetch view in case writes caused memory growth
    const viewAfter = this.getView();
    viewAfter.setUint32(nwrittenPtr, totalWritten, true);
    return WASI_ESUCCESS;
  }

  private fdRead(
    fd: number,
    iovsPtr: number,
    iovsLen: number,
    nreadPtr: number,
  ): number {
    const view = this.getView();
    const iovecs = readIovecs(view, iovsPtr, iovsLen);

    let totalRead = 0;

    for (const iov of iovecs) {
      if (fd === 0) {
        if (this.stdinData === undefined || this.stdinOffset >= this.stdinData.byteLength) {
          // No stdin data or all consumed: return EOF
          break;
        }
        const remaining = this.stdinData.byteLength - this.stdinOffset;
        const toRead = Math.min(iov.len, remaining);
        const bytes = this.getBytes();
        bytes.set(this.stdinData.subarray(this.stdinOffset, this.stdinOffset + toRead), iov.buf);
        this.stdinOffset += toRead;
        totalRead += toRead;
        if (toRead < iov.len) {
          break; // EOF reached mid-iovec
        }
        continue;
      }

      if (fd === CONTROL_FD) {
        if (!this.controlResponseBuf) break;
        const remaining = this.controlResponseBuf.byteLength;
        const toRead = Math.min(iov.len, remaining);
        const bytes = this.getBytes();
        bytes.set(this.controlResponseBuf.subarray(0, toRead), iov.buf);
        totalRead += toRead;
        if (toRead < remaining) {
          this.controlResponseBuf = this.controlResponseBuf.subarray(toRead);
        } else {
          this.controlResponseBuf = null;
        }
        break;
      }

      try {
        const buf = new Uint8Array(iov.len);
        const n = this.fdTable.read(fd, buf);
        if (n > 0) {
          const bytes = this.getBytes();
          bytes.set(buf.subarray(0, n), iov.buf);
          totalRead += n;
        }
        if (n < iov.len) {
          break; // EOF or short read
        }
      } catch (err) {
        return fdErrorToWasi(err);
      }
    }

    const viewAfter = this.getView();
    viewAfter.setUint32(nreadPtr, totalRead, true);
    return WASI_ESUCCESS;
  }

  private fdClose(fd: number): number {
    // Cannot close stdio
    if (fd <= 2) {
      return WASI_EBADF;
    }

    try {
      this.fdTable.close(fd);
      this.dirFds.delete(fd);
      return WASI_ESUCCESS;
    } catch (err) {
      return fdErrorToWasi(err);
    }
  }

  private fdSeek(
    fd: number,
    offset: bigint,
    whence: number,
    newOffsetPtr: number,
  ): number {
    try {
      const vfsWhence = wasiWhenceToVfs(whence);
      const newOffset = this.fdTable.seek(fd, Number(offset), vfsWhence);
      const view = this.getView();
      view.setBigUint64(newOffsetPtr, BigInt(newOffset), true);
      return WASI_ESUCCESS;
    } catch (err) {
      return fdErrorToWasi(err);
    }
  }

  private fdTell(fd: number, offsetPtr: number): number {
    try {
      const offset = this.fdTable.tell(fd);
      const view = this.getView();
      view.setBigUint64(offsetPtr, BigInt(offset), true);
      return WASI_ESUCCESS;
    } catch (err) {
      return fdErrorToWasi(err);
    }
  }

  private fdPrestatGet(fd: number, bufPtr: number): number {
    const preopen = this.preopens.find(p => p.fd === fd);
    if (preopen === undefined) {
      return WASI_EBADF;
    }

    const view = this.getView();
    // prestat: u8 tag (0 = dir), 3 bytes padding, u32 name_len
    view.setUint8(bufPtr, WASI_PREOPENTYPE_DIR);
    view.setUint8(bufPtr + 1, 0);
    view.setUint8(bufPtr + 2, 0);
    view.setUint8(bufPtr + 3, 0);
    const nameBytes = this.encoder.encode(preopen.vfsPath);
    view.setUint32(bufPtr + 4, nameBytes.byteLength, true);
    return WASI_ESUCCESS;
  }

  private fdPrestatDirName(
    fd: number,
    pathPtr: number,
    pathLen: number,
  ): number {
    const preopen = this.preopens.find(p => p.fd === fd);
    if (preopen === undefined) {
      return WASI_EBADF;
    }

    const bytes = this.getBytes();
    const encoded = this.encoder.encode(preopen.vfsPath);
    bytes.set(encoded.subarray(0, pathLen), pathPtr);
    return WASI_ESUCCESS;
  }

  private fdFdstatGet(fd: number, bufPtr: number): number {
    const view = this.getView();

    // fdstat layout: u8 filetype, u16 flags (at +2), u64 rights_base (+8), u64 rights_inheriting (+16)
    // Total: 24 bytes

    let filetype: number;

    // stdio fds are character devices
    if (fd <= 2) {
      filetype = WASI_FILETYPE_CHARACTER_DEVICE;
    } else if (this.dirFds.has(fd)) {
      filetype = WASI_FILETYPE_DIRECTORY;
    } else if (this.fdTable.isOpen(fd)) {
      filetype = WASI_FILETYPE_REGULAR_FILE;
    } else if (fd === CONTROL_FD) {
      filetype = WASI_FILETYPE_CHARACTER_DEVICE;
    } else {
      return WASI_EBADF;
    }

    view.setUint8(bufPtr, filetype);
    view.setUint8(bufPtr + 1, 0); // padding
    view.setUint16(bufPtr + 2, 0, true); // fdflags
    // 4 bytes padding
    view.setUint32(bufPtr + 4, 0, true);
    view.setBigUint64(bufPtr + 8, WASI_RIGHTS_ALL, true); // rights_base
    view.setBigUint64(bufPtr + 16, WASI_RIGHTS_ALL, true); // rights_inheriting
    return WASI_ESUCCESS;
  }

  private fdFilestatGet(fd: number, bufPtr: number): number {
    // For preopened / directory fds, stat the directory path
    const dirPath = this.dirFds.get(fd);
    if (dirPath !== undefined) {
      return this.writeFilestat(bufPtr, dirPath);
    }

    // For stdio fds, return a minimal character device stat
    if (fd <= 2) {
      return this.writeCharDeviceStat(bufPtr);
    }

    // For regular file fds opened via path_open
    const filePath = this.fdTable.getPath(fd);
    if (filePath !== undefined) {
      return this.writeFilestat(bufPtr, filePath);
    }

    return WASI_EBADF;
  }

  private fdReaddir(
    fd: number,
    bufPtr: number,
    bufLen: number,
    cookie: bigint,
    bufUsedPtr: number,
  ): number {
    const dirPath = this.dirFds.get(fd);
    if (dirPath === undefined) {
      return WASI_EBADF;
    }

    try {
      const entries = this.vfs.readdir(dirPath);
      const view = this.getView();
      const bytes = this.getBytes();

      let offset = 0;
      const startIndex = Number(cookie);

      for (let i = startIndex; i < entries.length; i++) {
        const entry = entries[i];
        const nameBytes = this.encoder.encode(entry.name);

        // dirent layout: u64 d_next, u64 d_ino, u32 d_namlen, u8 d_type, padding
        // Total header: 24 bytes, followed by name
        const entrySize = 24 + nameBytes.byteLength;

        if (offset + entrySize > bufLen) {
          // Per WASI spec: write as much of the entry as fits so that
          // bufUsed == bufLen, signaling that there are more entries.
          const remaining = bufLen - offset;
          if (remaining > 0) {
            // Build the full entry in a temp buffer, then copy what fits
            const tmp = new Uint8Array(entrySize);
            const tmpView = new DataView(tmp.buffer);
            tmpView.setBigUint64(0, BigInt(i + 1), true);     // d_next
            tmpView.setBigUint64(8, BigInt(i + 1), true);     // d_ino
            tmpView.setUint32(16, nameBytes.byteLength, true); // d_namlen
            tmpView.setUint8(20, inodeTypeToWasiFiletype(entry.type)); // d_type
            tmp.set(nameBytes, 24);                            // name
            bytes.set(tmp.subarray(0, remaining), bufPtr + offset);
            offset += remaining;
          }
          break;
        }

        // d_next: cookie value for next entry
        view.setBigUint64(bufPtr + offset, BigInt(i + 1), true);
        offset += 8;

        // d_ino: we don't track real inodes, use index
        view.setBigUint64(bufPtr + offset, BigInt(i + 1), true);
        offset += 8;

        // d_namlen
        view.setUint32(bufPtr + offset, nameBytes.byteLength, true);
        offset += 4;

        // d_type
        view.setUint8(bufPtr + offset, inodeTypeToWasiFiletype(entry.type));
        offset += 1;

        // 3 bytes padding to align to 8 bytes
        view.setUint8(bufPtr + offset, 0);
        view.setUint8(bufPtr + offset + 1, 0);
        view.setUint8(bufPtr + offset + 2, 0);
        offset += 3;

        // name (not null-terminated)
        bytes.set(nameBytes, bufPtr + offset);
        offset += nameBytes.byteLength;
      }

      const viewAfter = this.getView();
      viewAfter.setUint32(bufUsedPtr, offset, true);
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private pathOpen(
    dirFd: number,
    _dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    _rightsBase: bigint,
    _rightsInheriting: bigint,
    fdflags: number,
    fdPtr: number,
  ): number {
    try {
      const relativePath = this.readString(pathPtr, pathLen);
      const absPath = this.resolvePath(dirFd, relativePath);

      const wantCreate = (oflags & WASI_OFLAGS_CREAT) !== 0;
      const wantTrunc = (oflags & WASI_OFLAGS_TRUNC) !== 0;
      const wantDir = (oflags & WASI_OFLAGS_DIRECTORY) !== 0;
      const wantAppend = (fdflags & WASI_FDFLAGS_APPEND) !== 0;

      // If opening a directory, just register it and return
      if (wantDir) {
        // Verify the path is actually a directory
        const stat = this.vfs.stat(absPath);
        if (stat.type !== 'dir') {
          return WASI_EINVAL;
        }
        const fakeFd = this.allocateDirFd(absPath);
        const view = this.getView();
        view.setUint32(fdPtr, fakeFd, true);
        return WASI_ESUCCESS;
      }

      // Determine open mode
      let mode: OpenMode;
      if (wantAppend) {
        mode = 'a';
      } else if (wantCreate && wantTrunc) {
        mode = 'w';
      } else if (wantCreate) {
        // Create if not exists, but don't truncate
        mode = 'rw';
        // Ensure parent dirs exist and file is created if missing
        try {
          this.vfs.stat(absPath);
        } catch {
          this.vfs.writeFile(absPath, new Uint8Array(0));
        }
      } else {
        mode = 'r';
      }

      // For write/append modes, ensure the file exists
      if (mode === 'w' || mode === 'a') {
        try {
          this.vfs.stat(absPath);
        } catch {
          this.vfs.writeFile(absPath, new Uint8Array(0));
        }
      }

      const fd = this.fdTable.open(absPath, mode);
      const view = this.getView();
      view.setUint32(fdPtr, fd, true);
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private pathFilestatGet(
    dirFd: number,
    _flags: number,
    pathPtr: number,
    pathLen: number,
    bufPtr: number,
  ): number {
    try {
      const relativePath = this.readString(pathPtr, pathLen);
      const absPath = this.resolvePath(dirFd, relativePath);
      return this.writeFilestat(bufPtr, absPath);
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private pathCreateDirectory(
    dirFd: number,
    pathPtr: number,
    pathLen: number,
  ): number {
    try {
      const relativePath = this.readString(pathPtr, pathLen);
      const absPath = this.resolvePath(dirFd, relativePath);
      this.vfs.mkdir(absPath);
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private pathRemoveDirectory(
    dirFd: number,
    pathPtr: number,
    pathLen: number,
  ): number {
    try {
      const relativePath = this.readString(pathPtr, pathLen);
      const absPath = this.resolvePath(dirFd, relativePath);
      this.vfs.rmdir(absPath);
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private pathUnlinkFile(
    dirFd: number,
    pathPtr: number,
    pathLen: number,
  ): number {
    try {
      const relativePath = this.readString(pathPtr, pathLen);
      const absPath = this.resolvePath(dirFd, relativePath);
      this.vfs.unlink(absPath);
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private pathRename(
    oldDirFd: number,
    oldPathPtr: number,
    oldPathLen: number,
    newDirFd: number,
    newPathPtr: number,
    newPathLen: number,
  ): number {
    try {
      const oldRelative = this.readString(oldPathPtr, oldPathLen);
      const newRelative = this.readString(newPathPtr, newPathLen);
      const oldAbs = this.resolvePath(oldDirFd, oldRelative);
      const newAbs = this.resolvePath(newDirFd, newRelative);
      this.vfs.rename(oldAbs, newAbs);
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private clockTimeGet(
    clockId: number,
    _precision: bigint,
    timestampPtr: number,
  ): number {
    const view = this.getView();
    // Both realtime and monotonic return nanoseconds since epoch
    const nowMs = Date.now();
    const nowNs = BigInt(nowMs) * BigInt(1_000_000);
    view.setBigUint64(timestampPtr, nowNs, true);
    return WASI_ESUCCESS;
  }

  private randomGet(bufPtr: number, bufLen: number): number {
    const bytes = this.getBytes();
    const target = bytes.subarray(bufPtr, bufPtr + bufLen);
    crypto.getRandomValues(target);
    return WASI_ESUCCESS;
  }

  private procExit(code: number): number {
    this.exitCode = code;
    throw new WasiExitError(code);
  }

  private schedYield(): number {
    return WASI_ESUCCESS;
  }

  private stub(): number {
    return WASI_ENOSYS;
  }

  // ---- Internal helpers ----

  /** Allocate a pseudo-fd for an opened directory. */
  private allocateDirFd(absPath: string): number {
    // Open a dummy file to consume an fd number, then close it immediately.
    // We use a simple counter approach instead.
    // Find the next available fd by checking what FdTable uses.
    // Actually, let's open and immediately track. We need a real fd number
    // that doesn't collide. Use a simple approach: find max existing fd + 1.
    let maxFd = 3;
    for (const fd of this.dirFds.keys()) {
      if (fd >= maxFd) {
        maxFd = fd + 1;
      }
    }
    // Also check FdTable's range by trying to find a non-colliding fd.
    // We'll create a temporary file, open it, get the fd, then re-purpose it.
    // Simpler: just use a counter that we maintain.
    const fd = this.nextDirFd();
    this.dirFds.set(fd, absPath);
    return fd;
  }

  /** Track the next available fd for directory pseudo-fds. */
  private _nextDirFdCounter = 100; // Start high to avoid collision with FdTable

  private nextDirFd(): number {
    return this._nextDirFdCounter++;
  }

  /** Write a WASI filestat structure at bufPtr for the given VFS path. */
  private writeFilestat(bufPtr: number, absPath: string): number {
    try {
      const stat = this.vfs.stat(absPath);
      const view = this.getView();

      // filestat layout (64 bytes):
      //   u64 dev          (offset 0)
      //   u64 ino          (offset 8)
      //   u8  filetype     (offset 16) + 7 bytes padding
      //   u64 nlink        (offset 24)
      //   u64 size         (offset 32)
      //   u64 atim         (offset 40)
      //   u64 mtim         (offset 48)
      //   u64 ctim         (offset 56)

      view.setBigUint64(bufPtr, BigInt(stat.permissions), true); // dev (stores Unix permissions)
      view.setBigUint64(bufPtr + 8, BigInt(0), true); // ino
      view.setUint8(bufPtr + 16, inodeTypeToWasiFiletype(stat.type)); // filetype
      // padding bytes 17-23
      for (let i = 17; i < 24; i++) {
        view.setUint8(bufPtr + i, 0);
      }
      view.setBigUint64(bufPtr + 24, BigInt(1), true); // nlink
      view.setBigUint64(bufPtr + 32, BigInt(stat.size), true); // size
      view.setBigUint64(
        bufPtr + 40,
        BigInt(stat.atime.getTime()) * BigInt(1_000_000),
        true,
      ); // atim
      view.setBigUint64(
        bufPtr + 48,
        BigInt(stat.mtime.getTime()) * BigInt(1_000_000),
        true,
      ); // mtim
      view.setBigUint64(
        bufPtr + 56,
        BigInt(stat.ctime.getTime()) * BigInt(1_000_000),
        true,
      ); // ctim

      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  /** Write a minimal character device stat (for stdio fds). */
  private writeCharDeviceStat(bufPtr: number): number {
    const view = this.getView();
    // Zero out the entire 64-byte structure
    for (let i = 0; i < 64; i++) {
      view.setUint8(bufPtr + i, 0);
    }
    view.setUint8(bufPtr + 16, WASI_FILETYPE_CHARACTER_DEVICE);
    return WASI_ESUCCESS;
  }
}

/** Concatenate an array of Uint8Arrays into one. */
function concatBuffers(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 0) {
    return new Uint8Array(0);
  }
  if (buffers.length === 1) {
    return buffers[0];
  }

  let totalLen = 0;
  for (const buf of buffers) {
    totalLen += buf.byteLength;
  }

  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.byteLength;
  }
  return result;
}
