# curl/libcurl Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port curl/libcurl as one runtime-selecting Codepod C port with `auto|fetch|socket` networking and direct libcurl canaries.

**Architecture:** First make the host fetch ABI curl-capable: manual redirects, byte-preserving browser fetch, and transport-vs-HTTP error semantics. Then add `packages/c-ports/curl` as an upstream-pin C port for curl 8.19.0, patch libcurl with a Codepod network mode and fetch transport, and validate both CLI and library surfaces through sandbox tests.

**Tech Stack:** Deno tests, TypeScript kernel/network bridge, `cpcc`/`cpar`/`cpranlib`, `wasi-sdk`, curl/libcurl 8.19.0, static `libcurl.a`, C canaries, Codepod `libcodepod.a`/transitional `libcodepod_guest_compat.a`.

---

## Context

Spec: `docs/superpowers/specs/2026-05-01-curl-libcurl-port-design.md`.

Upstream pin: curl `8.19.0`. The official curl download page currently lists `curl 8.19.0`, released `2026-03-11`, as the source package. Use tag `curl-8_19_0` in `https://github.com/curl/curl.git` unless implementation-time verification shows the upstream tag spelling differs.

Existing c-port policy: `packages/c-ports/README.md` requires an upstream git submodule, patches in `patches/*.patch`, and an out-of-tree `build/work` copy.

Current transitional archive path in c-port Makefiles:

```make
GUEST_COMPAT_LIB := $(REPO_ROOT)/packages/guest-compat/build/libcodepod_guest_compat.a
```

Use that path until the archive rename is complete elsewhere. Do not block this port on the rename.

---

## File Map

### Host Fetch ABI

- Modify `packages/orchestrator/src/network/bridge.ts`
  - Add `redirect?: "follow" | "manual"` to fetch request handling.
  - Keep current manual redirect loop only when `redirect !== "manual"`.
  - Return 3xx status, headers, `location`, text body, and `body_base64` when manual.

- Modify `packages/orchestrator/src/network/bridge-client.ts`
  - Add optional redirect argument to `fetchSync`.
  - Serialize `{ url, method, headers, body, redirect }`.

- Modify `packages/orchestrator/src/network/browser-bridge.ts`
  - Add optional redirect argument to `fetchAsync`.
  - Use browser `fetch(..., { redirect })`.
  - Read `arrayBuffer()`, populate text `body` and lossless `body_base64`.

- Modify `packages/orchestrator/src/network/bridge.ts`
  - Update `NetworkBridgeLike` interface: `fetchSync(url, method, headers, body?, redirect?)`, `fetchAsync(..., redirect?)`.

- Modify `packages/orchestrator/src/host-imports/kernel-imports.ts`
  - Parse `redirect` from `host_network_fetch` request JSON.
  - Pass redirect through to `networkBridge`.
  - Keep `ok` for backwards compatibility, but plan curl/libcurl to ignore it.

- Modify `packages/orchestrator/src/sandbox.ts`
  - Add an explicit `networkBridge?: NetworkBridgeLike` embedding/test
    override so curl conformance can use deterministic fetch responses.

- Test `packages/orchestrator/src/network/__tests__/bridge.test.ts`
  - Add manual redirect behavior test.
  - Existing host-listener dependency can remain conditional if this environment cannot bind.

- Test `packages/orchestrator/src/network/__tests__/browser-bridge.test.ts`
  - New unit test with a mocked `globalThis.fetch` for manual redirects and binary base64.

- Test `packages/orchestrator/src/host-imports/__tests__/network-fetch-import.test.ts`
  - New import-level test that calls `host_network_fetch` with redirect/manual and verifies JSON response.

### curl Port

- Create `packages/c-ports/curl/.gitignore`
- Create `packages/c-ports/curl/README.md`
- Create `packages/c-ports/curl/Makefile`
- Add submodule `packages/c-ports/curl/upstream`
- Create `packages/c-ports/curl/patches/0001-codepod-network-mode.patch`
- Create `packages/c-ports/curl/patches/0002-codepod-fetch-transport.patch`
- Create `packages/c-ports/curl/patches/0003-disable-unsupported-process-features.patch`
- Create `packages/c-ports/curl/canaries/libcurl-fetch-canary.c`
- Create `packages/c-ports/curl/canaries/libcurl-socket-canary.c`

### Tests And Fixtures

- Create `packages/orchestrator/src/__tests__/curl-conformance.test.ts`
- Runtime artifacts copied by Makefile:
  - `packages/orchestrator/src/platform/__tests__/fixtures/curl.wasm`
  - `packages/orchestrator/src/platform/__tests__/fixtures/libcurl-fetch-canary.wasm`
  - `packages/orchestrator/src/platform/__tests__/fixtures/libcurl-socket-canary.wasm`

---

## Task 1: Host Fetch Manual Redirect And Binary Browser Parity

**Files:**
- Modify: `packages/orchestrator/src/network/bridge.ts`
- Modify: `packages/orchestrator/src/network/bridge-client.ts`
- Modify: `packages/orchestrator/src/network/browser-bridge.ts`
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts`
- Modify: `packages/orchestrator/src/sandbox.ts`
- Create: `packages/orchestrator/src/network/__tests__/browser-bridge.test.ts`
- Create: `packages/orchestrator/src/host-imports/__tests__/network-fetch-import.test.ts`
- Modify: `packages/orchestrator/src/network/__tests__/bridge.test.ts`

- [ ] **Step 1: Write browser bridge tests**

Create `packages/orchestrator/src/network/__tests__/browser-bridge.test.ts`:

```ts
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { BrowserNetworkBridge } from '../browser-bridge.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(bytes: Uint8Array, init: ResponseInit): Response {
  return new Response(bytes, init);
}

describe('BrowserNetworkBridge', () => {
  it('uses manual redirects when requested', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return Promise.resolve(response(new TextEncoder().encode('moved'), {
        status: 302,
        headers: { location: '/next' },
      }));
    }) as typeof fetch;

    const bridge = new BrowserNetworkBridge({ allowedHosts: ['example.test'] });
    const result = await bridge.fetchAsync('https://example.test/start', 'GET', {}, undefined, 'manual');

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe('/next');
    expect(result.body).toBe('moved');
    expect(calls[0].redirect).toBe('manual');
  });

  it('returns body_base64 for binary responses', async () => {
    globalThis.fetch = (() => {
      return Promise.resolve(response(new Uint8Array([0, 1, 2, 253, 254, 255]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }));
    }) as typeof fetch;

    const bridge = new BrowserNetworkBridge({ allowedHosts: ['example.test'] });
    const result = await bridge.fetchAsync('https://example.test/binary', 'GET', {});

    expect(result.status).toBe(200);
    expect(result.body_base64).toBe('AAEC/f7/');
  });
});
```

- [ ] **Step 2: Write host import redirect test**

Create `packages/orchestrator/src/host-imports/__tests__/network-fetch-import.test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert@^1.0.19';
import { createKernelImports } from '../kernel-imports.ts';
import type { NetworkBridgeLike, SyncFetchResult, SyncRequestResult } from '../../network/bridge.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class RecordingBridge implements NetworkBridgeLike {
  redirect: string | undefined;

  fetchSync(
    _url: string,
    _method: string,
    _headers: Record<string, string>,
    _body?: string,
    redirect?: 'follow' | 'manual',
  ): SyncFetchResult {
    this.redirect = redirect;
    return {
      status: 302,
      headers: { location: '/next' },
      body: 'moved',
      body_base64: 'bW92ZWQ=',
    };
  }

  requestSync(_op: Record<string, unknown>): SyncRequestResult {
    return { ok: false, error: 'not used' };
  }
}

