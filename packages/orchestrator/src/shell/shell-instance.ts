/**
 * ShellInstance: instantiates and drives the Rust shell-exec WASM module.
 *
 * Unlike ShellRunner (which parses via WASM but executes in TypeScript),
 * ShellInstance delegates both parsing AND execution to the Rust WASM binary.
 * The host provides filesystem, process spawning, and other services via
 * the `codepod` import namespace.
 *
 * Commands are sent to the WASM module via the __run_command export, and
 * results are returned as JSON.
 */

import type { VfsLike } from '../vfs/vfs-like.js';
import type { ProcessManager } from '../process/manager.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { RunResult } from './shell-types.js';
import { createShellImports } from '../host-imports/shell-imports.js';

export interface ShellInstanceOptions {
  /** Synchronous spawn handler for testing. Real SAB-based bridging comes later. */
  syncSpawn?: (
    cmd: string,
    args: string[],
    env: Record<string, string>,
    stdin: Uint8Array,
    cwd: string,
  ) => { exit_code: number; stdout: string; stderr: string };
}

export class ShellInstance {
  private instance: WebAssembly.Instance;
  private memory: WebAssembly.Memory;

  private constructor(instance: WebAssembly.Instance) {
    this.instance = instance;
    this.memory = instance.exports.memory as WebAssembly.Memory;
  }

  static async create(
    vfs: VfsLike,
    mgr: ProcessManager,
    adapter: PlatformAdapter,
    wasmPath: string,
    options?: ShellInstanceOptions,
  ): Promise<ShellInstance> {
    const module = await adapter.loadModule(wasmPath);

    // We need the memory before creating imports, but memory comes from
    // the WASM instance exports (after instantiation). Use a mutable ref
    // that gets set post-instantiation.
    let memoryRef: WebAssembly.Memory | null = null;
    const getMemory = (): WebAssembly.Memory => {
      if (!memoryRef) throw new Error('memory not initialized');
      return memoryRef;
    };

    // Proxy so import functions can access memory before it's assigned
    const memoryProxy = new Proxy({} as WebAssembly.Memory, {
      get(_target, prop, receiver) {
        const mem = getMemory();
        const val = (mem as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof val === 'function') {
          return val.bind(mem);
        }
        return val;
      },
    });

    const shellImports = createShellImports({
      vfs,
      mgr,
      memory: memoryProxy,
      syncSpawn: options?.syncSpawn,
    });

    // WASI P1 stubs (minimal -- shell-exec doesn't use WASI for I/O)
    const wasiImports: Record<string, WebAssembly.ImportValue> = {
      args_get: () => 0,
      args_sizes_get: (argcPtr: number, argvBufSizePtr: number) => {
        const view = new DataView(getMemory().buffer);
        view.setUint32(argcPtr, 0, true);
        view.setUint32(argvBufSizePtr, 0, true);
        return 0;
      },
      environ_get: () => 0,
      environ_sizes_get: (countPtr: number, sizePtr: number) => {
        const view = new DataView(getMemory().buffer);
        view.setUint32(countPtr, 0, true);
        view.setUint32(sizePtr, 0, true);
        return 0;
      },
      fd_write: (_fd: number, _iovPtr: number, _iovLen: number, nwrittenPtr: number) => {
        const view = new DataView(getMemory().buffer);
        view.setUint32(nwrittenPtr, 0, true);
        return 0;
      },
      fd_read: () => 0,
      fd_close: () => 0,
      fd_seek: () => 0,
      fd_prestat_get: () => 8, // EBADF - no preopens
      fd_prestat_dir_name: () => 8,
      fd_fdstat_get: (_fd: number, statPtr: number) => {
        // Return a minimal fdstat struct (24 bytes)
        const view = new DataView(getMemory().buffer);
        // filetype: 0 = unknown
        view.setUint8(statPtr, 0);
        // flags: 0
        view.setUint16(statPtr + 2, 0, true);
        // rights_base: all rights
        view.setBigUint64(statPtr + 8, 0xFFFFFFFFFFFFFFFFn, true);
        // rights_inheriting: all rights
        view.setBigUint64(statPtr + 16, 0xFFFFFFFFFFFFFFFFn, true);
        return 0;
      },
      proc_exit: (code: number) => {
        throw new Error(`proc_exit(${code})`);
      },
      clock_time_get: (_id: number, _precision: bigint, outPtr: number) => {
        const view = new DataView(getMemory().buffer);
        view.setBigUint64(outPtr, BigInt(Date.now()) * 1000000n, true);
        return 0;
      },
      random_get: (ptr: number, len: number) => {
        const buf = new Uint8Array(getMemory().buffer, ptr, len);
        crypto.getRandomValues(buf);
        return 0;
      },
      sched_yield: () => 0,
      poll_oneoff: () => 0,
      path_open: () => 44, // ENOSYS
      path_remove_directory: () => 44,
      path_unlink_file: () => 44,
      path_create_directory: () => 44,
      path_filestat_get: () => 44,
      path_rename: () => 44,
      path_symlink: () => 44,
      path_readlink: () => 44,
    };

    const imports: WebAssembly.Imports = {
      wasi_snapshot_preview1: wasiImports,
      codepod: shellImports,
    };

    const instance = await adapter.instantiate(module, imports);
    memoryRef = instance.exports.memory as WebAssembly.Memory;

    // Call _start to initialize (runs main() which is a no-op for WASM).
    // wasm32-wasip1 binaries call proc_exit(0) when main returns.
    const start = instance.exports._start as Function | undefined;
    if (start) {
      try {
        start();
      } catch (e: unknown) {
        // proc_exit(0) is expected for successful init
        if (!(e instanceof Error && e.message === 'proc_exit(0)')) throw e;
      }
    }

    return new ShellInstance(instance);
  }

