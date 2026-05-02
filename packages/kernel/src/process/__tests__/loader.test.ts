import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.19";
import { resolve } from "node:path";
import { createKernelImports } from "../../host-imports/kernel-imports.ts";
import { NodeAdapter } from "../../platform/node-adapter.ts";
import { VFS } from "../../vfs/vfs.ts";
import {
  bufferToString,
  createBufferTarget,
  createNullTarget,
  type FdTarget,
} from "../../wasi/fd-target.ts";
import { WasiHost } from "../../wasi/wasi-host.ts";
import { NO_PARENT_PID, ProcessKernel } from "../kernel.ts";
import { type LoaderContext, loadProcess } from "../loader.ts";
import { Sandbox } from "../../sandbox.ts";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../../platform/__tests__/fixtures",
);

async function makeLoaderContext(options: { maxProcesses?: number } = {}) {
  const vfs = new VFS();
  const adapter = new NodeAdapter();
  const kernel = new ProcessKernel({ maxProcesses: options.maxProcesses });
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

function malformedContinuationWasm(): Uint8Array {
  const enc = new TextEncoder();
  const u32 = (value: number): number[] => {
    const bytes: number[] = [];
    let n = value >>> 0;
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n !== 0) byte |= 0x80;
      bytes.push(byte);
    } while (n !== 0);
    return bytes;
  };
  const utf8 = (s: string): number[] => [...enc.encode(s)];
  const name = (s: string): number[] => {
    const bytes = utf8(s);
    return [...u32(bytes.length), ...bytes];
  };
  const section = (id: number, payload: number[]): number[] => [
    id,
    ...u32(payload.length),
    ...payload,
  ];
  const exportEntry = (
    nameText: string,
    kind: number,
    index: number,
  ): number[] => [
    ...name(nameText),
    kind,
    ...u32(index),
  ];
  const body = (instructions: number[]): number[] => [
    ...u32(instructions.length + 1),
    0x00,
    ...instructions,
  ];
  const customName = utf8("codepod.features");
  const customPayload = utf8(JSON.stringify({ features: ["continuations"] }));

  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, [
      ...u32(2),
      0x60,
      0x00,
      0x00,
      0x60,
      0x00,
      0x01,
      0x7f,
    ]),
    ...section(3, [
      ...u32(6),
      0,
      0,
      0,
      0,
      1,
      0,
    ]),
    ...section(5, [
      ...u32(1),
      0x00,
      0x01,
    ]),
    ...section(7, [
      ...u32(7),
      ...exportEntry("memory", 0x02, 0),
      ...exportEntry("asyncify_start_unwind", 0x00, 0),
      ...exportEntry("asyncify_stop_unwind", 0x00, 1),
      ...exportEntry("asyncify_start_rewind", 0x00, 2),
      ...exportEntry("asyncify_stop_rewind", 0x00, 3),
      ...exportEntry("asyncify_get_state", 0x00, 4),
      ...exportEntry("_start", 0x00, 5),
    ]),
    ...section(10, [
      ...u32(6),
      ...body([0x0b]),
      ...body([0x0b]),
      ...body([0x0b]),
      ...body([0x0b]),
      ...body([0x41, 0x00, 0x0b]),
      ...body([0x0b]),
    ]),
    ...section(0, [
      ...u32(customName.length),
      ...customName,
      ...customPayload,
    ]),
  ]);
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

Deno.test("loadProcess rolls back pid when asyncify initialization fails", async () => {
  const ctx = await makeLoaderContext({ maxProcesses: 1 });
  ctx.vfs.withWriteAccess(() => {
    ctx.vfs.writeFile(
      "/bin/malformed-continuation",
      malformedContinuationWasm(),
    );
    ctx.vfs.chmod("/bin/malformed-continuation", 0o755);
  });

  await assertRejects(
    () =>
      loadProcess(ctx, {
        argv: ["/bin/malformed-continuation"],
        mode: "cli",
      }),
    Error,
    "asyncify requires codepod_asyncify_buf_addr/size or __alloc exports",
  );
  assertEquals(ctx.kernel.getReservedProcessCount(), 0);
  assertEquals(ctx.kernel.canReserveProcessSlot(), true);
});

Deno.test("loadProcess can preserve pre-registered child state when caller owns rollback", async () => {
  const ctx = await makeLoaderContext();
  const bytes = await ctx.adapter.readBytes(`${WASM_DIR}/fork-canary.wasm`);
  ctx.vfs.withWriteAccess(() => {
    ctx.vfs.writeFile("/bin/broken-child", bytes);
    ctx.vfs.chmod("/bin/broken-child", 0o755);
  });

  const parentPid = ctx.kernel.allocPid(NO_PARENT_PID, "parent");
  const childPid = ctx.kernel.allocPid(parentPid, "/bin/broken-child");
  ctx.kernel.registerPending(childPid, "/bin/broken-child", parentPid);
  const stderrTarget = createBufferTarget(Infinity);
  ctx.kernel.adoptFdTable(
    childPid,
    new Map<number, FdTarget>([
      [0, createNullTarget()],
      [1, createBufferTarget(Infinity)],
      [2, stderrTarget],
    ]),
  );

  let caught = "";
  try {
    await loadProcess({
      ...ctx,
      allocatePid: () => childPid,
      buildKernelImports: () => ({}),
    }, {
      argv: ["/bin/broken-child"],
      mode: "cli",
      rollbackOnFailure: false,
    });
  } catch (e) {
    caught = e instanceof Error ? e.message : String(e);
    const target = ctx.kernel.getFdTarget(childPid, 2);
    assert(target?.type === "buffer");
    const data = new TextEncoder().encode(`/bin/broken-child: ${caught}\n`);
    target.buf.push(data);
    target.total += data.byteLength;
    ctx.kernel.releaseProcess(childPid, 127);
  }

  assert(caught.length > 0);
  assert(bufferToString(stderrTarget).includes("/bin/broken-child:"));
  assertEquals(await ctx.kernel.waitpid(childPid), 127);
  assertEquals(ctx.kernel.getReservedProcessCount(), 1);
  ctx.kernel.discardProcess(parentPid);
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
