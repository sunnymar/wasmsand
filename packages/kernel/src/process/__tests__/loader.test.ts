import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { resolve } from "node:path";
import { createKernelImports } from "../../host-imports/kernel-imports.ts";
import { NodeAdapter } from "../../platform/node-adapter.ts";
import { VFS } from "../../vfs/vfs.ts";
import { bufferToString, type FdTarget } from "../../wasi/fd-target.ts";
import { WasiHost } from "../../wasi/wasi-host.ts";
import { NO_PARENT_PID, ProcessKernel } from "../kernel.ts";
import { loadProcess, type LoaderContext } from "../loader.ts";
import { Sandbox } from "../../sandbox.ts";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../../platform/__tests__/fixtures",
);

async function makeLoaderContext() {
  const vfs = new VFS();
  const adapter = new NodeAdapter();
  const kernel = new ProcessKernel();
  const bytes = await adapter.readBytes(`${WASM_DIR}/true-cmd.wasm`);

  vfs.withWriteAccess(() => {
    vfs.mkdirp("/bin");
    vfs.writeFile("/bin/true", bytes);
    vfs.chmod("/bin/true", 0o755);
  });

  return {
    vfs,
    adapter,
    kernel,
    allocatePid: (argv: string[]) => kernel.allocPid(NO_PARENT_PID, argv[0]),
    releasePid: (pid: number, exitCode: number) =>
      kernel.releaseProcess(pid, exitCode),
    buildWasiHost: (
      pid: number,
      argv: string[],
      env: Record<string, string>,
      cwd: string,
    ) => {
      assertEquals(cwd, "/");
      const ioFds = new Map<number, FdTarget>();
      ioFds.set(0, kernel.getFdTarget(pid, 0)!);
      ioFds.set(1, kernel.getFdTarget(pid, 1)!);
      ioFds.set(2, kernel.getFdTarget(pid, 2)!);
      return new WasiHost({
        vfs,
        args: argv,
        env,
        preopens: { "/": "/" },
        ioFds,
        kernel,
        pid,
      });
    },
    buildKernelImports: (
      pid: number,
      memory: WebAssembly.Memory,
      wasiHost: WasiHost,
      threadsBackend: Parameters<LoaderContext["buildKernelImports"]>[3],
    ) =>
      createKernelImports({
        memory,
        callerPid: pid,
        kernel,
        wasiHost,
        threadsBackend,
      }),
    makeFdReadAndClear: (pid: number) => (fd: 1 | 2) => {
      const target = kernel.getFdTarget(pid, fd);
      if (!target || target.type !== "buffer") {
        return { data: "", truncated: false };
      }
      const data = bufferToString(target);
      const truncated = !!target.truncated;
      target.buf.length = 0;
      target.total = 0;
      target.truncated = false;
      return { data, truncated };
    },
  };
}

Deno.test("loadProcess instantiates a CLI wasm at a VFS path and returns a Process", async () => {
  const ctx = await makeLoaderContext();
  const proc = await loadProcess(ctx, {
    argv: ["/bin/true"],
    mode: "cli",
  });

  assertEquals(proc.mode, "cli");
  assert(proc.pid > 0);
  assertEquals(proc.exitCode, 0);

  await proc.terminate();
  assertEquals(await ctx.kernel.waitpid(proc.pid), 0);
});

Deno.test("loadProcess runs a continuation fork canary", async () => {
  const ctx = await makeLoaderContext();
  const bytes = await ctx.adapter.readBytes(`${WASM_DIR}/fork-canary.wasm`);
  ctx.vfs.withWriteAccess(() => {
    ctx.vfs.writeFile("/bin/fork-canary", bytes);
    ctx.vfs.chmod("/bin/fork-canary", 0o755);
  });

  const proc = await loadProcess(ctx, {
    argv: ["/bin/fork-canary"],
    mode: "cli",
  });

  assertEquals(proc.exitCode, 0);
  assert(proc.fdReadAndClear(1).data.trim().startsWith("fork-ok child="));
  await proc.terminate();
});

Deno.test("loadProcess rolls back pid and fd state when instantiation fails", async () => {
  const ctx = await makeLoaderContext();
  const bytes = await ctx.adapter.readBytes(`${WASM_DIR}/fork-canary.wasm`);
  ctx.vfs.withWriteAccess(() => {
    ctx.vfs.writeFile("/bin/broken-fork-canary", bytes);
    ctx.vfs.chmod("/bin/broken-fork-canary", 0o755);
  });

  let failed = false;
  try {
    await loadProcess({
      ...ctx,
      buildKernelImports: () => ({}),
    }, {
      argv: ["/bin/broken-fork-canary"],
      mode: "cli",
    });
  } catch {
    failed = true;
  }

  assert(failed);
  assertEquals(ctx.kernel.getReservedProcessCount(), 0);
  assertEquals(ctx.kernel.canReserveProcessSlot(), true);
  assertEquals(ctx.kernel.getFdTarget(1, 0), null);
});

Deno.test("loader-backed resident shell supports Asyncify fallback without JSPI", async () => {
  const originalSuspending = WebAssembly.Suspending;
  const originalPromising = WebAssembly.promising;
  Object.defineProperty(WebAssembly, "Suspending", {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(WebAssembly, "promising", {
    value: undefined,
    configurable: true,
  });

  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR });
    const result = await sandbox.run("echo hello | cat");

    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, "hello\n");

    const fileResult = await sandbox.run(
      "echo file-data > /tmp/asyncify-loader.txt; cat /tmp/asyncify-loader.txt",
    );
    assertEquals(fileResult.exitCode, 0);
    assertEquals(fileResult.stdout, "file-data\n");

    const multiStageResult = await sandbox.run("seq 1 10 | head -5 | wc -l");
    assertEquals(multiStageResult.exitCode, 0);
    assertEquals(multiStageResult.stdout.trim(), "5");
  } finally {
    sandbox?.destroy();
    Object.defineProperty(WebAssembly, "Suspending", {
      value: originalSuspending,
      configurable: true,
    });
    Object.defineProperty(WebAssembly, "promising", {
      value: originalPromising,
      configurable: true,
    });
  }
});
