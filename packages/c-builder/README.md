# codepod C Builder

The codepod C builder is a host-side, maturin-like wrapper around `clang` from
`wasi-sdk`.

Phase 1 scope:

- discover a local `wasi-sdk` toolchain
- apply the shared `wasm32-wasip1` target and baseline warning/optimization
  flags
- provide a direct builder entrypoint for small ports and canaries
- provide an `env` mode that exports subprocess-safe tool variables for
  upstream `make`-style recipes

This is not an in-WASI compiler. C code is cross-compiled on the host and the
resulting `.wasm` artifact is copied into codepod fixtures or package payloads.

## Builder entrypoint

Use [`scripts/build-c-port.sh`](../../scripts/build-c-port.sh).

Direct compile and link:

```bash
scripts/build-c-port.sh \
  --source packages/guest-compat/examples/stdio_canary.c \
  --include packages/guest-compat/include \
  --output /tmp/stdio-canary.wasm
```

Compile an object file for reuse:

```bash
scripts/build-c-port.sh \
  --compile-only \
  --source packages/guest-compat/src/codepod_command.c \
  --include packages/guest-compat/include \
  --output /tmp/codepod_command.o
```

Export toolchain settings for recipe-driven builds:

```bash
eval "$(scripts/build-c-port.sh env)"
make CC="$CC" AR="$AR" RANLIB="$RANLIB"
```

The exported `CC` points at `scripts/build-c-port.sh cc`, which wraps the real
`clang` with codepod's shared WASI defaults and survives into child processes.
`AR` and `RANLIB` point at the matching `wasi-sdk` LLVM binutils.

Recipes remain responsible for source fetching, patching, configure steps, and
artifact packaging. The builder owns toolchain discovery and the shared WASI
compiler defaults.
