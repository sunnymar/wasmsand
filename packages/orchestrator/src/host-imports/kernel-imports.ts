/**
 * Unified host import implementations for the `codepod` WASM namespace.
 *
 * createKernelImports() returns a record of functions that form the `codepod`
 * import namespace consumed by ANY WASM process (shell, python, tool binaries).
 *
 * Syscalls provided:
 *   Process management (new):
 *   - host_pipe: create a pipe, returns read_fd and write_fd
 *   - host_spawn: spawn a child WASM process
 *   - host_waitpid: wait for a child process to exit (async, requires JSPI)
 *   - host_close_fd: close a file descriptor
 *
 *   Network / extensions:
 *   - host_network_fetch: HTTP fetch via NetworkBridge (async/JSPI)
 *   - host_extension_invoke: call a host extension (Python only; shell uses host_spawn)
 *   - host_run_command: run a shell command and collect output (async/JSPI, Python subprocess)
 */

import type { NetworkBridgeLike } from '../network/bridge.js';
import type { ExtensionRegistry } from '../extension/registry.js';
import type { NativeModuleRegistry } from '../process/native-modules.js';
import type { ProcessKernel, SpawnRequest } from '../process/kernel.js';
import type { WasiHost } from '../wasi/wasi-host.js';
import type { FdTarget } from '../wasi/fd-target.js';
import { createStaticTarget } from '../wasi/fd-target.js';
import { readString, writeJson } from './common.js';

export interface KernelImportsOptions {
  memory: WebAssembly.Memory;

  /** PID of the calling process (used for fd table lookups). */
  callerPid?: number;

  /** Process kernel for pipe/spawn/waitpid/close_fd. Optional until Task 8. */
  kernel?: ProcessKernel;

  /** Network bridge for synchronous HTTP fetch from WASM. */
  networkBridge?: NetworkBridgeLike;

  /**
   * Extension registry for host_extension_invoke (used by Python WASM).
   * The shell no longer calls host_extension_invoke — it routes everything
   * through host_spawn, and the ProcessManager dispatches to host commands.
   */
  extensionRegistry?: ExtensionRegistry;

  /**
   * Legacy extension handler (sync, used by Worker proxy).
   * If both extensionRegistry and extensionHandler are provided,
   * extensionRegistry takes precedence.
   */
  extensionHandler?: (cmd: Record<string, unknown>) => Record<string, unknown>;

