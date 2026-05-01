import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';
import type { NetworkBridgeLike, SyncFetchResult, SyncRequestResult } from '../network/bridge.ts';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');

class StaticFetchBridge implements NetworkBridgeLike {
  requests: Array<{ url: string; method: string; redirect?: string; body?: string | null }> = [];

  fetchSync(
    url: string,
    method: string,
    _headers: Record<string, string>,
    body?: string,
    redirect?: 'follow' | 'manual',
  ): SyncFetchResult {
    this.requests.push({ url, method, redirect, body });
    if (url.endsWith('/denied')) {
      return { status: 0, headers: {}, body: '', error: 'blocked by test policy' };
    }
    if (url.endsWith('/redirect')) {
      return {
        status: 302,
        headers: { location: 'http://example.test/final' },
        body: '',
        body_base64: '',
      };
    }
    if (url.endsWith('/binary')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: '\u0000\u0001\u0002',
        body_base64: 'AAEC',
      };
    }

    const text = method === 'POST' ? `posted:${body ?? ''}` : 'hello curl';
    return {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: text,
      body_base64: btoa(text),
    };
  }

  requestSync(_op: Record<string, unknown>): SyncRequestResult {
    return { ok: false, error: 'socket path not used in this test' };
  }
}

describe('curl/libcurl conformance', () => {
  let sandbox: Sandbox | undefined;

  afterEach(() => {
    sandbox?.destroy();
    sandbox = undefined;
  });

  async function createSandbox(bridge = new StaticFetchBridge()) {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ['example.test'] },
      networkBridge: bridge,
    });
    return { sandbox, bridge };
  }

  it('curl --version reports curl', async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run('curl --version');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('curl');
  });

  it('fetch-forced curl GET prints response body', async () => {
    const { sandbox, bridge } = await createSandbox();
    const result = await sandbox.run('curl --codepod-network=fetch http://example.test/data');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello curl');
    expect(bridge.requests[0].redirect).toBe('manual');
  });

  it('fetch-forced curl POST sends request body', async () => {
    const { sandbox, bridge } = await createSandbox();
    const result = await sandbox.run("curl --codepod-network=fetch -d 'a=1' http://example.test/post");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('posted:a=1');
    expect(bridge.requests[0].method).toBe('POST');
    expect(bridge.requests[0].body).toContain('a=1');
  });

  it('fetch-forced curl writes binary response to VFS', async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run('curl --codepod-network=fetch -o /tmp/out.bin http://example.test/binary');
    expect(result.exitCode).toBe(0);
    const bytes = sandbox.readFile('/tmp/out.bin');
    expect(Array.from(bytes)).toEqual([0, 1, 2]);
  });

  it('fetch-forced curl without -L exposes redirects', async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run('curl --codepod-network=fetch -I http://example.test/redirect');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('302');
    expect(result.stdout.toLowerCase()).toContain('location:');
  });

  it('fetch-forced curl reports transport errors as non-zero', async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run('curl --codepod-network=fetch http://example.test/denied');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('blocked by test policy');
  });

  it('libcurl fetch canary runs through direct library API', async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run('libcurl-fetch-canary http://example.test/data');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status=200');
    expect(result.stdout).toContain('hello curl');
  });
});
