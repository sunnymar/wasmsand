/**
 * Generic process loader. Instantiates a wasm guest, wires WASI + codepod
 * imports, runs _start, and returns a Process handle.
 */

import { Process, type ProcessMode } from "./handle.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import type { VfsLike } from "../vfs/vfs-like.js";
import type { ProcessKernel } from "./kernel.js";
import { WasiHost } from "../wasi/wasi-host.js";
import { createBufferTarget, createNullTarget, createStaticTarget } from "../wasi/fd-target.js";
import { AsyncifyAsyncBridge } from "../async-bridge.js";
import { CooperativeSerialBackend } from "./threads/cooperative-serial.js";
import { makeIndirectCallTable } from "./threads/indirect-call-table.js";
import type { ThreadsBackend } from "./threads/backend.js";
import { defaultWasmModuleCache, sha256Hex, type WasmModuleCache } from "./module-cache.js";
import {
  analyzeCodepodModule,
  validateCodepodModuleProfile,
} from "./module-profile.js";

export interface LoaderContext {
  vfs: VfsLike;
  adapter: PlatformAdapter;
  kernel: ProcessKernel;
  allocatePid(argv: string[]): number;
  releasePid(pid: number, exitCode: number): void;
  buildWasiHost(
    pid: number,
    argv: string[],
    env: Record<string, string>,
    cwd: string,
  ): WasiHost;
  buildKernelImports(
    pid: number,
    memory: WebAssembly.Memory,
    wasiHost: WasiHost,
    threadsBackend: ThreadsBackend,
  ): Record<string, WebAssembly.ImportValue>;
  makeFdReadAndClear(
    pid: number,
  ): (fd: 1 | 2) => { data: string; truncated: boolean };
  moduleCache?: WasmModuleCache;
}

export interface LoadProcessOptions {
  argv: string[];
  mode: ProcessMode;
  env?: Record<string, string>;
  cwd?: string;
  memoryBytes?: number;
  stdoutLimit?: number;
  stderrLimit?: number;
  extraCodepodImports?: (
    memory: WebAssembly.Memory,
    wasiHost: WasiHost,
  ) => Record<string, WebAssembly.ImportValue>;
}