function readCString(memory: WebAssembly.Memory, ptr: number, len: number): string {
  return decoder.decode(new Uint8Array(memory.buffer, ptr, len));
}

Deno.test('host_network_fetch passes manual redirect and preserves HTTP status', async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bridge = new RecordingBridge();
  const imports = createKernelImports({ memory, networkBridge: bridge });
  const req = encoder.encode(JSON.stringify({
    url: 'https://example.test/start',
    method: 'GET',
    headers: {},
    redirect: 'manual',
  }));
  new Uint8Array(memory.buffer, 32, req.length).set(req);

  const written = await imports.host_network_fetch(32, req.length, 1024, 4096) as number;
  const json = JSON.parse(readCString(memory, 1024, written));

  assertEquals(bridge.redirect, 'manual');
  assertEquals(json.status, 302);
  assertEquals(json.error, null);
  assertEquals(json.body_base64, 'bW92ZWQ=');
});
```

- [ ] **Step 3: Extend NetworkBridge tests for manual redirects**

Modify the server script in `packages/orchestrator/src/network/__tests__/bridge.test.ts` by adding this route before the default 404:

```ts
      if (url.pathname === '/redirect') {
        res.writeHead(302, { Location: '/data' });
        res.end('redirect body');
        return;
      }
```

Add this test after `text body still works for UTF-8 content`:

```ts
  it('can return manual redirects without following them', async () => {
    const gateway = new NetworkGateway({ allowedHosts: ['127.0.0.1'] });
    bridge = new NetworkBridge(gateway);
    await bridge.start();

    const result = bridge.fetchSync(`${baseUrl}/redirect`, 'GET', {}, undefined, 'manual');
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe('/data');
    expect(result.body).toBe('redirect body');
  });
```

- [ ] **Step 4: Run tests and confirm they fail**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check \
  packages/orchestrator/src/network/__tests__/browser-bridge.test.ts \
  packages/orchestrator/src/host-imports/__tests__/network-fetch-import.test.ts
```

Expected:

- `browser-bridge.test.ts` fails because `fetchAsync` does not accept/pass redirect and does not set `body_base64`.
- `network-fetch-import.test.ts` fails because `NetworkBridgeLike.fetchSync` has no redirect argument or `kernel-imports.ts` does not pass it.

- [ ] **Step 5: Update bridge types and client serialization**

In `packages/orchestrator/src/network/bridge.ts`, replace the interface signatures with:

```ts
export type FetchRedirectMode = 'follow' | 'manual';

export interface SyncFetchResult {
  status: number;
  body: string;
  /** Base64-encoded response body for lossless binary transfer (wheels, WASM). */
  body_base64?: string;
  headers: Record<string, string>;
  error?: string;
}

/** Minimal interface for network access from WASM host imports. */
export interface NetworkBridgeLike {
  fetchSync(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    redirect?: FetchRedirectMode,
  ): SyncFetchResult;
  /** Async fetch — used in the browser where Atomics.wait() isn't available on the main thread. */
  fetchAsync?(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    redirect?: FetchRedirectMode,
  ): Promise<SyncFetchResult>;
  /** Send a generic operation (connect/send/recv/close) through the bridge. */
  requestSync(op: Record<string, unknown>): SyncRequestResult;
}
```

In `packages/orchestrator/src/network/bridge-client.ts`, change the import and method signature:

```ts
import type { FetchRedirectMode, SyncFetchResult, SyncRequestResult, NetworkBridgeLike } from './bridge.js';
```

```ts
  fetchSync(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    redirect?: FetchRedirectMode,
  ): SyncFetchResult {
```

Then change the request JSON line to:

```ts
    const reqJson = JSON.stringify({ url, method, headers, body, redirect });
```

- [ ] **Step 6: Update NetworkBridge worker fetch handling**

In `packages/orchestrator/src/network/bridge.ts`, change the public `fetchSync` signature to match:

```ts
  fetchSync(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    redirect?: FetchRedirectMode,
  ): SyncFetchResult {
```

and serialize redirect:

```ts
    const reqJson = JSON.stringify({ type: 'fetch', url, method, headers, body, redirect });
```

Inside the worker `handleFetch(req)` template, replace the redirect loop setup with:

```js
        const manualRedirect = req.redirect === 'manual';
        const MAX_REDIRECTS = 5;
        const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
        let currentUrl = req.url;
        let currentMethod = req.method;
        let currentBody = req.body || undefined;
        let resp;
        let redirectCount = 0;
```

and replace the redirect handling block after `fetch(...)` with:

```js
          if (manualRedirect || !REDIRECT_STATUSES.has(resp.status)) break;
          const location = resp.headers.get('location');
          if (!location) break;
          currentUrl = new URL(location, currentUrl).href;
          if (resp.status === 303) { currentMethod = 'GET'; currentBody = undefined; }
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            writeResponse(JSON.stringify({ status: 0, body: '', headers: {}, error: 'too many redirects' }), ${STATUS_ERROR});
            return;
          }
```

Keep the existing `redirect: 'manual'` option on the actual JS `fetch` call. That option prevents host fetch from hiding 3xx responses before the worker loop can decide whether to return or follow.

- [ ] **Step 7: Update BrowserNetworkBridge**

In `packages/orchestrator/src/network/browser-bridge.ts`, change the import:

```ts
import type { FetchRedirectMode, SyncFetchResult, SyncRequestResult, NetworkBridgeLike } from './bridge.js';
```

Replace `fetchAsync` with:

```ts
  async fetchAsync(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    redirect: FetchRedirectMode = 'follow',
  ): Promise<SyncFetchResult> {
    const access = this.gateway.checkAccess(url, method);
    if (!access.allowed) {
      return { status: 403, body: '', headers: {}, error: access.reason };
    }

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body || undefined,
        redirect,
      });

      const bytes = new Uint8Array(await resp.arrayBuffer());
      const respBody = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });

      return {
        status: resp.status,
        body: respBody,
        body_base64: btoa(binary),
        headers: respHeaders,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'Failed to fetch') {
        return { status: 0, body: '', headers: {}, error: `network error (likely CORS: ${url} does not allow cross-origin requests)` };
      }
      return { status: 0, body: '', headers: {}, error: msg };
    }
  }
```

- [ ] **Step 8: Update kernel host import**

In `packages/orchestrator/src/host-imports/kernel-imports.ts`, extend the parsed request type:

```ts
          redirect?: 'follow' | 'manual';
```

Read the redirect after body:

```ts
        const redirect = req.redirect === 'manual' ? 'manual' : 'follow';
```

Pass it to the bridge:

```ts
        const result = opts.networkBridge.fetchAsync
          ? await opts.networkBridge.fetchAsync(url, method, headers, body, redirect)
          : opts.networkBridge.fetchSync(url, method, headers, body, redirect);
```

Keep the existing response shape, including `ok`, for backwards compatibility:

