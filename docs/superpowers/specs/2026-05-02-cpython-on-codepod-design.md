# CPython on Codepod

## Status

Design approved for the first CPython porting milestone. This follows
the kernel/userland separation, bash/libcodepod, C ports, Rust std, and
socket work. CPython is the next large ABI test: it should run as a
normal guest process and force any missing POSIX/WASI surface into the
shared C compatibility layer rather than into Python-specific host
shortcuts.

Primary target: **CPython 3.14.4**. Python 3.13 made WASI a serious
PEP 11-supported platform, but 3.14 has newer WASM/WASI build
maintenance and uses `wasm32-wasip1` naming. A 3.13.x patch lane may
be added after 3.14 is useful, to prove the patch strategy is not
overfit to a single release.

## Outcome

`packages/c-ports/cpython/` builds a pinned upstream CPython 3.14.4
source tree into `cpython3.wasm` for `wasm32-wasip1`, linked through
Codepod's C toolchain and `libcodepod.a`.

During bring-up, the resulting `/bin/cpython3` is a normal process
from the kernel's point of view. After cutover, that same CPython
artifact owns `/bin/python3`. It uses standard C/POSIX names. When
CPython needs processes, files, sockets, time, randomness, or other
platform features, those calls should flow through wasi-libc and
`libcodepod.a`. If a CPython module is disabled only because upstream
WASI lacks that surface, we patch the platform gate so it builds
against Codepod's provided ABI.

RustPython remains in the tree only as a temporary compatibility path
while CPython is being brought up. CPython is not an alternate Python
runtime. It replaces RustPython once it covers the current product
paths. The replacement boundary is explicit: when CPython provides the
Python command, subprocess, networking, `_codepod`, and extension
bridge behavior we need, CPython takes over the `python3` command and
the RustPython package, old `python3.wasm` fixture, RustPython build
script, RustPython tool registration, and RustPython-specific Python
shims are removed together.

## Problem

The current Python implementation is RustPython:

- `packages/python/` builds a Rust binary named `python3.wasm`.
- `packages/orchestrator/src/sandbox.ts` installs RustPython-oriented
  `/usr/lib/python` shims for `subprocess`, `socket`, `ssl`,
  `requests`, and extension dispatch.
- `packages/python/crates/codepod-host` exposes `_codepod` as a
  RustPython native module.
- `host_run_command` still exists largely for that Python path.

That shape is useful for product continuity, but it no longer tests the
ABI we are building. CPython is a large C program with real standard
library expectations. It is the better signal for whether files,
processes, pipes, sockets, DNS, SSL, time, randomness, stdio, and
packaging behavior are actually coherent.

## Goals

1. Build upstream CPython 3.14.4 for `wasm32-wasip1` as a Codepod C
   port.
2. Link CPython through `cpcc` and `libcodepod.a`, not through
   Python-specific host imports.
3. Make `/bin/python3` run in the sandbox as a generic process.
4. Prefer libc/POSIX ABI fixes over Python-level monkeypatches.
5. Patch CPython only where upstream WASI build gates block modules
   before Codepod's ABI can help.
6. Add canaries that turn missing CPython surface into concrete ABI
   work items.
7. Keep the first milestone small enough to land before package/pip
   work begins.

## Non-goals

- Full `pip` and package installation. Real pip is a follow-up after
  the interpreter and core ABI are stable.
- NumPy, PIL, matplotlib, pandas, or native Python wheels. Those depend
  on the package format and extension-module story.
- Fork support. CPython paths that require `fork()` should be steered
  to `posix_spawn()` where possible. If a feature fundamentally needs
  fork, it remains unsupported.
- Real multi-threaded Python execution. Current Deno/JSPI backend only
  supports one spawned thread at a time. Real parallel threads require
  a shared-memory + atomics backend.
- Browser networking through raw sockets. Browser mode will need a
  fetch-backed transport, but the first CPython milestone should prove
  the socket ABI in non-browser backends first.

## Design

### Version Policy

The first supported CPython line is 3.14.4.

Reasons:

- It is the current stable 3.14 maintenance line.
- It contains bugfixes, build improvements, and documentation changes
  since 3.14.3.
- 3.14 includes WASM/WASI build-system cleanup after the 3.13 PEP 11
  milestone.
- It uses the `wasm32-wasip1` target naming that matches Codepod's C
  and Rust toolchains.

Patch layout:

