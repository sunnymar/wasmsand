# WASM AI Sandbox: Design & Requirements

## Overview

A lightweight, POSIX-flavored execution environment built on WebAssembly, designed to give LLMs access to familiar shell tools and a Python runtime. The sandbox provides a controlled, portable workspace that can run on both backend servers and in the browser — with no OS kernel, no containers, and no hardware emulation.

The key insight: LLMs are trained on vast amounts of POSIX/shell/Python usage. Providing a sandbox that speaks this language leverages all of that implicit knowledge, rather than requiring the LLM to learn a novel API.

## Goals

- Give an LLM access to a bash-like shell, standard POSIX tools, and a Python interpreter with a curated set of libraries — all running inside a WebAssembly sandbox.
- Virtual filesystem with controlled, capability-based access to the outside world (networking, host filesystem).
- Portable: runs server-side or client-side (in-browser). Client-side execution enables zero-server-cost compute and strong data privacy (user data never leaves the browser).
- Not a general-purpose OS. All code running in the sandbox is curated and controlled. We don't need `gcc`, `emacs`, or arbitrary binary execution. We need the tools an LLM actually uses.

## Non-Goals

- Full Linux emulation. No kernel, no hardware emulation, no x86-on-Wasm.
- Full POSIX compliance for its own sake. POSIX compatibility is a means to get tools to compile, not an end in itself.
- Heavy ML/training workloads. If someone needs to train models, they need real compute, not a Wasm sandbox.
- Running arbitrary untrusted user binaries.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  LLM Interface                   │
│         (tool call: execute command)              │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│                    Shell                         │
│         Bash-like (pipes, redirects,             │
│      env vars, globbing, control flow)           │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│                 Tool Layer                        │
│                                                   │
│  ┌─────────┐ ┌──────────┐ ┌───────────────────┐ │
│  │coreutils│ │  Python   │ │  Other tools      │ │
│  │grep find│ │ (Pyodide) │ │  jq, etc.         │ │
│  │cat sort │ │ + numpy   │ │                   │ │
│  │awk sed  │ │ + pandas  │ │                   │ │
│  │wc head  │ │ + matplot │ │                   │ │
│  │tail xargs│ │          │ │                   │ │
│  └─────────┘ └──────────┘ └───────────────────┘ │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              POSIX Abstraction Layer              │
│    Virtual FS, stdio, pipes, env, signals        │
│    (WASI / WASIX syscall interface)              │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              WebAssembly Runtime                  │
│         (Wasmer, Wasmtime, or browser)           │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│            Capability Bridge                      │
│    Controlled access to: network (allowlist),    │
│    host FS (mounted paths), output (images,      │
│    files back to LLM/user)                       │
└─────────────────────────────────────────────────┘
```

## Core Components

### 1. Shell

A bash-compatible shell that acts as the primary interface between the LLM and the sandbox.

**Must support:**
- Pipes (`|`), redirects (`>`, `>>`, `<`, `2>&1`)
- Environment variables (`$VAR`, `export`)
- Globbing (`*.py`, `**/*.txt`)
- Basic control flow (`if`, `for`, `while`) — primarily for inline scripts
- Command sequencing (`;`, `&&`, `||`)
- Subshells and command substitution (`$(...)`)

**Does not need to be actual bash.** It needs to *behave* like bash from the LLM's perspective. A purpose-built parser/interpreter that covers the above is sufficient and preferable — it can be more observable, more controllable, and can enforce resource budgets.

**Nice to have:**
- Structured output alongside text (e.g., returning both stdout and a generated image)
- Execution metadata (wall time, memory used) for the LLM to reason about

### 2. Coreutils / POSIX Tools

A curated set of command-line tools, compiled to Wasm (targeting WASI/WASIX).

**Required:**
- File operations: `cat`, `cp`, `mv`, `rm`, `mkdir`, `ls`, `touch`, `chmod` (virtual permissions)
- Text processing: `grep`, `sed`, `awk`, `sort`, `uniq`, `wc`, `head`, `tail`, `cut`, `tr`
- Search: `find`, `xargs`
- Data: `tee`, `diff`, `comm`
- Other: `echo`, `printf`, `date`, `env`, `which`, `true`, `false`

**Nice to have:**
- `jq` (JSON processing — very high value for LLM use)
- `curl` / `wget` (mediated through the capability bridge)
- `tar`, `gzip` (for working with archives)

**Implementation approach:** A BusyBox-style single binary compiled to Wasm is the most efficient approach. Alternatively, individual Rust or C implementations compiled to WASI/WASIX. Since we control all the code, we can ensure all tools yield properly (no infinite loops without syscalls).

### 3. Python Runtime

Pyodide (CPython compiled to WebAssembly) as the Python runtime.

**Core packages (standard library):**
- `json`, `csv`, `re`, `os`, `pathlib`, `collections`, `itertools`, `math`, `statistics`
- `io`, `sys`, `subprocess` (wired to the sandbox shell), `argparse`
- `datetime`, `hashlib`, `base64`, `urllib.parse`

**Curated third-party packages (via Pyodide):**
- `numpy` — numerical computing, array operations
- `pandas` — data manipulation, CSV/Excel processing
- `matplotlib` — charting and visualization (renders to PNG/SVG in-memory)
- `beautifulsoup4` — HTML/XML parsing
- `pyyaml` — YAML parsing
- `regex` — extended regex support (pure Python)

**Possibly useful, evaluate cost/benefit:**
- `scikit-learn` — if lightweight ML tasks (classification, regression, clustering) are in scope
- `sympy` — symbolic math
- `Pillow` — image manipulation
- `openpyxl` — Excel file handling

**Not included:** Heavy ML frameworks (torch, tensorflow), database drivers, web frameworks, GUI toolkits.

### 4. Virtual Filesystem

An in-memory filesystem that provides standard POSIX file semantics.

**Structure:**
```
/
├── home/
│   └── user/          # Working directory for the LLM
├── tmp/               # Scratch space
├── usr/
│   └── bin/           # Tools (grep, find, python, etc.)
├── mnt/
│   └── input/         # Mounted input files from the host/user
└── output/            # Files to be returned to the LLM/user
```

**Requirements:**
- Standard file operations (read, write, create, delete, rename, stat)
- Directory operations (mkdir, rmdir, readdir, chdir, getcwd)
- Pipes (for shell pipe implementation)
- Sufficient for Python's `os` and `pathlib` modules to work normally
- Snapshot/restore capability (for persistence across sessions or browser refresh)

**Storage backend:**
- Server-side: in-memory (ephemeral per session) or host-filesystem-backed
- Browser: in-memory, with optional IndexedDB persistence

### 5. Capability Bridge

The controlled interface between the sandbox and the outside world.

**Network access:**
- Deny-by-default
- Allowlist of permitted domains/endpoints, configured per session
- Mediated at the syscall level (WASIX socket calls are intercepted by the runtime)

**Host filesystem access:**
- Specific directories or files mounted read-only (or read-write) into the virtual FS
- Used for providing input data to the sandbox

**Output channel:**
- Files placed in `/output/` are made available to the LLM/user
- Binary outputs (images from matplotlib, generated files) are returned alongside text
- Structured result format: `{ stdout, stderr, exit_code, files: [{path, mime_type, data}] }`

**Resource limits:**
- Wall-clock timeout per command execution
- Memory ceiling for the Wasm instance
- Filesystem size limit
- Network request count/bandwidth limits

## LLM Interface

The sandbox is exposed to the LLM as a tool with a simple interface:

```json
{
  "tool": "sandbox_exec",
  "input": {
    "command": "find /mnt/input -name '*.csv' | head -5"
  }
}
```

```json
{
  "result": {
    "exit_code": 0,
    "stdout": "/mnt/input/sales_q1.csv\n/mnt/input/sales_q2.csv\n...",
    "stderr": "",
    "files": [],
    "execution_time_ms": 12
  }
}
```

For commands that produce files:

```json
{
  "tool": "sandbox_exec",
  "input": {
    "command": "python3 plot.py && ls /output/"
  }
}
```

```json
{
  "result": {
    "exit_code": 0,
    "stdout": "chart.png\n",
    "stderr": "",
    "files": [
      {
        "path": "/output/chart.png",
        "mime_type": "image/png",
        "size_bytes": 34521
      }
    ],
    "execution_time_ms": 850
  }
}
```

The sandbox maintains state across calls within a session — the filesystem persists, environment variables are retained, and files created by one command are available to subsequent commands.

## Implementation Considerations

### Wasm Runtime

**WASIX on Wasmer** is the most promising foundation:
- Extends WASI with threading, forking, process spawning, pipes, sockets, TTY
- Has browser support
- Active development by Wasmer team
- Sufficient POSIX coverage to compile the tools we need

**Risks:** WASIX is Wasmer-specific, not a W3C standard. If Wasmer stalls, we're coupled. Mitigation: the tool layer (coreutils, Python) targets WASI/POSIX at the source level — a runtime migration would require re-linking, not rewriting.

**Alternative:** WASI Preview 2 (component model) is the standards-track approach but is still maturing and lacks some of the POSIX extensions WASIX provides.

### Multiprocessing

Since all code in the sandbox is curated and controlled:
- All tools can be compiled/instrumented to yield at syscall boundaries (cooperative multitasking)
- Infinite loops in user-generated Python code are handled by wall-clock timeout + Wasm instance termination
- True parallelism is not required — shell pipelines can be executed stage-by-stage with intermediate buffers
- WASIX's `thread_spawn` and `proc_spawn` are available if needed, but the simple sequential model covers most LLM use cases

### Browser Execution

For client-side execution:
- Pyodide already runs in the browser — this is proven
- Wasm coreutils can execute in the browser's Wasm runtime
- The virtual filesystem uses in-memory storage (optionally backed by IndexedDB)
- SharedArrayBuffer + Web Workers available for any concurrency needs
- Main limitation: memory (typically 2-4 GB for Wasm in browsers) and initial load time

**Load time optimization:** Pre-compile and cache Wasm modules. Lazy-load Python packages. Ship a minimal boot image and pull additional packages on demand.

### Packaging & Distribution

The entire sandbox (runtime + tools + Python + packages) should be distributable as:
- A single Wasm bundle + asset files for browser deployment
- A server-side runtime package (npm package, Python package, or standalone binary)
- Target total size: ideally under 50MB compressed for the browser (Pyodide alone is ~10MB)

## Open Questions

1. **Shell implementation:** Write a custom bash-subset interpreter in Rust/C targeting Wasm, or port an existing lightweight shell (e.g., `dash`, `mksh`)?
2. **Package management:** Should the sandbox support `pip install` for pure-Python packages at runtime, or should all packages be pre-bundled?
3. **Session persistence:** How important is it to save/restore sandbox state across sessions? This affects the complexity of the filesystem and state management significantly.
4. **Multi-sandbox:** Should an LLM be able to run multiple sandboxes concurrently (e.g., for isolated experiments)?
5. **Extensibility:** Should there be a mechanism for users (not the LLM) to add custom tools to the sandbox?
