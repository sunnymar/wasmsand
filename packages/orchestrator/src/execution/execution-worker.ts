/**
 * Execution Worker entrypoint.
 *
 * Runs inside a Worker thread. Receives init + run messages from the main
 * thread, executes commands via ShellInstance, and posts results back.
 * VFS access goes through VfsProxy (SAB + Atomics).
 */

import { parentPort } from 'node:worker_threads';
import { VfsProxy } from './vfs-proxy.js';
import {
  STATUS_REQUEST,
  STATUS_RESPONSE,
  STATUS_ERROR,
  encodeRequest,
  decodeResponse,
} from './proxy-protocol.js';
import { ProcessManager } from '../process/manager.js';
import { ShellInstance } from '../shell/shell-instance.js';
import type { RunResult } from '../shell/shell-types.js';
import { CancelledError } from '../security.js';

if (!parentPort) throw new Error('Must run as Worker thread');

interface InitMessage {
  type: 'init';
  sab: SharedArrayBuffer;
  wasmDir: string;
  shellExecWasmPath: string;
  toolRegistry: [string, string][];
  networkEnabled: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  toolAllowlist?: string[];
  memoryBytes?: number;
  bridgeSab?: SharedArrayBuffer;
  networkPolicy?: { allowedHosts?: string[]; blockedHosts?: string[] };
  hasExtensions?: boolean;
}

interface RunMessage {
  type: 'run';
  command: string;
  env: [string, string][];
  timeoutMs?: number;
  stdoutLimit?: number;
  stderrLimit?: number;
}

let runner: ShellInstance | null = null;

parentPort.on('message', async (msg: InitMessage | RunMessage) => {
  if (msg.type === 'init') {
    const { sab, wasmDir, shellExecWasmPath, toolRegistry } = msg;

    const { NodeAdapter } = await import('../platform/node-adapter.js');
    const adapter = new NodeAdapter();

    const vfs = new VfsProxy(sab, { parentPort: parentPort! });

    // Set up network bridge client if SAB provided
    let networkBridge: import('../network/bridge.js').NetworkBridgeLike | undefined;
    let networkGateway: import('../network/gateway.js').NetworkGateway | undefined;
    if (msg.bridgeSab) {
      const { NetworkGateway } = await import('../network/gateway.js');
      const { BridgeClient } = await import('../network/bridge-client.js');
      if (msg.networkPolicy) {
        networkGateway = new NetworkGateway(msg.networkPolicy);
      }
      networkBridge = new BridgeClient(msg.bridgeSab, networkGateway);
    }

    const mgr = new ProcessManager(vfs, adapter, networkBridge, msg.toolAllowlist);

    for (const [name, path] of toolRegistry) {
      mgr.registerTool(name, path);
    }

    // Set up extension handler proxy: worker blocks on Atomics.wait while
    // main thread runs the async extension handler, then notifies.
    if (msg.hasExtensions) {
      const extInt32 = new Int32Array(sab);
      const extensionProxy = (cmd: Record<string, unknown>): Record<string, unknown> => {
        encodeRequest(sab, { op: 'extensionInvoke', ...cmd });
        Atomics.store(extInt32, 0, STATUS_REQUEST);
        parentPort!.postMessage('proxy-request');
        Atomics.wait(extInt32, 0, STATUS_REQUEST);
        const status = Atomics.load(extInt32, 0);
        const resp = decodeResponse(sab);
        Atomics.store(extInt32, 0, 0); // STATUS_IDLE
        if (status === STATUS_ERROR) {
          return { ok: false, error: resp.metadata.message ?? 'error' };
        }
        return resp.metadata as Record<string, unknown>;
      };
      mgr.setExtensionHandler(extensionProxy);
    }

    // Pre-load all tool modules so spawnSync can use them synchronously
    await mgr.preloadModules();

    runner = await ShellInstance.create(vfs, mgr, adapter, shellExecWasmPath, {
      syncSpawn: (cmd, args, env, stdin, cwd) =>
        mgr.spawnSync(cmd, args, env, stdin, cwd),
    });

    if (msg.stdoutBytes !== undefined || msg.stderrBytes !== undefined) {
      runner.setOutputLimits(msg.stdoutBytes, msg.stderrBytes);
    }

    if (msg.bridgeSab !== undefined) {
      runner.setEnv('PYTHONPATH', '/usr/lib/python');
    }

    parentPort!.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'run') {
    if (!runner) {
      parentPort!.postMessage({
        type: 'result',
        result: { exitCode: 1, stdout: '', stderr: 'Worker not initialized\n', executionTimeMs: 0 },
      });
      return;
    }

    // Apply env vars from main thread
    for (const [k, v] of msg.env) {
      runner.setEnv(k, v);
    }

    // Apply output limits if provided
    if (msg.stdoutLimit !== undefined || msg.stderrLimit !== undefined) {
      runner.setOutputLimits(msg.stdoutLimit, msg.stderrLimit);
    }

    // Set deadline for cooperative cancellation
    if (msg.timeoutMs !== undefined) {
      runner.resetCancel(msg.timeoutMs);
    }

    try {
      const result = await runner.run(msg.command);
      const envMap = runner.getEnvMap();
      parentPort!.postMessage({
        type: 'result',
        result,
        env: Array.from(envMap.entries()),
      });
    } catch (err) {
      if (err instanceof CancelledError) {
        parentPort!.postMessage({
          type: 'result',
          result: {
            exitCode: 124,
            stdout: '',
            stderr: `command ${err.reason.toLowerCase()}\n`,
            executionTimeMs: 0,
            errorClass: err.reason,
          },
        });
      } else {
        parentPort!.postMessage({
          type: 'result',
          result: {
            exitCode: 1,
            stdout: '',
            stderr: `Worker execution error: ${(err as Error).message}\n`,
            executionTimeMs: 0,
          },
        });
      }
    }
  }
});