```
packages/c-ports/cpython/
├── upstream/              # CPython submodule pinned to v3.14.4
├── patches/3.14/          # main Codepod patch stack
├── patches/3.13/          # future compatibility lane, initially absent
├── build/                 # out-of-tree build output
├── Makefile
├── README.md
└── .gitignore
```

The 3.13 lane is not part of the first acceptance gate. When added, it
should target the current 3.13 maintenance release, currently 3.13.13,
not the older 3.13.12. Add it only after 3.14 can run the core
canaries.

### Artifact Naming And Migration

During bring-up CPython uses a distinct artifact name:

- CPython output: `cpython3.wasm`
- RustPython output: `python3.wasm`
- CPython executable registration: `cpython3`
- Existing RustPython executable registration: `python3`

The first CPython port must not overwrite
`packages/orchestrator/src/platform/__tests__/fixtures/python3.wasm`,
because `scripts/build-mcp.sh`, `Sandbox.registerTools()`, worker
execution, and existing tests still treat that filename as RustPython.

This side-by-side naming is temporary and exists only to keep current
tests and product paths alive while the CPython ABI gaps are exposed
and fixed. The accepted end state is not two Python implementations;
it is CPython installed as `python3`.

The initial sandbox canaries should execute `cpython3 ...` directly.
The required cutover task, after those canaries pass, does this in one
PR:

1. switches `python3` tool registration from RustPython to CPython;
2. updates `scripts/build-mcp.sh` and any fixture copy paths;
3. removes RustPython-only startup shims from the CPython environment;
4. updates worker execution and tests that assume RustPython behavior;
5. deletes or archives the old RustPython `python3.wasm` build path.

### Toolchain Shape

CPython is a C port. It should follow the `packages/c-ports/` source
policy:

- upstream source is pinned, not downloaded ad hoc during every build;
- Codepod patches are stored as patch files;
- the build happens out of tree so the upstream source stays clean;
- `cpcc`, `cpar`, and `cpranlib` are used where CPython expects C
  compiler, archiver, and ranlib tools;
- `libcodepod.a` is linked into the bring-up `cpython3.wasm`
  artifact.
- the source tree is configured for `wasm32-wasip1` using CPython's
  cross-build requirements, including a host build Python and a target
  configure/build stage.

The preferred first build path is CPython's own WASI helper:

```bash
python3 Tools/wasm/wasi.py build -- --config-cache
```

The Codepod port wraps that shape rather than ignoring it:

1. build the native host Python that CPython needs for generated files;
2. configure the WASI target build with `CC=cpcc`, `AR=cpar`,
   `RANLIB=cpranlib`, `WASI_SDK_PATH`, and Codepod link flags;
3. preserve CPython's generated-file flow instead of hand-editing
   generated files;
4. set `HOSTRUNNER` only for host-side configure probes that truly need
   to execute target wasm, and point it at a Codepod-aware runner when
   probes require Codepod imports;
5. stage the stdlib install layout under `build/install` before copying
   into sandbox fixtures.

If `Tools/wasm/wasi.py` cannot be made to accept the Codepod compiler
wrappers, the direct configure/make fallback must still keep the same
two-stage structure: host-build Python first, then target configure,
target make, target install/staging. It must not skip generated files,
`pybuilddir.txt`, frozen modules, or stdlib layout setup.

### ABI-First Rule

When CPython needs a platform feature, prefer this order:

1. Let CPython call the standard C/POSIX API.
2. Provide or fix that symbol in `packages/guest-compat`.
3. Wire the symbol to the generic kernel import layer if needed.
4. Patch CPython's WASI gates only if the module is excluded before
   link time.
5. Add Python-level shims only if no lower-level hook exists.

Examples:

- process support lands in stages. First enable and test
  `os.posix_spawn()` / `os.posix_spawnp()` against Codepod's
  `posix_spawn`, `posix_spawnp`, pipes, dup/close actions, and
  `waitpid`. Only after that works should CPython's `subprocess`
  module be patched/enabled. Upstream still marks `subprocess`
  unavailable on WASI, and `subprocess.Popen` does not always use
  `posix_spawn()`; capture, close-fd, and `_posixsubprocess` paths
  need separate verification.
- `_socket` should build against Codepod's `socket`, `connect`,
  `send`, `recv`, `getsockname`, `getpeername`, DNS, and related
  surface. If CPython disables `_socket` for WASI, patch that gate and
  let missing symbols fall out.
- `_ssl` should build only once the TLS/cert story is ready enough to
  support Python's expectations. Until then, `_socket` can land before
  `_ssl`.
