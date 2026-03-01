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
 *   Network / extensions (migrated from python-imports + shell-imports):
 *   - host_network_fetch: synchronous HTTP via NetworkBridge
 *   - host_extension_invoke: call a host extension and get JSON result
 *   - host_is_extension: check if an extension is available
 */

import type { NetworkBridgeLike } from '../network/bridge.js';
import type { ExtensionRegistry } from '../extension/registry.js';
import type { ProcessKernel, SpawnRequest } from '../process/kernel.js';
import type { FdTarget } from '../wasi/fd-target.js';
import { readString, writeJson } from './common.js';

export interface KernelImportsOptions {
  memory: WebAssembly.Memory;

  /** PID of the calling process (used for fd table lookups). */
  callerPid?: number;

  /** Process kernel for pipe/spawn/waitpid/close_fd. Optional until Task 8. */
  kernel?: ProcessKernel;

  /** Network bridge for synchronous HTTP fetch from WASM. */
  networkBridge?: NetworkBridgeLike;

  /** Extension registry for command extensions (new-style). */
  extensionRegistry?: ExtensionRegistry;

  /**
   * Legacy extension handler (old-style, used by manager.ts).
   * If both extensionRegistry and extensionHandler are provided,
   * extensionRegistry takes precedence.
   */
  extensionHandler?: (cmd: Record<string, unknown>) => Record<string, unknown>;

  /** Tool allowlist for security policy. If set, only listed extensions are allowed. */
  toolAllowlist?: string[];

  /** Called by host_spawn to actually create and start a WASM process. */
  spawnProcess?: (req: SpawnRequest, fdTable: Map<number, FdTarget>) => number;
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
        return opts.spawnProcess(req, fdTable);
      }
      return -1;
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

    // host_yield() -> void
    // Async — yields to the JS microtask queue, allowing other WASM stacks to run.
    // This is the cooperative scheduling primitive: sleep(0).
    async host_yield(): Promise<void> {
      await Promise.resolve();
    },

    // ── Network / extensions (migrated) ──

    // host_network_fetch(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Synchronous HTTP fetch via NetworkBridge.
    host_network_fetch(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      const reqJson = readString(memory, reqPtr, reqLen);

      if (!opts.networkBridge) {
        return writeJson(memory, outPtr, outCap, { ok: false, error: 'networking not configured' });
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

        const result = opts.networkBridge.fetchSync(url, method, headers, body);
        return writeJson(memory, outPtr, outCap, {
          ok: true,
          status: result.status,
          headers: result.headers,
          body: result.body,
          error: result.error,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_extension_invoke(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Invokes a host extension. Supports both legacy extensionHandler and
    // the newer ExtensionRegistry interface.
    // Returns a Promise when using ExtensionRegistry — JSPI suspends WASM,
    // awaits the extension handler, then resumes WASM with the result.
    async host_extension_invoke(
      reqPtr: number, reqLen: number,
      outPtr: number, outCap: number,
    ): Promise<number> {
      const reqJson = readString(memory, reqPtr, reqLen);

      // Try ExtensionRegistry first (new-style, async)
      if (opts.extensionRegistry) {
        try {
          const req = JSON.parse(reqJson) as {
            name?: string;
            extension?: string;
            args?: string[];
            stdin?: string;
            env?: [string, string][];
            cwd?: string;
          };

          const name = (req.name ?? req.extension ?? '') as string;
          const args = req.args ?? [];
          const stdin = req.stdin ?? '';
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
          return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
        }
      }

      return writeJson(memory, outPtr, outCap, { ok: false, error: 'extensions not available' });
    },

    // host_is_extension(name_ptr, name_len) -> i32
    // Returns 1 if the named extension is available, 0 otherwise.
    host_is_extension(namePtr: number, nameLen: number): number {
      const name = readString(memory, namePtr, nameLen);

      // ExtensionRegistry check (new-style)
      if (opts.extensionRegistry) {
        if (!opts.extensionRegistry.has(name)) return 0;
        if (opts.toolAllowlist && !opts.toolAllowlist.includes(name)) return 0;
        return 1;
      }

      // Legacy extensionHandler: if handler exists, report extensions as available
      if (opts.extensionHandler) {
        return 1;
      }

      return 0;
    },
  };
}
