/// <reference path="../jspi.d.ts" />
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
import type { ShellLike, StreamCallbacks } from './shell-like.js';
import { AsyncifyAsyncBridge } from '../async-bridge.js';
import { createShellImports } from '../host-imports/shell-imports.js';
import { createKernelImports } from '../host-imports/kernel-imports.js';
import { ProcessKernel, NO_PARENT_PID, type SpawnRequest } from '../process/kernel.js';
import { WasiHost } from '../wasi/wasi-host.js';
import { createBufferTarget, createNullTarget, createStaticTarget, bufferToString, type FdTarget } from '../wasi/fd-target.js';

/** Default environment variables for a new ShellInstance. */
const DEFAULT_ENV: [string, string][] = [
  ['HOME', '/home/user'],
  ['PWD', '/home/user'],
  ['USER', 'user'],
  ['PATH', '/bin:/usr/bin'],
  ['PYTHONPATH', '/usr/lib/python'],
  ['SHELL', '/bin/sh'],
  // Disable pyc bytecode caching — writing __pycache__ dirs triggers a VFS bug
  // where subsequent path_open calls for .py files return EISDIR.
  ['PYTHONDONTWRITEBYTECODE', '1'],
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
  /** Legacy extension handler (sync, used by Worker proxy). */
  extensionHandler?: (cmd: Record<string, unknown>) => Record<string, unknown>;
  /** Tool allowlist for security policy. */
  toolAllowlist?: string[];
  /** Max WASM linear memory in bytes for spawned child processes. */
  memoryBytes?: number;
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

  // Process kernel for pipe/spawn support.
  // Needed to extract buffer-captured output from spawned pipeline stages.
  private kernel: ProcessKernel | undefined;

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

    // We need a reference to the ShellInstance for the deadline check,
    // but the instance doesn't exist yet. Use a mutable ref.
    let shellRef: ShellInstance | null = null;

    const shellImports = createShellImports({
      vfs,
      mgr,
      memory: memoryProxy,
      syncSpawn: options?.syncSpawn,
    });

    // ── Process kernel for pipe/spawn/waitpid/close_fd ──
    const kernel = new ProcessKernel();
    // The shell isn't special — it just happens to be the first process
    // to call allocPid on this kernel, so it gets PID 1 (Unix init by
    // convention).  When a Python script or another tool spawns a fresh
    // shell as a child later, that nested shell calls allocPid on its
    // own kernel (because each ShellInstance owns one) and is similarly
    // PID 1 inside its own container.
    const shellPid = kernel.allocPid(NO_PARENT_PID, 'shell');
    kernel.setFdTarget(shellPid, 0, createNullTarget());    // stdin: no terminal input
    kernel.setFdTarget(shellPid, 1, createBufferTarget());   // stdout: captured (no limit on kernel fd)
    kernel.setFdTarget(shellPid, 2, createBufferTarget());   // stderr: captured (no limit on kernel fd)

    // Build runCommand callback for Python _codepod.spawn() / subprocess support.
    // Each call creates a fresh ShellInstance so we don't re-enter the busy one.
    const runCommand = async (cmd: string, stdin: string) => {
      const sub = await ShellInstance.create(vfs, mgr, adapter, wasmPath, {
        networkBridge: options?.networkBridge,
        extensionRegistry: options?.extensionRegistry,
      });
      try {
        const result = await sub.run(cmd, { stdinData: new TextEncoder().encode(stdin) });
        return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
      } finally {
        sub.destroy();
      }
    };

    // Kernel imports provide codepod-namespace syscalls (network, process mgmt)
    const kernelImports = createKernelImports({
      memory: memoryProxy,
      callerPid: shellPid,
      kernel,
      networkBridge: options?.networkBridge,
      nativeModules: mgr.nativeModules,
      runCommand,
      spawnProcess: (req: SpawnRequest, fdTable: Map<number, FdTarget>, parentPid: number) => {
        if (options?.syncSpawn) {
          return spawnSyncProcess(req, fdTable, kernel, options.syncSpawn, parentPid);
        }
        return spawnAsyncProcess(req, fdTable, mgr, kernel, adapter, shellRef?.getDeadlineMs(), options?.memoryBytes, options?.networkBridge, options?.extensionRegistry, runCommand, parentPid);
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

    // Bridge for async import/export wrapping (JSPI or Asyncify).
    // Declared here so the post-instantiation block can access it.
    let asyncifyBridge: AsyncifyAsyncBridge | null = null;

    // JSPI: Wrap async imports so WASM suspends when they return a Promise.
    // WebAssembly.Suspending is available in Node 25+ (unflagged) and Chrome 137+.
    if (typeof WebAssembly.Suspending === 'function') {
      // Process management: host_waitpid blocks until child exits
      codepodImports.host_waitpid = new WebAssembly.Suspending(
        kernelImports.host_waitpid as (...args: number[]) => Promise<number>,
      ) as unknown as WebAssembly.ImportValue;
      // host_yield: cooperative scheduling primitive
      codepodImports.host_yield = new WebAssembly.Suspending(
        kernelImports.host_yield as () => Promise<void>,
      ) as unknown as WebAssembly.ImportValue;
      // Network fetch (async for browser JSPI support)
      codepodImports.host_network_fetch = new WebAssembly.Suspending(
        kernelImports.host_network_fetch as (...args: number[]) => Promise<number>,
      ) as unknown as WebAssembly.ImportValue;
      // Register tool (async when loading native modules)
      codepodImports.host_register_tool = new WebAssembly.Suspending(
        shellImports.host_register_tool as (...args: number[]) => Promise<number>,
      ) as unknown as WebAssembly.ImportValue;
      // host_run_command: Python _codepod.spawn() / subprocess support
      codepodImports.host_run_command = new WebAssembly.Suspending(
        kernelImports.host_run_command as (...args: number[]) => Promise<number>,
      ) as unknown as WebAssembly.ImportValue;
    } else {
      // Asyncify fallback: wrap async imports with the unwind/rewind bridge.
      // The bridge is initialised after instantiation (needs the WASM exports).
      asyncifyBridge = new AsyncifyAsyncBridge();
      const aw = (fn: unknown) =>
        asyncifyBridge!.wrapImport(fn as (...args: number[]) => Promise<number> | number) as WebAssembly.ImportValue;

      codepodImports.host_waitpid       = aw(kernelImports.host_waitpid);
      codepodImports.host_yield         = aw(kernelImports.host_yield);
      codepodImports.host_network_fetch = aw(kernelImports.host_network_fetch);
      codepodImports.host_register_tool = aw(shellImports.host_register_tool);
      codepodImports.host_run_command   = aw(kernelImports.host_run_command);
      // fd_read and poll_oneoff are wrapped below, after wasiImports is defined.
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
                target.onChunk?.(slice);
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
      poll_oneoff: async (inPtr: number, outPtr: number, nsubscriptions: number, neventsPtr: number): Promise<number> => {
        // WASI_EVENTTYPE_CLOCK = 0
        // WASI_SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME = 1
        // Subscriptions are 48 bytes each; events are 32 bytes each.
        if (nsubscriptions === 0) return 28; // WASI_EINVAL
        const mem = getMemory();
        const view = new DataView(mem.buffer);
        let earliestDeadlineMs = Infinity;
        let earliestUserdata = 0n;
        for (let i = 0; i < nsubscriptions; i++) {
          const base = inPtr + i * 48;
          const userdata = view.getBigUint64(base, true);
          const type = view.getUint8(base + 8);
          if (type === 0 /* CLOCK */) {
            const timeout = view.getBigUint64(base + 24, true);
            const flags = view.getUint16(base + 40, true);
            const isAbsolute = (flags & 1) !== 0;
            let deadlineMs: number;
            if (isAbsolute) {
              deadlineMs = Number(timeout / 1_000_000n);
            } else {
              deadlineMs = Date.now() + Number(timeout / 1_000_000n);
            }
            if (deadlineMs < earliestDeadlineMs) {
              earliestDeadlineMs = deadlineMs;
              earliestUserdata = userdata;
            }
          }
        }
        if (earliestDeadlineMs !== Infinity) {
          const waitMs = Math.max(0, earliestDeadlineMs - Date.now());
          if (waitMs > 0) {
            await new Promise<void>(res => setTimeout(res, waitMs));
          }
          // Write one clock event
          const mem2 = getMemory();
          const view2 = new DataView(mem2.buffer);
          view2.setBigUint64(outPtr, earliestUserdata, true);
          view2.setUint16(outPtr + 8, 0, true);   // error: ESUCCESS
          view2.setUint8(outPtr + 10, 0);           // type: CLOCK
          view2.setUint8(outPtr + 11, 0);
          view2.setUint32(outPtr + 12, 0, true);
          view2.setBigUint64(outPtr + 16, 0n, true);
          view2.setUint16(outPtr + 24, 0, true);
          view2.setUint16(outPtr + 26, 0, true);
          view2.setUint32(outPtr + 28, 0, true);
          view2.setUint32(neventsPtr, 1, true);
          return 0; // ESUCCESS
        }
        return 28; // WASI_EINVAL
      },
      path_open: () => 44, // ENOSYS
      path_remove_directory: () => 44,
      path_unlink_file: () => 44,
      path_create_directory: () => 44,
      path_filestat_get: () => 44,
      path_rename: () => 44,
      path_symlink: () => 44,
      path_readlink: () => 44,
    };

    // Wrap WASI fd_read / fd_write / poll_oneoff for pipe suspension and sleep.
    if (typeof WebAssembly.Suspending === 'function') {
      // JSPI: WASM suspends when an import returns a Promise.
      wasiImports.fd_read = new WebAssembly.Suspending(
        wasiImports.fd_read as (...args: number[]) => number,
      ) as unknown as WebAssembly.ImportValue;
      wasiImports.fd_write = new WebAssembly.Suspending(
        wasiImports.fd_write as (...args: number[]) => number,
      ) as unknown as WebAssembly.ImportValue;
      wasiImports.poll_oneoff = new WebAssembly.Suspending(
        wasiImports.poll_oneoff as (...args: number[]) => Promise<number>,
      ) as unknown as WebAssembly.ImportValue;
    } else if (asyncifyBridge) {
      // Asyncify: wrap with unwind/rewind bridge (same bridge instance as codepod imports).
      const aw = (fn: unknown) =>
        asyncifyBridge!.wrapImport(fn as (...args: number[]) => Promise<number> | number) as WebAssembly.ImportValue;
      wasiImports.fd_read     = aw(wasiImports.fd_read)     as typeof wasiImports.fd_read;
      wasiImports.poll_oneoff = aw(wasiImports.poll_oneoff) as typeof wasiImports.poll_oneoff;
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

    // Asyncify post-init: allocate the data buffer and wire up asyncify exports.
    // Must happen after _start() so the WASM allocator is initialised.
    if (asyncifyBridge && rawRunCommand) {
      const alloc = instance.exports.__alloc as ((size: number) => number) | undefined;
      if (!alloc) throw new Error('asyncify requires __alloc export from the WASM binary');
      // 64 KB is sufficient for the deepest Rust call stacks we see in practice.
      const ASYNCIFY_BUF = 65536;
      const dataAddr = alloc(ASYNCIFY_BUF);
      // Write asyncify data buffer header: [start_ptr, end_ptr, ...data...]
      const memView = new DataView(memoryRef!.buffer);
      memView.setUint32(dataAddr,     dataAddr + 8,          true); // start of save area
      memView.setUint32(dataAddr + 4, dataAddr + ASYNCIFY_BUF, true); // end of save area
      asyncifyBridge.initFromInstance(instance, dataAddr);
      wrappedRunCommand = asyncifyBridge.wrapExport(rawRunCommand as (...args: number[]) => number);
    }

    const shell = new ShellInstance(instance);
    shell.runCommandFn = wrappedRunCommand;
    shell.kernel = kernel;
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
  async run(command: string, options?: { stdinData?: Uint8Array }): Promise<RunResult> {
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

    // If stdinData is provided, install it as a static target on fd 0 for this run.
    // After the run, restore the null target so the shell's stdin is clean again.
    const hadStdinData = options?.stdinData && options.stdinData.byteLength > 0;
    if (hadStdinData && this.kernel) {
      this.kernel.setFdTarget(0, 0, createStaticTarget(options!.stdinData!));
    }

    // Sync env changes to the WASM module by prepending export statements
    const envExports: string[] = [];
    for (const [k, v] of this.env) {
      if (this.syncedEnv.get(k) !== v) {
        // Validate env var name to prevent shell injection
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          continue; // skip invalid env var names
        }
        // Escape single quotes in value for shell safety
        const escaped = v.replace(/'/g, "'\\''");
        envExports.push(`export ${k}='${escaped}'`);
        this.syncedEnv.set(k, v);
      }
    }
    // Check for unset vars
    for (const k of this.syncedEnv.keys()) {
      if (!this.env.has(k)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          this.syncedEnv.delete(k);
          continue;
        }
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

    // All output flows through the kernel buffer (pid 0 fd 1/2):
    // - Builtins call write_to_fd(stdout_fd, ...) via WASI fd_write
    // - Sync external commands write post-redirect output to stdout_fd
    // - Async spawned pipeline stages write via child fd tables
    // This is the single source of truth for stdout/stderr.
    let stdout = '';
    let stderr = '';
    if (this.kernel) {
      const stdoutTarget = this.kernel.getFdTarget(0, 1);
      const stderrTarget = this.kernel.getFdTarget(0, 2);
      if (stdoutTarget?.type === 'buffer' && stdoutTarget.buf.length > 0) {
        stdout = bufferToString(stdoutTarget);
      }
      if (stderrTarget?.type === 'buffer' && stderrTarget.buf.length > 0) {
        stderr = bufferToString(stderrTarget);
      }
      // Reset buffers for the next run
      if (stdoutTarget?.type === 'buffer') { stdoutTarget.buf.length = 0; stdoutTarget.total = 0; stdoutTarget.truncated = false; }
      if (stderrTarget?.type === 'buffer') { stderrTarget.buf.length = 0; stderrTarget.total = 0; stderrTarget.truncated = false; }
    }
    // Kernel buffer is the sole source of truth. No JSON fallback needed.
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

    // Restore null stdin target after run (if we temporarily installed stdinData)
    if (hadStdinData && this.kernel) {
      this.kernel.setFdTarget(0, 0, createNullTarget());
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

  /** Set or clear streaming callbacks on pid 0 stdout/stderr buffer targets. */
  setOutputCallbacks(callbacks: StreamCallbacks | null): void {
    if (!this.kernel) return;
    const stdoutTarget = this.kernel.getFdTarget(0, 1);
    const stderrTarget = this.kernel.getFdTarget(0, 2);
    if (stdoutTarget?.type === 'buffer') stdoutTarget.onChunk = callbacks?.onStdout ?? undefined;
    if (stderrTarget?.type === 'buffer') stderrTarget.onChunk = callbacks?.onStderr ?? undefined;
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
  deadlineMs?: number,
  memoryBytes?: number,
  networkBridge?: NetworkBridgeLike,
  extensionRegistry?: ExtensionRegistry,
  runCommand?: (cmd: string, stdin: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  parentPid: number = NO_PARENT_PID,
): number {
  // Tool allowlist check
  if (!mgr.isToolAllowed(req.prog)) {
    const pid = kernel.allocPid(parentPid, req.prog);
    for (const [fd, target] of fdTable) kernel.setFdTarget(pid, fd, target);
    const errMsg = new TextEncoder().encode(`${req.prog}: tool not allowed by security policy\n`);
    const stderrTarget = fdTable.get(2);
    if (stderrTarget?.type === 'buffer') { stderrTarget.buf.push(errMsg); stderrTarget.total += errMsg.byteLength; }
    else if (stderrTarget?.type === 'pipe_write') stderrTarget.pipe.write(errMsg);
    for (const [fd] of fdTable) kernel.closeFd(pid, fd);
    kernel.registerExited(pid, 126, parentPid);
    return pid;
  }

  const pid = kernel.allocPid(parentPid, `${req.prog} ${req.args.join(' ')}`);

  // Check for host commands (TypeScript handlers) first
  const hostCmdEntry = mgr.getHostCommand(req.prog);
  if (hostCmdEntry) {
    for (const [fd, target] of fdTable) kernel.setFdTarget(pid, fd, target);
    // Execute host command asynchronously
    const promise = (async () => {
      // Read stdin from fd 0 if available
      let stdinStr = '';
      const stdinTarget = fdTable.get(0);
      if (stdinTarget?.type === 'pipe_read') {
        stdinStr = new TextDecoder().decode(stdinTarget.pipe.drainSync());
      } else if (stdinTarget?.type === 'static') {
        stdinStr = new TextDecoder().decode(stdinTarget.data);
      }
      try {
        // Intercept --help: return the extension's description if available
        let result;
        if (req.args.includes('--help') && hostCmdEntry.description) {
          result = { stdout: hostCmdEntry.description + '\n', exitCode: 0 };
        } else {
          result = await hostCmdEntry.handler({
            args: req.args,
            stdin: stdinStr,
            env: Object.fromEntries(req.env),
            cwd: req.cwd,
          });
        }
        // Write stdout/stderr to fd targets
        if (result.stdout) {
          const data = new TextEncoder().encode(result.stdout);
          const out = fdTable.get(1);
          if (out?.type === 'buffer') { out.buf.push(data); out.total += data.byteLength; }
          else if (out?.type === 'pipe_write') out.pipe.write(data);
        }
        if (result.stderr) {
          const data = new TextEncoder().encode(result.stderr);
          const err = fdTable.get(2);
          if (err?.type === 'buffer') { err.buf.push(data); err.total += data.byteLength; }
          else if (err?.type === 'pipe_write') err.pipe.write(data);
        }
        for (const [fd] of fdTable) kernel.closeFd(pid, fd);
        kernel.registerExited(pid, result.exitCode);
      } catch (e: unknown) {
        const msg = new TextEncoder().encode(`${req.prog}: ${e instanceof Error ? e.message : String(e)}\n`);
        const err = fdTable.get(2);
        if (err?.type === 'buffer') { err.buf.push(msg); err.total += msg.byteLength; }
        else if (err?.type === 'pipe_write') err.pipe.write(msg);
        for (const [fd] of fdTable) kernel.closeFd(pid, fd);
        kernel.registerExited(pid, 1);
      }
    })();
    kernel.attachProcess(pid, promise, null);
    return pid;
  }

  const module = mgr.getModule(req.prog);
  if (!module) return -1;

  // Store fd targets in the kernel so cleanupFds can close them on exit.
  // This ensures pipe write ends get closed when the child process exits,
  // signaling EOF to downstream readers.
  for (const [fd, target] of fdTable) {
    kernel.setFdTarget(pid, fd, target);
  }

  // argv[0] defaults to the tool name, but callers (e.g. the shell executor
  // dispatching a BusyBox applet symlink) may override it so multicall
  // binaries see the user-facing command name.
  const argv0 = req.argv0 ?? req.prog;
  const host = new WasiHost({
    vfs: mgr.getVfs(),
    args: [argv0, ...req.args],
    env: Object.fromEntries(req.env),
    preopens: { '/': '/' },
    ioFds: fdTable,
    deadlineMs,
  });

  const imports = host.getImports() as WebAssembly.Imports & Record<string, Record<string, unknown>>;

  // If memoryBytes is set, inject a bounded memory into the import object
  if (memoryBytes !== undefined) {
    const maxPages = Math.ceil(memoryBytes / 65536);
    const moduleImports = WebAssembly.Module.imports(module);
    for (const imp of moduleImports) {
      if (imp.kind === 'memory') {
        const mem = new WebAssembly.Memory({ initial: 1, maximum: maxPages });
        if (!imports[imp.module]) imports[imp.module] = {} as WebAssembly.ModuleImports & Record<string, unknown>;
        (imports[imp.module] as Record<string, unknown>)[imp.name] = mem;
      }
    }
  }

  // JSPI-wrap fd_read/fd_write for pipe suspension in the child process.
  if (typeof WebAssembly.Suspending === 'function') {
    imports.wasi_snapshot_preview1.fd_read = new WebAssembly.Suspending(
      imports.wasi_snapshot_preview1.fd_read as (...args: number[]) => number,
    ) as unknown as WebAssembly.ImportValue;
    imports.wasi_snapshot_preview1.fd_write = new WebAssembly.Suspending(
      imports.wasi_snapshot_preview1.fd_write as (...args: number[]) => number,
    ) as unknown as WebAssembly.ImportValue;
  }

  // Helper: check memory limit post-instantiation, write error and bail if exceeded.
  const checkMemLimit = (instance: WebAssembly.Instance): boolean => {
    if (memoryBytes === undefined) return false;
    const mem = instance.exports.memory as WebAssembly.Memory | undefined;
    if (!mem) return false;
    const modImports = WebAssembly.Module.imports(module);
    const hasMemoryImport = modImports.some(imp => imp.kind === 'memory');
    if (!hasMemoryImport || mem.buffer.byteLength > memoryBytes) {
      const errMsg = new TextEncoder().encode('memory limit exceeded\n');
      const stderrTarget = kernel.getFdTarget(pid, 2);
      if (stderrTarget?.type === 'buffer') { stderrTarget.buf.push(errMsg); stderrTarget.total += errMsg.byteLength; }
      else if (stderrTarget?.type === 'pipe_write') stderrTarget.pipe.write(errMsg);
      for (const [fd] of fdTable) kernel.closeFd(pid, fd);
      kernel.registerExited(pid, 1);
      return true; // exceeded
    }
    return false;
  };

  const handleInstantiationError = (err?: unknown) => {
    let msg = 'memory limit exceeded\n';
    if (memoryBytes !== undefined) {
      // Memory-limited spawn — generic memory error
    } else if (err instanceof Error) {
      msg = `${err.message}\n`;
    }
    const errMsg = new TextEncoder().encode(msg);
    const stderrTarget = kernel.getFdTarget(pid, 2);
    if (stderrTarget?.type === 'buffer') { stderrTarget.buf.push(errMsg); stderrTarget.total += errMsg.byteLength; }
    else if (stderrTarget?.type === 'pipe_write') stderrTarget.pipe.write(errMsg);
    for (const [fd] of fdTable) kernel.closeFd(pid, fd);
    kernel.registerExited(pid, 1);
  };

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
      wasiHost: host,
      networkBridge,
      extensionRegistry,
      nativeModules: mgr.nativeModules,
      runCommand,
      // The child's spawn calls record the child's pid as the new
      // grandchild's ppid — this is how getppid() resolves to the real
      // parent at every level of the process tree.
      spawnProcess: (req2, fdTable2, grandparentPid) => spawnAsyncProcess(req2, fdTable2, mgr, kernel, adapter, deadlineMs, memoryBytes, networkBridge, extensionRegistry, runCommand, grandparentPid),
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
      imports.codepod.host_network_fetch = new WebAssembly.Suspending(
        childKernelImports.host_network_fetch as (...args: number[]) => Promise<number>,
      ) as unknown as WebAssembly.ImportValue;
      // Python uses host_extension_invoke for _codepod.extension_call()
      imports.codepod.host_extension_invoke = new WebAssembly.Suspending(
        childKernelImports.host_extension_invoke as (...args: number[]) => Promise<number>,
      ) as unknown as WebAssembly.ImportValue;
      // Python uses host_run_command for _codepod.spawn() / subprocess support
      imports.codepod.host_run_command = new WebAssembly.Suspending(
        childKernelImports.host_run_command as (...args: number[]) => Promise<number>,
      ) as unknown as WebAssembly.ImportValue;
    }

    // Start the process asynchronously
    adapter.instantiate(module, imports).then((instance) => {
      if (checkMemLimit(instance)) return;
      childMemRef = instance.exports.memory as WebAssembly.Memory;
      host.setMemory(childMemRef);

      let startFn = instance.exports._start as Function;
      if (typeof (WebAssembly as any).promising === 'function') {
        startFn = (WebAssembly as any).promising(startFn);
      }

      const promise = Promise.resolve().then(() => startFn()).catch(() => {});
      kernel.attachProcess(pid, promise, host);
    }).catch(handleInstantiationError);
  } else {
    // Module doesn't need codepod imports — simpler path
    adapter.instantiate(module, imports).then((instance) => {
      if (checkMemLimit(instance)) return;
      host.setMemory(instance.exports.memory as WebAssembly.Memory);

      let startFn = instance.exports._start as Function;
      if (typeof (WebAssembly as any).promising === 'function') {
        startFn = (WebAssembly as any).promising(startFn);
      }

      const promise = Promise.resolve().then(() => startFn()).catch(() => {});
      kernel.attachProcess(pid, promise, host);
    }).catch(handleInstantiationError);
  }

  return pid;
}

/**
 * Synchronous spawn for testing.
 *
 * When syncSpawn is provided, external commands are handled by the test's
 * callback instead of instantiating real WASM modules. The callback's
 * stdout/stderr are written to the child's fd targets (which point to the
 * shell's kernel buffers), and the process is registered as already exited.
 */
function spawnSyncProcess(
  req: SpawnRequest,
  fdTable: Map<number, FdTarget>,
  kernel: ProcessKernel,
  syncSpawn: NonNullable<ShellInstanceOptions['syncSpawn']>,
  parentPid: number = NO_PARENT_PID,
): number {
  const pid = kernel.allocPid(parentPid, `${req.prog} ${req.args.join(' ')}`);

  // Store fd targets in the kernel for cleanup
  for (const [fd, target] of fdTable) {
    kernel.setFdTarget(pid, fd, target);
  }

  const env: Record<string, string> = {};
  for (const [k, v] of req.env) env[k] = v;

  // Build stdin: prefer stdin_data, then drain pipe/static from fd 0
  let stdin: Uint8Array;
  if (req.stdin_data) {
    stdin = new TextEncoder().encode(req.stdin_data);
  } else {
    const stdinTarget = fdTable.get(0);
    if (stdinTarget?.type === 'pipe_read') {
      stdin = stdinTarget.pipe.drainSync();
    } else if (stdinTarget?.type === 'static') {
      stdin = stdinTarget.data.subarray(stdinTarget.offset);
      stdinTarget.offset = stdinTarget.data.byteLength;
    } else {
      stdin = new Uint8Array(0);
    }
  }

  let result: { exit_code: number; stdout: string; stderr: string };
  try {
    result = syncSpawn(req.prog, req.args, env, stdin, req.cwd);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    result = { exit_code: 127, stdout: '', stderr: `${req.prog}: ${msg}\n` };
  }

  const enc = new TextEncoder();

  // Write stdout to the child's fd 1 target
  const stdoutTarget = fdTable.get(1);
  if (stdoutTarget && result.stdout) {
    const data = enc.encode(result.stdout);
    if (stdoutTarget.type === 'buffer') {
      stdoutTarget.buf.push(data);
      stdoutTarget.total += data.byteLength;
    } else if (stdoutTarget.type === 'pipe_write') {
      stdoutTarget.pipe.write(data);
    }
  }

  // Write stderr to the child's fd 2 target
  const stderrTarget = fdTable.get(2);
  if (stderrTarget && result.stderr) {
    const data = enc.encode(result.stderr);
    if (stderrTarget.type === 'buffer') {
      stderrTarget.buf.push(data);
      stderrTarget.total += data.byteLength;
    } else if (stderrTarget.type === 'pipe_write') {
      stderrTarget.pipe.write(data);
    }
  }

  // Close child fds (decrements pipe refcounts, signals EOF)
  for (const [fd] of fdTable) {
    kernel.closeFd(pid, fd);
  }

  // Register as already exited so waitpid returns immediately
  kernel.registerExited(pid, result.exit_code);

  return pid;
}
