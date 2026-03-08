/**
 * BrowserNetworkBridge: async network bridge for browser environments.
 *
 * Uses the browser's native fetch() API directly. Since WASM runs on the main
 * thread in browsers (where Atomics.wait() is not allowed), this bridge relies
 * on JSPI to suspend the WASM stack while the fetch completes asynchronously.
 *
 * Provides fetchAsync() for the kernel import's async path. fetchSync() throws
 * since it cannot block in a browser main thread.
 */

import type { SyncFetchResult, SyncRequestResult, NetworkBridgeLike } from './bridge.js';
import { NetworkGateway } from './gateway.js';
import type { NetworkPolicy } from './gateway.js';

export class BrowserNetworkBridge implements NetworkBridgeLike {
  private gateway: NetworkGateway;

  constructor(policy: NetworkPolicy) {
    this.gateway = new NetworkGateway(policy);
  }

  fetchSync(): SyncFetchResult {
    return { status: 0, body: '', headers: {}, error: 'fetchSync not available in browser — use fetchAsync via JSPI' };
  }

  async fetchAsync(url: string, method: string, headers: Record<string, string>, body?: string): Promise<SyncFetchResult> {
    // Check gateway policy
    const access = this.gateway.checkAccess(url, method);
    if (!access.allowed) {
      return { status: 403, body: '', headers: {}, error: access.reason };
    }

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body || undefined,
      });

      const respBody = await resp.text();
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });

      return {
        status: resp.status,
        body: respBody,
        headers: respHeaders,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 0, body: '', headers: {}, error: msg };
    }
  }

  requestSync(): SyncRequestResult {
    return { ok: false, error: 'requestSync not available in browser' };
  }

  async start(): Promise<void> {
    // No worker to start in browser mode
  }

  stop(): void {
    // No worker to stop
  }
}
