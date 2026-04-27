import type { FdTarget } from '../wasi/fd-target.js';
import { createAsyncPipe, type AsyncPipeReadEnd, type AsyncPipeWriteEnd } from '../vfs/pipe.js';
import type { WasiHost } from '../wasi/wasi-host.js';

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
  /**
   * Optional argv[0] override. When present, the child sees this as argv[0]
   * instead of `prog`. Required for multicall binaries (e.g. BusyBox) where
   * a symlink `grep -> busybox` must run the busybox wasm with `argv[0] =
   * "grep"` so the applet dispatcher selects grep.
   */
  argv0?: string;
}

export interface ProcessEntry {
  pid: number;
  /** Parent PID — the PID of the in-sandbox process that spawned this one.
   *  ppid == 0 means "no in-sandbox parent" (the codepod runtime itself),
   *  which is what the first process to start sees from getppid() — exactly
   *  how Linux treats init's parent. */
  ppid: number;
  promise: Promise<void> | null;
  exitCode: number;
  state: 'running' | 'exited';
  wasiHost: WasiHost | null;
  waiters: ((exitCode: number) => void)[];
  command?: string;
}

/** Synthetic ppid for processes with no in-sandbox parent (the first
 *  process to start, typically the shell, sees this from getppid).
 *  Mirrors Linux: getppid() inside init returns 0. */
export const NO_PARENT_PID = 0;

export class ProcessKernel {
  private processTable = new Map<number, ProcessEntry>();
  /** PIDs are allocated sequentially starting at 1.  The shell isn't
   *  special — it's just whichever process was first to call allocPid()
   *  (and that does happen to be the shell in every current entry path,
   *  so it gets PID 1, matching Unix convention).  When Python or another
   *  tool spawns a fresh shell as a child, that child gets the next free
   *  PID and `ppid` set to whoever called allocPid on its behalf. */
  private nextPid = 1;
  private fdTables = new Map<number, Map<number, FdTarget>>();
  private nextFds = new Map<number, number>();

  /** Allocate a new PID and pre-register a process entry for it.
   *  Pass `ppid = 0` for the first/topmost process (no in-sandbox parent),
   *  or the spawning caller's PID for any subsequent process. */
  allocPid(ppid: number = NO_PARENT_PID, command?: string): number {
    const pid = this.nextPid++;
    this.processTable.set(pid, {
      pid, ppid, promise: null, exitCode: -1, state: 'running',
      wasiHost: null, waiters: [], command,
    });
    if (!this.fdTables.has(pid)) {
      this.fdTables.set(pid, new Map());
      this.nextFds.set(pid, 3);
    }
    return pid;
  }

  /** Look up the parent PID of a process, or 0 if unknown. */
  getPpid(pid: number): number {
    return this.processTable.get(pid)?.ppid ?? 0;
  }

  /** Best-effort signal delivery.  Today: cancel the target's WASI host
   *  (which throws WasiExitError, surfacing as exit 124).  This is enough
   *  for `kill -TERM <pid>` and `kill -9 <pid>` style termination; finer
   *  signal semantics (queued signals, sigaction handlers) are tracked
   *  via the guest-compat signal layer for in-process self-signalling. */
  killProcess(pid: number, _sig: number): boolean {
    const entry = this.processTable.get(pid);
    if (!entry || entry.state === 'exited') return false;
    entry.wasiHost?.cancelExecution();
    return true;
  }