```ts
          ok: !result.error && result.status >= 200 && result.status < 400,
          status: result.status,
          headers: result.headers,
          body: result.body,
          body_base64: result.body_base64 ?? null,
          error: result.error ?? null,
```

- [ ] **Step 9: Add Sandbox networkBridge injection**

In `packages/orchestrator/src/sandbox.ts`, import the interface:

```ts
import type { NetworkBridgeLike } from './network/bridge.js';
```

Add this field to `SandboxOptions` after `network?: NetworkPolicy;`:

```ts
  /** Optional network bridge override. Primarily used by tests and alternate embeddings. */
  networkBridge?: NetworkBridgeLike;
```

Change `SandboxParts.bridge` from:

```ts
  bridge?: NetworkBridge;
```

to:

```ts
  bridge?: NetworkBridgeLike;
```

Change `createLoaderContext`'s `bridge` option from:

```ts
    bridge?: NetworkBridge;
```

to:

```ts
    bridge?: NetworkBridgeLike;
```

In `Sandbox.create`, replace:

```ts
    const { bridge } = await Sandbox.createNetworkBridge(options.network);
```

with:

```ts
    const ownedNetwork = options.networkBridge
      ? { bridge: options.networkBridge }
      : await Sandbox.createNetworkBridge(options.network);
    const bridge = ownedNetwork.bridge;
```

Keep `createNetworkBridge()` unchanged. This override is explicit and avoids
mocking global fetch or opening a host listener in curl conformance tests.

- [ ] **Step 10: Verify Task 1**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check \
  packages/orchestrator/src/network/__tests__/browser-bridge.test.ts \
  packages/orchestrator/src/host-imports/__tests__/network-fetch-import.test.ts \
  packages/orchestrator/src/network/__tests__/bridge.test.ts
```

Expected:

- Browser and host import tests pass.
- `bridge.test.ts` passes when local host binding is allowed. If this environment reports `listen EPERM 127.0.0.1`, leave the failing bridge listener issue to the existing host-network restriction and run the first two tests plus the full orchestrator sweep later.

Run type-check:

```bash
source scripts/dev-init.sh && deno check \
  packages/orchestrator/src/network/bridge.ts \
  packages/orchestrator/src/network/bridge-client.ts \
  packages/orchestrator/src/network/browser-bridge.ts \
  packages/orchestrator/src/host-imports/kernel-imports.ts \
  packages/orchestrator/src/sandbox.ts \
  packages/orchestrator/src/network/__tests__/browser-bridge.test.ts \
  packages/orchestrator/src/host-imports/__tests__/network-fetch-import.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit Task 1**

```bash
git add \
  packages/orchestrator/src/network/bridge.ts \
  packages/orchestrator/src/network/bridge-client.ts \
  packages/orchestrator/src/network/browser-bridge.ts \
  packages/orchestrator/src/host-imports/kernel-imports.ts \
  packages/orchestrator/src/sandbox.ts \
  packages/orchestrator/src/network/__tests__/bridge.test.ts \
  packages/orchestrator/src/network/__tests__/browser-bridge.test.ts \
  packages/orchestrator/src/host-imports/__tests__/network-fetch-import.test.ts
git commit -m "feat(network): expose fetch redirect and binary semantics"
```

---

## Task 2: Scaffold curl C Port

**Files:**
- Create: `packages/c-ports/curl/.gitignore`
- Create: `packages/c-ports/curl/README.md`
- Create: `packages/c-ports/curl/Makefile`
- Modify: `.gitmodules`
- Add submodule: `packages/c-ports/curl/upstream`

- [ ] **Step 1: Add upstream submodule**

Run:

```bash
git submodule add https://github.com/curl/curl.git packages/c-ports/curl/upstream
cd packages/c-ports/curl/upstream && git checkout curl-8_19_0
cd /Users/sunny/work/codepod/codepod
git add .gitmodules packages/c-ports/curl/upstream
```

Expected:

- `.gitmodules` has a new `packages/c-ports/curl/upstream` entry.
- `git submodule status packages/c-ports/curl/upstream` shows a pinned commit and tag `curl-8_19_0`.

- [ ] **Step 2: Create `.gitignore`**

Create `packages/c-ports/curl/.gitignore`:

```gitignore
/build/
```

- [ ] **Step 3: Create README**

Create `packages/c-ports/curl/README.md`:

```md
# curl/libcurl port

Codepod C port of curl/libcurl 8.19.0.

The port builds a static `libcurl.a`, a `curl.wasm` CLI, and two direct
libcurl canaries:

- `libcurl-fetch-canary.wasm`
- `libcurl-socket-canary.wasm`

Networking is selected at runtime:

- `auto` chooses a working transport.
- `fetch` routes HTTP through `codepod.host_network_fetch`.
- `socket` routes HTTP through POSIX sockets backed by the Codepod socket ABI.

The curl CLI exposes this only for tests and diagnostics:

```bash
curl --codepod-network=auto|fetch|socket URL
```

Library tests use `CURLOPT_CODEPOD_NETWORK` or `CODEPOD_CURL_NETWORK`.

## Build

```bash
make -C packages/c-ports/curl copy-fixtures
```

The build uses the repository `cpcc` toolchain and the shared guest
compatibility archive. Upstream source lives in `upstream/` as a git submodule;
Codepod changes live in `patches/*.patch` and are applied to `build/work/`.
```

- [ ] **Step 4: Create initial Makefile**

Create `packages/c-ports/curl/Makefile`:

```make
REPO_ROOT := $(shell cd ../../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
CURL_VERSION := 8.19.0
UPSTREAM := upstream
PATCHES_DIR := patches
BUILD_DIR := build
WORK_DIR := $(BUILD_DIR)/work
CANARY_DIR := canaries
GUEST_COMPAT_INCLUDE := $(abspath ../../guest-compat/include)
GUEST_COMPAT_LIB := $(REPO_ROOT)/packages/guest-compat/build/libcodepod_guest_compat.a

CPCC := $(REPO_ROOT)/target/release/cpcc
CPAR := $(REPO_ROOT)/target/release/cpar
CPRANLIB := $(REPO_ROOT)/target/release/cpranlib

WASI_EMULATED_CFLAGS := -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS
WASI_EMULATED_LDFLAGS := -lwasi-emulated-mman -lwasi-emulated-process-clocks -Wl,-u,__main_argc_argv

.PHONY: all submodule-init worktree configure build canaries copy-fixtures clean ensure-toolchain ensure-compat

all: $(BUILD_DIR)/curl.wasm $(BUILD_DIR)/libcurl-fetch-canary.wasm $(BUILD_DIR)/libcurl-socket-canary.wasm

submodule-init:
	@if [ ! -f $(UPSTREAM)/configure.ac ]; then \
		echo "==> Initializing curl submodule"; \
		cd $(REPO_ROOT) && git submodule update --init packages/c-ports/curl/$(UPSTREAM); \
	fi

ensure-toolchain:
	cd $(REPO_ROOT) && cargo build --release -p cpcc-toolchain

ensure-compat:
	$(MAKE) -C $(REPO_ROOT)/packages/guest-compat lib

$(WORK_DIR)/configure.ac: submodule-init
	mkdir -p $(WORK_DIR)
	rsync -a --delete --exclude='.git' $(UPSTREAM)/ $(WORK_DIR)/
	if [ -d $(PATCHES_DIR) ] && ls $(PATCHES_DIR)/*.patch >/dev/null 2>&1; then \
		for p in $(PATCHES_DIR)/*.patch; do \
			echo "==> Applying $$p"; \
			git -C $(WORK_DIR) apply --whitespace=nowarn $(abspath $$p); \
		done; \
	fi
	touch $(WORK_DIR)/configure.ac

$(WORK_DIR)/configure: $(WORK_DIR)/configure.ac
	cd $(WORK_DIR) && autoreconf -fi

$(WORK_DIR)/Makefile: $(WORK_DIR)/configure ensure-toolchain ensure-compat
	cd $(WORK_DIR) && \
		CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
		CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE)" \
		CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
		CFLAGS="$(WASI_EMULATED_CFLAGS) -O2" \
		LDFLAGS="$(WASI_EMULATED_LDFLAGS)" \
		ac_cv_func_fork=no \
		ac_cv_func_vfork=no \
		./configure \
			--host=wasm32-wasi \
			--prefix=/usr \
			--disable-shared \
			--enable-static \
			--disable-threaded-resolver \
			--disable-verbose \
			--disable-manual \
			--disable-libcurl-option \
			--without-ssl \
			--without-zlib \
			--without-brotli \
			--without-zstd \
			--without-libpsl \
			--without-nghttp2 \
			--without-ngtcp2 \
			--without-nghttp3 \
			--disable-ftp \
			--disable-file \
			--disable-ldap \
			--disable-ldaps \
			--disable-rtsp \
			--disable-proxy \
			--disable-dict \
			--disable-telnet \
			--disable-tftp \
			--disable-pop3 \
			--disable-imap \
			--disable-smb \
			--disable-smtp \
			--disable-gopher \
			--disable-mqtt

configure: $(WORK_DIR)/Makefile

$(BUILD_DIR)/curl.wasm: $(WORK_DIR)/Makefile ensure-compat
	cd $(WORK_DIR) && \
		CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
		CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE)" \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
			VERSION="$(CURL_VERSION)" \
			src/curl
	cp $(WORK_DIR)/src/curl $(BUILD_DIR)/curl.wasm

$(BUILD_DIR)/libcurl-fetch-canary.wasm: $(WORK_DIR)/Makefile $(CANARY_DIR)/libcurl-fetch-canary.c
	mkdir -p $(BUILD_DIR)
	CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
	CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE) $(WORK_DIR)/include" \
	$(CPCC) -O2 \
		-I$(WORK_DIR)/include \
		-I$(WORK_DIR)/lib \
		$(CANARY_DIR)/libcurl-fetch-canary.c \
		$(WORK_DIR)/lib/.libs/libcurl.a \
		-o $@

$(BUILD_DIR)/libcurl-socket-canary.wasm: $(WORK_DIR)/Makefile $(CANARY_DIR)/libcurl-socket-canary.c
	mkdir -p $(BUILD_DIR)
	CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
	CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE) $(WORK_DIR)/include" \
	$(CPCC) -O2 \
		-I$(WORK_DIR)/include \
		-I$(WORK_DIR)/lib \
		$(CANARY_DIR)/libcurl-socket-canary.c \
		$(WORK_DIR)/lib/.libs/libcurl.a \
		-o $@

copy-fixtures: all
	cp $(BUILD_DIR)/curl.wasm $(FIXTURES)/curl.wasm
	cp $(BUILD_DIR)/libcurl-fetch-canary.wasm $(FIXTURES)/libcurl-fetch-canary.wasm
	cp $(BUILD_DIR)/libcurl-socket-canary.wasm $(FIXTURES)/libcurl-socket-canary.wasm

clean:
	rm -rf $(BUILD_DIR)
```

The configure flags intentionally start with HTTP-only, no TLS-library linkage. Fetch-mode HTTPS will still work because browser/host fetch owns TLS. Socket-mode HTTPS is out of this first milestone unless a TLS backend is added.

- [ ] **Step 5: Create empty patches directory**

Run:

```bash
mkdir -p packages/c-ports/curl/patches packages/c-ports/curl/canaries
touch packages/c-ports/curl/patches/.gitkeep
touch packages/c-ports/curl/canaries/.gitkeep
```

- [ ] **Step 6: Verify scaffold**

Run:

```bash
git diff --check -- \
  packages/c-ports/curl/.gitignore \
  packages/c-ports/curl/README.md \
  packages/c-ports/curl/Makefile \
  .gitmodules
```

Expected: no output.

- [ ] **Step 7: Commit Task 2**

```bash
git add .gitmodules packages/c-ports/curl
git commit -m "build(curl): scaffold c port"
```

---

## Task 3: Define Codepod Network Mode Patch

**Files:**
- Create: `packages/c-ports/curl/patches/0001-codepod-network-mode.patch`

This task creates the public mode API and CLI/env parsing, before the fetch backend exists.

- [ ] **Step 1: Inspect curl option layout**

Run:

```bash
sed -n '1,220p' packages/c-ports/curl/upstream/include/curl/curl.h
rg -n "CURLOPT_|CINIT|enum.*CURLoption|CURLOPTTYPE" packages/c-ports/curl/upstream/include packages/c-ports/curl/upstream/lib
rg -n "long.*option|--http|tool_getparam|ParameterError|config" packages/c-ports/curl/upstream/src
```

Expected:

- Find the `CURLOPT_*` enum allocation style.
- Find CLI option parsing in `src/tool_getparam.*` or equivalent for curl 8.19.0.

- [ ] **Step 2: Add patch with mode enum and option**

Create `packages/c-ports/curl/patches/0001-codepod-network-mode.patch` by editing a clean worktree copy:

```bash
make -C packages/c-ports/curl clean
make -C packages/c-ports/curl submodule-init
mkdir -p packages/c-ports/curl/build/patch-work
rsync -a --delete --exclude='.git' packages/c-ports/curl/upstream/ packages/c-ports/curl/build/patch-work/
```

Apply these edits in `packages/c-ports/curl/build/patch-work`:

1. In `include/curl/curl.h`, add a public enum near other small public enums:

```c
typedef enum {
  CURLCODEPOD_NETWORK_AUTO = 0,
  CURLCODEPOD_NETWORK_FETCH = 1,
  CURLCODEPOD_NETWORK_SOCKET = 2
} curl_codepod_network;
```

2. Add `CURLOPT_CODEPOD_NETWORK` as a long option near the end of the `CURLoption` enum using curl's `CINIT(name, LONG, number)` pattern. Use the next free number in the local upstream file and add this comment immediately above it:

```c
  /* Codepod-only: select runtime network backend. Value is curl_codepod_network. */
```

3. In libcurl's easy handle user-defined settings struct, add:

```c
  long codepod_network;
```

4. In the easy handle default initialization, set:

```c
  set->codepod_network = CURLCODEPOD_NETWORK_AUTO;
```

5. In libcurl's `CURLOPT_*` setter switch, handle `CURLOPT_CODEPOD_NETWORK`:

```c
  case CURLOPT_CODEPOD_NETWORK:
    if(arg < CURLCODEPOD_NETWORK_AUTO || arg > CURLCODEPOD_NETWORK_SOCKET)
      return CURLE_BAD_FUNCTION_ARGUMENT;
    data->set.codepod_network = arg;
    break;