- `tempfile`, `os`, `pathlib`, and importlib should exercise VFS,
  cwd, env, errno, and stat behavior through normal WASI/libc calls.

### Browser Networking

Browser networking is a later sub-slice. CPython's socket module should
first work against Codepod's socket ABI in runtimes that can provide
socket backends.

For browser mode, raw sockets are not generally available. The likely
path is:

- a Codepod fetch primitive exposed below Python;
- a Python or C extension transport for HTTP clients that can use
  fetch when sockets are unavailable;
- targeted patching of Python networking libraries only where they
  cannot consume the lower-level transport.

This is deliberately separate from the first CPython acceptance gate.

### Runtime Layout

The sandbox should install CPython as ordinary files:

- `/bin/cpython3` or `/bin/cpython3.wasm` as the executable during
  migration;
- `/usr/lib/python3.14/` for the standard library;
- optional symlinks such as `/usr/bin/cpython3 -> /bin/cpython3`;
- no RustPython-only `sitecustomize.py` unless a CPython-specific
  bootstrap needs it.

`PYTHONPATH` remains user-configurable, but the default stdlib path
should be CPython's real stdlib layout rather than `/usr/lib/python`
shims designed for RustPython.

Migration gate: CPython canaries must run with a clean CPython import
environment. They must not see `/usr/lib/python` ahead of
`/usr/lib/python3.14`, and they must not import the current
RustPython-specific `subprocess.py`, `socket.py`, `ssl.py`,
`requests.py`, `sitecustomize.py`, or extension shim files. During the
side-by-side phase, `Sandbox.create()` should install RustPython shims
only for the temporary `python3` compatibility path, not for
`cpython3`. At cutover, those RustPython shims are deleted or moved out
of the default sandbox image.

### `_codepod` Module

After the base interpreter runs, add a CPython `_codepod` module. It
should be a small C extension or built-in module that exposes Codepod
features that are not POSIX:

- extension invocation;
- optional fetch primitive;
- optional sandbox metadata/helpers.

It should not own subprocess, files, sockets, or normal networking
unless those cannot be reached through CPython's standard layers.

### Acceptance Canaries

The first CPython milestone is accepted when these run in the Codepod
sandbox:

```bash
cpython3 -c "print(1 + 2)"
cpython3 -c "import sys; print(sys.version_info[:2])"
cpython3 -c "import os, tempfile; print(os.getcwd(), tempfile.gettempdir())"
cpython3 -c "open('/tmp/hello.txt', 'w').write('hi'); print(open('/tmp/hello.txt').read())"
cpython3 -c "import pathlib; pathlib.Path('/tmp/p').write_text('x'); print(pathlib.Path('/tmp/p').read_text())"
```

Process canary stage 1, before `subprocess` is enabled:

```bash
cpython3 -c "import os; pid = os.posix_spawnp('echo', ['echo', 'hi'], os.environ); print(isinstance(pid, int))"
```

Process canary stage 2, once CPython's subprocess path is explicitly
patched/enabled:

```bash
cpython3 -c "import subprocess; r = subprocess.run(['/bin/echo', 'hi'], capture_output=True, text=True); print(r.returncode, r.stdout.strip())"
```

Socket canary, once `_socket` is enabled:

```bash
cpython3 -c "import socket; s = socket.create_connection(('127.0.0.1', 18080)); s.sendall(b'ping'); print(s.recv(4).decode())"
```

Each failing canary must be categorized as one of:

- CPython build gate patch needed;
- missing `guest-compat` C symbol;
- missing kernel host import/backend behavior;
- unsupported-by-design for this milestone.

## Open Questions

1. Whether CPython's `Tools/wasm/wasi.py` can be cleanly driven through
   `cpcc`, or whether a direct configure/make flow is simpler.
2. Whether `_socket` can be enabled with small CPython build-gate
   patches or requires deeper configure/module changes.
3. Whether `_posixsubprocess` can use `posix_spawn` cleanly on WASI, or
   whether CPython assumes fork-era invariants in too many places.
4. How much of `_ssl` should land before Python package work starts.
5. Whether `_codepod` should be built into CPython statically for the
   first cutover or shipped as a dynamically imported extension once
   package layout work exists.

## Sources

- Python 3.13 made `wasm32-wasi` a PEP 11 tier-2 platform.
- Python 3.14 includes WASM/WASI build updates, including
  `wasm32-wasip1` target naming.
- CPython's WebAssembly build docs describe `Tools/wasm` as the
  upstream build helper for WASI/Emscripten targets.
