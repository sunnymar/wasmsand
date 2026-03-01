# SSRF Redirect Fix (VULN-NET-01) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent SSRF by re-validating network policy on every HTTP redirect hop.

**Architecture:** Replace the single `globalThis.fetch()` call with a manual redirect loop (`redirect: 'manual'`) that checks each `Location` header against the policy before following. Same logic applied in both `NetworkGateway.fetch()` and the bridge worker.

**Tech Stack:** TypeScript, Deno test runner (`@std/testing/bdd`, `@std/expect`)

---

### Task 1: Add redirect-following tests to gateway.test.ts

**Files:**
- Modify: `packages/orchestrator/src/network/__tests__/gateway.test.ts`

**Step 1: Write failing tests for redirect policy re-validation**

Add a new `describe('redirect handling')` block inside the existing `describe('NetworkGateway')` after the `describe('fetch')` block. These tests mock `globalThis.fetch` to return 3xx responses and verify the gateway's behavior.

```ts
  describe('redirect handling', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('follows redirect within allowed hosts', async () => {
      let callCount = 0;
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        callCount++;
        if (callCount === 1) {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://example.com/final' },
          });
        }
        return new Response('final');
      }) as typeof fetch;

      const gw = new NetworkGateway({ allowedHosts: ['example.com'] });
      const resp = await gw.fetch('https://example.com/start');
      expect(await resp.text()).toBe('final');
      expect(callCount).toBe(2);
    });

    it('blocks redirect to disallowed host', async () => {
      globalThis.fetch = mock(async () => {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://evil.com/steal' },
        });
      }) as typeof fetch;

      const gw = new NetworkGateway({ allowedHosts: ['example.com'] });
      try {
        await gw.fetch('https://example.com/start');
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkAccessDenied);
        expect((err as NetworkAccessDenied).message).toContain('evil.com');
      }
    });

    it('enforces max redirect limit', async () => {
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        return new Response(null, {
          status: 302,
          headers: { Location: String(url) + '/next' },
        });
      }) as typeof fetch;

      const gw = new NetworkGateway({ allowedHosts: ['example.com'] });
      try {
        await gw.fetch('https://example.com/start');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkAccessDenied);
        expect((err as NetworkAccessDenied).message).toContain('too many redirects');
      }
    });

    it('303 changes method to GET', async () => {
      const calls: { url: string; method: string }[] = [];
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? 'GET' });
        if (calls.length === 1) {
          return new Response(null, {
            status: 303,
            headers: { Location: 'https://example.com/result' },
          });
        }
        return new Response('ok');
      }) as typeof fetch;

      const gw = new NetworkGateway({ allowedHosts: ['example.com'] });
      await gw.fetch('https://example.com/submit', { method: 'POST', body: 'data' });
      expect(calls[0].method).toBe('POST');
      expect(calls[1].method).toBe('GET');
    });

    it('307 preserves method', async () => {
      const calls: { url: string; method: string }[] = [];
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? 'GET' });
        if (calls.length === 1) {
          return new Response(null, {
            status: 307,
            headers: { Location: 'https://example.com/new-endpoint' },
          });
        }
        return new Response('ok');
      }) as typeof fetch;

      const gw = new NetworkGateway({ allowedHosts: ['example.com'] });
      await gw.fetch('https://example.com/api', { method: 'POST', body: 'data' });
      expect(calls[0].method).toBe('POST');
      expect(calls[1].method).toBe('POST');
    });

    it('calls onRequest callback for redirect targets', async () => {
      const onRequestUrls: string[] = [];
      const onRequest = mock(async (req: { url: string }) => {
        onRequestUrls.push(req.url);
        return true;
      });
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        if (onRequestUrls.length <= 1) {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://example.com/redirected' },
          });
        }
        return new Response('ok');
      }) as typeof fetch;

      const gw = new NetworkGateway({ allowedHosts: ['example.com'], onRequest });
      await gw.fetch('https://example.com/start');
      expect(onRequestUrls).toContain('https://example.com/start');
      expect(onRequestUrls).toContain('https://example.com/redirected');
    });
  });
```

Also add `beforeEach` import to the existing imports line:

Change: `import { describe, it } from '@std/testing/bdd';`
To: `import { describe, it, beforeEach, afterEach } from '@std/testing/bdd';`

**Step 2: Run tests to verify they fail**