  createPipe(callerPid: number): { readFd: number; writeFd: number } {
    const fdTable = this.fdTables.get(callerPid);
    if (!fdTable) throw new Error(`No fd table for pid ${callerPid}`);
    const [readEnd, writeEnd] = createAsyncPipe();
    let nextFd = this.nextFds.get(callerPid) ?? 3;
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

  setFdTarget(pid: number, fd: number, target: FdTarget): void {
    let fdTable = this.fdTables.get(pid);
    if (!fdTable) {
      fdTable = new Map();
      this.fdTables.set(pid, fdTable);
    }
    fdTable.set(fd, target);
  }

  buildFdTableForSpawn(callerPid: number, req: SpawnRequest): Map<number, FdTarget> {
    const callerFdTable = this.fdTables.get(callerPid);
    if (!callerFdTable) throw new Error(`No fd table for caller pid ${callerPid}`);
    const newFdTable = new Map<number, FdTarget>();
    const stdinTarget = callerFdTable.get(req.stdin_fd);
    if (stdinTarget) {
      if (stdinTarget.type === 'pipe_read') stdinTarget.pipe.addRef();
      newFdTable.set(0, stdinTarget);
    }
    const stdoutTarget = callerFdTable.get(req.stdout_fd);
    if (stdoutTarget) {
      if (stdoutTarget.type === 'pipe_write') stdoutTarget.pipe.addRef();
      newFdTable.set(1, stdoutTarget);
    }
    const stderrTarget = callerFdTable.get(req.stderr_fd);
    if (stderrTarget) {
      if (stderrTarget.type === 'pipe_write') stderrTarget.pipe.addRef();
      newFdTable.set(2, stderrTarget);
    }
    return newFdTable;
  }

  /** Pre-register a process entry so waitpid can find it before async instantiation completes. */
  registerPending(pid: number, command?: string, ppid: number = NO_PARENT_PID): void {
    if (!this.processTable.has(pid)) {
      this.processTable.set(pid, {
        pid, ppid, promise: null, exitCode: -1, state: 'running', wasiHost: null, waiters: [],
        command,
      });
    } else {
      const e = this.processTable.get(pid)!;
      if (command !== undefined) e.command = command;
      e.ppid = ppid;
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

  registerProcess(pid: number, promise: Promise<void>, wasiHost: WasiHost, ppid: number = NO_PARENT_PID): void {
    this.processTable.set(pid, {
      pid, ppid, promise, exitCode: -1, state: 'running', wasiHost, waiters: [],
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

  /** Register a process as already exited (used for synchronous spawn). */
  registerExited(pid: number, exitCode: number, ppid: number = NO_PARENT_PID): void {
    const existing = this.processTable.get(pid);
    if (existing) {
      existing.state = 'exited';
      existing.exitCode = exitCode;
      existing.promise = Promise.resolve();
      for (const waiter of existing.waiters) waiter(exitCode);
      existing.waiters.length = 0;
    } else {
      this.processTable.set(pid, {
        pid, ppid, promise: Promise.resolve(), exitCode, state: 'exited', wasiHost: null, waiters: [],
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

  listProcesses(): { pid: number; ppid: number; state: string; exit_code: number; command: string }[] {
    const result: { pid: number; ppid: number; state: string; exit_code: number; command: string }[] = [];
    for (const [pid, entry] of this.processTable) {
      result.push({
        pid,
        ppid: entry.ppid,
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
    // Allocate a new fd number
    let nextFd = this.nextFds.get(pid) ?? 3;
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
      if (existing.type === 'pipe_write') existing.pipe.close();
      if (existing.type === 'pipe_read') existing.pipe.close();
    }
    // Point dst to same target as src (add ref for pipes)
    if (srcTarget.type === 'pipe_write') srcTarget.pipe.addRef();
    if (srcTarget.type === 'pipe_read') srcTarget.pipe.addRef();
    fdTable.set(dstFd, srcTarget);
  }

  closeFd(pid: number, fd: number): void {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) return;
    const target = fdTable.get(fd);
    if (!target) { fdTable.delete(fd); return; }
    // Ref-counted close — only actually closes when refcount hits 0.
    if (target.type === 'pipe_write') target.pipe.close();
    if (target.type === 'pipe_read') target.pipe.close();
    fdTable.delete(fd);
  }

  /** Close all fds in a process's fd table (ref-counted close for pipes). */
  private cleanupFds(pid: number): void {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) return;
    for (const [, target] of fdTable) {
      if (target.type === 'pipe_write') target.pipe.close();
      if (target.type === 'pipe_read') target.pipe.close();
    }
    fdTable.clear();
  }

  initProcess(pid: number): void {
    if (!this.fdTables.has(pid)) {
      this.fdTables.set(pid, new Map());
      this.nextFds.set(pid, 3);
    }
  }

  dispose(): void {
    for (const fdTable of this.fdTables.values()) {
      for (const target of fdTable.values()) {
        if (target.type === 'pipe_read') target.pipe.close();
        if (target.type === 'pipe_write') target.pipe.close();
      }
    }
    this.fdTables.clear();
    this.processTable.clear();
  }
}
