# curl/libcurl On codepod

## Status

Proposed design for the next ABI-expansion port after `bash-rs` reached a
green kernel/bash conformance checkpoint.

This is a porting effort, not a plain upstream build. Upstream libcurl and
curl assume platform facilities that codepod intentionally does not expose in
all runtimes. The most important mismatch is networking: Node/Deno/Wasmtime can
support socket-backed HTTP, while browser-hosted sandboxes need HTTP to route
through `codepod.host_network_fetch`.

The goal is one libcurl/curl artifact that chooses its network transport at
runtime. We do not want separate "browser curl" and "socket curl" builds.

## Problem

codepod now has enough C/Rust ABI surface for larger real ports:

- `libcodepod.a` and `cpcc` build C guests against the `codepod` host ABI.
- POSIX sockets are backed by kernel socket imports and a backend abstraction.
- `codepod.host_network_fetch` already exists for browser-compatible HTTP.
- bash exercises pipes, redirection, process spawning, fd ownership, and a large
  portion of the process/file ABI.

curl/libcurl is the next useful stress test because it hits a different set of
production-shaped requirements:

- HTTP request/response semantics instead of only raw TCP canaries.
- Browser-compatible fetch semantics.
- Headers, bodies, redirects, status codes, binary output, and stderr/progress.
- A large C configure/build system driven through the codepod C tooling.
- A library artifact (`libcurl`) plus a CLI consumer (`curl`).

The port must not solve this by adding fake Unix behavior. In particular,
`fork()`/`vfork()` remain unsupported. Any curl code path that shells out or
depends on process duplication must be patched out, replaced with explicit
codepod behavior, or reported unsupported.

## Goals

1. Build upstream-derived `libcurl` and `curl` as standalone
   `wasm32-wasip1` artifacts through the codepod C toolchain.
2. Keep one artifact with runtime network selection:
   `auto`, `fetch`, or `socket`.
3. Support fetch-backed HTTP(S) through `codepod.host_network_fetch`.
4. Support socket-backed HTTP where the sandbox runtime provides sockets.
5. Preserve normal curl CLI behavior for the first practical subset:
   `--version`, `GET`, `HEAD`, `-X`, `-H`, `-d/--data`, `-o`, `-L`,
   status/exit codes, binary bodies, and stderr diagnostics.
6. Exercise `libcurl` directly with C canaries, not only through the CLI.
7. Keep the port patches explicit and reviewable in the repository.

## Non-goals

- Full upstream curl feature parity in the first milestone.
- Implementing `fork()` or `vfork()`.
- Shelling out to external helpers.
- Dynamic libraries or plugin loading.
- A separate browser-only curl build.
- Replacing the existing `host_network_fetch` JSON protocol unless the port
  proves a precise gap.
- FTP, SMTP, WebSocket, TELNET, LDAP, RTSP, or other non-HTTP protocols in the
  first milestone.

## Artifacts

Expected repository shape:

```text
packages/c-ports/curl/
  README.md
  Makefile
  patches/
    0001-codepod-network-transport.patch
    0002-disable-unsupported-process-features.patch
  upstream/                # git submodule pinned to a release tag
  build/                   # out-of-tree build output
  canaries/
    libcurl-fetch-canary.c
    libcurl-socket-canary.c
```

Runtime fixtures:

```text
packages/orchestrator/src/platform/__tests__/fixtures/curl.wasm
packages/orchestrator/src/platform/__tests__/fixtures/libcurl-fetch-canary.wasm
packages/orchestrator/src/platform/__tests__/fixtures/libcurl-socket-canary.wasm
```

Test surface:

```text
packages/orchestrator/src/__tests__/curl-conformance.test.ts
packages/guest-compat/conformance/c/libcurl-*.c
```

`libcurl` itself is a static archive consumed at build time. It is not a
runtime `.wasm` dynamic library. CLI tests validate user-facing `curl`, while
runnable C canary executables validate `libcurl` as a library.

## Runtime Network Selection

The port has one network mode setting:

