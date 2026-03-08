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
import { HOST_MATCH_SOURCE } from './host-match.js';

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

/** Generic sync request/response for any bridge operation. */
export interface SyncRequestResult {
  ok: boolean;
  [key: string]: unknown;
}

/** Minimal interface for synchronous network access (main-thread or Worker). */
export interface NetworkBridgeLike {
  fetchSync(url: string, method: string, headers: Record<string, string>, body?: string): SyncFetchResult;
  /** Send a generic operation (connect/send/recv/close) through the bridge. */
  requestSync(op: Record<string, unknown>): SyncRequestResult;
}

export class NetworkBridge implements NetworkBridgeLike {
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
      const allowedHosts = workerData.allowedHosts;
      const blockedHosts = workerData.blockedHosts;
      const int32 = new Int32Array(sab);
      const uint8 = new Uint8Array(sab);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      ${HOST_MATCH_SOURCE}

      function checkAccess(url) {
        let host;
        try { host = new URL(url).hostname; }
        catch { return { allowed: false, reason: 'invalid URL' }; }

        if (allowedHosts !== undefined) {
          if (matchesHostList(host, allowedHosts)) return { allowed: true };
          return { allowed: false, reason: 'host ' + host + ' not in allowedHosts' };
        }
        if (blockedHosts !== undefined) {
          if (matchesHostList(host, blockedHosts)) return { allowed: false, reason: 'host ' + host + ' is in blockedHosts' };
          return { allowed: true };
        }
        return { allowed: false, reason: 'no network policy configured (default deny)' };
      }

      // Socket state for full mode
      const sockets = new Map();
      let nextSocketId = 1;
      let net = null;
      let tls = null;
      try { net = require('node:net'); tls = require('node:tls'); } catch {}

      function writeResponse(json, status) {
        const encoded = encoder.encode(json);
        uint8.set(encoded, 8);
        Atomics.store(int32, 1, encoded.byteLength);
        Atomics.store(int32, 0, status);
        Atomics.notify(int32, 0);
      }

      function writeOk(obj) {
        writeResponse(JSON.stringify(obj), ${STATUS_RESPONSE_READY});
      }

      function writeErr(msg) {
        writeResponse(JSON.stringify({ ok: false, error: msg }), ${STATUS_ERROR});
      }

      function checkHostAccess(host) {
        if (allowedHosts !== undefined) {
          if (matchesHostList(host, allowedHosts)) return { allowed: true };
          return { allowed: false, reason: 'host ' + host + ' not in allowedHosts' };
        }
        if (blockedHosts !== undefined) {
          if (matchesHostList(host, blockedHosts)) return { allowed: false, reason: 'host ' + host + ' is in blockedHosts' };
          return { allowed: true };
        }
        return { allowed: false, reason: 'no network policy configured (default deny)' };
      }

