/**
 * NetworkBridge: sync-async bridge for WASI socket calls.
 *
 * Uses SharedArrayBuffer + Atomics to allow synchronous WASM code to
 * make network requests fulfilled asynchronously by a Worker.
 *
 * Protocol (over SharedArrayBuffer):
 *   Int32[0] = status: 0=idle, 1=request_ready, 2=response_ready, 3=error
 *   Int32[1] = data length (bytes)
 *   Bytes 8+ = JSON request or response payload
 */

import type { Worker } from 'node:worker_threads';
import type { NetworkGateway } from './gateway.js';

const SAB_SIZE = 16 * 1024 * 1024; // 16MB
const STATUS_IDLE = 0;
const STATUS_REQUEST_READY = 1;
const STATUS_RESPONSE_READY = 2;
const STATUS_ERROR = 3;

export interface SyncFetchResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  error?: string;
}

/** Minimal interface for synchronous network access (main-thread or Worker). */
export interface NetworkBridgeLike {
  fetchSync(url: string, method: string, headers: Record<string, string>, body?: string): SyncFetchResult;
}

export class NetworkBridge {
  private sab: SharedArrayBuffer;
  private int32: Int32Array;
  private uint8: Uint8Array;
  private worker: Worker | null = null;
  private gateway: NetworkGateway;

  constructor(gateway: NetworkGateway) {
    this.gateway = gateway;
    this.sab = new SharedArrayBuffer(SAB_SIZE);
    this.int32 = new Int32Array(this.sab);
    this.uint8 = new Uint8Array(this.sab);
  }

  /** Return the underlying SharedArrayBuffer for use in Worker threads. */
  getSab(): SharedArrayBuffer { return this.sab; }

  async start(): Promise<void> {
    const { Worker } = await import('node:worker_threads');
    const workerCode = `
      const { workerData, parentPort } = require('node:worker_threads');
      const sab = workerData.sab;
      const int32 = new Int32Array(sab);
      const uint8 = new Uint8Array(sab);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      parentPort.postMessage('ready');

      async function loop() {
        while (true) {
          Atomics.wait(int32, 0, ${STATUS_IDLE});
          if (Atomics.load(int32, 0) !== ${STATUS_REQUEST_READY}) continue;

          const len = Atomics.load(int32, 1);
          const reqJson = decoder.decode(uint8.slice(8, 8 + len));
          const req = JSON.parse(reqJson);

          try {
            const resp = await fetch(req.url, {
              method: req.method,
              headers: req.headers,
              body: req.body || undefined,
            });
            const body = await resp.text();
            const headers = {};
            resp.headers.forEach((v, k) => { headers[k] = v; });
            const result = JSON.stringify({ status: resp.status, body, headers });
            const encoded = encoder.encode(result);
            uint8.set(encoded, 8);
            Atomics.store(int32, 1, encoded.byteLength);
            Atomics.store(int32, 0, ${STATUS_RESPONSE_READY});
          } catch (err) {
            const result = JSON.stringify({ status: 0, body: '', headers: {}, error: err.message });
            const encoded = encoder.encode(result);
            uint8.set(encoded, 8);
            Atomics.store(int32, 1, encoded.byteLength);
            Atomics.store(int32, 0, ${STATUS_ERROR});
          }
          Atomics.notify(int32, 0);
        }
      }
      loop();
    `;

    this.worker = new Worker(workerCode, {
      eval: true,
      workerData: { sab: this.sab },
    });

    // Attach error handler that unblocks any waiting thread
    this.worker.on('error', () => {
      Atomics.store(this.int32, 0, STATUS_ERROR);
      Atomics.notify(this.int32, 0);
    });

    // Wait for the worker to signal it's ready (with a fallback timeout)
    await new Promise<void>((resolve, reject) => {
      this.worker!.on('message', (msg: string) => {
        if (msg === 'ready') resolve();
      });
      this.worker!.on('error', reject);
      setTimeout(() => resolve(), 2000); // fallback timeout
    });
  }

  /**
   * Synchronous fetch -- blocks the calling thread until the worker completes.
   * Safe to call from WASI host functions.
   */
  fetchSync(url: string, method: string, headers: Record<string, string>, body?: string): SyncFetchResult {
    if (!this.worker) {
      return { status: 0, body: '', headers: {}, error: 'bridge not started' };
    }

    // Check gateway policy synchronously first
    const access = this.gateway.checkAccess(url, method);
    if (!access.allowed) {
      return { status: 403, body: '', headers: {}, error: access.reason };
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const reqJson = JSON.stringify({ url, method, headers, body });
    const reqEncoded = encoder.encode(reqJson);
    if (reqEncoded.byteLength > SAB_SIZE - 8) {
      return { status: 413, body: '', headers: {}, error: 'request too large' };
    }
    this.uint8.set(reqEncoded, 8);
    Atomics.store(this.int32, 1, reqEncoded.byteLength);
    Atomics.store(this.int32, 0, STATUS_REQUEST_READY);
    Atomics.notify(this.int32, 0);

    // Block until response (30-second timeout to avoid hanging if worker crashes)
    const waitResult = Atomics.wait(this.int32, 0, STATUS_REQUEST_READY, 30_000);
    if (waitResult === 'timed-out') {
      Atomics.store(this.int32, 0, STATUS_IDLE);
      return { status: 0, body: '', headers: {}, error: 'network request timed out' };
    }

    const status = Atomics.load(this.int32, 0);
    const len = Atomics.load(this.int32, 1);
    const respJson = decoder.decode(this.uint8.slice(8, 8 + len));

    // Reset to idle
    Atomics.store(this.int32, 0, STATUS_IDLE);

    const result = JSON.parse(respJson) as SyncFetchResult;
    if (status === STATUS_ERROR) {
      result.error = result.error || 'unknown error';
    }
    return result;
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