```text
auto | fetch | socket
```

The default is `auto`.

Configuration sources, highest precedence first:

1. `--codepod-network=auto|fetch|socket` on the curl CLI.
2. `CODEPOD_CURL_NETWORK=auto|fetch|socket`.
3. libcurl codepod option for direct library tests.
4. Default `auto`.

The CLI flag is codepod-specific and exists for tests and diagnostics. It is
not meant to be a user-facing replacement for normal curl options.

`auto` means:

- If the runtime reports that browser/fetch mode is required, use fetch.
- Else if socket networking is available, use sockets.
- Else if fetch is available, use fetch.
- Else fail with a curl-style networking error.

Forced modes are strict:

- `fetch` must fail clearly if `host_network_fetch` is unavailable.
- `socket` must fail clearly if socket creation/connect is unavailable or
  blocked by policy.

The runtime capability probe should be cheap and explicit. It may start as a
codepod-specific helper in the port, backed by existing imports, and later move
into a shared guest-compat API if other ports need the same choice.

## libcurl Integration

The port adds a Codepod network backend inside libcurl rather than wrapping the
curl CLI externally.

### Fetch Backend

The fetch backend converts libcurl's HTTP request state into the existing
`host_network_fetch` request:

```json
{
  "url": "https://example.test/path",
  "method": "POST",
  "headers": { "content-type": "application/json" },
  "body": "...",
  "redirect": "manual"
}
```

The host returns:

```json
{
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "...",
  "body_base64": null,
  "error": null
}
```

Binary response bodies use `body_base64`. The port must not route binary data
through lossy UTF-8 conversions. The browser bridge must therefore read
responses with `arrayBuffer()` and populate `body_base64`, matching the
Node/Deno bridge behavior.

`error != null` is the transport/policy failure signal. HTTP status is response
metadata. A `404` response is still a completed curl transfer unless the user
requested curl's normal failure behavior (`--fail` / corresponding libcurl
option). The existing host `ok` field is not sufficient for libcurl error
mapping because it currently folds HTTP status into success.

Minimum fetch-backed libcurl behavior:

- Set response status.
- Expose response headers.
- Deliver response body through libcurl's normal write callback.
- Accept request headers.
- Accept request body for `POST`/custom methods.
- Map host/network/policy failures to deterministic curl errors using
  `error`, not HTTP status.
- Keep redirects visible to libcurl by passing `redirect: "manual"` through
  `host_network_fetch` and implementing manual redirect support in every host
  bridge, including browser fetch. Fetch mode must not use browser/default
  redirect-following behavior for curl requests.

The fetch backend is allowed to be request-buffered in the first milestone:
the complete request body is collected before calling `host_network_fetch`, and
the complete response body is delivered after the host returns. Streaming can
be a later optimization.

### Socket Backend

The socket path should remain as close to upstream libcurl as practical:

- `socket`, `connect`, `send`, `recv`, `shutdown`, `getsockname`,
  `getpeername`, `getsockopt`, `setsockopt`, and resolver calls should route
  through the existing guest-compat/socket layer.
- Sandbox policy remains enforced by the kernel socket backend.
- Loopback behavior follows the sandbox-owned loopback rules, not host
  loopback rules.

Socket mode validates the POSIX socket ABI. Fetch mode validates the browser
network ABI. Both are first-class.

## Process And Unsupported Feature Policy

The port must not preserve code paths that depend on unsupported Unix process
semantics.

Patch rules:

- `fork()` and `vfork()` call sites are removed, disabled, or converted to
  explicit unsupported errors.
- External helper execution is disabled unless it can be expressed through
  codepod's supported spawn/wait API and is required for the milestone.
- Feature detection should prefer configure-time disables over runtime crashes.
- Unsupported protocols/features should fail predictably, not instantiate a
  binary that later traps.

This mirrors the bash decision: codepod supports spawning standalone WASM
programs, not Unix process cloning.

## Build Strategy

Use the existing C porting/toolchain path:

- `cpcc` / `cpar` / `cpranlib`.
- the shared codepod compatibility archive (`libcodepod.a`; c-port recipes
  that still use the transitional `libcodepod_guest_compat.a` name should be
  updated or wrapped as part of the implementation plan).
- `wasi-sdk` for C compilation.
- Repository patches under `packages/c-ports/curl/patches`.
- A Makefile or recipe script that can rebuild from a clean source tree.

The recipe should be reproducible:

1. Initialize the pinned upstream submodule.
2. Apply patches.
3. Configure with unsupported protocols/features disabled.
4. Build `libcurl` and `curl`.
5. Copy wasm fixtures.
6. Run canaries.

The source policy follows `packages/c-ports/README.md`: curl starts as an
upstream-pin submodule, not a build-time download. Codepod changes live in
`patches/*.patch` and are applied to an out-of-tree work copy. If the patch
set stops being reviewable, the port can later move to a fork-pin, but that is
not the initial shape.

## Testing

### Library Canaries

Add C canaries that link `libcurl` and run inside the sandbox:

- fetch-mode GET.
- socket-mode GET.
- custom request header.
- POST body.
- binary response body.
- policy-denied host maps to a deterministic libcurl error.

These canaries should run through orchestrator tests so they exercise the same
kernel imports as other guest-compat artifacts.

### CLI Conformance

Add curl CLI tests:

- `curl --version` includes curl/libcurl version and codepod feature marker.
- `curl --codepod-network=fetch URL` prints response body.
- `curl --codepod-network=socket URL` prints response body when sockets are
  available.
- `curl --codepod-network=auto URL` chooses a working transport.
- `curl -I URL` prints headers without body.
- `curl -H 'x-test: yes' URL` sends headers.
- `curl -d 'a=1' URL` sends body.
- `curl -o /tmp/out URL` writes bytes to VFS.
- `curl -L URL` follows redirects, while the same URL without `-L` exposes the
  3xx response according to curl/libcurl semantics.
- Denied hosts produce non-zero exit and useful stderr.

Network tests that require a host listener must be conditional in restricted
test environments, as with the current network-fetch suite. Fetch-mode tests
should be preferred for browser-compatible coverage because they do not require
guest raw sockets.

### Regression Sweep

The port should keep these existing suites green:

- bash/kernel orchestrator sweep.
- guest-compat canaries.
- socket fd tests.
- import parity tests.
- source-purity checks for bash.

## Acceptance Criteria

The curl/libcurl slice is complete when:

1. `curl.wasm` builds reproducibly from `packages/c-ports/curl`.
2. `curl --version` runs inside codepod.
3. Fetch-forced curl can GET text and binary responses.
4. Socket-forced curl can GET through the socket backend where sockets are
   available.
5. Auto mode chooses a working backend without a separate build.
6. libcurl C canaries pass for fetch and socket modes.
7. Host/network policy denial is reported as a normal curl/libcurl error, not
   a wasm trap.
8. No new `fork()`/`vfork()` dependency is introduced.
9. Existing bash/kernel active tests remain green.

## Fixed Decisions

- Direct libcurl tests use a real Codepod-specific option,
  `CURLOPT_CODEPOD_NETWORK`, plus the environment fallback. The environment
  path lets the CLI share the same behavior without inventing a second
  configuration mechanism.
- Fetch mode keeps redirects in libcurl so fetch and socket mode use the same
  redirect policy. This requires a `host_network_fetch` protocol field for
  manual redirects and browser bridge support for `redirect: "manual"`.
- TLS certificate inspection is unsupported in fetch mode for this milestone.
  Browser fetch does not expose the same certificate details as socket/OpenSSL.
- curl starts as an upstream-pin submodule with patches, matching the current
  c-port source policy.

## Why zsh Comes Later

zsh is still valuable, but it stresses a different problem: shell process
semantics, job control, terminal behavior, and unsupported `fork()` patterns.
curl/libcurl is the better next ABI target because it expands the supported
surface we already intend to provide: C toolchain, networking, files, policy,
and browser-compatible HTTP.
