/**
 * Stdio JSON-RPC server for the wasmsand SDK.
 *
 * Reads newline-delimited JSON-RPC 2.0 from stdin, routes to the Dispatcher,
 * and writes JSON-RPC responses to stdout. The first RPC call must be `create`
 * (which creates the Sandbox). After `kill`, the process exits.
 *
 * All debug/error output goes to stderr — stdout is reserved for JSON-RPC.
 */

import { createInterface } from 'node:readline';
import { Sandbox } from '@wasmsand/sandbox';
import { NodeAdapter } from '@wasmsand/sandbox/node';
import { Dispatcher } from './dispatcher.js';

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

function respond(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + '\n');
}

function errorResponse(
  id: number | string,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function log(msg: string): void {
  process.stderr.write(`[sdk-server] ${msg}\n`);
}

// Max request size: 8MB default. Overridable via limits.rpcBytes.
let maxLineBytes = 8 * 1024 * 1024;

async function main(): Promise<void> {
  let dispatcher: Dispatcher | null = null;

  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (Buffer.byteLength(line) > maxLineBytes) {
      respond(errorResponse(0, -32700, 'Request too large'));
      continue;
    }

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      // Malformed JSON — send parse error
      respond(errorResponse(0, -32700, 'Parse error'));
      continue;
    }

    const { id, method, params = {} } = req;

    // First RPC must be `create`
    if (method === 'create') {
      if (dispatcher) {
        respond(errorResponse(id, -32600, 'Sandbox already created'));
        continue;
      }

      try {
        const {
          wasmDir,
          timeoutMs,
          fsLimitBytes,
          shellWasmPath,
          limits,
          mounts,
          pythonPath,
        } = params as {
          wasmDir?: string;
          timeoutMs?: number;
          fsLimitBytes?: number;
          shellWasmPath?: string;
          limits?: {
            stdoutBytes?: number;
            stderrBytes?: number;
            commandBytes?: number;
            fileCount?: number;
            rpcBytes?: number;
          };
          mounts?: Array<{ path: string; files: Record<string, string>; writable?: boolean }>;
          pythonPath?: string[];
        };

        if (!wasmDir || typeof wasmDir !== 'string') {
          respond(errorResponse(id, -32602, 'Missing required param: wasmDir'));
          continue;
        }

        // Decode base64-encoded mount files
        const mountConfigs = mounts?.map(m => ({
          path: m.path,
          files: Object.fromEntries(
            Object.entries(m.files).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))]),
          ),
          writable: m.writable,
        }));

        const sandbox = await Sandbox.create({
          wasmDir,
          adapter: new NodeAdapter(),
          timeoutMs,
          fsLimitBytes,
          shellWasmPath,
          security: limits ? { limits } : undefined,
          mounts: mountConfigs,
          pythonPath,
        });

        if (limits?.rpcBytes !== undefined) {
          maxLineBytes = Math.max(1024, Math.min(limits.rpcBytes, 128 * 1024 * 1024));
        }

        dispatcher = new Dispatcher(sandbox);
        respond({ jsonrpc: '2.0', id, result: { ok: true } });
      } catch (err) {
        log(`create failed: ${err}`);
        respond(errorResponse(id, -32603, `Internal error: ${(err as Error).message}`));
      }
      continue;
    }

    // All other methods require the sandbox to be created first
    if (!dispatcher) {
      respond(errorResponse(id, -32600, 'Sandbox not created. Call "create" first.'));
      continue;
    }

    try {
      const result = await dispatcher.dispatch(method, params as Record<string, unknown>);
      respond({ jsonrpc: '2.0', id, result });

      // After kill, exit the process
      if (dispatcher.isKilled()) {
        process.exit(0);
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err) {
        const rpcErr = err as { code: number; message: string };
        respond(errorResponse(id, rpcErr.code, rpcErr.message));
      } else {
        respond(errorResponse(id, -32603, 'Internal error'));
      }
    }
  }
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
