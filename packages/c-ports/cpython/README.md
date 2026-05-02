# CPython port

CPython 3.14.4 built for `wasm32-wasip1` through Codepod's C toolchain.

Bring-up artifact: `cpython3.wasm`.
Final cutover artifact: `python3.wasm`, replacing RustPython once the
CPython canaries cover the current product paths.

## Build

```bash
make -C packages/c-ports/cpython
```

This builds the Codepod-linked bring-up artifact at
`build/cpython3.wasm` and verifies `python.wasm --version` through the
Codepod sandbox runner, not plain `wasmtime`.

The upstream stock WASI artifact remains available as an explicit
baseline:

```bash
make -C packages/c-ports/cpython upstream-wasi-build
```

## Status

Initial bring-up. RustPython still owns the `python3` command until the
CPython ABI canaries pass. The temporary sandbox command is `cpython3`.

The upstream CPython WASI helper builds successfully on this machine and
produces `upstream/cross-build/wasm32-wasip1/python.wasm`. The Codepod
target stages a fresh worktree, configures the WASI host build with
`cpcc`/`cpar`/`cpranlib`, links `libcodepod.a`, and copies the result to
`build/cpython3.wasm`.

The upstream helper still requires `WASI_SDK_PATH`; the Makefile derives
that value from `cpcc --print-sdk-path`. Codepod compile/link targets
should invoke `cpcc` directly and do not need separate wasi-sdk discovery.

Current gaps:

- The artifact is version-smoke-tested only (`Python 3.14.4`) through the
  sandbox runner.
- `_ssl`, `_hashlib`, `zlib`, `_ctypes`, and several other optional
  modules are not built yet.
- Subprocess, sockets, stdlib import layout, and package installation
  still need dedicated CPython canaries before cutover from RustPython.
