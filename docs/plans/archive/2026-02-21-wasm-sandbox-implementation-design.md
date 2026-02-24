# WASM AI Sandbox: Implementation Design

## Decisions

- **Deployment**: Browser and server simultaneously from day one
- **Language split**: Rust for shell + coreutils (compiled to WASI P1), TypeScript for orchestrator
- **Wasm target**: WASI Preview 1 — widest portability, thinnest runtime
- **Shell**: Custom Rust bash-subset interpreter, emits execution plans to the orchestrator
- **Coreutils**: Real implementations (uutils, frawk, GNU sed/find via wasi-sdk), not toy subsets
- **Python**: Pyodide as peer Wasm instance sharing the VFS, seamless integration
- **Fork**: Userspace simulation in the orchestrator (memory snapshot + COW VFS clone)
- **Syscalls**: Standard WASI architecture — wasi-libc inside sandbox, ~40 WASI P1 imports implemented host-side in TS
- **VFS**: In-memory tree in TypeScript, snapshotable, backs both WASI syscalls and Pyodide FS

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TS Orchestrator                           │
│  (Node.js OR browser — same code, thin platform adapter)    │
│                                                             │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────────┐  │
│  │  WASI Host   │  │     VFS     │  │ Capability Bridge │  │
│  │  (~40 P1 fns │  │ (in-memory  │  │ (network allow-   │  │
│  │  + fork)     │  │  tree, COW  │  │  list, host FS    │  │
│  │              │  │  snapshots) │  │  mounts, limits)  │  │
│  └──────┬───────┘  └──────┬──────┘  └────────┬──────────┘  │
│         │                 │                   │             │
│  ┌──────▼─────────────────▼───────────────────▼──────────┐  │
│  │              Process Manager                           │  │
│  │   Fork simulation, exec dispatch, pipe wiring,        │  │
│  │   Wasm instance lifecycle, Pyodide delegation         │  │
│  └──────┬────────────────────────────────────┬───────────┘  │
│         │                                    │              │
│  ┌──────▼──────────┐              ┌──────────▼───────────┐  │
│  │  Wasm Instances │              │      Pyodide         │  │
│  │  shell, core-   │              │  Mounted to same     │  │
│  │  utils — WASI   │              │  VFS, subprocess     │  │
│  │  P1 binaries    │              │  routes back to      │  │
│  │                 │              │  orchestrator        │  │
│  └─────────────────┘              └──────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. Shell (Rust → WASI P1)

