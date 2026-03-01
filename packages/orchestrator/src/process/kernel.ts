import type { FdTarget } from '../wasi/fd-target.js';
import { createAsyncPipe, type AsyncPipeReadEnd, type AsyncPipeWriteEnd } from '../vfs/pipe.js';
import type { WasiHost } from '../wasi/wasi-host.js';

export interface SpawnRequest {
  prog: string;
  args: string[];
  env: [string, string][];
  cwd: string;
  stdinFd: number;
  stdoutFd: number;
  stderrFd: number;
}

export interface ProcessEntry {
  pid: number;
  promise: Promise<void> | null;
  exitCode: number;
  state: 'running' | 'exited';
  wasiHost: WasiHost | null;
  waiters: ((exitCode: number) => void)[];
}

export class ProcessKernel {
  private processTable = new Map<number, ProcessEntry>();
  private nextPid = 1;
  private fdTables = new Map<number, Map<number, FdTarget>>();
  private nextFds = new Map<number, number>();

  constructor() {
    // Process 0 (shell) gets a default fd table
    this.fdTables.set(0, new Map());
    this.nextFds.set(0, 3);
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
    const stdinTarget = callerFdTable.get(req.stdinFd);
    if (stdinTarget) newFdTable.set(0, stdinTarget);
    const stdoutTarget = callerFdTable.get(req.stdoutFd);
    if (stdoutTarget) newFdTable.set(1, stdoutTarget);
    const stderrTarget = callerFdTable.get(req.stderrFd);
    if (stderrTarget) newFdTable.set(2, stderrTarget);
    return newFdTable;
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

  allocPid(): number { return this.nextPid++; }

  async waitpid(pid: number): Promise<number> {
    const entry = this.processTable.get(pid);
    if (!entry) return -1;
    if (entry.state === 'exited') return entry.exitCode;
    return new Promise<number>((resolve) => { entry.waiters.push(resolve); });
  }

  closeFd(pid: number, fd: number): void {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) return;
    const target = fdTable.get(fd);
    if (!target) return;
    if (target.type === 'pipe_read') target.pipe.close();
    else if (target.type === 'pipe_write') target.pipe.close();
    fdTable.delete(fd);
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