  /** Run a shell command and collect output. Used by Python _codepod.spawn(). */
  runCommand?: (cmd: string, stdin: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

  /** Called by host_spawn to actually create and start a WASM process.
   *  `parentPid` is the PID of the in-sandbox process making the spawn
   *  call — set on the child as ppid so getppid() inside the child
   *  resolves to its real spawning parent. */
  spawnProcess?: (req: SpawnRequest, fdTable: Map<number, FdTarget>, parentPid: number) => number;

  /** Registry of dynamically loaded native Python module WASMs. */
  nativeModules?: NativeModuleRegistry;

  /** Active WASI host for guest-side fd operations such as dup2 on stdio. */
  wasiHost?: WasiHost;
}

export function createKernelImports(opts: KernelImportsOptions): Record<string, WebAssembly.ImportValue> {
  const { memory } = opts;
  const callerPid = opts.callerPid ?? 0;

  return {
    // ── Process management (new) ──

    // host_pipe(out_ptr, out_cap) -> i32
    // Creates a pipe and writes { read_fd, write_fd } as JSON to the output buffer.
    host_pipe(outPtr: number, outCap: number): number {
      if (!opts.kernel) {
        return writeJson(memory, outPtr, outCap, { error: 'kernel not available' });
      }
      const { readFd, writeFd } = opts.kernel.createPipe(callerPid);
      return writeJson(memory, outPtr, outCap, { read_fd: readFd, write_fd: writeFd });
    },

    // host_spawn(req_ptr, req_len) -> i32 (pid or -1 on error)
    // Spawns a child WASM process. The request is a JSON SpawnRequest.
    host_spawn(reqPtr: number, reqLen: number): number {
      const reqJson = readString(memory, reqPtr, reqLen);
      const req = JSON.parse(reqJson) as SpawnRequest;
      if (opts.spawnProcess && opts.kernel) {
        const fdTable = opts.kernel.buildFdTableForSpawn(callerPid, req);
        // If stdin_data is provided, override fd 0 with a static target
        if (req.stdin_data) {
          fdTable.set(0, createStaticTarget(new TextEncoder().encode(req.stdin_data)));
        }
        return opts.spawnProcess(req, fdTable, callerPid);
      }
      return -1;
    },

    // host_getpid() -> i32
    // Returns the pid of the calling process within the codepod kernel.
    host_getpid(): number {
      return callerPid;
    },

    // host_getppid() -> i32
    // Returns the parent pid of the calling process, or 0 if no
    // in-sandbox parent (the topmost process — typically the shell —
    // sees getppid() == 0, mirroring Linux init).
    host_getppid(): number {
      return opts.kernel ? opts.kernel.getPpid(callerPid) : 0;
    },

    // host_kill(pid, sig) -> i32
    // Best-effort signal delivery: cancels the target's WASI host so it
    // exits with WasiExitError(124).  This is enough for `kill -TERM` /
    // `kill -9` style termination from one in-sandbox process to another.
    // Returns 0 on success, -1 with errno=ESRCH (3) if no such process,
    // mirroring kill(2).
    host_kill(pid: number, sig: number): number {
      if (!opts.kernel) return -1;
      const exists = opts.kernel
        .listProcesses()
        .some(p => p.pid === pid && p.state !== 'exited');
      if (!exists) return -1;
      // sig 0 is the existence probe — POSIX requires no signal sent.
      if (sig === 0) return 0;
      return opts.kernel.killProcess(pid, sig) ? 0 : -1;
    },

    // host_waitpid(pid, out_ptr, out_cap) -> i32
    // Async — must be wrapped with WebAssembly.Suspending for JSPI.
    // Waits for the child process to exit and writes { exit_code } to the output buffer.
    async host_waitpid(pid: number, outPtr: number, outCap: number): Promise<number> {
      if (!opts.kernel) {
        return writeJson(memory, outPtr, outCap, { exit_code: -1 });
      }
      const exitCode = await opts.kernel.waitpid(pid);
      return writeJson(memory, outPtr, outCap, { exit_code: exitCode });
    },

    // host_close_fd(fd) -> i32
    // Closes a file descriptor in the caller's fd table.
    host_close_fd(fd: number): number {
      if (!opts.kernel) return -1;
      opts.kernel.closeFd(callerPid, fd);
      return 0;
    },

    // host_read_fd(fd, out_ptr, out_cap) -> i32
    // Reads all available data from a pipe fd and writes it to the output buffer.
    host_read_fd(fd: number, outPtr: number, outCap: number): number {
      if (!opts.kernel) {
        return writeJson(memory, outPtr, outCap, { error: 'kernel not available' });
      }
      const target = opts.kernel.getFdTarget(callerPid, fd);
      if (!target || target.type !== 'pipe_read') {
        return writeJson(memory, outPtr, outCap, { error: `not a readable fd: ${fd}` });
      }
      const data = target.pipe.drainSync();
      const str = new TextDecoder().decode(data);
      const buf = new Uint8Array(memory.buffer, outPtr, outCap);
      const encoded = new TextEncoder().encode(str);
      if (encoded.length > outCap) return encoded.length; // signal retry with larger buffer
      buf.set(encoded);
      return encoded.length;
    },

    // host_write_fd(fd, data_ptr, data_len) -> i32
    // Writes data to a pipe fd. Returns bytes written, or negative error code.
    host_write_fd(fd: number, dataPtr: number, dataLen: number): number {
      if (!opts.kernel) return -1;
      const target = opts.kernel.getFdTarget(callerPid, fd);
      if (!target || target.type !== 'pipe_write') {
        return -1;
      }
      const data = new Uint8Array(memory.buffer, dataPtr, dataLen);
      target.pipe.write(new Uint8Array(data)); // copy since wasm memory may shift
      return dataLen;
    },

    // host_dup(fd, out_ptr, out_cap) -> i32
    // Duplicates a file descriptor, returning a new fd pointing to the same target.
    host_dup(fd: number, outPtr: number, outCap: number): number {
      if (!opts.kernel) return -1;
      try {
        const newFd = opts.kernel.dup(callerPid, fd);
        return writeJson(memory, outPtr, outCap, { fd: newFd });
      } catch { return -1; }
    },

    // host_dup2(src_fd, dst_fd) -> i32
    // Makes dst_fd point to the same target as src_fd.
    host_dup2(srcFd: number, dstFd: number): number {
      if (opts.wasiHost) {
        return opts.wasiHost.renumberFd(srcFd, dstFd) === 0 ? 0 : -1;
      }
      if (!opts.kernel) return -1;
      try {
        opts.kernel.dup2(callerPid, srcFd, dstFd);
        return 0;
      } catch { return -1; }
    },

    // host_yield() -> void
    // Async — yields to the JS microtask queue, allowing other WASM stacks to run.
    // This is the cooperative scheduling primitive: sleep(0).
    async host_yield(): Promise<void> {
      await Promise.resolve();
    },

    // host_waitpid_nohang(pid) -> i32
    // Non-blocking: returns exit code if process exited, -1 if still running.
    host_waitpid_nohang(pid: number): number {
      if (!opts.kernel) return -1;
      return opts.kernel.waitpidNohang(pid);
    },

    // host_list_processes(out_ptr, out_cap) -> i32
    // Returns JSON array of all processes.
    host_list_processes(outPtr: number, outCap: number): number {
      if (!opts.kernel) return writeJson(memory, outPtr, outCap, []);
      const procs = opts.kernel.listProcesses();
      return writeJson(memory, outPtr, outCap, procs);
    },

    // ── Network ──

    // host_network_fetch(req_ptr, req_len, out_ptr, out_cap) -> i32
    // HTTP fetch via NetworkBridge. Async (JSPI) to support both SAB-based
    // bridges (Node/Deno) and direct fetch() in the browser.
    async host_network_fetch(reqPtr: number, reqLen: number, outPtr: number, outCap: number): Promise<number> {
      const reqJson = readString(memory, reqPtr, reqLen);

      const fetchError = (error: string) =>
        writeJson(memory, outPtr, outCap, { ok: false, status: 0, headers: {}, body: '', error });

      if (!opts.networkBridge) {
        return fetchError('networking not configured');
      }

      try {
        const req = JSON.parse(reqJson) as {
          url?: string;
          method?: string;
          headers?: Record<string, string>;
          body?: string;
        };
        const url = req.url as string;
        const method = (req.method as string) ?? 'GET';
        const headers = (req.headers as Record<string, string>) ?? {};
        const body = req.body as string | undefined;

        // Use async fetch if available (browser), otherwise fall back to sync (SAB bridge)
        const result = opts.networkBridge.fetchAsync
          ? await opts.networkBridge.fetchAsync(url, method, headers, body)
          : opts.networkBridge.fetchSync(url, method, headers, body);
        return writeJson(memory, outPtr, outCap, {
          ok: !result.error && result.status >= 200 && result.status < 400,
          status: result.status,
          headers: result.headers,
          body: result.body,
          body_base64: result.body_base64 ?? null,
          error: result.error ?? null,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return fetchError(msg);
      }
    },

    // ── Native module bridge ──

    // host_native_invoke(module_ptr, module_len, method_ptr, method_len,
    //                    args_ptr, args_len, out_ptr, out_cap) -> i32
    // Calls invoke() on a dynamically loaded native Python module WASM.
    host_native_invoke(
      modulePtr: number, moduleLen: number,
      methodPtr: number, methodLen: number,
      argsPtr: number, argsLen: number,
      outPtr: number, outCap: number,
    ): number {
      if (!opts.nativeModules) {
        return writeJson(memory, outPtr, outCap, { error: 'native modules not available' });
      }
      const moduleName = readString(memory, modulePtr, moduleLen);
      const method = readString(memory, methodPtr, methodLen);
      const argsJson = readString(memory, argsPtr, argsLen);

      try {
        const result = opts.nativeModules.invoke(moduleName, method, argsJson);
        const encoded = new TextEncoder().encode(result);
        if (encoded.length > outCap) {
          return encoded.length; // signal need more space
        }
        new Uint8Array(memory.buffer, outPtr, encoded.length).set(encoded);
        return encoded.length;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { error: msg });
      }
    },

    // ── Sockets (full mode only) ──

    // host_socket_connect(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Opens a TCP or TLS socket to the given host:port.
    // Request JSON: { host, port, tls }
    // Response JSON: { ok, socket_id } or { ok: false, error }
    host_socket_connect(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      if (!opts.networkBridge) {
        return writeJson(memory, outPtr, outCap, { ok: false, error: 'networking not configured' });
      }
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        const result = opts.networkBridge.requestSync({
          op: 'connect', host: req.host, port: req.port, tls: req.tls ?? false,
        });
        return writeJson(memory, outPtr, outCap, result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_socket_send(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Sends data on an open socket.
    // Request JSON: { socket_id, data_b64 }
    // Response JSON: { ok, bytes_sent } or { ok: false, error }
    host_socket_send(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      if (!opts.networkBridge) {
        return writeJson(memory, outPtr, outCap, { ok: false, error: 'networking not configured' });
      }
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        const result = opts.networkBridge.requestSync({
          op: 'send', socket_id: req.socket_id, data_b64: req.data_b64,
        });
        return writeJson(memory, outPtr, outCap, result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_socket_recv(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Receives data from an open socket.
    // Request JSON: { socket_id, max_bytes }
    // Response JSON: { ok, data_b64 } or { ok: false, error }
    host_socket_recv(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      if (!opts.networkBridge) {
        return writeJson(memory, outPtr, outCap, { ok: false, error: 'networking not configured' });
      }
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        const result = opts.networkBridge.requestSync({
          op: 'recv', socket_id: req.socket_id, max_bytes: req.max_bytes ?? 65536,
        });
        return writeJson(memory, outPtr, outCap, result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_socket_close(req_ptr, req_len) -> i32
    // Closes an open socket.
    // Request JSON: { socket_id }
    // Returns 0 on success, -1 on error.
    host_socket_close(reqPtr: number, reqLen: number): number {
      if (!opts.networkBridge) return -1;
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        opts.networkBridge.requestSync({ op: 'close', socket_id: req.socket_id });
        return 0;
      } catch { return -1; }
    },

    // ── Extensions (Python only — shell routes through host_spawn) ──

    // host_extension_invoke(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Invokes a host extension. Used by Python's _codepod.extension_call().
    // The shell no longer calls this — it goes through host_spawn and the
    // ProcessManager dispatches to host commands.
    async host_extension_invoke(
      reqPtr: number, reqLen: number,
      outPtr: number, outCap: number,
    ): Promise<number> {
      const reqJson = readString(memory, reqPtr, reqLen);

      if (opts.extensionRegistry) {
        try {
          const req = JSON.parse(reqJson) as {
            name?: string;
            extension?: string;
            // When called from Python _codepod.extension_call(**kwargs), the entire
            // kwargs dict is serialized as the `args` field. Unpack it here.
            args?: string[] | Record<string, unknown>;
            stdin?: string;
            env?: [string, string][];
            cwd?: string;
          };

          const name = (req.name ?? req.extension ?? '') as string;

          // Python kwargs arrive as `args: {args: [...], stdin: "...", ...}`.
          // Detect and unpack that shape; otherwise treat args as a string array.
          let args: string[];
          let stdin: string;
          if (Array.isArray(req.args)) {
            args = req.args as string[];
            stdin = req.stdin ?? '';
          } else if (req.args && typeof req.args === 'object') {
            const kw = req.args as Record<string, unknown>;
            args = Array.isArray(kw.args) ? (kw.args as string[]) : [];
            stdin = typeof kw.stdin === 'string' ? kw.stdin : (req.stdin ?? '');
          } else {
            args = [];
            stdin = req.stdin ?? '';
          }

          const envObj: Record<string, string> = {};
          if (req.env) for (const [k, v] of req.env) envObj[k] = v;
          const cwd = req.cwd ?? '/';

          const result = await opts.extensionRegistry.invoke(name, {
            args, stdin, env: envObj, cwd,
          });

          return writeJson(memory, outPtr, outCap, {
            exit_code: result.exitCode,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return writeJson(memory, outPtr, outCap, {
            exit_code: 1, stdout: '', stderr: `${msg}\n`,
          });
        }
      }

      // Fall back to legacy extensionHandler (sync)
      if (opts.extensionHandler) {
        try {
          const req = JSON.parse(reqJson) as Record<string, unknown>;
          const result = opts.extensionHandler(req);
          return writeJson(memory, outPtr, outCap, result);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return writeJson(memory, outPtr, outCap, {
            exit_code: 1, stdout: '', stderr: `${msg}\n`,
          });
        }
      }

      return writeJson(memory, outPtr, outCap, {
        exit_code: 1, stdout: '', stderr: 'extensions not available\n',
      });
    },

    // host_run_command(req_ptr, req_len, out_ptr, out_cap) -> i32 (async/JSPI)
    // Runs a shell command and captures output. Used by Python _codepod.spawn().
    async host_run_command(
      reqPtr: number, reqLen: number,
      outPtr: number, outCap: number,
    ): Promise<number> {
      if (!opts.runCommand) {
        return writeJson(memory, outPtr, outCap, {
          exit_code: 1, stdout: '', stderr: 'subprocess not available\n',
        });
      }
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen)) as { cmd: string; stdin?: string };
        const result = await opts.runCommand(req.cmd, req.stdin ?? '');
        return writeJson(memory, outPtr, outCap, {
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, {
          exit_code: 1, stdout: '', stderr: `${msg}\n`,
        });
      }
    },

  };
}