Run: `cd /Users/sunny/work/codepod/codepod && /Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/network/__tests__/gateway.test.ts`

Expected: New redirect tests fail (gateway currently follows redirects automatically via `globalThis.fetch`, so the mock won't intercept the second hop correctly, or the policy won't block the redirect target).

---

### Task 2: Implement redirect loop in NetworkGateway.fetch()

**Files:**
- Modify: `packages/orchestrator/src/network/gateway.ts`

**Step 1: Add constants after the `NetworkAccessDenied` class (line 29)**

```ts
/** Maximum number of HTTP redirects to follow before aborting. */
const MAX_REDIRECTS = 5;

/** HTTP status codes that indicate a redirect. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
```

**Step 2: Replace the `fetch()` method body (lines 78-111)**

Replace the entire method with the redirect-following loop:

```ts
  /** Fetch with policy enforcement. Throws NetworkAccessDenied on denial. */
  async fetch(url: string, options?: RequestInit): Promise<Response> {
    let currentUrl = url;
    let currentMethod = options?.method ?? 'GET';
    let currentBody: BodyInit | null | undefined = options?.body;

    for (let hops = 0; ; hops++) {
      const headers: Record<string, string> = {};
      if (options?.headers) {
        const h = options.headers;
        if (h instanceof Headers) {
          h.forEach((v, k) => { headers[k] = v; });
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) { headers[k] = v; }
        } else {
          Object.assign(headers, h);
        }
      }

      // Static check
      const access = this.checkAccess(currentUrl, currentMethod);
      if (!access.allowed) {
        throw new NetworkAccessDenied(currentUrl, access.reason!);
      }

      // Dynamic callback check
      if (this.policy.onRequest) {
        const allowed = await this.policy.onRequest({ url: currentUrl, method: currentMethod, headers });
        if (!allowed) {
          throw new NetworkAccessDenied(currentUrl, 'denied by onRequest callback');
        }
      }

      const resp = await globalThis.fetch(currentUrl, {
        ...options,
        method: currentMethod,
        body: currentBody,
        redirect: 'manual',
      });

      if (!REDIRECT_STATUSES.has(resp.status)) {
        return resp;
      }

      const location = resp.headers.get('Location');
      if (!location) {
        return resp; // No Location header — return as-is
      }

      // Resolve relative redirects against current URL
      currentUrl = new URL(location, currentUrl).href;

      // 303: change method to GET and drop body (RFC 7231)
      if (resp.status === 303) {
        currentMethod = 'GET';
        currentBody = undefined;
      }

      if (hops >= MAX_REDIRECTS) {
        throw new NetworkAccessDenied(currentUrl, 'too many redirects');
      }
    }
  }
```

**Step 3: Run tests to verify they pass**

Run: `cd /Users/sunny/work/codepod/codepod && /Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/network/__tests__/gateway.test.ts`

Expected: All tests pass, including the new redirect tests.

**Step 4: Commit**

```bash
git add packages/orchestrator/src/network/gateway.ts packages/orchestrator/src/network/__tests__/gateway.test.ts
git commit -m "fix: re-validate network policy on each redirect hop (VULN-NET-01)"
```

---

### Task 3: Implement redirect loop in bridge worker

**Files:**
- Modify: `packages/orchestrator/src/network/bridge.ts`

**Step 1: Replace the `try` block in the worker code (lines 105-125)**

Replace the existing fetch+response handling inside the worker's `loop()` function with a redirect-following loop. The worker code is a string template, so change the section between `try {` and `} catch (err) {`:

