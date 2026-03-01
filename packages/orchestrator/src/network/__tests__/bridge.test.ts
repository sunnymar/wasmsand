import { describe, it, afterEach, beforeAll, afterAll } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { NetworkBridge } from '../bridge.js';
import { NetworkGateway } from '../gateway.js';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * These tests spin up an HTTP server in a CHILD PROCESS so that
 * the Worker's real fetch() can hit a controlled endpoint without
 * deadlocking.
 *
 * The deadlock occurs when the HTTP server runs on the main thread:
 * fetchSync() calls Atomics.wait() which blocks the main thread event
 * loop, preventing the same-process HTTP server from responding.
 * Running the server in a child process avoids this.
 */

describe('NetworkBridge', { sanitizeOps: false, sanitizeResources: false }, () => {
  let serverProcess: ChildProcess;
  let baseUrl: string;
  let bridge: NetworkBridge;

  beforeAll(async () => {
    const serverScript = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === '/data') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('bridge response');
        return;
      }

      if (url.pathname === '/echo-headers') {
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers[k] = v;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(headers));
        return;
      }

      if (url.pathname === '/error') {
        req.socket.destroy();
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      process.stdout.write(JSON.stringify({ port: addr.port }) + '\\n');
    });
  `;

    serverProcess = spawn(process.execPath, ['-e', serverScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for the server to print its port
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      serverProcess.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const info = JSON.parse(line.trim());
              if (info.port) {
                resolve(info.port);
                return;
              }
            } catch {
              // not yet complete JSON
            }
          }
        }
      });
      serverProcess.on('error', reject);
      serverProcess.on('exit', (code) => {
        reject(new Error(`Server process exited with code ${code}`));
      });
      setTimeout(() => reject(new Error('Timeout waiting for server')), 5000);
    });

    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  afterEach(() => {
    bridge?.dispose();
  });

  it('performs a synchronous fetch via the bridge', async () => {
    const gateway = new NetworkGateway({ allowedHosts: ['127.0.0.1'] });
    bridge = new NetworkBridge(gateway);
    await bridge.start();

    const result = bridge.fetchSync(`${baseUrl}/data`, 'GET', {});
    expect(result.status).toBe(200);
    expect(result.body).toBe('bridge response');
  });

  it('returns error for blocked hosts', async () => {
    const gateway = new NetworkGateway({ blockedHosts: ['evil.com'] });
    bridge = new NetworkBridge(gateway);
    await bridge.start();

    const result = bridge.fetchSync('https://evil.com', 'GET', {});
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.error).toBeTruthy();
  });

  it('disposes worker cleanly', async () => {
    const gateway = new NetworkGateway({ allowedHosts: ['127.0.0.1'] });
    bridge = new NetworkBridge(gateway);
    await bridge.start();
    bridge.dispose();
    bridge.dispose(); // double dispose should not throw
  });
});
