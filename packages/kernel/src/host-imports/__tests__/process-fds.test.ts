import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { createKernelImports } from "../kernel-imports.ts";
import { ProcessKernel } from "../../process/kernel.ts";
import { createAsyncPipe } from "../../vfs/pipe.ts";
import { VFS } from "../../vfs/vfs.ts";
import { WasiHost } from "../../wasi/wasi-host.ts";

Deno.test("host_dup2 duplicates kernel-backed io fds without moving the source", () => {
  const kernel = new ProcessKernel();
  const pid = kernel.allocPid();
  const ioFds = kernel.getFdTable(pid);
  const [, writeEnd] = createAsyncPipe();
  ioFds.set(7, { type: "pipe_write", pipe: writeEnd });

  const wasiHost = new WasiHost({
    vfs: new VFS(),
    args: ["program"],
    env: {},
    preopens: { "/": "/" },
    ioFds,
    kernel,
    pid,
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  wasiHost.setMemory(memory);

  const imports = createKernelImports({
    memory,
    callerPid: pid,
    kernel,
    wasiHost,
  });

  assertEquals(imports.host_dup2(7, 1), 0);
  assertEquals(kernel.getFdTarget(pid, 7)?.type, "pipe_write");
  assertEquals(kernel.getFdTarget(pid, 1)?.type, "pipe_write");
});
