import type { FdTarget } from '../wasi/fd-target.js';
import { createAsyncPipe, type AsyncPipeReadEnd, type AsyncPipeWriteEnd } from '../vfs/pipe.js';
import type { WasiHost } from '../wasi/wasi-host.js';

// Keep kernel-managed descriptors out of the WASI fd table's low range.
// WASI preopens and file opens usually start at 3; pipes/sockets here are
// private codepod fds that guest libc reaches through host_* imports.
export const KERNEL_FD_BASE = 1024;
export const NO_PARENT_PID = 0;

export interface SpawnRequest {
  prog: string;
  args: string[];
  env: [string, string][];
  cwd: string;
  // snake_case to match JSON from Rust's serde_json
  stdin_fd: number;
  stdout_fd: number;
  stderr_fd: number;
  stdin_data?: string;
}

export interface ProcessEntry {
  pid: number;
  promise: Promise<void> | null;
  exitCode: number;
  state: 'running' | 'exited';
  wasiHost: WasiHost | null;
  waiters: ((exitCode: number) => void)[];
  command?: string;
}

interface FileLockState {
  exclusive?: string;
  shared: Set<string>;
}

export class ProcessKernel {
  private processTable = new Map<number, ProcessEntry>();
  private nextPid = 1;
  private fdTables = new Map<number, Map<number, FdTarget>>();
  private nextFds = new Map<number, number>();
  private fileLocks = new Map<string, FileLockState>();

  constructor() {
    // Process 0 (shell) gets a default fd table
    this.fdTables.set(0, new Map());
    this.nextFds.set(0, KERNEL_FD_BASE);
  }

  createPipe(callerPid: number): { readFd: number; writeFd: number } {
    const fdTable = this.fdTables.get(callerPid);
    if (!fdTable) throw new Error(`No fd table for pid ${callerPid}`);
    const [readEnd, writeEnd] = createAsyncPipe();
    let nextFd = this.nextFds.get(callerPid) ?? KERNEL_FD_BASE;
    const readFd = nextFd++;
    const writeFd = nextFd++;
    this.nextFds.set(callerPid, nextFd);
    fdTable.set(readFd, { type: 'pipe_read', pipe: readEnd });
    fdTable.set(writeFd, { type: 'pipe_write', pipe: writeEnd });
    return { readFd, writeFd };
  }

  getFdTarget(pid: number, fd: number): FdTarget | null {
    return this.fdTables.get(pid)?.get(fd) ?? null;
  }

  getFdTable(pid: number): Map<number, FdTarget> {
    let fdTable = this.fdTables.get(pid);
    if (!fdTable) {
      fdTable = new Map();
      this.fdTables.set(pid, fdTable);
    }
    return fdTable;
  }

  setFdTarget(pid: number, fd: number, target: FdTarget): void {
    const fdTable = this.getFdTable(pid);
    fdTable.set(fd, target);
  }

  allocFd(pid: number, target: FdTarget): number {
    let fdTable = this.fdTables.get(pid);
    if (!fdTable) {
      fdTable = new Map();
      this.fdTables.set(pid, fdTable);
    }
    let nextFd = this.nextFds.get(pid) ?? KERNEL_FD_BASE;
    while (fdTable.has(nextFd)) nextFd++;
    fdTable.set(nextFd, target);
    this.nextFds.set(pid, nextFd + 1);
    return nextFd;
  }

  buildFdTableForSpawn(callerPid: number, req: SpawnRequest): Map<number, FdTarget> {
    const callerFdTable = this.fdTables.get(callerPid);
    if (!callerFdTable) throw new Error(`No fd table for caller pid ${callerPid}`);
    const newFdTable = new Map<number, FdTarget>();
    const stdinTarget = callerFdTable.get(req.stdin_fd);
    if (stdinTarget) {
      if (stdinTarget.type === 'pipe_read') stdinTarget.pipe.addRef();
      if (stdinTarget.type === 'vfs_file') stdinTarget.refs++;
      newFdTable.set(0, stdinTarget);
    }
    const stdoutTarget = callerFdTable.get(req.stdout_fd);
    if (stdoutTarget) {
      if (stdoutTarget.type === 'pipe_write') stdoutTarget.pipe.addRef();
      if (stdoutTarget.type === 'vfs_file') stdoutTarget.refs++;
      newFdTable.set(1, stdoutTarget);
    }
    const stderrTarget = callerFdTable.get(req.stderr_fd);
    if (stderrTarget) {
      if (stderrTarget.type === 'pipe_write') stderrTarget.pipe.addRef();
      if (stderrTarget.type === 'vfs_file') stderrTarget.refs++;
      newFdTable.set(2, stderrTarget);
    }
    return newFdTable;
  }

