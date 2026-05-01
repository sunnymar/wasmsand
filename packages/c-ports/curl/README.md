# curl/libcurl port

Codepod C port scaffold for curl/libcurl 8.19.0.

This scaffold builds the `curl.wasm` CLI. Later patch tasks will enable a
static `libcurl.a` and two direct libcurl canaries:

- `libcurl-fetch-canary.wasm`
- `libcurl-socket-canary.wasm`

The planned networking mode will be selected at runtime:

- `auto` chooses a working transport.
- `fetch` routes HTTP through `codepod.host_network_fetch`.
- `socket` routes HTTP through POSIX sockets backed by the Codepod socket ABI.

Later patch tasks will expose this curl CLI option for tests and diagnostics:

```bash
curl --codepod-network=auto|fetch|socket URL
```

Later library tests will use `CURLOPT_CODEPOD_NETWORK` or
`CODEPOD_CURL_NETWORK`.

## HTTPS

Fetch mode supports `https://` through `codepod.host_network_fetch`; TLS is
handled by the host/browser fetch implementation. Socket-mode HTTPS requires
the mbedTLS task in the TLS extension plan.

## Build

```bash
make -C packages/c-ports/curl copy-fixtures
```

For now this copies `curl.wasm`. Later canary tasks will also copy
`libcurl-fetch-canary.wasm` and `libcurl-socket-canary.wasm`.

The build uses the repository `cpcc` toolchain and the shared guest
compatibility archive. Upstream source lives in `upstream/` as a git submodule;
Codepod changes live in `patches/*.patch` and are applied to `build/work/`.
