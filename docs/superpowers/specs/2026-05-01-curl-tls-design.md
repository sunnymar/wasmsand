# curl/libcurl TLS Extension

## Status

Design for the next curl/libcurl slice after the first Codepod curl port
successfully built real curl 8.19.0, added `auto|fetch|socket` transport
selection, and passed sandbox conformance for fetch-backed HTTP and strict
socket mode.

This extends the existing port. It does not replace the current fetch transport,
socket transport, or static `libcurl.a` canary shape.

## Problem

The current curl build is intentionally HTTP-only:

```text
--without-ssl
```

That leaves two different HTTPS requirements unsatisfied:

1. Browser-compatible HTTPS through `codepod.host_network_fetch`.
2. Socket-backed HTTPS through a guest TLS library.

These are different problems. Fetch-mode HTTPS should not require a guest TLS
stack because the host/browser fetch implementation already owns TLS. Socket
mode is different: curl opens TCP sockets itself, so libcurl needs a TLS backend
linked into the guest artifact.

The first TLS milestone should prove HTTPS semantics without immediately taking
on the heaviest TLS port. OpenSSL remains important for compatibility, but it
should not be the first blocker.

## Goals

1. Support `https://` URLs in `--codepod-network=fetch` mode using
   `codepod.host_network_fetch`.
2. Keep fetch-mode HTTPS browser-compatible: no guest TLS dependency and no
   direct socket requirement.
3. Preserve curl semantics for fetch-mode HTTPS:
   - HTTP status is response metadata, not a transport failure.
   - Binary bodies remain byte-preserving through `body_base64`.
   - Redirects remain visible to libcurl through manual redirect mode.
   - Transport/policy errors map to deterministic curl failures.
4. Add direct `libcurl` canary coverage for HTTPS fetch mode.
5. Add mbedTLS as the first socket-mode TLS backend.
6. Rebuild curl with mbedTLS for socket-mode HTTPS while keeping fetch mode
   available in the same artifact.
7. Keep OpenSSL as a later compatibility backend after the TLS/toolchain shape
   is proven.

## Non-Goals

- OpenSSL in this slice.
- Full curl TLS feature parity in the first TLS milestone.
- Client certificates, custom trust stores, CRL files, OCSP, TLS pinning, or
  proxy TLS.
- HTTP/2 or HTTP/3.
- Dynamic TLS libraries.
- Separate fetch-only and socket-only curl artifacts.
- Weakening sandbox network policy.

## Architecture

The port keeps one curl artifact with runtime network selection:

```text
auto | fetch | socket
```

Fetch mode and socket mode handle HTTPS differently.

### Fetch HTTPS

Fetch mode routes the full request through `codepod.host_network_fetch`:

```json
{
  "url": "https://example.test/data",
  "method": "GET",
  "headers": {},
  "body": null,
  "redirect": "manual"
}
```

The host/browser bridge performs TLS as part of fetch. The guest receives HTTP
response metadata and bytes:

```json
{
  "status": 200,
  "headers": { "content-type": "application/octet-stream" },
  "body": "",
  "body_base64": "AAEC",
  "error": null
}
```

The libcurl patch must allow fetch mode to claim `https://` before libcurl
rejects it due to the no-SSL build or routes it to the socket TLS path. This is
only valid in fetch mode. Forced socket mode must still require a real TLS
backend for HTTPS.

### Socket HTTPS

Socket mode follows upstream libcurl as closely as practical. The guest opens
sockets through the existing POSIX socket ABI and libcurl performs TLS through
a linked TLS library.

The first backend is mbedTLS because it is smaller and more tractable than
OpenSSL for the first proof. The expected repository shape is:

```text
packages/c-ports/mbedtls/
  Makefile
  README.md
  upstream/
  patches/
  build/
```

The curl build consumes static mbedTLS archives and configures curl with an
mbedTLS backend instead of `--without-ssl`.

The same `curl.wasm` must still support fetch mode. Fetch mode remains the path
for browser-hosted sandboxes and for tests that do not require raw sockets.

## Transport Selection Semantics

Forced modes are strict:

- `--codepod-network=fetch https://...` uses `host_network_fetch`.
- `--codepod-network=socket https://...` uses sockets plus guest TLS.
- Forced socket mode must not fall back to fetch.
- Forced fetch mode must not open sockets.