export async function loadProcess(
  ctx: LoaderContext,
  opts: LoadProcessOptions,
): Promise<Process> {
  const { argv, mode } = opts;
  const path = argv[0];
  if (!path) throw new Error("loadProcess: argv[0] is required");

  const bytes = ctx.vfs.readFile(path);
  if (
    bytes.length < 4 || bytes[0] !== 0x00 || bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 || bytes[3] !== 0x6d
  ) {
    throw new Error(`loadProcess: ${path} is not a wasm binary`);
  }

  const digest = await sha256Hex(bytes);
  const module = await (ctx.moduleCache ?? defaultWasmModuleCache).getOrCompile(digest, bytes);
  const profile = validateCodepodModuleProfile(analyzeCodepodModule(module));
  const env = opts.env ?? {};
  const cwd = opts.cwd ?? "/";
  const pid = ctx.allocatePid(argv);

  ctx.kernel.initProcess(pid);
  if (!ctx.kernel.getFdTarget(pid, 0)) {
    ctx.kernel.setFdTarget(pid, 0, createNullTarget());
  }
  if (!ctx.kernel.getFdTarget(pid, 1)) {
    ctx.kernel.setFdTarget(pid, 1, createBufferTarget(opts.stdoutLimit ?? Infinity));
  }
  if (!ctx.kernel.getFdTarget(pid, 2)) {
    ctx.kernel.setFdTarget(pid, 2, createBufferTarget(opts.stderrLimit ?? Infinity));
  }

  const proc = Process.__forLoader({ pid, mode });
  const wasi = ctx.buildWasiHost(pid, argv, env, cwd);
  const wasiImports = wasi.getImports().wasi_snapshot_preview1;

  let memoryRef: WebAssembly.Memory | null = null;
  const memoryProxy = new Proxy({} as WebAssembly.Memory, {
    get(_target, prop) {
      if (!memoryRef) throw new Error("memory not initialized");
      const val =
        (memoryRef as unknown as Record<string | symbol, unknown>)[prop];
      return typeof val === "function" ? val.bind(memoryRef) : val;
    },
  });

  const asyncifyBridge = profile.bridge === "asyncify" ||
      typeof WebAssembly.Suspending !== "function"
    ? new AsyncifyAsyncBridge()
    : null;
  const threadsBackend = new CooperativeSerialBackend();

  const codepodImports: Record<string, WebAssembly.ImportValue> = {
    ...ctx.buildKernelImports(pid, memoryProxy, wasi, threadsBackend),
    ...(opts.extraCodepodImports?.(memoryProxy, wasi) ?? {}),
  };
  if (asyncifyBridge) {
    codepodImports.host_setjmp = asyncifyBridge
      .hostSetjmp as unknown as WebAssembly.ImportValue;
    codepodImports.host_longjmp = asyncifyBridge
      .hostLongjmp as unknown as WebAssembly.ImportValue;
  }
  wrapAsyncImports(codepodImports, [
    "host_waitpid",
    "host_yield",
    "host_network_fetch",
    "host_register_tool",
    "host_socket_accept",
    "host_extension_invoke",
    "host_run_command",
    "host_thread_spawn",
    "host_thread_join",
    "host_thread_detach",
    "host_thread_yield",
    "host_mutex_lock",
    "host_cond_wait",
  ], asyncifyBridge);
  wrapAsyncImports(
    wasiImports as Record<string, WebAssembly.ImportValue>,
    ["fd_read", "fd_write", "poll_oneoff"],
    asyncifyBridge,
  );

  const instance = await ctx.adapter.instantiate(module, {
    wasi_snapshot_preview1: wasiImports,
    codepod: codepodImports,
  });
  const table = instance.exports.__indirect_function_table;
  if (table instanceof WebAssembly.Table) {
    const promising =
      typeof WebAssembly.promising === "function"
        ? ((fn: unknown) => WebAssembly.promising(fn as Function))
        : ((fn: unknown) => fn);
    threadsBackend.setIndirectCallTable(
      makeIndirectCallTable(table, promising),
    );
  }

  memoryRef = instance.exports.memory as WebAssembly.Memory;
  if (opts.memoryBytes !== undefined && memoryRef.buffer.byteLength > opts.memoryBytes) {
    throw new Error(`memory limit exceeded: ${memoryRef.buffer.byteLength} > ${opts.memoryBytes}`);
  }
  proc.__setMemory(memoryRef);
  proc.__setFdReadAndClear(ctx.makeFdReadAndClear(pid));
  proc.__setStdin((data) => {
    ctx.kernel.setFdTarget(
      pid,
      0,
      data && data.byteLength > 0 ? createStaticTarget(data) : createNullTarget(),
    );
  });

  const asyncifyInitialized = asyncifyBridge
    ? initAsyncifyBridge(asyncifyBridge, instance)
    : false;
  // Async pipe reads are a suspension capability, not a setjmp feature:
  // JSPI supports them for every module; non-JSPI runtimes need the current
  // module to be Asyncify-instrumented.
  wasi.setCanSuspendPipeReads(
    typeof WebAssembly.Suspending === "function" || asyncifyInitialized,
  );

  const rawStart = instance.exports._start as (() => unknown) | undefined;
  const startFn = rawStart
    ? asyncifyBridge && asyncifyInitialized
      ? asyncifyBridge.wrapExport(rawStart as () => number)
      : !asyncifyBridge && typeof WebAssembly.promising === "function"
      ? WebAssembly.promising(rawStart)
      : rawStart
    : undefined;
  let exitCode: number;
  try {
    exitCode = await wasi.startAsync(instance, startFn);
  } catch (e) {
    const stderr = proc.fdReadAndClear(2).data.trimEnd();
    if (stderr) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`${message}\n${stderr}`, { cause: e });
    }
    throw e;
  }
  if (mode === "cli") proc.exitCode = exitCode;

  const wrappedExports: Record<string, (...args: number[]) => unknown> = {};
  for (const [name, raw] of Object.entries(instance.exports)) {
    if (typeof raw !== "function") continue;
    if (
      !asyncifyBridge &&
      typeof WebAssembly.promising === "function" &&
      shouldAsyncWrapExport(name)
    ) {
      wrappedExports[name] = WebAssembly.promising(
        raw as (...args: number[]) => unknown,
      );
    } else if (
      asyncifyBridge && asyncifyInitialized && shouldAsyncifyWrapExport(name)
    ) {
      wrappedExports[name] = asyncifyBridge.wrapExport(
        raw as (...args: number[]) => number,
      );
    } else {
      wrappedExports[name] = raw as (...args: number[]) => unknown;
    }
  }
  proc.__setExports({ exports: wrappedExports });

  proc.__setTerminate(async () => {
    ctx.releasePid(pid, proc.exitCode ?? 0);
  });

  return proc;
}