Custom Rust bash-subset interpreter. Parses commands and emits execution plans to the orchestrator — does not run commands directly (it can't spawn Wasm instances; only the host can).

**Execution flow:**
1. Shell receives command string
2. Parses into AST (pipeline, redirects, control flow)
3. Serializes plan, sends to orchestrator via dedicated fd
4. Orchestrator instantiates tools, wires pipes, runs them
5. Orchestrator returns exit code + output metadata
6. Shell handles control flow based on exit codes

**Protocol (shell <-> orchestrator):**
```json
{ "run": { "pipeline": [...], "redirects": [...] } }
{ "result": { "exit_code": 0, "stdout_bytes": 1234 } }
```

**v1 syntax support:**
- Pipes, redirects (>, >>, <, 2>&1, 2>/dev/null)
- &&, ||, ;, (subshell)
- $(command substitution), backticks
- if/then/elif/else/fi, for/do/done, while/do/done
- Variable assignment, export, $VAR, ${VAR:-default}
- Globbing (*, ?, **/*.txt)
- Single/double quoting, escape characters
- Builtins: echo, test/[, read, exit, cd, pwd, export

### 2. Coreutils (Rust → WASI P1)

Per-tool .wasm binaries, lazy-loaded on first use. Full implementations — an LLM writes standard commands and they work.

| Category | Tools | Source |
|----------|-------|--------|
| File ops | cat, cp, mv, rm, mkdir, ls, touch, ln, chmod | uutils |
| Text processing | grep, sort, uniq, wc, head, tail, cut, tr | uutils |
| Text (full) | awk, sed | frawk / GNU sed via wasi-sdk |
| Search | find, xargs | GNU findutils via wasi-sdk or Rust impl |
| Data | tee, diff, comm | uutils |
| Utility | echo, printf, date, env, which, true, false, basename, dirname, realpath | uutils |
| Network | curl, wget | Rust impls, socket syscalls -> capability bridge |
| Data formats | jq | Rust impl (serde_json-based CLI) |
| Archives | tar, gzip | Rust crates (tar-rs, flate2) |

awk, sed, find are full implementations, not subsets. Minor behavioral variations (macOS vs GNU flag differences) are acceptable.

### 3. Python Integration (Pyodide)

Pyodide runs as a peer Wasm instance. Appears as /usr/bin/python3.

**Integration mechanism:**
1. Custom Pyodide FS backend (WASMSANDFS) proxies all file ops to our VFS
2. Environment (cwd, env vars, sys.argv) synced before each invocation
3. stdout/stderr piped back through shell redirect infrastructure
4. subprocess.Popen monkey-patched to route commands back to orchestrator

**Pre-bundled packages (v1):**
- numpy, pandas, matplotlib
- beautifulsoup4, pyyaml, regex
- Standard library (json, csv, re, os, pathlib, etc.) works out of the box

Packages lazy-loaded on first import.

### 4. Virtual Filesystem (TypeScript)

In-memory tree structure backing both WASI syscalls and Pyodide FS.

**Layout:**
```
/
├── bin/             # Tool entries for discovery
├── usr/bin/         # Tool entries for discovery (LLMs check both)
├── home/user/       # Working directory, LLM workspace
├── tmp/             # Scratch
└── mnt/             # Optional host FS mounts
```

No special /output/ directory. Host reads/writes any file by path via the sandbox API.

**Structure:**
- Tree of inodes (file, dir, symlink, pipe)
- Per-inode: metadata (permissions, timestamps, size) + content (ArrayBuffer or child map)
- Per-process file descriptor table (fd -> inode + offset + flags)
- COW snapshots for fork simulation (shallow clone, copy on write)
- Pipes as VFS objects (ring buffer backing a read fd + write fd)

**Tool discovery:** /bin/ and /usr/bin/ populated with entries for all available tools. `ls /usr/bin`, `which grep`, `find / -name python3` all work. Tools not yet loaded still appear — lazy loading is transparent.

**Storage backends (via platform adapter):**
- In-memory (default, both platforms)
- IndexedDB persistence (browser, optional)
- Host FS mount (server, optional)

### 5. Process Manager (TypeScript)

Manages the lifecycle of all "processes" in the sandbox.

**Process model:**
- Each running command = a process with pid, fd table, env vars, cwd
- Process table lives in the orchestrator
- Shell pipelines spawn multiple processes wired via VFS pipes

**Fork simulation:**
1. Wasm binary calls fork() (custom WASI import)
2. Orchestrator snapshots: Wasm linear memory + VFS (COW) + fd table + env
3. New Wasm instance created from same module with copied memory
4. Parent gets child pid, child gets 0
5. Both run (sequentially in v1, Web Workers later if needed)

**Pipeline execution (e.g., `cat data.csv | grep error | wc -l`):**
1. Create VFS pipes
2. Spawn each stage with stdin/stdout wired to pipes
3. Run stages (sequentially with buffering, or concurrently later)
4. Collect exit code from last stage

**Resource limits:**
- Wall-clock timeout per command (kills Wasm instance)
- Memory ceiling (checked on memory.grow)
- VFS size limit (checked on write)
- Max process count (prevents fork bombs)
- Network request budget

### 6. WASI Host Implementation (TypeScript)

Implements the ~40 WASI Preview 1 functions plus a custom fork() import.

Standard WASI architecture: wasi-libc inside the sandbox handles path resolution, fd tables, buffers. The host implements the actual syscalls backed by VFS + capability bridge.

```
Inside Wasm: wasi-libc (paths, fds, buffers) -> calls WASI imports
──────────── Wasm boundary ────────────
Host (TS):   WASI imports -> VFS, capability checks, resource limits
```

Security boundary = the Wasm import interface. Code inside the sandbox cannot escape — it can only call the imports the host provides.

### 7. Capability Bridge (TypeScript)

**Network:**
- Deny-by-default
- Per-session allowlist: sandbox.allowNetwork(["api.example.com"])
- Intercepted at WASI socket syscalls
- Server: orchestrator makes real HTTP requests
- Browser: uses fetch() — CORS applies as an additional sandbox layer, not worked around

**Host FS mounts:**
- Server-side: sandbox.mount("/mnt/data", hostPath, { readOnly: true })
- Browser: inject files via sandbox.writeFile()

### 8. Platform Adapter (TypeScript)

Thin abstraction so the same orchestrator runs in Node.js and browser.

```typescript
interface PlatformAdapter {
  loadModule(name: string): Promise<WebAssembly.Module>
  instantiate(module: WebAssembly.Module, imports: Imports): Promise<WebAssembly.Instance>
  fetch(url: string, opts: RequestInit): Promise<Response>
  saveSnapshot(id: string, data: Uint8Array): Promise<void>
  loadSnapshot(id: string): Promise<Uint8Array | null>
  spawnWorker?(module: WebAssembly.Module, memory: ArrayBuffer): Worker
}
```

- **Node**: reads .wasm from filesystem, worker_threads, disk persistence
- **Browser**: fetches .wasm from CDN/bundle, Cache API, Web Workers, IndexedDB

### 9. Sandbox API (TypeScript)

The public interface for host applications.

```typescript
interface Sandbox {
  // Lifecycle
  static create(options?: SandboxOptions): Promise<Sandbox>
  destroy(): void

  // Running commands
  run(command: string): Promise<RunResult>

  // File I/O — any path in the VFS
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  listDir(path: string): Promise<DirEntry[]>

  // Capabilities
  allowNetwork(domains: string[]): void
  mount(vfsPath: string, hostPath: string, opts?: MountOptions): void

  // State
  snapshot(): Promise<SnapshotId>
  restore(id: SnapshotId): Promise<void>
}

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
  executionTimeMs: number
}

interface SandboxOptions {
  memoryLimitMb?: number      // default 256
  timeoutMs?: number          // per-command, default 30000
  fsLimitMb?: number          // default 256
  maxProcesses?: number       // default 64
}
```

**LLM tool interface** wraps the above — the sandbox is tool-call-framework-agnostic:
```json
{
  "tool": "sandbox_run",
  "input": { "command": "find /home/user -name '*.csv' | head -5" }
}
```
```json
{
  "exit_code": 0,
  "stdout": "/home/user/sales_q1.csv\n/home/user/sales_q2.csv\n",
  "stderr": "",
  "execution_time_ms": 12
}
```

## Package and Distribution

- npm package with Node + browser adapters
- Browser: ESM bundle, .wasm files as separate lazy-loaded assets
- Server: CommonJS + ESM dual package
- Pyodide loaded from CDN or bundled
- Target compressed size: under 50MB for browser (Pyodide ~10MB, tools TBD)