  /** Pre-register a process entry so waitpid can find it before async instantiation completes. */
  registerPending(pid: number, command?: string): void {
    if (!this.processTable.has(pid)) {
      this.processTable.set(pid, {
        pid, promise: null, exitCode: -1, state: 'running', wasiHost: null, waiters: [],
        command,
      });
    }
  }

  /** Attach a running promise and WasiHost to a previously registered pending process. */
  attachProcess(pid: number, promise: Promise<void>, wasiHost: WasiHost | null): void {
    const entry = this.processTable.get(pid);
    if (!entry) return;
    entry.promise = promise;
    entry.wasiHost = wasiHost;
    const onExit = () => {
      entry.state = 'exited';
      entry.exitCode = wasiHost?.getExitCode() ?? 0;
      // Close the child's fds (decrements pipe refcounts, signals EOF).
      this.cleanupFds(pid);
      for (const waiter of entry.waiters) waiter(entry.exitCode);
      entry.waiters.length = 0;
    };
    promise.then(onExit, onExit);
  }

  registerProcess(pid: number, promise: Promise<void>, wasiHost: WasiHost): void {
    this.processTable.set(pid, {
      pid, promise, exitCode: -1, state: 'running', wasiHost, waiters: [],
    });
    const onExit = () => {
      const entry = this.processTable.get(pid);
      if (entry) {
        entry.state = 'exited';
        entry.exitCode = wasiHost.getExitCode() ?? 0;
        for (const waiter of entry.waiters) waiter(entry.exitCode);
        entry.waiters.length = 0;
      }
    };
    promise.then(onExit, onExit);
  }

  allocPid(_ppid: number = NO_PARENT_PID, _command?: string): number { return this.nextPid++; }

  releaseProcess(pid: number, exitCode: number): void {
    this.registerExited(pid, exitCode);
    this.cleanupFds(pid);
  }

  /** Register a process as already exited (used for synchronous spawn). */
  registerExited(pid: number, exitCode: number): void {
    const existing = this.processTable.get(pid);
    if (existing) {
      existing.state = 'exited';
      existing.exitCode = exitCode;
      existing.promise = Promise.resolve();
      for (const waiter of existing.waiters) waiter(exitCode);
      existing.waiters.length = 0;
    } else {
      this.processTable.set(pid, {
        pid, promise: Promise.resolve(), exitCode, state: 'exited', wasiHost: null, waiters: [],
      });
    }
  }

  async waitpid(pid: number): Promise<number> {
    const entry = this.processTable.get(pid);
    if (!entry) return -1;
    if (entry.state === 'exited') return entry.exitCode;
    return new Promise<number>((resolve) => { entry.waiters.push(resolve); });
  }

  waitpidNohang(pid: number): number {
    const entry = this.processTable.get(pid);
    if (!entry) return -1;
    if (entry.state === 'exited') return entry.exitCode;
    return -1;
  }

  hasProcess(pid: number): boolean {
    return this.processTable.has(pid);
  }

  listProcesses(): { pid: number; state: string; exit_code: number; command: string }[] {
    const result: { pid: number; state: string; exit_code: number; command: string }[] = [];
    for (const [pid, entry] of this.processTable) {
      result.push({
        pid,
        state: entry.state,
        exit_code: entry.exitCode,
        command: entry.command ?? '',
      });
    }
    return result;
  }