```

6. Add internal helper declaration in the most local libcurl header that can see the easy handle:

```c
long Curl_codepod_network_mode(const struct Curl_easy *data);
```

7. Add internal helper implementation:

```c
long Curl_codepod_network_mode(const struct Curl_easy *data)
{
  const char *env = curl_getenv("CODEPOD_CURL_NETWORK");
  long mode = data->set.codepod_network;
  if(env) {
    if(!strcmp(env, "auto"))
      mode = CURLCODEPOD_NETWORK_AUTO;
    else if(!strcmp(env, "fetch"))
      mode = CURLCODEPOD_NETWORK_FETCH;
    else if(!strcmp(env, "socket"))
      mode = CURLCODEPOD_NETWORK_SOCKET;
    free((void *)env);
  }
  return mode;
}
```

8. In the curl CLI config struct, add:

```c
  long codepod_network;
```

9. Initialize it to `CURLCODEPOD_NETWORK_AUTO`.

10. Add `--codepod-network <auto|fetch|socket>` parsing. On invalid value, return the same kind of parameter error curl uses for invalid enum-like options.

11. When creating/configuring the easy handle, call:

```c
  my_setopt_long(curl, CURLOPT_CODEPOD_NETWORK, config->codepod_network);
```

Then generate the patch:

```bash
cd packages/c-ports/curl/build/patch-work
git diff --no-index /dev/null /dev/null >/dev/null || true
git diff > ../../patches/0001-codepod-network-mode.patch
```

If `git diff` does not work because `patch-work` is not a git repository, use:

```bash
cd packages/c-ports/curl/build/patch-work
git init
git add .
git commit -m baseline
# make the edits above
git diff > ../../patches/0001-codepod-network-mode.patch
```

- [ ] **Step 3: Verify patch applies**

Run:

```bash
make -C packages/c-ports/curl clean
make -C packages/c-ports/curl configure
```

Expected:

- Patch application reaches `0001-codepod-network-mode.patch`.
- Configure may still fail later due missing fetch transport references only if the patch touches unresolved symbols. If so, fix the patch so this task is self-contained and configure completes.

- [ ] **Step 4: Commit Task 3**

```bash
git add packages/c-ports/curl/patches/0001-codepod-network-mode.patch
git commit -m "feat(curl): add codepod network mode option"
```

---

## Task 4: Add Codepod Fetch Runtime To guest-compat

**Files:**
- Modify: `packages/guest-compat/src/codepod_runtime.h`
- Create: `packages/guest-compat/src/codepod_fetch.c`
- Modify: `packages/guest-compat/Makefile`
- Test: `packages/guest-compat/conformance/c/fetch-canary.c`
- Test fixture copied to: `packages/orchestrator/src/platform/__tests__/fixtures/fetch-canary.wasm`
- Modify: `packages/orchestrator/src/__tests__/guest-compat.test.ts`

- [ ] **Step 1: Add C canary**

Create `packages/guest-compat/conformance/c/fetch-canary.c`:

```c
#include "codepod_compat.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: fetch-canary URL\n");
    return 2;
  }

  char *out = NULL;
  int rc = codepod_fetch_text(argv[1], "GET", NULL, NULL, &out);
  if (rc != 0) {
    fprintf(stderr, "fetch failed: %d\n", rc);
    return 1;
  }
  printf("%s", out ? out : "");
  free(out);
  return 0;
}
```

- [ ] **Step 2: Add public C API declaration**

In `packages/guest-compat/include/codepod_compat.h`, add:

```c
int codepod_fetch_text(
  const char *url,
  const char *method,
  const char *headers_json,
  const char *body,
  char **out_body
);
```

- [ ] **Step 3: Add raw import declaration**

In `packages/guest-compat/src/codepod_runtime.h`, add:

```c
__attribute__((import_module("codepod"), import_name("host_network_fetch")))
int codepod_host_network_fetch(int req_ptr, int req_len, int out_ptr, int out_cap);
```

- [ ] **Step 4: Add implementation**

Create `packages/guest-compat/src/codepod_fetch.c`:

```c
#include "codepod_runtime.h"

#include <errno.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static void append_json_string(char *dst, size_t cap, const char *s) {
  size_t used = strlen(dst);
  strncat(dst, "\"", cap - used - 1);
  for (const char *p = s ? s : ""; *p; ++p) {
    used = strlen(dst);
    if (*p == '"' || *p == '\\') {
      if (used + 2 >= cap) break;
      dst[used] = '\\';
      dst[used + 1] = *p;
      dst[used + 2] = '\0';
    } else if (*p == '\n') {
      strncat(dst, "\\n", cap - strlen(dst) - 1);
    } else {
      if (used + 1 >= cap) break;
      dst[used] = *p;
      dst[used + 1] = '\0';
    }
  }
  strncat(dst, "\"", cap - strlen(dst) - 1);
}

static const char *find_field(const char *json, const char *name) {
  static char needle[64];
  snprintf(needle, sizeof(needle), "\"%s\":", name);
  return strstr(json, needle);
}

static char *dup_json_string_field(const char *json, const char *name) {
  const char *p = find_field(json, name);
  if (!p) return NULL;
  p = strchr(p, '"');
  if (!p) return NULL;
  p++;
  const char *start = p;
  while (*p && *p != '"') p++;
  size_t len = (size_t)(p - start);
  char *out = malloc(len + 1);
  if (!out) return NULL;
  memcpy(out, start, len);
  out[len] = '\0';
  return out;
}

int codepod_fetch_text(
  const char *url,
  const char *method,
  const char *headers_json,
  const char *body,
  char **out_body
) {
  if (!url || !out_body) {
    errno = EINVAL;
    return -1;
  }
  *out_body = NULL;

  char req[8192] = {0};
  strncat(req, "{\"url\":", sizeof(req) - strlen(req) - 1);
  append_json_string(req, sizeof(req), url);
  strncat(req, ",\"method\":", sizeof(req) - strlen(req) - 1);
  append_json_string(req, sizeof(req), method ? method : "GET");
  strncat(req, ",\"headers\":", sizeof(req) - strlen(req) - 1);
  strncat(req, headers_json ? headers_json : "{}", sizeof(req) - strlen(req) - 1);
  strncat(req, ",\"body\":", sizeof(req) - strlen(req) - 1);
  if (body) append_json_string(req, sizeof(req), body);
  else strncat(req, "null", sizeof(req) - strlen(req) - 1);
  strncat(req, ",\"redirect\":\"manual\"}", sizeof(req) - strlen(req) - 1);

  int cap = 65536;
  char *resp = malloc((size_t)cap + 1);
  if (!resp) return -1;
  int written = codepod_host_network_fetch((int)(uintptr_t)req, (int)strlen(req), (int)(uintptr_t)resp, cap);
  if (written > cap) {
    cap = written;
    char *retry = realloc(resp, (size_t)cap + 1);
    if (!retry) {
      free(resp);
      return -1;
    }
    resp = retry;
    written = codepod_host_network_fetch((int)(uintptr_t)req, (int)strlen(req), (int)(uintptr_t)resp, cap);
  }
  if (written < 0) {
    free(resp);
    return -1;
  }
  resp[written] = '\0';

  char *error = dup_json_string_field(resp, "error");
  if (error && error[0]) {
    free(error);
    free(resp);
    errno = EIO;
    return -1;
  }
  free(error);

  char *text = dup_json_string_field(resp, "body");
  *out_body = text ? text : strdup("");
  free(resp);
  return *out_body ? 0 : -1;
}
```

This helper is intentionally narrow and text-oriented. The libcurl patch may use the raw `host_network_fetch` import directly for binary/base64. This helper only proves C can call the host fetch ABI.

- [ ] **Step 5: Wire Makefile**

In `packages/guest-compat/Makefile`, add `src/codepod_fetch.c` to the archive source/object list and add `fetch-canary` to the conformance canary build/copy list following the existing `socket-canary` pattern.

- [ ] **Step 6: Add orchestrator test**

In `packages/orchestrator/src/__tests__/guest-compat.test.ts`, add a step under `Guest compatibility canaries`:

```ts
  class StaticFetchBridge implements NetworkBridgeLike {
    fetchSync(): SyncFetchResult {
      return {
        status: 200,
        headers: {},
        body: 'fetch-canary-ok',
        body_base64: 'ZmV0Y2gtY2FuYXJ5LW9r',
      };
    }

    requestSync(): SyncRequestResult {
      return { ok: false, error: 'not used' };
    }
  }

  await t.step('routes C host_network_fetch through codepod_fetch_text', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ['example.test'] },
      networkBridge: new StaticFetchBridge(),
    });
    try {
      const result = await sb.run('/bin/fetch-canary https://example.test/data');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('fetch-canary-ok');
    } finally {
      sb.destroy();
    }
  });
