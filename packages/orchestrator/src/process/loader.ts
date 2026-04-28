/**
 * Generic process loader. Instantiates a wasm guest, wires WASI + codepod
 * imports, runs _start, and returns a Process handle.
 */

import { Process, type ProcessMode } from "./handle.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import type { VfsLike } from "../vfs/vfs-like.js";
import type { ProcessKernel } from "./kernel.js";
import { WasiHost } from "../wasi/wasi-host.js";
import { createBufferTarget, createNullTarget } from "../wasi/fd-target.js";
import { AsyncifyAsyncBridge } from "../async-bridge.js";

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
  ): Record<string, WebAssembly.ImportValue>;
  makeFdReadAndClear(
    pid: number,
  ): (fd: 1 | 2) => { data: string; truncated: boolean };
}

export interface LoadProcessOptions {
  argv: string[];
  mode: ProcessMode;
  env?: Record<string, string>;
  cwd?: string;
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

  const module = await WebAssembly.compile(bytes as BufferSource);
  const env = opts.env ?? {};
  const cwd = opts.cwd ?? "/";
  const pid = ctx.allocatePid(argv);

  ctx.kernel.initProcess(pid);
  ctx.kernel.setFdTarget(pid, 0, createNullTarget());
  ctx.kernel.setFdTarget(pid, 1, createBufferTarget());
  ctx.kernel.setFdTarget(pid, 2, createBufferTarget());

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

  const asyncifyBridge = typeof WebAssembly.Suspending === "function"
    ? null
    : new AsyncifyAsyncBridge();

  const codepodImports: Record<string, WebAssembly.ImportValue> = {
    ...ctx.buildKernelImports(pid, memoryProxy, wasi),
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
    "host_run_command",
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

  memoryRef = instance.exports.memory as WebAssembly.Memory;
  proc.__setMemory(memoryRef);
  proc.__setFdReadAndClear(ctx.makeFdReadAndClear(pid));

  const exitCode = wasi.start(instance);
  if (mode === "cli") proc.exitCode = exitCode;

  const asyncifyInitialized = asyncifyBridge
    ? initAsyncifyBridge(asyncifyBridge, instance)
    : false;

  const wrappedExports: Record<string, (...args: number[]) => unknown> = {};
  for (const [name, raw] of Object.entries(instance.exports)) {
    if (typeof raw !== "function") continue;
    if (typeof WebAssembly.promising === "function") {
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

    if (typeof WebAssembly.Suspending === "function") {
      imports[name] = new WebAssembly.Suspending(
        value as (...args: number[]) => unknown,
      ) as unknown as WebAssembly.ImportValue;
    } else if (asyncifyBridge) {
      imports[name] = asyncifyBridge.wrapImport(
        value as (...args: number[]) => Promise<number> | number,
      ) as WebAssembly.ImportValue;
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

  const alloc = exports.__alloc as ((size: number) => number) | undefined;
  if (!alloc) {
    throw new Error("asyncify requires __alloc export from the WASM binary");
  }

  const asyncifyBufSize = 65536;
  const dataAddr = alloc(asyncifyBufSize);
  const memory = exports.memory as WebAssembly.Memory;
  const view = new DataView(memory.buffer);
  view.setUint32(dataAddr, dataAddr + 8, true);
  view.setUint32(dataAddr + 4, dataAddr + asyncifyBufSize, true);
  bridge.initFromInstance(instance, dataAddr);
  return true;
}

function shouldAsyncifyWrapExport(name: string): boolean {
  return ![
    "__alloc",
    "__dealloc",
    "asyncify_start_unwind",
    "asyncify_stop_unwind",
    "asyncify_start_rewind",
    "asyncify_stop_rewind",
    "asyncify_get_state",
  ].includes(name);
}