  dup(pid: number, fd: number): number {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) throw new Error(`No fd table for pid ${pid}`);
    const srcTarget = fdTable.get(fd);
    if (!srcTarget) throw new Error(`dup: fd ${fd} not found`);
    // Add ref for pipes
    if (srcTarget.type === 'pipe_write') srcTarget.pipe.addRef();
    if (srcTarget.type === 'pipe_read') srcTarget.pipe.addRef();
    if (srcTarget.type === 'vfs_file') srcTarget.refs++;
    if (srcTarget.type === 'socket') srcTarget.refs++;
    // Allocate a new fd number
    let nextFd = this.nextFds.get(pid) ?? KERNEL_FD_BASE;
    const newFd = nextFd++;
    this.nextFds.set(pid, nextFd);
    fdTable.set(newFd, srcTarget);
    return newFd;
  }

  dup2(pid: number, srcFd: number, dstFd: number): void {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) throw new Error(`No fd table for pid ${pid}`);
    const srcTarget = fdTable.get(srcFd);
    if (!srcTarget) throw new Error(`dup2: src fd ${srcFd} not found`);
    // If dst already exists, close it first (decrement pipe refcount)
    const existing = fdTable.get(dstFd);
    if (existing) {
      this.closeTarget(existing);
    }
    // Point dst to same target as src (add ref for pipes)
    if (srcTarget.type === 'pipe_write') srcTarget.pipe.addRef();
    if (srcTarget.type === 'pipe_read') srcTarget.pipe.addRef();
    if (srcTarget.type === 'vfs_file') srcTarget.refs++;
    if (srcTarget.type === 'socket') srcTarget.refs++;
    fdTable.set(dstFd, srcTarget);
  }

  closeFd(pid: number, fd: number): boolean {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) return false;
    const target = fdTable.get(fd);
    if (!target) { fdTable.delete(fd); return false; }
    this.unlockFile(pid, fd);
    this.closeTarget(target);
    fdTable.delete(fd);
    return true;
  }

  lockFile(pid: number, fd: number, exclusive: boolean): number {
    const path = this.vfsPathForFd(pid, fd);
    if (!path) return 9; // EBADF
    const owner = `${pid}:${fd}`;
    const state = this.fileLocks.get(path) ?? { shared: new Set<string>() };

    if (exclusive) {
      const onlyOwnShared = state.shared.size === 0 || (state.shared.size === 1 && state.shared.has(owner));
      if ((state.exclusive && state.exclusive !== owner) || !onlyOwnShared) return 11; // EWOULDBLOCK
      state.exclusive = owner;
      state.shared.delete(owner);
    } else {
      if (state.exclusive && state.exclusive !== owner) return 11; // EWOULDBLOCK
      state.shared.add(owner);
    }

    this.fileLocks.set(path, state);
    return 0;
  }

  unlockFile(pid: number, fd: number): number {
    const path = this.vfsPathForFd(pid, fd);
    if (!path) return 9; // EBADF
    const owner = `${pid}:${fd}`;
    const state = this.fileLocks.get(path);
    if (!state) return 0;
    if (state.exclusive === owner) delete state.exclusive;
    state.shared.delete(owner);
    if (!state.exclusive && state.shared.size === 0) this.fileLocks.delete(path);
    return 0;
  }

  /** Close all fds in a process's fd table (ref-counted close for pipes). */
  private cleanupFds(pid: number): void {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) return;
    for (const [fd, target] of fdTable) {
      this.unlockFile(pid, fd);
      this.closeTarget(target);
    }
    fdTable.clear();
  }

  private vfsPathForFd(pid: number, fd: number): string | null {
    const target = this.fdTables.get(pid)?.get(fd);
    if (!target || target.type !== 'vfs_file') return null;
    return target.fdTable.getPath(target.fd) ?? null;
  }

  private closeTarget(target: FdTarget): void {
    if (target.type === 'pipe_write') target.pipe.close();
    if (target.type === 'pipe_read') target.pipe.close();
    if (target.type === 'vfs_file') {
      target.refs--;
      if (target.refs <= 0) {
        target.fdTable.close(target.fd);
      }
    }
    if (target.type === 'socket') {
      target.refs--;
      if (target.refs <= 0 && target.socket !== null) {
        target.close(target.socket);
        target.socket = null;
      }
    }
  }

  initProcess(pid: number): void {
    if (!this.fdTables.has(pid)) {
      this.fdTables.set(pid, new Map());
      this.nextFds.set(pid, KERNEL_FD_BASE);
    }
  }

  adoptFdTable(pid: number, fdTable: Map<number, FdTarget>): void {
    this.fdTables.set(pid, fdTable);
    let nextFd = KERNEL_FD_BASE;
    for (const fd of fdTable.keys()) {
      if (fd >= nextFd) nextFd = fd + 1;
    }
    this.nextFds.set(pid, nextFd);
  }

  dispose(): void {
    for (const fdTable of this.fdTables.values()) {
      for (const target of fdTable.values()) {
        this.closeTarget(target);
      }
    }
    this.fdTables.clear();
    this.processTable.clear();
    this.fileLocks.clear();
  }
}
