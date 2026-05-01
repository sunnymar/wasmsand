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
