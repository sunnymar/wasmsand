/**
 * ShellInstance: instantiates and drives the Rust shell-exec WASM module.
 *
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
import type { NetworkBridgeLike } from '../network/bridge.js';
import type { ExtensionRegistry } from '../extension/registry.js';
import type { RunResult } from './shell-types.js';
import type { HistoryEntry } from './history.js';
import type { ShellLike } from './shell-like.js';
import { createShellImports } from '../host-imports/shell-imports.js';

/** Default environment variables for a new ShellInstance. */
const DEFAULT_ENV: [string, string][] = [
  ['HOME', '/home/user'],
  ['PWD', '/home/user'],
  ['USER', 'user'],
  ['PATH', '/bin:/usr/bin'],
  ['PYTHONPATH', '/usr/lib/python'],
  ['SHELL', '/bin/sh'],
];

export interface ShellInstanceOptions {
  /** Synchronous spawn handler for testing. Real SAB-based bridging comes later. */
  syncSpawn?: (
    cmd: string,
    args: string[],
    env: Record<string, string>,
    stdin: Uint8Array,
    cwd: string,
  ) => { exit_code: number; stdout: string; stderr: string };
  /** Network bridge for synchronous HTTP fetch from WASM. */
  networkBridge?: NetworkBridgeLike;
  /** Extension registry for command extensions. */
  extensionRegistry?: ExtensionRegistry;
  /** Tool allowlist for security policy. */
  toolAllowlist?: string[];
}

export class ShellInstance implements ShellLike {
  private instance: WebAssembly.Instance;
  private memory: WebAssembly.Memory;

  // Environment (local mirror for Sandbox snapshot/restore)
  private env: Map<string, string> = new Map(DEFAULT_ENV);
  // Track which env vars have been synced to the WASM module
  private syncedEnv: Map<string, string> = new Map(DEFAULT_ENV);

  // History
  private historyEntries: HistoryEntry[] = [];
  private nextHistoryIndex = 1;

  // Cancellation
  private cancelledReason: string | null = null;
  private deadlineMs: number = Infinity;