`auto` remains conservative:

- Browser or fetch-required runtime: use fetch.
- Socket-capable runtime with TLS backend and non-browser policy: socket may be
  used for HTTP(S).
- If socket TLS is unavailable but fetch is available, HTTPS may use fetch.
- If neither transport can satisfy the request, fail with a curl-style error.

The exact auto probe can stay simple in the first TLS slice, but auto-mode
HTTPS is in scope. The implementation must include an active test where plain
`curl https://...` runs in a fetch-required or no-socket sandbox and uses
`host_network_fetch` instead of attempting the socket/TLS path.

## Trust And Certificates

Fetch mode delegates certificate validation to the host/browser fetch
implementation.

Socket mode delegates certificate validation to mbedTLS/libcurl. The first
socket HTTPS milestone may use a test-only CA bundle or verification-disabled
local fixture if needed to prove plumbing. Public CA bundle packaging is a
follow-up because it belongs with broader package/VFS installation policy.

The implementation must not silently disable verification for general socket
HTTPS. If a test requires disabled verification, the test command must opt in
explicitly through normal curl behavior such as `-k`.

## Tests

Fetch HTTPS tests are deterministic and required:

- `curl --codepod-network=fetch https://example.test/data` prints a body.
- `curl --codepod-network=fetch -o /tmp/out.bin https://example.test/binary`
  writes exact bytes.
- `curl --codepod-network=fetch -I https://example.test/redirect` exposes a
  manual 3xx response and `location` header.
- `libcurl-fetch-canary https://example.test/data` reports status and body.
- A bridge spy proves fetch mode used `host_network_fetch` and did not call the
  socket path.
- Plain `curl https://example.test/data` in a fetch-required or no-socket
  sandbox uses fetch mode automatically and does not call the socket path.

Socket HTTPS tests are required once mbedTLS is linked:

- `curl --version` reports an SSL backend containing `mbedTLS`.
- `curl --codepod-network=socket https://...` does not fall back to fetch.
- `curl --codepod-network=socket -k https://127.0.0.1:<port>/...` completes a
  real TLS transfer against a deterministic local TLS server, or the same test
  uses `--cacert` with a test CA.
- `libcurl-socket-canary https://127.0.0.1:<port>/...` completes a real TLS
  transfer against the same deterministic local TLS server, using either test
  CA verification or an explicit insecure/test mode.
- The active socket HTTPS tests must prove mbedTLS I/O, entropy, SNI/hostname
  handling where applicable, and certificate plumbing enough to catch a broken
  TLS handshake. Build/link/no-fetch checks are useful but are not sufficient
  acceptance for socket-mode HTTPS.

## Build Expectations

The mbedTLS port must:

- Build static archives with the Codepod C toolchain.
- Avoid host platform assumptions that do not apply to WASI.
- Use Codepod-compatible entropy through existing WASI/random support or a
  narrow guest-compat addition if mbedTLS requires one.
- Produce reproducible artifacts consumed by the curl Makefile.

The curl port must:

- Keep patches explicit under `packages/c-ports/curl/patches`.
- Keep `CPCC_USE_SETJMP=1` if curl still imports setjmp/longjmp.
- Configure and link the single static curl artifact with mbedTLS for socket
  TLS, while fetch mode must not invoke the TLS backend or open sockets.
- Continue copying the existing curl/libcurl fixtures.

## Error Handling

Fetch-mode errors continue to come from the `error` field of the host fetch
response. HTTP status codes do not become curl transfer failures unless the user
requested normal curl failure behavior.

Socket TLS errors should use libcurl's normal TLS errors. Policy failures from
the Codepod socket backend remain socket/connect failures, not certificate
failures.

## Rollout

1. Add fetch-mode HTTPS support and tests.
2. Add the mbedTLS c-port scaffold.
3. Build static mbedTLS archives with `cpcc`.
4. Reconfigure curl with mbedTLS and keep fetch mode intact.
5. Add socket-mode HTTPS build/canary coverage.
6. Re-run curl, ABI, and broad orchestrator verification.

## Future Work

- OpenSSL compatibility backend.
- Public CA bundle packaging.
- Browser-specific fetch conformance for more curl options.
- HTTP/2 after TLS is stable.
- libcurl multi/streaming improvements for fetch mode.
