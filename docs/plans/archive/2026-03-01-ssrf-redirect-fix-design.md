# Design: Fix SSRF via redirect following (VULN-NET-01)

## Problem

`NetworkGateway.fetch()` and the bridge worker both check the network policy on the initial URL only, then delegate to `globalThis.fetch()` which follows 3xx redirects by default. A server on an allowed host can redirect to a blocked host (e.g. `169.254.169.254` AWS IMDS), bypassing the policy.

## Solution

Disable automatic redirect following (`redirect: 'manual'`) and implement a manual redirect loop that re-validates each hop against the network policy.

## Design

### Constants

```ts
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
```

### `NetworkGateway.fetch()` changes

Replace the single `globalThis.fetch(url, options)` call with a loop:

1. Set `redirect: 'manual'` on the fetch options
2. Fetch the URL
3. If the response status is in `REDIRECT_STATUSES` and has a `Location` header:
   - Resolve the `Location` against the current URL (handles relative redirects)
   - Run `checkAccess()` on the new URL — throw `NetworkAccessDenied` if blocked
   - Run `onRequest` callback if configured — throw if denied
   - For 303: change method to `GET`, drop body
   - For 307/308: preserve method and body
   - Increment hop counter; throw if > `MAX_REDIRECTS`
   - Loop back to step 2 with the new URL
4. If not a redirect, return the response

### Bridge worker changes

Same redirect-following logic duplicated in the worker's `loop()` function. The worker already has `checkAccess()` inlined, so the re-validation uses that. Same 5-hop limit. Since the worker deals with the response body directly, it follows redirects before reading the body.

### 303 method semantics

Per RFC 7231, a 303 response means the client should follow the redirect with GET regardless of the original method. 307 and 308 preserve the original method and body.

### Files changed

| File | Change |
|------|--------|
| `packages/orchestrator/src/network/gateway.ts` | Add `MAX_REDIRECTS`, `REDIRECT_STATUSES`, redirect loop in `fetch()` |
| `packages/orchestrator/src/network/bridge.ts` | Add redirect loop in worker code |
| `packages/orchestrator/src/network/__tests__/gateway.test.ts` | Tests: redirect re-validation blocks disallowed redirect target, hop limit enforced, 303 method change |
| `packages/orchestrator/src/__tests__/security-adversarial.test.ts` | Adversarial test: redirect to blocked host via Sandbox integration |

### Test plan

1. **Redirect to blocked host is denied** — Mock `globalThis.fetch` to return 302 to `evil.com`. Verify `NetworkAccessDenied` is thrown.
2. **Redirect within allowed hosts works** — Mock fetch to return 302 from `a.example.com` to `b.example.com`, both in allowedHosts. Verify final response returned.
3. **Hop limit enforced** — Mock fetch to return infinite 302 chain. Verify error after 5 hops.
4. **303 changes method to GET** — Mock fetch to return 303. Verify follow-up fetch uses GET.
5. **307 preserves method** — Mock fetch to return 307 with POST. Verify follow-up fetch uses POST.
6. **Adversarial Sandbox test** — Verify via Sandbox that a curl to an allowed host that would redirect to a blocked host is denied.
