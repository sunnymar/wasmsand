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
import { createKernelImports } from '../host-imports/kernel-imports.js';
import { ProcessKernel, type SpawnRequest } from '../process/kernel.js';
import { WasiHost } from '../wasi/wasi-host.js';
import { createBufferTarget, createNullTarget, type FdTarget } from '../wasi/fd-target.js';

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

  // JSPI-wrapped __run_command (or raw export if JSPI unavailable).
  // Stored separately because V8 makes WASM exports read-only.
  private runCommandFn: Function | undefined;

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

    // ── Process kernel for pipe/spawn/waitpid/close_fd ──
    const kernel = new ProcessKernel();
    // Set the shell's fd targets in the kernel (pid 0)
    kernel.setFdTarget(0, 0, createNullTarget());    // stdin: no terminal input
    kernel.setFdTarget(0, 1, createBufferTarget());   // stdout: captured (no limit on kernel fd)
    kernel.setFdTarget(0, 2, createBufferTarget());   // stderr: captured (no limit on kernel fd)

    // Kernel imports provide codepod-namespace syscalls (extensions, network, process mgmt)
    const kernelImports = createKernelImports({
      memory: memoryProxy,
      callerPid: 0,
      kernel,
      networkBridge: options?.networkBridge,
      extensionRegistry: options?.extensionRegistry,
      toolAllowlist: options?.toolAllowlist,
      spawnProcess: (req: SpawnRequest, fdTable: Map<number, FdTarget>) => {
        return spawnAsyncProcess(req, fdTable, mgr, kernel, adapter);
      },
    });

    // Merge: shell-specific imports take precedence, then kernel-level imports
    const codepodImports: Record<string, WebAssembly.ImportValue> = {
      ...kernelImports,
      ...shellImports,
    };

    // The WASM binary imports `host_spawn_async` but kernel-imports provides `host_spawn`.
    // Alias it so the import linker finds the right name.
    codepodImports.host_spawn_async = kernelImports.host_spawn as WebAssembly.ImportValue;

    // JSPI: Wrap async imports so WASM suspends when they return a Promise.
    // WebAssembly.Suspending is available in Node 25+ (unflagged) and Chrome 137+.
    if (typeof WebAssembly.Suspending === 'function') {
      // Extension invoke (async, returns Promise)
      if (options?.extensionRegistry) {
        codepodImports.host_extension_invoke = new WebAssembly.Suspending(
          kernelImports.host_extension_invoke as (...args: number[]) => Promise<number>,
        ) as unknown as WebAssembly.ImportValue;
      }
      // Process management: host_waitpid blocks until child exits
      codepodImports.host_waitpid = new WebAssembly.Suspending(
        kernelImports.host_waitpid as (...args: number[]) => Promise<number>,
      ) as unknown as WebAssembly.ImportValue;
      // host_yield: cooperative scheduling primitive
      codepodImports.host_yield = new WebAssembly.Suspending(
        kernelImports.host_yield as () => Promise<void>,
      ) as unknown as WebAssembly.ImportValue;
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
      fd_write: (fd: number, iovPtr: number, iovLen: number, nwrittenPtr: number): number => {
        const mem = getMemory();
        const view = new DataView(mem.buffer);
        const bytes = new Uint8Array(mem.buffer);
        const target = kernel.getFdTarget(0, fd);
        if (!target) {
          // Unknown fd — return 0 bytes written (backward-compat for fds 0-2)
          view.setUint32(nwrittenPtr, 0, true);
          return 0;
        }
        let totalWritten = 0;
        for (let i = 0; i < iovLen; i++) {
          const buf = view.getUint32(iovPtr + i * 8, true);
          const len = view.getUint32(iovPtr + i * 8 + 4, true);
          const data = bytes.slice(buf, buf + len);
          switch (target.type) {
            case 'pipe_write': {
              const n = target.pipe.write(data);
              if (n === -1) {
                // EPIPE
                const v2 = new DataView(getMemory().buffer);
                v2.setUint32(nwrittenPtr, totalWritten, true);
                return 76; // WASI_EPIPE
              }
              totalWritten += n;
              break;
            }
            case 'buffer': {
              if (target.total < target.limit) {
                const remaining = target.limit - target.total;
                const slice = data.byteLength <= remaining ? data : data.slice(0, remaining);
                target.buf.push(slice);
                if (data.byteLength > remaining) target.truncated = true;
              } else {
                target.truncated = true;
              }
              target.total += data.byteLength;
              totalWritten += data.byteLength;
              break;
            }
            case 'null':
              totalWritten += data.byteLength;
              break;
            default:
              // pipe_read, static — can't write
              view.setUint32(nwrittenPtr, totalWritten, true);
              return 8; // WASI_EBADF
          }
        }
        const v2 = new DataView(getMemory().buffer);
        v2.setUint32(nwrittenPtr, totalWritten, true);
        return 0;
      },
      fd_read: async (fd: number, iovPtr: number, iovLen: number, nreadPtr: number): Promise<number> => {
        const mem = getMemory();
        const view = new DataView(mem.buffer);
        const target = kernel.getFdTarget(0, fd);
        if (!target) {
          view.setUint32(nreadPtr, 0, true);
          return 0;
        }
        let totalRead = 0;
        for (let i = 0; i < iovLen; i++) {
          const buf = view.getUint32(iovPtr + i * 8, true);
          const len = view.getUint32(iovPtr + i * 8 + 4, true);
          switch (target.type) {
            case 'pipe_read': {
              const readBuf = new Uint8Array(len);
              const n = await target.pipe.read(readBuf);
              if (n > 0) {
                const bytes = new Uint8Array(getMemory().buffer);
                bytes.set(readBuf.subarray(0, n), buf);
                totalRead += n;
              }
              if (n < len) {
                // EOF or short read — stop
                const v2 = new DataView(getMemory().buffer);
                v2.setUint32(nreadPtr, totalRead, true);
                return 0;
              }
              continue;
            }
            case 'static': {
              if (target.offset >= target.data.byteLength) break;
              const remaining = target.data.byteLength - target.offset;
              const toRead = Math.min(len, remaining);
              const bytes = new Uint8Array(getMemory().buffer);
              bytes.set(target.data.subarray(target.offset, target.offset + toRead), buf);
              target.offset += toRead;
              totalRead += toRead;
              if (toRead < len) {
                const v2 = new DataView(getMemory().buffer);
                v2.setUint32(nreadPtr, totalRead, true);
                return 0;
              }
              continue;
            }
            case 'null':
              break;
            default:
              return 8; // WASI_EBADF
          }
          break; // EOF from null/static
        }
        const v2 = new DataView(getMemory().buffer);
        v2.setUint32(nreadPtr, totalRead, true);
        return 0;
      },
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

    // JSPI: Wrap WASI fd_read/fd_write for pipe suspension.
    // When a WASM process reads from an empty pipe or writes to a full pipe,
    // the host returns a Promise that resolves when data is available.
    // This requires the WASI functions to be JSPI-Suspending.
    if (typeof WebAssembly.Suspending === 'function') {
      wasiImports.fd_read = new WebAssembly.Suspending(
        wasiImports.fd_read as (...args: number[]) => number,
      ) as unknown as WebAssembly.ImportValue;
      wasiImports.fd_write = new WebAssembly.Suspending(
        wasiImports.fd_write as (...args: number[]) => number,
      ) as unknown as WebAssembly.ImportValue;
    }

    const imports: WebAssembly.Imports = {
      wasi_snapshot_preview1: wasiImports,
      codepod: codepodImports,
    };

    const instance = await adapter.instantiate(module, imports);
    memoryRef = instance.exports.memory as WebAssembly.Memory;

    // JSPI: Wrap the __run_command export so it returns a Promise when
    // the WASM stack is suspended (e.g. during async extension invocation,
    // host_waitpid, host_yield, or pipe I/O).
    // Stored in a separate field because V8 makes WASM exports read-only.
    const rawRunCommand = instance.exports.__run_command as Function | undefined;
    let wrappedRunCommand: Function | undefined = rawRunCommand;
    if (rawRunCommand && typeof (WebAssembly as any).promising === 'function') {
      wrappedRunCommand = (WebAssembly as any).promising(rawRunCommand);
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
    shell.runCommandFn = wrappedRunCommand;
    shellRef = shell;

    // Populate /bin/ in VFS with entries for registered tools so that
    // `ls /bin` and `stat /bin/<tool>` work correctly.
    vfs.withWriteAccess(() => {
      try {
        vfs.mkdir('/bin');
      } catch {
        // already exists
      }
      for (const toolName of mgr.getRegisteredTools()) {
        try {
          vfs.writeFile(`/bin/${toolName}`, new Uint8Array(0));
        } catch {
          // ignore
        }
      }
    });

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
    // When JSPI is active, runCommandFn is wrapped with WebAssembly.promising()
    // and returns a Promise<number>. When JSPI is not active, it returns number.
    // Either way, `await` handles both correctly.
    const runCommand = this.runCommandFn as (
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

    // Sync env from WASM back to TypeScript
    if (result.env && typeof result.env === 'object') {
      const wasmEnv = result.env as Record<string, string>;
      // Update our env Map with WASM state
      this.env.clear();
      for (const [k, v] of Object.entries(wasmEnv)) {
        this.env.set(k, v);
      }
      // Also sync the synced state so we don't re-export these next time
      this.syncedEnv = new Map(this.env);
    }

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

// ── Async process spawning ──

/**
 * Spawn a child WASM process asynchronously.
 *
 * Called by the kernel when the shell's Rust code calls `host_spawn_async`.
 * Allocates a PID, loads the module, creates a WasiHost with the provided
 * fd table (which may include pipe endpoints), JSPI-wraps fd_read/fd_write
 * for pipe suspension, instantiates the module, and registers the running
 * process with the kernel.
 *
 * Returns the child PID (>= 1) or -1 on error.
 */
function spawnAsyncProcess(
  req: SpawnRequest,
  fdTable: Map<number, FdTarget>,
  mgr: ProcessManager,
  kernel: ProcessKernel,
  adapter: PlatformAdapter,
): number {
  const pid = kernel.allocPid();
  kernel.initProcess(pid);
  kernel.registerPending(pid);

  const module = mgr.getModule(req.prog);
  if (!module) return -1;

  const host = new WasiHost({
    vfs: mgr.getVfs(),
    args: [req.prog, ...req.args],
    env: Object.fromEntries(req.env),
    preopens: { '/': '/' },
    ioFds: fdTable,
  });

  const imports = host.getImports() as WebAssembly.Imports & Record<string, Record<string, unknown>>;

  // JSPI-wrap fd_read/fd_write for pipe suspension in the child process.
  if (typeof WebAssembly.Suspending === 'function') {
    imports.wasi_snapshot_preview1.fd_read = new WebAssembly.Suspending(
      imports.wasi_snapshot_preview1.fd_read as (...args: number[]) => number,
    ) as unknown as WebAssembly.ImportValue;
    imports.wasi_snapshot_preview1.fd_write = new WebAssembly.Suspending(
      imports.wasi_snapshot_preview1.fd_write as (...args: number[]) => number,
    ) as unknown as WebAssembly.ImportValue;
  }

  // Add kernel imports if the module needs the `codepod` namespace.
  const moduleImportDescs = WebAssembly.Module.imports(module);
  if (moduleImportDescs.some(imp => imp.module === 'codepod')) {
    // Build a memory proxy for the child (memory comes from instance exports)
    let childMemRef: WebAssembly.Memory | null = null;
    const childMemoryProxy = new Proxy({} as WebAssembly.Memory, {
      get(_target, prop) {
        if (!childMemRef) throw new Error('child memory not initialized');
        const val = (childMemRef as unknown as Record<string | symbol, unknown>)[prop];
        return typeof val === 'function' ? (val as Function).bind(childMemRef) : val;
      },
    });

    const childKernelImports = createKernelImports({
      memory: childMemoryProxy,
      callerPid: pid,
      kernel,
      spawnProcess: (req2, fdTable2) => spawnAsyncProcess(req2, fdTable2, mgr, kernel, adapter),
    });
    imports.codepod = childKernelImports as unknown as Record<string, WebAssembly.ImportValue>;

    // Alias host_spawn_async for WASM compatibility
    imports.codepod.host_spawn_async = childKernelImports.host_spawn as WebAssembly.ImportValue;

    // JSPI-wrap async syscalls in the child's codepod imports
    if (typeof WebAssembly.Suspending === 'function') {
      imports.codepod.host_waitpid = new WebAssembly.Suspending(
        childKernelImports.host_waitpid as (...args: number[]) => Promise<number>,
      ) as unknown as WebAssembly.ImportValue;
      imports.codepod.host_yield = new WebAssembly.Suspending(
        childKernelImports.host_yield as () => Promise<void>,
      ) as unknown as WebAssembly.ImportValue;
    }

    // Start the process asynchronously
    adapter.instantiate(module, imports).then((instance) => {
      childMemRef = instance.exports.memory as WebAssembly.Memory;
      host.setMemory(childMemRef);

      let startFn = instance.exports._start as Function;
      if (typeof (WebAssembly as any).promising === 'function') {
        startFn = (WebAssembly as any).promising(startFn);
      }

      const promise = Promise.resolve().then(() => startFn()).catch(() => {});
      kernel.attachProcess(pid, promise, host);
    }).catch(() => {
      // If instantiation fails, attach as immediately exited
      kernel.attachProcess(pid, Promise.resolve(), host);
    });
  } else {
    // Module doesn't need codepod imports — simpler path
    adapter.instantiate(module, imports).then((instance) => {
      host.setMemory(instance.exports.memory as WebAssembly.Memory);

      let startFn = instance.exports._start as Function;
      if (typeof (WebAssembly as any).promising === 'function') {
        startFn = (WebAssembly as any).promising(startFn);
      }

      const promise = Promise.resolve().then(() => startFn()).catch(() => {});
      kernel.attachProcess(pid, promise, host);
    }).catch(() => {
      kernel.attachProcess(pid, Promise.resolve(), host);
    });
  }

  return pid;
}