```ts
          try {
            const MAX_REDIRECTS = 5;
            const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
            let currentUrl = req.url;
            let currentMethod = req.method;
            let currentBody = req.body || undefined;
            let resp;

            for (let hops = 0; ; hops++) {
              // Re-validate policy on each hop
              if (hops > 0) {
                const hopAccess = checkAccess(currentUrl);
                if (!hopAccess.allowed) {
                  const result = JSON.stringify({ status: 403, body: '', headers: {}, error: hopAccess.reason });
                  const encoded = encoder.encode(result);
                  uint8.set(encoded, 8);
                  Atomics.store(int32, 1, encoded.byteLength);
                  Atomics.store(int32, 0, ${STATUS_ERROR});
                  Atomics.notify(int32, 0);
                  resp = null;
                  break;
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
              if (resp.status === 303) {
                currentMethod = 'GET';
                currentBody = undefined;
              }

              if (hops >= MAX_REDIRECTS) {
                const result = JSON.stringify({ status: 0, body: '', headers: {}, error: 'too many redirects' });
                const encoded = encoder.encode(result);
                uint8.set(encoded, 8);
                Atomics.store(int32, 1, encoded.byteLength);
                Atomics.store(int32, 0, ${STATUS_ERROR});
                Atomics.notify(int32, 0);
                resp = null;
                break;
              }
            }

            if (resp) {
              const body = await resp.text();
              const headers = {};
              resp.headers.forEach((v, k) => { headers[k] = v; });
              const result = JSON.stringify({ status: resp.status, body, headers });
              const encoded = encoder.encode(result);
              uint8.set(encoded, 8);
              Atomics.store(int32, 1, encoded.byteLength);
              Atomics.store(int32, 0, ${STATUS_RESPONSE_READY});
            }
```

Note: The `resp = null` + `if (resp)` pattern avoids duplicating the Atomics notify — the error paths do their own notify+continue, and the success path only runs when `resp` is a real response.

**Step 2: Run bridge tests**

Run: `cd /Users/sunny/work/codepod/codepod && /Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/network/__tests__/bridge.test.ts`

Expected: All existing bridge tests pass.

**Step 3: Commit**

```bash
git add packages/orchestrator/src/network/bridge.ts
git commit -m "fix: re-validate network policy on redirects in bridge worker"
```

---

### Task 4: Add adversarial security test

**Files:**
- Modify: `packages/orchestrator/src/__tests__/security-adversarial.test.ts`

**Step 1: Write test for redirect to blocked host**

Add before the `it('fork inherits allowlist restrictions')` test. This test exercises the gateway through the Sandbox's `curl` builtin, proving the full stack blocks redirect-based SSRF.

Note: The curl builtin inside the sandbox goes through `NetworkGateway.fetch()`, so we can't mock `globalThis.fetch` directly. Instead we test this at the gateway unit test level (Task 1 already covers it). For the adversarial test, we verify the gateway's checkAccess is called for known-bad metadata IPs by using the `blockedHosts` config.

```ts
  it('redirect-based SSRF is blocked by policy re-validation', async () => {
    // This test verifies the gateway rejects redirect targets at the policy
    // level. We use a direct gateway test since curl inside the sandbox
    // delegates to NetworkGateway.fetch().
    const { NetworkGateway, NetworkAccessDenied } = await import('../network/gateway.js');

    const gw = new NetworkGateway({ allowedHosts: ['trusted.com'] });

    // Mock globalThis.fetch to simulate a redirect to metadata endpoint
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      });
    }) as typeof fetch;
    try {
      let caught = false;
      try {
        await gw.fetch('https://trusted.com/api');
      } catch (err) {
        caught = true;
        expect(err).toBeInstanceOf(NetworkAccessDenied);
        expect((err as Error).message).toContain('169.254.169.254');
      }
      expect(caught).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
```

**Step 2: Run adversarial tests**

Run: `cd /Users/sunny/work/codepod/codepod && /Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/__tests__/security-adversarial.test.ts`

Expected: All tests pass, including the new one.

**Step 3: Commit**

```bash
git add packages/orchestrator/src/__tests__/security-adversarial.test.ts
git commit -m "test: adversarial test for redirect-based SSRF (VULN-NET-01)"
```

---

### Task 5: Run full verification

**Step 1: Type check**

Run: `cd /Users/sunny/work/codepod/codepod/packages/orchestrator && npx tsc --noEmit`

Expected: Clean (no output).

**Step 2: Gateway tests**

Run: `cd /Users/sunny/work/codepod/codepod && /Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/network/__tests__/gateway.test.ts`

Expected: All pass.

**Step 3: Bridge tests (regression)**

Run: `cd /Users/sunny/work/codepod/codepod && /Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/network/__tests__/bridge.test.ts`

Expected: All pass.

**Step 4: Security adversarial tests**

Run: `cd /Users/sunny/work/codepod/codepod && /Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/__tests__/security-adversarial.test.ts`

Expected: All pass.

**Step 5: Security acceptance tests (regression)**

Run: `cd /Users/sunny/work/codepod/codepod && /Users/sunny/.deno/bin/deno test -A --no-check packages/orchestrator/src/__tests__/security.test.ts`

Expected: All pass.