function wrapAsyncImports(
  imports: Record<string, WebAssembly.ImportValue>,
  names: string[],
  asyncifyBridge: AsyncifyAsyncBridge | null,
): void {
  for (const name of names) {
    const value = imports[name];
    if (typeof value !== "function") continue;

    if (asyncifyBridge) {
      imports[name] = asyncifyBridge.wrapImport(
        value as (...args: number[]) => Promise<number> | number,
      ) as WebAssembly.ImportValue;
    } else if (typeof WebAssembly.Suspending === "function") {
      imports[name] = new WebAssembly.Suspending(
        value as (...args: number[]) => unknown,
      ) as unknown as WebAssembly.ImportValue;
    }
  }
}

function initAsyncifyBridge(
  bridge: AsyncifyAsyncBridge,
  instance: WebAssembly.Instance,
): boolean {
  const exports = instance.exports;
  const hasAsyncifyState =
    typeof exports.asyncify_start_unwind === "function" &&
    typeof exports.asyncify_stop_unwind === "function" &&
    typeof exports.asyncify_start_rewind === "function" &&
    typeof exports.asyncify_stop_rewind === "function" &&
    typeof exports.asyncify_get_state === "function";
  if (!hasAsyncifyState) return false;

  const addrExport = exports.codepod_asyncify_buf_addr as (() => number) | undefined;
  const sizeExport = exports.codepod_asyncify_buf_size as (() => number) | undefined;
  const alloc = exports.__alloc as ((size: number) => number) | undefined;

  let dataAddr: number;
  let asyncifyBufSize: number;
  if (typeof addrExport === "function" && typeof sizeExport === "function") {
    dataAddr = addrExport();
    asyncifyBufSize = sizeExport();
  } else if (alloc) {
    asyncifyBufSize = 65536;
    dataAddr = alloc(asyncifyBufSize);
  } else {
    throw new Error("asyncify requires codepod_asyncify_buf_addr/size or __alloc exports");
  }

  const memory = exports.memory as WebAssembly.Memory;
  const view = new DataView(memory.buffer);
  view.setUint32(dataAddr, dataAddr + 8, true);
  view.setUint32(dataAddr + 4, dataAddr + asyncifyBufSize, true);
  bridge.initFromInstance(instance, dataAddr, asyncifyBufSize);
  return true;
}

function shouldAsyncifyWrapExport(name: string): boolean {
  return shouldAsyncWrapExport(name);
}

function shouldAsyncWrapExport(name: string): boolean {
  return ![
    "__alloc",
    "__dealloc",
    "asyncify_start_unwind",
    "asyncify_stop_unwind",
    "asyncify_start_rewind",
    "asyncify_stop_rewind",
    "asyncify_get_state",
    "codepod_asyncify_buf_addr",
    "codepod_asyncify_buf_size",
  ].includes(name);
}
