/**
 * Stdio JSON-RPC server for the codepod SDK.
 *
 * Reads newline-delimited JSON-RPC 2.0 from stdin, routes to the Dispatcher,
 * and writes JSON-RPC responses to stdout. The first RPC call must be `create`
 * (which creates the Sandbox). After `kill`, the process exits.
 *
 * All debug/error output goes to stderr — stdout is reserved for JSON-RPC.
 */

import { createInterface } from 'node:readline';
import { Sandbox } from '@codepod/sandbox';
import type { ExtensionConfig, ExtensionInvokeArgs, ExtensionInvokeResult } from '@codepod/sandbox';
import { NodeAdapter } from '@codepod/sandbox/node';
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

// --- Bidirectional RPC: callback infrastructure ---
// The server can send requests to the Python client (for extension invocations).
// Callback IDs use 'cb_' prefix to distinguish from normal responses.
const pendingCallbacks = new Map<string, {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}>();
let nextCbId = 1;

function sendCallback(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `cb_${nextCbId++}`;
    pendingCallbacks.set(id, { resolve, reject });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function main(): Promise<void> {
  let dispatcher: Dispatcher | null = null;

  const rl = createInterface({ input: process.stdin });

  // Use event-driven readline instead of `for await` so callback responses
  // from the client can be processed while an async dispatch is in progress.
  const processLine = async (line: string): Promise<void> => {
    if (Buffer.byteLength(line) > maxLineBytes) {
      respond(errorResponse(0, -32700, 'Request too large'));
      return;
    }

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      respond(errorResponse(0, -32700, 'Parse error'));
      return;
    }

    const { id, method, params = {} } = req;

    // Handle callback responses from client (id starts with 'cb_')
    if (typeof id === 'string' && id.startsWith('cb_') && ('result' in req || 'error' in (req as any))) {
      const pending = pendingCallbacks.get(id);
      if (pending) {
        pendingCallbacks.delete(id);
        if ('error' in (req as any) && (req as any).error) {
          pending.reject(new Error((req as any).error.message));
        } else {
          pending.resolve((req as any).result);
        }
      }
      return;
    }

    // First RPC must be `create`
    if (method === 'create') {
      if (dispatcher) {
        respond(errorResponse(id, -32600, 'Sandbox already created'));
        return;
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
          extensions: extensionSpecs,
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
          extensions?: Array<{
            name: string;
            description?: string;
            hasCommand?: boolean;
            pythonPackage?: { version: string; summary?: string; files: Record<string, string> };
          }>;
        };

        if (!wasmDir || typeof wasmDir !== 'string') {
          respond(errorResponse(id, -32602, 'Missing required param: wasmDir'));
          return;
        }

        // Decode base64-encoded mount files
        const mountConfigs = mounts?.map(m => ({
          path: m.path,
          files: Object.fromEntries(
            Object.entries(m.files).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))]),
          ),
          writable: m.writable,
        }));

        // Build extension configs — hasCommand extensions get a callback handler
        const extensionConfigs: ExtensionConfig[] | undefined = extensionSpecs?.map((ext) => ({
          name: ext.name,
          description: ext.description,
          command: ext.hasCommand ? async (input: ExtensionInvokeArgs): Promise<ExtensionInvokeResult> => {
            const result = await sendCallback('extension.invoke', {
              name: ext.name,
              args: input.args,
              stdin: input.stdin,
              env: input.env,
              cwd: input.cwd,
            });
            return result as ExtensionInvokeResult;
          } : undefined,
          pythonPackage: ext.pythonPackage,
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
          extensions: extensionConfigs,
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
      return;
    }

    // All other methods require the sandbox to be created first
    if (!dispatcher) {
      respond(errorResponse(id, -32600, 'Sandbox not created. Call "create" first.'));
      return;
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
  };

  rl.on('line', (line) => {
    processLine(line).catch((err) => {
      log(`processLine error: ${err}`);
    });
  });

  // Keep process alive until stdin closes
  await new Promise<void>((resolve) => {
    rl.on('close', resolve);
  });
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