```

Add these imports to the top of the file if they are not already present:

```ts
import type { NetworkBridgeLike, SyncFetchResult, SyncRequestResult } from '../network/bridge.ts';
```

- [ ] **Step 7: Verify Task 4**

Run:

```bash
source scripts/dev-init.sh && make -C packages/guest-compat lib
source scripts/dev-init.sh && make -C packages/guest-compat copy-fixtures
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/guest-compat.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add \
  packages/guest-compat/include/codepod_compat.h \
  packages/guest-compat/src/codepod_runtime.h \
  packages/guest-compat/src/codepod_fetch.c \
  packages/guest-compat/Makefile \
  packages/guest-compat/conformance/c/fetch-canary.c \
  packages/orchestrator/src/__tests__/guest-compat.test.ts \
  packages/orchestrator/src/platform/__tests__/fixtures/fetch-canary.wasm
git commit -m "feat(guest-compat): expose host fetch helper"
```

---

## Task 5: Add libcurl Fetch Transport Patch

**Files:**
- Create: `packages/c-ports/curl/patches/0002-codepod-fetch-transport.patch`
- Modify through patch: curl upstream worktree files under `lib/`

- [ ] **Step 1: Locate libcurl connect/HTTP hooks**

Run:

```bash
rg -n "Curl_handler_http|Curl_http|CONNECT|Curl_connect|Curl_do|Curl_readwrite|Curl_client_write|Curl_xfer|Curl_send|Curl_recv" packages/c-ports/curl/upstream/lib
rg -n "Curl_get_line|headers|httpcode|req\\.method|CUSTOMREQUEST|postfields|mimepost" packages/c-ports/curl/upstream/lib
```

Expected:

- Identify the HTTP handler table.
- Identify where libcurl marks response code, response headers, and body write callbacks.

- [ ] **Step 2: Add codepod fetch source file in patch worktree**

In a clean patch worktree, create `lib/codepod_fetch.c` with these responsibilities:

```c
/*
 * Codepod fetch transport for curl.
 *
 * This file is compiled only in the Codepod port. It converts one buffered
 * HTTP request into codepod.host_network_fetch and feeds the response back
 * into libcurl's normal status/header/body machinery.
 */
```

Implement these internal functions:

```c
CURLcode Curl_codepod_fetch_perform(struct Curl_easy *data);
bool Curl_codepod_fetch_should_use(struct Curl_easy *data);
```

Minimum behavior:

- `Curl_codepod_fetch_should_use(data)` returns true for:
  - `CURLOPT_CODEPOD_NETWORK == FETCH`
  - `AUTO` when sockets are not available or when a future runtime probe says fetch is required.
- It returns false for `SOCKET`.
- `Curl_codepod_fetch_perform(data)`:
  - Builds request URL from the current transfer URL.
  - Gets method from libcurl request state.
  - Collects request headers from the easy handle.
  - Buffers request body for `-d`/POST fields.
  - Calls `codepod_host_network_fetch` with `redirect: "manual"`.
  - Decodes `body_base64` if present.
  - Sets response code in `data->info.httpcode` or curl 8.19 equivalent.
  - Emits response headers through libcurl's header callback path.
  - Emits response body through libcurl's write callback path.
  - Returns `CURLE_OK` for HTTP 4xx/5xx unless `CURLOPT_FAILONERROR` is active.
  - Returns `CURLE_COULDNT_CONNECT` or `CURLE_RECV_ERROR` for host `error`.

Use existing libcurl helpers for callbacks wherever possible. If a helper is not accessible from the new file, keep the first patch small by placing the fetch implementation next to the HTTP code that already has access to those helpers.

- [ ] **Step 3: Hook fetch transport into HTTP path**

Patch the HTTP perform path so that before libcurl opens/connects a socket for HTTP/HTTPS, it checks:

```c
if(Curl_codepod_fetch_should_use(data))
  return Curl_codepod_fetch_perform(data);