  // Output limits
  private stdoutLimitBytes: number | undefined;
  private stderrLimitBytes: number | undefined;

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
      get(_target, prop, _receiver) {
        const mem = getMemory();
        const val = (mem as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof val === 'function') {
          return val.bind(mem);
        }
        return val;
      },
    });

    // We need a reference to the ShellInstance for the checkCancel callback,
    // but the instance doesn't exist yet. Use a mutable ref.
    let shellRef: ShellInstance | null = null;

    const shellImports = createShellImports({
      vfs,
      mgr,
      memory: memoryProxy,
      syncSpawn: options?.syncSpawn,
      networkBridge: options?.networkBridge,
      extensionRegistry: options?.extensionRegistry,
      toolAllowlist: options?.toolAllowlist,
      checkCancel: () => {
        if (!shellRef) return 0;
        if (shellRef.cancelledReason === 'TIMEOUT') return 1;
        if (shellRef.cancelledReason) return 2;
        if (shellRef.deadlineMs !== Infinity && Date.now() > shellRef.deadlineMs) {
          shellRef.cancelledReason = 'TIMEOUT';
          return 1;
        }
        return 0;
      },
    });

    // JSPI: Wrap async import so WASM suspends when it returns a Promise.
    // WebAssembly.Suspending is available in Node 25+ (unflagged) and Chrome 137+.
    if (options?.extensionRegistry && typeof WebAssembly.Suspending === 'function') {
      shellImports.host_extension_invoke = new WebAssembly.Suspending(
        shellImports.host_extension_invoke as (...args: number[]) => Promise<number>,
      );
    }

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

    // JSPI: Wrap the __run_command export so it returns a Promise when
    // the WASM stack is suspended (e.g. during async extension invocation).
    if (options?.extensionRegistry && typeof WebAssembly.promising === 'function') {
      const rawRunCommand = instance.exports.__run_command;
      if (rawRunCommand) {
        (instance.exports as Record<string, WebAssembly.ExportValue>).__run_command =
          WebAssembly.promising(rawRunCommand as Function);
      }
    }

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

    const shell = new ShellInstance(instance);
    shellRef = shell;
    return shell;
  }

  // ── Environment ──

  getEnv(name: string): string | undefined {
    return this.env.get(name);
  }

  setEnv(name: string, value: string): void {
    this.env.set(name, value);
  }

  /** Return a copy of all env vars (for snapshot). */
  getEnvMap(): Map<string, string> {
    return new Map(this.env);
  }

  /** Replace all env vars (for restore). */
  setEnvMap(env: Map<string, string>): void {
    this.env = new Map(env);
    // Force resync on next run
    this.syncedEnv = new Map();
  }

  // ── History ──

  getHistory(): HistoryEntry[] {
    return [...this.historyEntries];
  }

  clearHistory(): void {
    this.historyEntries = [];
    this.nextHistoryIndex = 1;
  }

  // ── Cancellation ──

  cancel(reason: string): void {
    this.cancelledReason = reason;
  }

  setDeadlineNow(): void {
    this.deadlineMs = 0;
  }

  resetCancel(timeoutMs?: number): void {
    this.cancelledReason = null;
    this.deadlineMs = timeoutMs !== undefined ? Date.now() + timeoutMs : Infinity;
  }

  /** Return the current deadline (epoch ms, or Infinity if none). */
  getDeadlineMs(): number {
    return this.deadlineMs;
  }

  // ── Output limits ──

  setOutputLimits(stdoutBytes?: number, stderrBytes?: number): void {
    this.stdoutLimitBytes = stdoutBytes;
    this.stderrLimitBytes = stderrBytes;
  }

  // ── Command execution ──

  /**
   * Run a shell command and return the result.
   *
   * The command is passed to the Rust __run_command export which parses it,
   * executes it (calling back into the host for process spawning, filesystem
   * operations, etc.), and returns a JSON-encoded RunResult.
   */
  async run(command: string): Promise<RunResult> {
    // When JSPI is active, __run_command is wrapped with WebAssembly.promising()
    // and returns a Promise<number>. When JSPI is not active, it returns number.
    // Either way, `await` handles both correctly.
    const runCommand = this.instance.exports.__run_command as (
      cmdPtr: number,
      cmdLen: number,
      outPtr: number,
      outCap: number,
    ) => number | Promise<number>;

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

    // Sync env changes to the WASM module by prepending export statements
    const envExports: string[] = [];
    for (const [k, v] of this.env) {
      if (this.syncedEnv.get(k) !== v) {
        // Escape single quotes in value for shell safety
        const escaped = v.replace(/'/g, "'\\''");
        envExports.push(`export ${k}='${escaped}'`);
        this.syncedEnv.set(k, v);
      }
    }
    // Check for unset vars
    for (const k of this.syncedEnv.keys()) {
      if (!this.env.has(k)) {
        envExports.push(`unset ${k}`);
        this.syncedEnv.delete(k);
      }
    }

    // If we have env changes, run them first (silently)
    if (envExports.length > 0) {
      const envCmd = envExports.join('; ');
      const envEncoder = new TextEncoder();
      const envBytes = envEncoder.encode(envCmd);
      const envCmdPtr = alloc(envBytes.length);
      new Uint8Array(this.memory.buffer, envCmdPtr, envBytes.length).set(envBytes);

      let envOutCap = 256;
      let envOutPtr = alloc(envOutCap);
      const envNeeded = await runCommand(envCmdPtr, envBytes.length, envOutPtr, envOutCap);
      if (envNeeded > envOutCap) {
        dealloc(envOutPtr, envOutCap);
        envOutCap = envNeeded;
        envOutPtr = alloc(envOutCap);
        await runCommand(envCmdPtr, envBytes.length, envOutPtr, envOutCap);
      }
      dealloc(envCmdPtr, envBytes.length);
      dealloc(envOutPtr, envOutCap);
    }

    // Record in history
    this.historyEntries.push({
      index: this.nextHistoryIndex++,
      command,
      timestamp: Date.now(),
    });

    // Write command string into WASM memory
    const encoder = new TextEncoder();
    const cmdBytes = encoder.encode(command);
    const cmdPtr = alloc(cmdBytes.length);
    new Uint8Array(this.memory.buffer, cmdPtr, cmdBytes.length).set(cmdBytes);

    // Allocate output buffer
    let outCap = 4096;
    let outPtr = alloc(outCap);

    let needed = await runCommand(cmdPtr, cmdBytes.length, outPtr, outCap);

    // If buffer was too small, reallocate and retry
    if (needed > outCap) {
      dealloc(outPtr, outCap);
      outCap = needed;
      outPtr = alloc(outCap);
      needed = await runCommand(cmdPtr, cmdBytes.length, outPtr, outCap);
    }

    // Read result JSON from output buffer
    const resultBytes = new Uint8Array(this.memory.buffer, outPtr, needed);
    const resultJson = new TextDecoder().decode(resultBytes);

    // Free WASM memory
    dealloc(cmdPtr, cmdBytes.length);
    dealloc(outPtr, outCap);

    const result = JSON.parse(resultJson);
    let stdout: string = result.stdout ?? '';
    let stderr: string = result.stderr ?? '';
    let truncated: { stdout: boolean; stderr: boolean } | undefined;

    const enc = new TextEncoder();

    if (this.stdoutLimitBytes !== undefined && enc.encode(stdout).byteLength > this.stdoutLimitBytes) {
      // Truncate to approximate byte limit (may split multi-byte chars, but safe for ASCII-heavy output)
      const bytes = enc.encode(stdout);
      stdout = new TextDecoder().decode(bytes.slice(0, this.stdoutLimitBytes));
      truncated = { stdout: true, stderr: false };
    }

    if (this.stderrLimitBytes !== undefined && enc.encode(stderr).byteLength > this.stderrLimitBytes) {
      const bytes = enc.encode(stderr);
      stderr = new TextDecoder().decode(bytes.slice(0, this.stderrLimitBytes));
      truncated = truncated
        ? { ...truncated, stderr: true }
        : { stdout: false, stderr: true };
    }

    // Check if the command was cancelled or timed out
    let errorClass: import('../security.js').ErrorClass | undefined;
    let exitCode = result.exit_code ?? 0;

    if (this.cancelledReason === 'TIMEOUT' || (this.deadlineMs !== Infinity && Date.now() > this.deadlineMs)) {
      errorClass = 'TIMEOUT';
      exitCode = 124;
      this.cancelledReason = 'TIMEOUT';
    } else if (this.cancelledReason === 'CANCELLED') {
      errorClass = 'CANCELLED';
      exitCode = 125;
    }

    return {
      exitCode,
      stdout,
      stderr,
      executionTimeMs: result.execution_time_ms ?? 0,
      ...(truncated ? { truncated } : {}),
      ...(errorClass ? { errorClass } : {}),
    };
  }

  /** Release the WASM instance (will be GC'd). */
  destroy(): void {
    // WASM instance will be garbage collected
  }
}