      async function handleFetch(req) {
        const access = checkAccess(req.url);
        if (!access.allowed) {
          writeResponse(JSON.stringify({ status: 403, body: '', headers: {}, error: access.reason }), ${STATUS_ERROR});
          return;
        }
        const MAX_REDIRECTS = 5;
        const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
        let currentUrl = req.url;
        let currentMethod = req.method;
        let currentBody = req.body || undefined;
        let resp;
        let redirectCount = 0;

        for (;;) {
          if (redirectCount > 0) {
            const hopAccess = checkAccess(currentUrl);
            if (!hopAccess.allowed) {
              writeResponse(JSON.stringify({ status: 403, body: '', headers: {}, error: hopAccess.reason }), ${STATUS_ERROR});
              return;
            }
          }
          resp = await fetch(currentUrl, {
            method: currentMethod,
            headers: req.headers,
            body: currentBody,
            redirect: 'manual',
          });
          if (!REDIRECT_STATUSES.has(resp.status)) break;
          const location = resp.headers.get('location');
          if (!location) break;
          currentUrl = new URL(location, currentUrl).href;
          if (resp.status === 303) { currentMethod = 'GET'; currentBody = undefined; }
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            writeResponse(JSON.stringify({ status: 0, body: '', headers: {}, error: 'too many redirects' }), ${STATUS_ERROR});
            return;
          }
        }
        const body = await resp.text();
        const headers = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });
        writeOk({ status: resp.status, body, headers });
      }

      async function handleConnect(req) {
        if (!net) { writeErr('sockets not available (no net module)'); return; }
        const access = checkHostAccess(req.host);
        if (!access.allowed) { writeErr(access.reason); return; }
        const id = nextSocketId++;
        return new Promise((resolve) => {
          const connectFn = req.tls ? tls.connect : net.connect;
          const opts = { host: req.host, port: req.port };
          if (req.tls) opts.servername = req.host;
          const sock = connectFn(opts, () => {
            sockets.set(id, sock);
            writeOk({ ok: true, socket_id: id });
            resolve();
          });
          sock.on('error', (err) => {
            sockets.delete(id);
            writeErr('connect: ' + err.message);
            resolve();
          });
          setTimeout(() => {
            if (!sockets.has(id)) {
              sock.destroy();
              writeErr('connect: timed out');
              resolve();
            }
          }, 30000);
        });
      }

      async function handleSend(req) {
        const sock = sockets.get(req.socket_id);
        if (!sock) { writeErr('send: invalid socket_id'); return; }
        const data = Buffer.from(req.data_b64, 'base64');
        return new Promise((resolve) => {
          sock.write(data, (err) => {
            if (err) { writeErr('send: ' + err.message); }
            else { writeOk({ ok: true, bytes_sent: data.length }); }
            resolve();
          });
        });
      }

      async function handleRecv(req) {
        const sock = sockets.get(req.socket_id);
        if (!sock) { writeErr('recv: invalid socket_id'); return; }
        const maxBytes = req.max_bytes || 65536;
        return new Promise((resolve) => {
          const chunk = sock.read(maxBytes);
          if (chunk) {
            writeOk({ ok: true, data_b64: chunk.toString('base64') });
            resolve();
            return;
          }
          // No data available yet — wait for readable or end
          let settled = false;
          const onReadable = () => {
            if (settled) return;
            settled = true;
            cleanup();
            const c = sock.read(maxBytes);
            writeOk({ ok: true, data_b64: c ? c.toString('base64') : '' });
            resolve();
          };
          const onEnd = () => {
            if (settled) return;
            settled = true;
            cleanup();
            writeOk({ ok: true, data_b64: '' });
            resolve();
          };
          const onError = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            writeErr('recv: ' + err.message);
            resolve();
          };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            writeErr('recv: timed out');
            resolve();
          }, 30000);
          function cleanup() {
            clearTimeout(timer);
            sock.removeListener('readable', onReadable);
            sock.removeListener('end', onEnd);
            sock.removeListener('error', onError);
          }
          sock.on('readable', onReadable);
          sock.on('end', onEnd);
          sock.on('error', onError);
        });
      }

      function handleClose(req) {
        const sock = sockets.get(req.socket_id);
        if (!sock) { writeErr('close: invalid socket_id'); return; }
        sock.destroy();
        sockets.delete(req.socket_id);
        writeOk({ ok: true });
      }

      parentPort.postMessage('ready');

      async function loop() {
        while (true) {
          Atomics.wait(int32, 0, ${STATUS_IDLE});
          if (Atomics.load(int32, 0) !== ${STATUS_REQUEST_READY}) continue;

          const len = Atomics.load(int32, 1);
          const reqJson = decoder.decode(uint8.slice(8, 8 + len));
          const req = JSON.parse(reqJson);

          try {
            const op = req.op || 'fetch';
            switch (op) {
              case 'fetch': await handleFetch(req); break;
              case 'connect': await handleConnect(req); break;
              case 'send': await handleSend(req); break;
              case 'recv': await handleRecv(req); break;
              case 'close': handleClose(req); break;
              default: writeErr('unknown op: ' + op); break;
            }
          } catch (err) {
            writeErr(err.message);
          }
        }
      }
      loop();
    `;

    this.worker = new Worker(workerCode, {
      eval: true,
      workerData: {
        sab: this.sab,
        allowedHosts: this.gateway.getAllowedHosts(),
        blockedHosts: this.gateway.getBlockedHosts(),
      },
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

  /**
   * Generic sync request — sends any operation through the bridge.
   * Used for socket operations (connect, send, recv, close).
   */
  requestSync(op: Record<string, unknown>): SyncRequestResult {
    if (!this.worker) {
      return { ok: false, error: 'bridge not started' };
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const reqJson = JSON.stringify(op);
    const reqEncoded = encoder.encode(reqJson);
    if (reqEncoded.byteLength > SAB_SIZE - 8) {
      return { ok: false, error: 'request too large' };
    }
    this.uint8.set(reqEncoded, 8);
    Atomics.store(this.int32, 1, reqEncoded.byteLength);
    Atomics.store(this.int32, 0, STATUS_REQUEST_READY);
    Atomics.notify(this.int32, 0);

    const waitResult = Atomics.wait(this.int32, 0, STATUS_REQUEST_READY, 30_000);
    if (waitResult === 'timed-out') {
      Atomics.store(this.int32, 0, STATUS_IDLE);
      return { ok: false, error: 'request timed out' };
    }

    const len = Atomics.load(this.int32, 1);
    const respJson = decoder.decode(this.uint8.slice(8, 8 + len));
    Atomics.store(this.int32, 0, STATUS_IDLE);
    return JSON.parse(respJson) as SyncRequestResult;
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