  /**
   * Run a shell command and return the result.
   *
   * The command is passed to the Rust __run_command export which parses it,
   * executes it (calling back into the host for process spawning, filesystem
   * operations, etc.), and returns a JSON-encoded RunResult.
   */
  async run(command: string): Promise<RunResult> {
    const runCommand = this.instance.exports.__run_command as (
      cmdPtr: number,
      cmdLen: number,
      outPtr: number,
      outCap: number,
    ) => number;

    if (!runCommand) {
      throw new Error('WASM module does not export __run_command');
    }

    const alloc = this.instance.exports.__alloc as (size: number) => number;
    const dealloc = this.instance.exports.__dealloc as (
      ptr: number,
      size: number,
    ) => void;

    if (!alloc || !dealloc) {
      throw new Error('WASM module does not export __alloc/__dealloc');
    }

    // Write command string into WASM memory
    const encoder = new TextEncoder();
    const cmdBytes = encoder.encode(command);
    const cmdPtr = alloc(cmdBytes.length);
    new Uint8Array(this.memory.buffer, cmdPtr, cmdBytes.length).set(cmdBytes);

    // Allocate output buffer
    let outCap = 4096;
    let outPtr = alloc(outCap);

    let needed = runCommand(cmdPtr, cmdBytes.length, outPtr, outCap);

    // If buffer was too small, reallocate and retry
    if (needed > outCap) {
      dealloc(outPtr, outCap);
      outCap = needed;
      outPtr = alloc(outCap);
      needed = runCommand(cmdPtr, cmdBytes.length, outPtr, outCap);
    }

    // Read result JSON from output buffer
    const resultBytes = new Uint8Array(this.memory.buffer, outPtr, needed);
    const resultJson = new TextDecoder().decode(resultBytes);

    // Free WASM memory
    dealloc(cmdPtr, cmdBytes.length);
    dealloc(outPtr, outCap);

    const result = JSON.parse(resultJson);
    return {
      exitCode: result.exit_code ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      executionTimeMs: result.execution_time_ms ?? 0,
    };
  }

  /** Release the WASM instance (will be GC'd). */
  destroy(): void {
    // WASM instance will be garbage collected
  }
}
