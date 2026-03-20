# codepod

A portable WebAssembly sandbox that gives LLMs access to a POSIX shell, 100+ commands, and a Python runtime — no containers, no kernel, no hardware emulation. Ships with an [MCP server](docs/guides/mcp-server.md) so Claude can use it directly as a tool.

**[Try it in your browser](https://codepod-sandbox.github.io/codepod/)**

LLMs are trained on enormous amounts of shell and Python usage. Rather than inventing a new API for code execution, codepod speaks the language they already know: bash, coreutils, and Python 3.

## What it does

- **Shell execution** — pipes, redirects, variables, globbing, control flow, functions, subshells, background jobs (`&`), aliases, arrays, process substitution
- **100+ commands** — cat, grep, sed, awk, find, sort, jq, tar, curl, sqlite3, `pdfinfo`, `pdfunite`, `pdfseparate`, `xlsx2csv`, `csv2xlsx`, and more
- **Native document tools** — inspect and transform PDFs and spreadsheets with familiar real-world CLI names
- **Python 3** via RustPython compiled to WASI, with **numpy** support (native Rust implementation)
- **Virtual filesystem** — in-memory POSIX VFS with optional persistence
- **Host mounts** — inject files into the VFS at arbitrary paths
- **Extensions** — register custom shell commands backed by host-side handlers
- **MCP server** — plug into Claude Code, Claude Desktop, or any MCP client
- **Runs everywhere** — same code works server-side (Deno/Node.js) and in the browser

## Document commands

codepod ships document-oriented commands as native WASM executables, so they behave like the rest of the built-in shell toolchain instead of host-side extensions.

- **PDF** — `pdfinfo`, `pdfunite`, `pdfseparate`
- **Spreadsheet** — `xlsx2csv`, `csv2xlsx`

These follow familiar real-world CLI names and mostly familiar flags, which matters for LLMs: models already know how to reach for `pdfinfo` or `xlsx2csv` in the same way they reach for `awk`, `sed`, or `sqlite3`.

```bash
# Inspect a PDF
pdfinfo report.pdf

# Merge multiple PDFs
pdfunite part1.pdf part2.pdf merged.pdf

# Split a PDF into one file per page
pdfseparate input.pdf page-%d.pdf

# Export the first worksheet to CSV
xlsx2csv workbook.xlsx

# Create an XLSX workbook from CSV
csv2xlsx -i data.csv output.xlsx Sheet1
```

## Install

**TypeScript:**

```bash
npm install @codepod/sandbox
```

**Python:**

```bash
pip install codepod
```

## Quick start

### TypeScript

```typescript
import { Sandbox } from '@codepod/sandbox';
import { NodeAdapter } from '@codepod/sandbox/node';

const sandbox = await Sandbox.create({
  adapter: new NodeAdapter(),
  wasmDir: './node_modules/@codepod/sandbox/wasm',
});

const result = await sandbox.run('echo hello world | wc -w');
console.log(result.stdout); // "3\n"

sandbox.destroy();
```

### Python

```python
from codepod import Sandbox

with Sandbox() as sb:
    result = sb.commands.run("echo hello world | wc -w")
    print(result.stdout)  # "3\n"

    sb.files.write("/tmp/data.csv", b"name,score\nalice,95\nbob,87\n")
    result = sb.commands.run("cat /tmp/data.csv | sort -t, -k2 -rn")
    print(result.stdout)
```

## Documentation

| Guide | Description |
|-------|-------------|
| [TypeScript SDK](docs/guides/typescript-sdk.md) | Full TypeScript API, browser/Node setup, configuration |
| [Python SDK](docs/guides/python-sdk.md) | Python API, file operations, error handling, VirtualFileSystem |
| [Shell & Commands Reference](docs/guides/shell-reference.md) | All 100+ commands, including PDF and spreadsheet tools, plus shell features and virtual `/dev` and `/proc` |
| [MCP Server](docs/guides/mcp-server.md) | Claude Code/Desktop setup, tools, configuration |
| [Mounting Files](docs/guides/mounting-files.md) | Host mounts, MemoryFS, custom VirtualFileSystem implementations |
| [Extensions](docs/guides/extensions.md) | Custom shell commands and Python packages backed by host handlers |
| [Package Manager](docs/guides/package-manager.md) | Installing WASI binaries at runtime |
| [State & Persistence](docs/guides/state-persistence.md) | Export/import, snapshots, fork, auto-persistence, command history |
| [Security Architecture](docs/guides/security.md) | Threat model, sandbox boundaries, isolation guarantees, trust model |

## Architecture

```
Claude / MCP Client          Host Application
        │ (stdio, MCP)              │ (TypeScript / Python API)
        ▼                           ▼
   MCP Server ──────────► TypeScript Orchestrator ─── VFS (in-memory)
                                    │
                              Process Manager
                                    │
                               WASI P1 Host
                              ┌─────┴─────┐
                              │     │     │
                           Shell  Utils  Python
                           (Rust) (Rust) (RustPython)
                              └─────┬─────┘
                              WebAssembly
```

The shell parser is written in Rust and compiled to WASI. It emits a JSON AST that the TypeScript orchestrator executes, managing the virtual filesystem, process lifecycle, and I/O plumbing. Coreutils are individual Rust binaries compiled to WASM. Python runs via RustPython (also compiled to WASI) sharing the same VFS.

All command execution runs inside the WASM sandbox — no host process spawning. File I/O is in-memory VFS only. Networking is default-deny. See [Security Architecture](docs/guides/security.md) for the full threat model and isolation guarantees.

## Limitations

- **No networking by default.** Must be explicitly enabled with a domain allowlist.
- **In-memory filesystem.** Default 256 MB, configurable. Use persistence modes to survive restarts.
- **Sequential pipeline execution.** Pipeline stages run one at a time with buffered I/O.
- **Bash-compatible, not full POSIX.** Covers most scripting needs — aliases, arrays, process substitution, and background jobs are all supported.
- **No runtime pip install from PyPI.** Python packages are standard library, native Rust implementations (numpy), or provided via extensions.
- **Not formally audited.** Defense-in-depth security is implemented but not yet pen-tested.

## Development

Requires [Deno](https://deno.com) (runtime + test runner) and a Rust toolchain with the `wasm32-wasip1` target. Deno is required because codepod uses [JSPI](https://v8.dev/blog/jspi) (`WebAssembly.Suspending`/`WebAssembly.promising`) to let WASM code call async host functions — Bun does not support JSPI.

```bash
deno install       # install dependencies
make build         # build everything (Rust WASM + TypeScript)
deno test -A --no-check packages/orchestrator packages/sdk-server packages/mcp-server
make npm           # package for npm
make wheel         # package Python wheel (current platform)
```

## How it compares

codepod occupies a specific point in the design space: a lightweight WASM-based sandbox with real POSIX semantics, designed for LLM code execution on both server and browser.

### vs. Docker

[Docker](https://www.docker.com/) is the industry standard for containerized execution. It uses Linux kernel namespaces and cgroups to isolate processes, giving you a full Linux userspace with any language, any binary, and full filesystem access.

| | codepod | Docker |
|---|---|---|
| **Isolation** | WASM linear memory sandbox | Linux kernel namespaces + cgroups |
| **Startup** | Instant (cached WASM instantiation) | ~500ms-2s (container start) |
| **Runs in browser** | Yes | No |
| **Infrastructure** | None — single process, in-memory | Docker daemon + Linux kernel |
| **Cost per sandbox** | ~64KB initial memory | Container overhead (~10-50MB) |
| **Filesystem** | In-memory VFS with host mounts | Full Linux FS with bind mounts, volumes |
| **Python** | RustPython + native numpy | Full CPython + pip install anything |
| **Shell** | POSIX shell, 95+ commands, aliases, arrays, process substitution, background jobs | Full Linux (bash, zsh, everything) |
| **Networking** | Opt-in domain allowlist | Full network stack (configurable) |
| **Persistence** | Snapshot/restore/fork/export | Volumes, bind mounts, image layers |
| **Embeddable** | Yes (library, runs in-process) | No (requires daemon) |

Docker is the right choice when you need full Linux compatibility, package managers, and production-grade container orchestration. codepod is for when you need lightweight, embeddable sandboxes that run anywhere (including the browser) without a daemon or kernel dependency.

### vs. E2B

[E2B](https://e2b.dev) (~11k stars) runs Firecracker microVMs in the cloud. Each sandbox is a full Linux VM with its own kernel, filesystem, and network stack. This gives you maximum compatibility (any language, any binary, full networking) but at a cost: cloud-only, per-second billing, and ~150-200ms cold starts.

codepod takes a fundamentally different approach — no VMs, no containers, no kernel. WASM instances in a single process.

| | codepod | E2B |
|---|---|---|
| **Isolation** | WASM linear memory sandbox | Firecracker microVM (KVM) |
| **Startup** | Instant (cached WASM instantiation) | ~150-200ms (VM boot) |
| **Runs locally** | Yes (Deno/Node.js, browser) | No (requires Linux KVM) |
| **Runs in browser** | Yes | No |
| **Infrastructure** | None — single process, in-memory | Cloud service or self-hosted Terraform + KVM |
| **Cost per sandbox** | ~64KB initial memory | Full VM (default 512MB+ RAM) |
| **10 concurrent sandboxes** | ~1x compiled code + 10x heap | 10x full VMs |
| **Filesystem** | In-memory VFS with host mounts and virtual FS | Ephemeral VM disk (no host mount or virtual FS support) |
| **Python** | RustPython + native numpy | Full CPython + pip install anything |
| **Shell** | POSIX shell, 95+ commands, aliases, arrays, process substitution, background jobs | Full Linux (bash, apt, everything) |
| **Networking** | Opt-in domain allowlist | Full network stack |
| **Persistence** | Snapshot/restore/fork/export (in-memory) | VM snapshots |
| **Open source** | Yes (BSD 3-Clause) | Yes (Apache 2.0) |

E2B is the right choice when you need full Linux compatibility — C extensions, system packages, GPU, or unrestricted networking. codepod is for when you want lightweight, zero-infrastructure sandboxes that run anywhere (including the browser) with predictable resource usage and no cloud dependency.

### vs. Deno Sandbox

[Deno Sandbox](https://deno.com/deploy/sandbox) is a cloud service (beta, launched Feb 2026) running lightweight Linux microVMs on Deno Deploy. Like E2B, it provides full Linux environments with any language support. Unlike E2B, it's cloud-only with no self-hosting option.

| | codepod | Deno Sandbox |
|---|---|---|
| **Isolation** | WASM linear memory | Linux microVM |
| **Startup** | Instant | <1s (stated) |
| **Self-hostable** | Yes | No (managed service only) |
| **Runs in browser** | Yes | No |
| **Open source** | Yes | No |
| **Python** | RustPython + numpy | Full CPython |
| **Shell** | POSIX shell, 95+ commands, aliases, arrays, process substitution, background jobs | Full Linux |

### vs. RustPython

[RustPython](https://github.com/RustPython/RustPython) (21k+ stars) is a Python 3 interpreter written in Rust. codepod uses RustPython compiled to WASI as its Python runtime — it runs as a standard WASI binary through the same process manager as coreutils, sharing the virtual filesystem and I/O plumbing with no special-case integration.

RustPython gives codepod near-complete Python 3 coverage (classes, generators, decorators, context managers, and stdlib modules like `json`, `re`, `math`, `collections`) in a single WASM binary. The tradeoff is startup latency (hundreds of milliseconds for the first invocation, cached after) and no C extension support. codepod works around this for key packages by providing native Rust implementations compiled directly into the WASM binary — numpy is supported this way via [numpy-rust](https://github.com/codepod-sandbox/numpy-rust) (400+ operations, 8 dtypes, linalg, FFT, random). Additional packages (pillow, matplotlib) follow the same pattern.

### vs. Monty (Pydantic)

[Monty](https://github.com/pydantic/monty) (5.7k stars) is a minimal Python interpreter from the Pydantic team, explicitly targeting LLM-generated code. It prioritizes microsecond startup (~0.06ms), tiny footprint, and strict isolation via a controlled external-function model — filesystem, network, and environment access only happen through developer-approved callbacks.

codepod initially used Monty but switched to RustPython because Monty's Python subset was too restrictive for practical agent use: no classes, limited stdlib (only `sys`, `typing`, `asyncio`), and no modules like `json` or `re` that LLMs reach for constantly. Monty is the right choice if you need sub-millisecond startup and can constrain your agent to simple procedural scripts. codepod chose broader Python coverage at the cost of higher startup latency, since commands are typically batched and the WASM module is cached after first load.

### vs. lifo

[lifo](https://github.com/lifo-sh/lifo) is a browser-native Unix environment — 60+ commands, a bash-like shell, a virtual filesystem with IndexedDB persistence. It implements commands in JavaScript against browser APIs, while codepod compiles real Rust coreutils and a Rust shell parser to WebAssembly running under WASI.

| | codepod | lifo |
|---|---|---|
| **Execution model** | WASM binaries under WASI host | JS functions against browser APIs |
| **Process isolation** | Each command is an isolated WASM instance with its own linear memory | Shared JS thread, no memory isolation between commands |
| **Security boundary** | WASM sandbox + WASI syscall interception + configurable policies | Browser sandbox only |
| **Server-side** | Yes (Deno/Node.js with Worker-based hard-kill) | Browser-only |
| **Python** | Full Python 3 via RustPython WASI + numpy | None |
| **Persistence** | In-memory VFS with snapshot/restore/fork, export/import | IndexedDB-backed VFS |

## Origin

This project was written entirely by Claude (Anthropic's AI assistant) as an experiment in AI-driven software engineering. Every line of code — the Rust shell parser, the TypeScript orchestrator, the Python SDK, the WASM coreutils integration, and the build tooling — was generated by Claude across a series of collaborative sessions with a human directing the design.

## License

[BSD 3-Clause](LICENSE)