```

This must happen after request options are finalized and before socket connect. It must not affect socket-forced mode.

- [ ] **Step 4: Add source to curl build files**

Patch the upstream build metadata so `lib/codepod_fetch.c` is compiled into `libcurl.a` for the Codepod port. For autotools, this likely means adding `codepod_fetch.c` to the relevant `lib/Makefile.inc` or `lib/Makefile.am` source list.

- [ ] **Step 5: Generate patch**

From the patch worktree:

```bash
git diff > ../../patches/0002-codepod-fetch-transport.patch
```

- [ ] **Step 6: Verify build reaches curl**

Run:

```bash
source scripts/dev-init.sh && make -C packages/c-ports/curl clean
source scripts/dev-init.sh && make -C packages/c-ports/curl all
```

Expected:

- `build/curl.wasm` exists.
- If the first compile fails on internal libcurl helper visibility, patch the transport to live in the HTTP source file instead of a standalone source file. Keep the final patch reviewable.

- [ ] **Step 7: Commit Task 5**

```bash
git add packages/c-ports/curl/patches/0002-codepod-fetch-transport.patch packages/c-ports/curl/Makefile
git commit -m "feat(curl): add codepod fetch transport"
```

---

## Task 6: Add Unsupported Process Feature Patch

**Files:**
- Create: `packages/c-ports/curl/patches/0003-disable-unsupported-process-features.patch`

- [ ] **Step 1: Search upstream for process assumptions**

Run:

```bash
rg -n "\\bfork\\b|\\bvfork\\b|popen|system\\(|execv|CreateProcess|pipe\\(|SIGPIPE|resolver|threaded" packages/c-ports/curl/upstream
```

Expected:

- `fork`/`vfork` must not remain as enabled runtime dependencies.
- Threaded resolver is already disabled by configure.
- `SIGPIPE` handling may remain if it routes through existing signal compatibility and does not require Unix process semantics.

- [ ] **Step 2: Create patch**

Create `packages/c-ports/curl/patches/0003-disable-unsupported-process-features.patch` from a patch worktree. Apply these rules:

- Any `fork()`/`vfork()` path compiles out under `__wasi__` or Codepod-specific build define.
- External helper execution returns a clear unsupported error.
- Configure cache variables in Makefile remain:

```make
ac_cv_func_fork=no
ac_cv_func_vfork=no
```

If the search finds no compiled `fork`/`vfork` users after configure disables, create a patch that adds a `docs/CODEPOD.md` file inside the worktree explaining the disabled process features, and include it in the patch. This keeps the policy visible in the port.

- [ ] **Step 3: Verify no forbidden symbols**

After `make -C packages/c-ports/curl all`, run:

```bash
wasm-tools objdump packages/c-ports/curl/build/curl.wasm 2>/dev/null | rg "fork|vfork" || true
```

If `wasm-tools` is unavailable, use:

```bash
strings packages/c-ports/curl/build/curl.wasm | rg "fork|vfork" || true
```

Expected:

- No direct unresolved import or runtime dependency on `fork`/`vfork`.
- Plain text documentation strings may appear only if they are in help text and not executable dependency names.

- [ ] **Step 4: Commit Task 6**

```bash
git add packages/c-ports/curl/patches/0003-disable-unsupported-process-features.patch
git commit -m "fix(curl): disable unsupported process features"
```

---

## Task 7: Add libcurl Canaries

**Files:**
- Create: `packages/c-ports/curl/canaries/libcurl-fetch-canary.c`
- Create: `packages/c-ports/curl/canaries/libcurl-socket-canary.c`
- Modify: `packages/c-ports/curl/Makefile`

- [ ] **Step 1: Add fetch canary**

Create `packages/c-ports/curl/canaries/libcurl-fetch-canary.c`:

```c
#include <curl/curl.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct buffer {
  char *ptr;
  size_t len;
};

static size_t write_cb(char *data, size_t size, size_t nmemb, void *userdata) {
  struct buffer *buf = (struct buffer *)userdata;
  size_t n = size * nmemb;
  char *next = realloc(buf->ptr, buf->len + n + 1);
  if (!next) return 0;
  buf->ptr = next;
  memcpy(buf->ptr + buf->len, data, n);
  buf->len += n;
  buf->ptr[buf->len] = '\0';
  return n;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: libcurl-fetch-canary URL\n");
    return 2;
  }

  CURL *curl = curl_easy_init();
  if (!curl) return 1;

  struct buffer body = {0};
  curl_easy_setopt(curl, CURLOPT_URL, argv[1]);
  curl_easy_setopt(curl, CURLOPT_CODEPOD_NETWORK, CURLCODEPOD_NETWORK_FETCH);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);

  CURLcode rc = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_cleanup(curl);

  if (rc != CURLE_OK) {
    fprintf(stderr, "curl error: %s\n", curl_easy_strerror(rc));
    free(body.ptr);
    return 1;
  }

  printf("status=%ld body=%s\n", status, body.ptr ? body.ptr : "");
  free(body.ptr);
  return 0;
}
```

- [ ] **Step 2: Add socket canary**

Create `packages/c-ports/curl/canaries/libcurl-socket-canary.c`:

```c
#include <curl/curl.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct buffer {
  char *ptr;
  size_t len;
};

static size_t write_cb(char *data, size_t size, size_t nmemb, void *userdata) {
  struct buffer *buf = (struct buffer *)userdata;
  size_t n = size * nmemb;
  char *next = realloc(buf->ptr, buf->len + n + 1);
  if (!next) return 0;
  buf->ptr = next;
  memcpy(buf->ptr + buf->len, data, n);
  buf->len += n;
  buf->ptr[buf->len] = '\0';
  return n;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: libcurl-socket-canary URL\n");
    return 2;
  }

  CURL *curl = curl_easy_init();
  if (!curl) return 1;

  struct buffer body = {0};
  curl_easy_setopt(curl, CURLOPT_URL, argv[1]);
  curl_easy_setopt(curl, CURLOPT_CODEPOD_NETWORK, CURLCODEPOD_NETWORK_SOCKET);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);

  CURLcode rc = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_cleanup(curl);

  if (rc != CURLE_OK) {
    fprintf(stderr, "curl error: %s\n", curl_easy_strerror(rc));
    free(body.ptr);
    return 1;
  }

  printf("status=%ld body=%s\n", status, body.ptr ? body.ptr : "");
  free(body.ptr);
  return 0;
}
```

- [ ] **Step 3: Build canaries**

Run:

```bash
source scripts/dev-init.sh && make -C packages/c-ports/curl all
```

Expected:

- `packages/c-ports/curl/build/libcurl-fetch-canary.wasm` exists.
- `packages/c-ports/curl/build/libcurl-socket-canary.wasm` exists.

- [ ] **Step 4: Commit Task 7**

```bash
git add packages/c-ports/curl/canaries packages/c-ports/curl/Makefile
git commit -m "test(curl): add libcurl network canaries"
```

---

## Task 8: Add curl Orchestrator Conformance Tests

**Files:**
- Create: `packages/orchestrator/src/__tests__/curl-conformance.test.ts`

- [ ] **Step 1: Add tests**

Create `packages/orchestrator/src/__tests__/curl-conformance.test.ts`:

```ts
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.ts';
import { NodeAdapter } from '../platform/node-adapter.ts';
import type { NetworkBridgeLike, SyncFetchResult, SyncRequestResult } from '../network/bridge.ts';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');

class StaticFetchBridge implements NetworkBridgeLike {
  requests: Array<{ url: string; method: string; redirect?: string; body?: string }> = [];

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
        headers: { location: 'https://example.test/final' },
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
    return {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: method === 'POST' ? `posted:${body ?? ''}` : 'hello curl',
      body_base64: btoa(method === 'POST' ? `posted:${body ?? ''}` : 'hello curl'),
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

  it('curl --version reports curl and codepod', async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run('curl --version');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('curl');
    expect(result.stdout).toContain('codepod');
  });

  it('fetch-forced curl GET prints response body', async () => {
    const { sandbox, bridge } = await createSandbox();
    const result = await sandbox.run('curl --codepod-network=fetch https://example.test/data');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello curl');
    expect(bridge.requests[0].redirect).toBe('manual');
  });

  it('fetch-forced curl POST sends request body', async () => {
    const { sandbox, bridge } = await createSandbox();
    const result = await sandbox.run("curl --codepod-network=fetch -d 'a=1' https://example.test/post");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('posted:a=1');
    expect(bridge.requests[0].method).toBe('POST');
    expect(bridge.requests[0].body).toContain('a=1');
  });

