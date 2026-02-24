# RustPython WASI Integration

Replaces Pydantic Monty with RustPython compiled to `wasm32-wasip1`.

## Decision

Monty supports a narrow subset of Python (no classes, no stdlib — no `json`, `re`, `math`, `collections`). LLMs constantly generate code that hits these walls. RustPython provides full Python 3 with frozen stdlib, `sys.argv`, `os.environ`, and standard file I/O — all via WASI syscalls we already implement.

**Why RustPython over Pyodide:** RustPython compiles to a single WASI binary (~12MB with frozen stdlib). No JS glue, no emscripten, no special runtime. It slots into our existing WasiHost + ProcessManager infrastructure with zero new abstractions.

**Why not keep Monty:** Monty's binary size advantage erodes as it adds features. Its external function model requires custom bridges for every capability. RustPython uses standard WASI syscalls that our host already provides.

## Architecture

RustPython is just another WASI binary — like `cat.wasm`, `grep.wasm`, `ls.wasm`. No special runtime, no external function bridges, no JS-side interpreter.

```
ShellRunner.execSimple("python3 script.py")
  -> resolves "python3" to registered tool "rustpython.wasm"
  -> ProcessManager.spawn("rustpython.wasm", ["python3", "script.py"], env, stdin)
    -> WasiHost provides fd_read/fd_write/path_open/etc backed by VFS
    -> RustPython opens script.py via WASI path_open -> reads from VFS
    -> import json -> resolved from frozen stdlib (embedded in binary)
    -> print() -> WASI fd_write(1) -> captured as stdout
    -> sys.argv -> WASI args_get -> ["python3", "script.py"]
    -> os.environ -> WASI environ_get -> shell environment
  -> returns SpawnResult { exitCode, stdout, stderr }
```

PythonRunner simplifies from a Monty external-function orchestrator to a thin wrapper that maps `python3` args to `ProcessManager.spawn()` calls.

## What Changes

| Component | Change |
|---|---|
| `rustpython.wasm` | **New**: ~12MB WASI binary with frozen stdlib |
| `python-runner.ts` | **Rewrite**: Remove Monty, delegate to ProcessManager.spawn() |
| `shell-runner.ts` | **Minor**: Register python3/python as tool names. Shebang handler already works |
| `@pydantic/monty` | **Remove**: Delete dependency and external function bridge code |
| `wasi-host.ts` | **Likely no changes**: Already implements all needed WASI syscalls |
| Tests | **Update**: Existing behavioral tests should pass. Add stdlib-specific tests |

## What Works (via existing WASI infrastructure)

- `sys.argv` via WASI `args_get`
- `os.environ` via WASI `environ_get`
- `import json, re, math, collections, dataclasses, typing, csv, hashlib, random, itertools, functools, time` — frozen in binary
- `open()` / file I/O via WASI `path_open` + `fd_read`/`fd_write`
- stdin piping (`cat foo | python3 -c "..."`) via WASI `fd_read(0)`
- Class definitions, decorators, generators, context managers, f-strings, comprehensions
- Correct error tracebacks with line numbers

## What Doesn't Work (acceptable)

- `import numpy/pandas/scipy` — no C extensions in WASM
- `subprocess.run()` — no `posixsubprocess` on WASI
- `socket`, `ssl`, networking — excluded from WASM build
- `multiprocessing`, `threading` — no thread support in WASI

LLMs get a clear `ModuleNotFoundError` for unsupported modules instead of inscrutable failures.

## Build

```bash
cargo build --release --target wasm32-wasip1 \
  --no-default-features \
  --features freeze-stdlib,stdlib,compiler,importlib,stdio,encodings,host_env
```

Output committed to fixtures alongside other WASI binaries. Full frozen stdlib included — no curation, no maintenance burden.

## WASI Syscall Coverage

RustPython will use these WASI imports, all already implemented in `wasi-host.ts`:

- `args_get`, `args_sizes_get` — argv
- `environ_get`, `environ_sizes_get` — environment
- `fd_read`, `fd_write`, `fd_close`, `fd_seek` — I/O
- `fd_prestat_get`, `fd_prestat_dir_name` — preopened dirs
- `fd_filestat_get`, `fd_fdstat_get` — file metadata
- `path_open`, `path_filestat_get` — filesystem
- `fd_readdir` — directory listing
- `clock_time_get` — time module
- `random_get` — random module
- `proc_exit` — process exit
