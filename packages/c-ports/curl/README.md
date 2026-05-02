# curl/libcurl port

Codepod C port for curl/libcurl 8.19.0.

This builds the `curl.wasm` CLI and two direct libcurl canaries:

- `libcurl-fetch-canary.wasm`
- `libcurl-socket-canary.wasm`

The networking mode is selected at runtime:

- `auto` chooses a working transport.
- `fetch` routes HTTP through `codepod.host_network_fetch`.
- `socket` routes HTTP through POSIX sockets backed by the Codepod socket ABI.

The curl CLI exposes this option for tests and diagnostics:

```bash
curl --codepod-network=auto|fetch|socket URL
```

Library consumers use `CURLOPT_CODEPOD_NETWORK` or `CODEPOD_CURL_NETWORK`.

## HTTPS

Fetch mode supports `https://` through `codepod.host_network_fetch`; TLS is
handled by the host/browser fetch implementation.

Socket mode supports HTTPS through mbedTLS. The curl manifest installs
`ca-certificates.crt` into the sandbox VFS at
`/etc/ssl/certs/ca-certificates.crt`, and curl is configured to use that path
as its default CA bundle.

## Build

```bash
make -C packages/c-ports/curl copy-fixtures
```

This copies `curl.wasm`, the libcurl canaries, the CA bundle, and
`curl.manifest.json` into the orchestrator fixture directory.

The build uses the repository `cpcc` toolchain and the shared guest
compatibility archive. Upstream source lives in `upstream/` as a git submodule;
Codepod changes live in `patches/*.patch` and are applied to `build/work/`.