  it('fetch-forced curl writes binary response to VFS', async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run('curl --codepod-network=fetch -o /tmp/out.bin https://example.test/binary');
    expect(result.exitCode).toBe(0);
    const bytes = await sandbox.readFile('/tmp/out.bin');
    expect(Array.from(bytes)).toEqual([0, 1, 2]);
  });

  it('fetch-forced curl without -L exposes redirects', async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run('curl --codepod-network=fetch -I https://example.test/redirect');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('302');
    expect(result.stdout.toLowerCase()).toContain('location:');
  });

  it('fetch-forced curl reports transport errors as non-zero', async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run('curl --codepod-network=fetch https://example.test/denied');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('blocked by test policy');
  });

  it('libcurl fetch canary runs through direct library API', async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run('/bin/libcurl-fetch-canary https://example.test/data');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status=200');
    expect(result.stdout).toContain('hello curl');
  });
});
```

This test relies on the `SandboxOptions.networkBridge` override added in Task
1. Do not use external internet for these tests.

- [ ] **Step 2: Run tests and verify expected failure before fixtures**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/curl-conformance.test.ts
```

Expected:

- Fails because `curl.wasm` and canary fixtures are not installed yet, or because `Sandbox.create` injection needs the narrow hook.

- [ ] **Step 3: Copy fixtures**

Run:

```bash
source scripts/dev-init.sh && make -C packages/c-ports/curl copy-fixtures
```

Expected:

- `curl.wasm`, `libcurl-fetch-canary.wasm`, and `libcurl-socket-canary.wasm` are copied to orchestrator fixtures.

- [ ] **Step 4: Run tests and fix integration issues**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/curl-conformance.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 8**

```bash
git add \
  packages/orchestrator/src/__tests__/curl-conformance.test.ts \
  packages/orchestrator/src/platform/__tests__/fixtures/curl.wasm \
  packages/orchestrator/src/platform/__tests__/fixtures/libcurl-fetch-canary.wasm \
  packages/orchestrator/src/platform/__tests__/fixtures/libcurl-socket-canary.wasm
git commit -m "test(curl): cover curl and libcurl in sandbox"
```

---

## Task 9: Socket-Forced curl Coverage

**Files:**
- Modify: `packages/orchestrator/src/__tests__/curl-conformance.test.ts`

- [ ] **Step 1: Add socket-mode local loopback test**

Append to `curl-conformance.test.ts`:

```ts
  it('socket-forced libcurl canary uses socket backend when available', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      network: {
        allowedHosts: ['127.0.0.1'],
        serverSockets: { allowLoopback: true },
      },
    });

    const server = await sandbox.spawn(['/bin/socket-listen-canary'], { mode: 'cli' });
    try {
      const result = await sandbox.run('/bin/libcurl-socket-canary http://127.0.0.1:8080/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status=200');
    } finally {
      await server.terminate?.();
    }
  });
```

If `socket-listen-canary` is not an HTTP server and only validates raw sockets, replace this with a host-side local listener test and guard it like `network-fetch.test.ts` when host binding is denied. The important invariant is that `--codepod-network=socket` does not fall back to fetch.

- [ ] **Step 2: Add CLI socket forced test**

Add:

```ts
  it('socket-forced curl fails clearly when socket backend is unavailable', async () => {
    const { sandbox } = await createSandbox();
    const result = await sandbox.run('curl --codepod-network=socket https://example.test/data');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain('socket');
  });
```

- [ ] **Step 3: Verify Task 9**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/curl-conformance.test.ts
```

Expected:

- Fetch tests pass.
- Socket-unavailable failure test passes.
- Socket available test passes if a deterministic local HTTP listener exists; otherwise mark that one `it.skip` with message `deferred until deterministic in-sandbox HTTP listener exists`, and keep the libcurl socket canary build passing.

- [ ] **Step 4: Commit Task 9**

```bash
git add packages/orchestrator/src/__tests__/curl-conformance.test.ts
git commit -m "test(curl): cover socket network mode"
```

---

## Task 10: Final Verification

**Files:**
- No new files.
- May update docs if commands differ from the plan.

- [ ] **Step 1: Build curl fixtures**

Run:

```bash
source scripts/dev-init.sh && make -C packages/c-ports/curl clean
source scripts/dev-init.sh && make -C packages/c-ports/curl copy-fixtures
```

Expected:

- `packages/orchestrator/src/platform/__tests__/fixtures/curl.wasm`
- `packages/orchestrator/src/platform/__tests__/fixtures/libcurl-fetch-canary.wasm`
- `packages/orchestrator/src/platform/__tests__/fixtures/libcurl-socket-canary.wasm`

- [ ] **Step 2: Run focused curl/network tests**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check \
  packages/orchestrator/src/network/__tests__/browser-bridge.test.ts \
  packages/orchestrator/src/host-imports/__tests__/network-fetch-import.test.ts \
  packages/orchestrator/src/__tests__/curl-conformance.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run ABI regression tests**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check \
  packages/orchestrator/src/__tests__/guest-compat.test.ts \
  packages/orchestrator/src/__tests__/pipeline-streaming.test.ts \
  packages/orchestrator/src/__tests__/subprocess.test.ts \
  packages/orchestrator/src/__tests__/wasi-syscalls.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run broad orchestrator active suite**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/*.test.ts
```

Expected:

- Active suites pass.
- Existing deferred tests remain ignored.
- Host listener dependent network tests may early-return in restricted environments.

- [ ] **Step 5: Type-check touched TypeScript files**

Run:

```bash
source scripts/dev-init.sh && deno check \
  packages/orchestrator/src/network/bridge.ts \
  packages/orchestrator/src/network/bridge-client.ts \
  packages/orchestrator/src/network/browser-bridge.ts \
  packages/orchestrator/src/host-imports/kernel-imports.ts \
  packages/orchestrator/src/network/__tests__/browser-bridge.test.ts \
  packages/orchestrator/src/host-imports/__tests__/network-fetch-import.test.ts \
  packages/orchestrator/src/__tests__/curl-conformance.test.ts
```

Expected: PASS.

- [ ] **Step 6: Check source purity and process assumptions**

Run:

```bash
scripts/check-bash-source-purity.sh
rg -n "\\bfork\\b|\\bvfork\\b" packages/c-ports/curl/patches packages/c-ports/curl/canaries packages/c-ports/curl/Makefile
```

Expected:

- Bash purity passes.
- `rg` finds only comments, configure cache variables, or explicit unsupported-process patch context.

- [ ] **Step 7: Commit verification/doc updates**

If final verification required documentation updates:

```bash
git add packages/c-ports/curl/README.md docs/superpowers/plans/2026-05-01-curl-libcurl-port.md
git commit -m "docs(curl): document port verification"
```

If no files changed, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Runtime `auto|fetch|socket`: Tasks 3, 5, 8, 9.
- Fetch manual redirects: Task 1 and Task 8.
- Browser binary base64: Task 1.
- Static libcurl plus runnable canaries: Tasks 2, 7, 8.
- Host status vs transport error: Tasks 1, 5, 8.
- No `fork`/`vfork`: Task 6 and Task 10.
- Existing regression suite: Task 10.

Known implementation risks:

- curl internals may require placing fetch transport code inside existing HTTP source rather than a new file. Task 5 allows that while preserving the same behavior and patch boundary.
- Deterministic socket-mode CLI coverage depends on an in-sandbox or host listener. If host bind is restricted, keep fetch-mode exhaustive and retain socket-mode build/canary coverage until an in-sandbox HTTP listener exists.
- HTTPS in socket mode is not in the first milestone because the Makefile disables TLS libraries. HTTPS in fetch mode is supported by host/browser fetch.
