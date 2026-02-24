/**
 * WorkerExecutor — main-thread Worker lifecycle manager.
 *
 * Creates Worker threads for command execution, serves VFS proxy
 * requests over SharedArrayBuffer, and handles timeout/kill.
 */

import type { Worker } from 'node:worker_threads';
import type { VFS } from '../vfs/vfs.js';
import type { RunResult } from '../shell/shell-runner.js';
import {
  SAB_SIZE,
  STATUS_RESPONSE,
  STATUS_ERROR,
  decodeRequest,
  encodeResponse,
} from './proxy-protocol.js';
import { VfsError } from '../vfs/inode.js';

export interface WorkerConfig {
  vfs: VFS;
  wasmDir: string;
  shellWasmPath: string;
  toolRegistry: [string, string][];
  networkEnabled?: boolean;
  stdoutLimit?: number;
  stderrLimit?: number;
}

export interface WorkerRunResult extends RunResult {
  /** Environment updates from the worker, for syncing back to ShellRunner. */
  env?: [string, string][];
}

export class WorkerExecutor {
  private worker: Worker | null = null;
  private sab: SharedArrayBuffer;
  private int32: Int32Array;
  private config: WorkerConfig;
  private pendingResolve: ((r: WorkerRunResult) => void) | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.sab = new SharedArrayBuffer(SAB_SIZE);
    this.int32 = new Int32Array(this.sab);
  }

  async run(command: string, env: Map<string, string>, timeoutMs: number): Promise<WorkerRunResult> {
    if (!this.worker) {
      await this.createWorker();
    }

    this.running = true;

    return new Promise<WorkerRunResult>((resolve) => {
      this.pendingResolve = resolve;

      this.timeoutTimer = setTimeout(() => {
        this.terminateWorker({
          exitCode: 124,
          stdout: '',
          stderr: 'command timeout\n',
          executionTimeMs: timeoutMs,
          errorClass: 'TIMEOUT',
        });
      }, timeoutMs);

      this.worker!.postMessage({
        type: 'run',
        command,
        env: Array.from(env.entries()),
        timeoutMs,
        stdoutLimit: this.config.stdoutLimit,
        stderrLimit: this.config.stderrLimit,
      });
    });
  }

  kill(): void {
    this.terminateWorker({
      exitCode: 125,
      stdout: '',
      stderr: 'command cancelled\n',
      executionTimeMs: 0,
      errorClass: 'CANCELLED',
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  dispose(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.running = false;
  }

  private async createWorker(): Promise<void> {
    const { Worker } = await import('node:worker_threads');

    // In bun, TypeScript files can be loaded directly as Workers.
    const workerPath = new URL('./execution-worker.ts', import.meta.url).pathname;
    this.worker = new Worker(workerPath);

    // Handle messages from Worker
    this.worker.on('message', (msg: any) => {
      if (msg === 'proxy-request') {
        this.handleProxyRequest();
        return;
      }
      if (msg?.type === 'result') {
        this.running = false;
        if (this.timeoutTimer) {
          clearTimeout(this.timeoutTimer);
          this.timeoutTimer = null;
        }
        if (this.pendingResolve) {
          const resolve = this.pendingResolve;
          this.pendingResolve = null;
          const result: WorkerRunResult = msg.result as RunResult;
          if (msg.env) {
            result.env = msg.env;
          }
          resolve(result);
        }
      }
    });

    this.worker.on('error', (err) => {
      this.terminateWorker({
        exitCode: 1,
        stdout: '',
        stderr: `Worker error: ${err.message}\n`,
        executionTimeMs: 0,
      });
    });

    // Send init message and wait for ready
    const readyPromise = new Promise<void>((resolve) => {
      const onMsg = (msg: any) => {
        if (msg?.type === 'ready') {
          this.worker!.off('message', onMsg);
          resolve();
        }
      };
      this.worker!.on('message', onMsg);
    });

    this.worker.postMessage({
      type: 'init',
      sab: this.sab,
      wasmDir: this.config.wasmDir,
      shellWasmPath: this.config.shellWasmPath,
      toolRegistry: this.config.toolRegistry,
      networkEnabled: this.config.networkEnabled ?? false,
    });

    await readyPromise;
  }

  private handleProxyRequest(): void {
    const { metadata, binary } = decodeRequest(this.sab);
    const op = metadata.op as string;
    const vfs = this.config.vfs;

    // Wrap all VFS operations in withWriteAccess so the Worker can write
    // to system paths (e.g. /.wasi-preopen-sentinel, /bin) that are
    // outside the default writable-path list.
    try {
      vfs.withWriteAccess(() => {
        switch (op) {
          case 'readFile': {
            const content = vfs.readFile(metadata.path as string);
            encodeResponse(this.sab, {}, content);
            Atomics.store(this.int32, 0, STATUS_RESPONSE);
            break;
          }
          case 'writeFile': {
            vfs.writeFile(metadata.path as string, binary ?? new Uint8Array(0));
            encodeResponse(this.sab, { ok: true });
            Atomics.store(this.int32, 0, STATUS_RESPONSE);
            break;
          }
          case 'stat': {
            const st = vfs.stat(metadata.path as string);
            encodeResponse(this.sab, {
              type: st.type,
              size: st.size,
              permissions: st.permissions,
              mtime: st.mtime.toISOString(),
              ctime: st.ctime.toISOString(),
              atime: st.atime.toISOString(),
            });
            Atomics.store(this.int32, 0, STATUS_RESPONSE);
            break;
          }
          case 'readdir': {
            const entries = vfs.readdir(metadata.path as string);
            encodeResponse(this.sab, { entries });
            Atomics.store(this.int32, 0, STATUS_RESPONSE);
            break;
          }
          case 'mkdir': {
            vfs.mkdir(metadata.path as string);
            encodeResponse(this.sab, { ok: true });
            Atomics.store(this.int32, 0, STATUS_RESPONSE);
            break;
          }
          case 'mkdirp': {
            vfs.mkdirp(metadata.path as string);
            encodeResponse(this.sab, { ok: true });
            Atomics.store(this.int32, 0, STATUS_RESPONSE);
            break;
          }
          case 'unlink': {
            vfs.unlink(metadata.path as string);
            encodeResponse(this.sab, { ok: true });
            Atomics.store(this.int32, 0, STATUS_RESPONSE);
            break;
          }
          case 'rmdir': {
            vfs.rmdir(metadata.path as string);
            encodeResponse(this.sab, { ok: true });
            Atomics.store(this.int32, 0, STATUS_RESPONSE);
            break;
          }
          case 'rename': {
            vfs.rename(metadata.oldPath as string, metadata.newPath as string);
            encodeResponse(this.sab, { ok: true });
            Atomics.store(this.int32, 0, STATUS_RESPONSE);
            break;
          }
          case 'chmod': {
            vfs.chmod(metadata.path as string, metadata.mode as number);
            encodeResponse(this.sab, { ok: true });
            Atomics.store(this.int32, 0, STATUS_RESPONSE);
            break;
          }
          case 'symlink': {
            vfs.symlink(metadata.target as string, metadata.path as string);
            encodeResponse(this.sab, { ok: true });
            Atomics.store(this.int32, 0, STATUS_RESPONSE);
            break;
          }
          default: {
            encodeResponse(this.sab, {
              error: true,
              code: 'ENOSYS',
              message: `Unknown op: ${op}`,
            });
            Atomics.store(this.int32, 0, STATUS_ERROR);
            break;
          }
        }
      });
    } catch (err) {
      if (err instanceof VfsError) {
        encodeResponse(this.sab, {
          error: true,
          code: err.errno,
          message: err.message,
        });
      } else {
        encodeResponse(this.sab, {
          error: true,
          code: 'EIO',
          message: (err as Error).message,
        });
      }
      Atomics.store(this.int32, 0, STATUS_ERROR);
    }

    Atomics.notify(this.int32, 0);
  }

  private terminateWorker(result: RunResult): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.running = false;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(result);
    }
  }
}
