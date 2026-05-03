import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { createKernelImports } from "../kernel-imports.ts";
import { readString } from "../common.ts";
import { ProcessKernel } from "../../process/kernel.ts";
import { VFS } from "../../vfs/vfs.ts";
import { FdTable } from "../../vfs/fd-table.ts";
import { createVfsFileTarget } from "../../wasi/fd-target.ts";

const encoder = new TextEncoder();

function writeString(memory: WebAssembly.Memory, ptr: number, value: string) {
  const bytes = encoder.encode(value);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

function readJson(memory: WebAssembly.Memory, ptr: number, len: number) {
  return JSON.parse(readString(memory, ptr, len)) as Record<string, unknown>;
}

Deno.test("kernel host_spawn preserves shell's legacy synchronous result ABI", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const request = JSON.stringify({
    program: "echo",
    args: ["hello"],
    env: [["A", "B"]],
    cwd: "/tmp",
    stdin: "input",
  });
  const reqLen = writeString(memory, 0, request);

  const imports = createKernelImports({
    memory,
    syncSpawn: (cmd, args, env, stdin, cwd) => {
      assertEquals(cmd, "echo");
      assertEquals(args, ["hello"]);
      assertEquals(env, { A: "B" });
      assertEquals(new TextDecoder().decode(stdin), "input");
      assertEquals(cwd, "/tmp");
      return { exit_code: 0, stdout: "hello\n", stderr: "" };
    },
  });

  const written = (imports.host_spawn as (...args: number[]) => number)(
    0,
    reqLen,
    4096,
    1024,
  );

  assertEquals(readJson(memory, 4096, written), {
    exit_code: 0,
    stdout: "hello\n",
    stderr: "",
  });
});

Deno.test("kernel host_spawn reserves a process slot before fd cloning", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel({ maxProcesses: 1 });
  const parentPid = kernel.allocPid();
  const request = JSON.stringify({
    prog: "/bin/cat",
    args: [],
    env: [],
    cwd: "/",
    stdin_fd: 0,
    stdout_fd: 1,
    stderr_fd: 2,
  });
  const reqLen = writeString(memory, 0, request);
  let spawned = false;

  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
    spawnProcess: () => {
      spawned = true;
      return 123;
    },
  });

  const pid = (imports.host_spawn as (...args: number[]) => number)(0, reqLen);
  assertEquals(pid, -1);
  assertEquals(spawned, false);
  assertEquals(kernel.getReservedProcessCount(), 1);
  assertEquals(kernel.getPpid(2), 0);
  assertEquals(kernel.getFdTarget(2, 0), null);
  kernel.dispose();
});

Deno.test("kernel host_spawn releases cloned fd refs when spawnProcess fails", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel({ maxProcesses: 2 });
  const parentPid = kernel.allocPid();
  const vfs = new VFS();
  vfs.writeFile("/tmp/in.txt", new TextEncoder().encode("data"));
  const fdTable = new FdTable(vfs);
  const fd = fdTable.open("/tmp/in.txt", "r");
  const target = createVfsFileTarget(fdTable, fd);
  kernel.setFdTarget(parentPid, 0, target);
  const request = JSON.stringify({
    prog: "/bin/cat",
    args: [],
    env: [],
    cwd: "/",
    stdin_fd: 0,
    stdout_fd: 1,
    stderr_fd: 2,
  });
  const reqLen = writeString(memory, 0, request);

  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
    spawnProcess: () => {
      throw new Error("boom");
    },
  });

  const pid = (imports.host_spawn as (...args: number[]) => number)(0, reqLen);
  assertEquals(pid, -1);
  assertEquals(target.refs, 1);
  assertEquals(fdTable.isOpen(fd), true);
  assertEquals(kernel.getReservedProcessCount(), 1);
  kernel.dispose();
});

Deno.test("kernel host_waitpid only reaps children of the caller", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const parentPid = kernel.allocPid();
  const siblingPid = kernel.allocPid();
  const childPid = kernel.allocPid(parentPid, "child");
  kernel.releaseProcess(childPid, 5);

  const siblingImports = createKernelImports({
    memory,
    kernel,
    callerPid: siblingPid,
  });
  const deniedLen = await (siblingImports.host_waitpid as (...args: number[]) => Promise<number>)(
    childPid,
    4096,
    1024,
  );
  assertEquals(readJson(memory, 4096, deniedLen), { pid: childPid, exit_code: -1 });
  assertEquals(kernel.hasProcess(childPid), true);

  const parentImports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
  });
  const waitedLen = await (parentImports.host_waitpid as (...args: number[]) => Promise<number>)(
    childPid,
    4096,
    1024,
  );
  assertEquals(readJson(memory, 4096, waitedLen), { pid: childPid, exit_code: 5 });
  assertEquals(kernel.hasProcess(childPid), false);
  kernel.dispose();
});

Deno.test("kernel host_waitpid_nohang distinguishes running from ECHILD", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const parentPid = kernel.allocPid();
  const siblingPid = kernel.allocPid();
  const childPid = kernel.allocPid(parentPid, "child");

  const parentImports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
  });
  const siblingImports = createKernelImports({
    memory,
    kernel,
    callerPid: siblingPid,
  });

  assertEquals((parentImports.host_waitpid_nohang as (pid: number) => number)(childPid), -1);
  assertEquals((siblingImports.host_waitpid_nohang as (pid: number) => number)(childPid), -2);
  assertEquals((parentImports.host_waitpid_nohang as (pid: number) => number)(999), -2);
  kernel.dispose();
});

Deno.test("kernel host_waitpid_nohang reaps any exited child for pid -1", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = new ProcessKernel();
  const parentPid = kernel.allocPid();
  const runningPid = kernel.allocPid(parentPid, "running");
  const exitedPid = kernel.allocPid(parentPid, "exited");
  kernel.releaseProcess(exitedPid, 8);

  const imports = createKernelImports({
    memory,
    kernel,
    callerPid: parentPid,
  });

  const written = (imports.host_waitpid_nohang as (pid: number, outPtr: number, outCap: number) => number)(
    -1,
    4096,
    1024,
  );

  assertEquals(readJson(memory, 4096, written), { pid: exitedPid, exit_code: 8 });
  assertEquals(kernel.hasProcess(exitedPid), false);
  assertEquals(kernel.hasProcess(runningPid), true);
  assertEquals((imports.host_waitpid_nohang as (pid: number, outPtr: number, outCap: number) => number)(
    -1,
    4096,
    1024,
  ), -1);
  kernel.dispose();
});
