import { describe, it, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const SERVER_PATH = resolve(import.meta.dirname, 'server.ts');
const WASM_DIR = resolve(import.meta.dirname, '../../orchestrator/src/platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../../orchestrator/src/shell/__tests__/fixtures/codepod-shell.wasm');

function startServer() {
  const proc = spawn('bun', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = createInterface({ input: proc.stdout! });
  const responses: string[] = [];
  rl.on('line', (line) => responses.push(line));

  function send(obj: unknown): void {
    proc.stdin!.write(JSON.stringify(obj) + '\n');
  }

  async function recv(): Promise<unknown> {
    const start = responses.length;
    for (let i = 0; i < 100; i++) {
      if (responses.length > start) return JSON.parse(responses[start]);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out waiting for response');
  }

  return { proc, send, recv };
}

describe('SDK Server (integration)', () => {
  it('create -> run -> kill lifecycle', async () => {
    const { proc, send, recv } = startServer();
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'create', params: { wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM } });
      const createResp = await recv();
      expect(createResp).toMatchObject({ jsonrpc: '2.0', id: 1, result: { ok: true } });

      send({ jsonrpc: '2.0', id: 2, method: 'run', params: { command: 'echo hello' } });
      const runResp = await recv();
      expect(runResp).toMatchObject({ jsonrpc: '2.0', id: 2, result: { exitCode: 0 } });
      expect((runResp as any).result.stdout.trim()).toBe('hello');

      send({ jsonrpc: '2.0', id: 3, method: 'kill', params: {} });
      const killResp = await recv();
      expect(killResp).toMatchObject({ jsonrpc: '2.0', id: 3, result: { ok: true } });
    } finally {
      proc.kill();
    }
  }, 30_000);
});
