/**
 * Host import implementations for Python WASM modules.
 *
 * createPythonImports() returns a record of functions that form the `codepod`
 * import namespace consumed by the `_codepod` Rust native module (Task 20).
 *
 * Three host functions are provided:
 *   - host_network_fetch: synchronous HTTP via NetworkBridge
 *   - host_extension_invoke: call a host extension and get JSON result
 *   - host_is_extension: check if extensions are available
 */

import type { NetworkBridgeLike } from '../network/bridge.js';
import { readString, writeJson } from './common.js';

export interface PythonImportsOptions {
  memory: WebAssembly.Memory;
  networkBridge?: NetworkBridgeLike;
  extensionHandler?: (cmd: Record<string, unknown>) => Record<string, unknown>;
}

export function createPythonImports(opts: PythonImportsOptions): Record<string, WebAssembly.ImportValue> {
  const { memory } = opts;

  return {
    // host_network_fetch(req_ptr, req_len, out_ptr, out_cap) -> i32
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
    host_extension_invoke(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      const reqJson = readString(memory, reqPtr, reqLen);

      if (!opts.extensionHandler) {
        return writeJson(memory, outPtr, outCap, { ok: false, error: 'extensions not available' });
      }

      try {
        const req = JSON.parse(reqJson) as Record<string, unknown>;
        const result = opts.extensionHandler(req);
        return writeJson(memory, outPtr, outCap, result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_is_extension(name_ptr, name_len) -> i32
    host_is_extension(namePtr: number, nameLen: number): number {
      if (!opts.extensionHandler) return 0;
      // Read the name to consume the arguments (required by the ABI)
      readString(memory, namePtr, nameLen);
      // If an extension handler is configured, extensions are available.
      // A more precise per-name check would need access to the extension
      // registry; for now, return 1 if the handler exists.
      return 1;
    },
  };
}
