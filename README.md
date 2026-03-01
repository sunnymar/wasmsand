# codepod

A portable WebAssembly sandbox that gives LLMs access to a POSIX shell, 95+ commands, and a Python runtime — no containers, no kernel, no hardware emulation. Ships with an [MCP server](docs/guides/mcp-server.md) so Claude can use it directly as a tool.

**[Try it in your browser](https://codepod-sandbox.github.io/codepod/)**

LLMs are trained on enormous amounts of shell and Python usage. Rather than inventing a new API for code execution, codepod speaks the language they already know: bash, coreutils, and Python 3.

## What it does

- **Shell execution** — pipes, redirects, variables, globbing, control flow, functions, subshells
- **95+ commands** — cat, grep, sed, awk, find, sort, jq, tar, curl, sqlite3, and more
- **Python 3** via RustPython compiled to WASI
- **Virtual filesystem** — in-memory POSIX VFS with optional persistence
- **Host mounts** — inject files into the VFS at arbitrary paths
- **Extensions** — register custom shell commands backed by host-side handlers
- **MCP server** — plug into Claude Code, Claude Desktop, or any MCP client
- **Runs everywhere** — same code works server-side (Deno/Node.js) and in the browser

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
| [Shell & Commands Reference](docs/guides/shell-reference.md) | All 95+ commands, shell features, virtual `/dev` and `/proc` |
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
- **Bash-compatible, not full POSIX.** Covers most scripting needs. Missing: aliases, `trap`, job control, arrays, process substitution.
- **No runtime pip install from PyPI.** Python packages are standard library or provided via extensions.
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

## Related projects

codepod occupies a specific point in the design space: a lightweight WASM-based sandbox with real POSIX semantics, designed for LLM code execution on both server and browser. Here's how it compares to related projects.

### RustPython

[RustPython](https://github.com/RustPython/RustPython) (21k+ stars) is a Python 3 interpreter written in Rust. codepod uses RustPython compiled to WASI as its Python runtime — it runs as a standard WASI binary through the same process manager as coreutils, sharing the virtual filesystem and I/O plumbing with no special-case integration.

RustPython gives codepod near-complete Python 3 coverage (classes, generators, decorators, context managers, and stdlib modules like `json`, `re`, `math`, `collections`) in a single ~12MB WASM binary. The tradeoff is startup latency (hundreds of milliseconds for the first invocation, cached after) and no C extension support — `numpy`, `pandas`, and anything requiring native code won't work. For LLM use cases this is rarely a limitation since agents primarily use the standard library.

### Monty (Pydantic)

[Monty](https://github.com/pydantic/monty) (5.7k stars) is a minimal Python interpreter from the Pydantic team, explicitly targeting LLM-generated code. It prioritizes microsecond startup (~0.06ms), tiny footprint, and strict isolation via a controlled external-function model — filesystem, network, and environment access only happen through developer-approved callbacks.

codepod initially used Monty but switched to RustPython because Monty's Python subset was too restrictive for practical agent use: no classes, limited stdlib (only `sys`, `typing`, `asyncio`), and no modules like `json` or `re` that LLMs reach for constantly. Monty is the right choice if you need sub-millisecond startup and can constrain your agent to simple procedural scripts. codepod chose broader Python coverage at the cost of higher startup latency, since commands are typically batched and the WASM module is cached after first load.

Monty is still early and actively developing — classes and `json` support are on their roadmap. It's worth watching.

### lifo

[lifo](https://github.com/lifo-sh/lifo) is a browser-native Unix environment — 60+ commands, a bash-like shell, a virtual filesystem with IndexedDB persistence, and Node.js compatibility shims. It positions itself as [zero-cost AI sandboxing](https://lifo.sh/): no server, no VM, instant boot.

The key architectural difference: lifo implements commands in JavaScript against browser APIs, while codepod compiles real Rust coreutils and a Rust shell parser to WebAssembly running under WASI. This has significant implications:

| | codepod | lifo |
|---|---|---|
| **Execution model** | WASM binaries under WASI host | JS functions against browser APIs |
| **Process isolation** | Each command is an isolated WASM instance with its own linear memory | Shared JS thread, no memory isolation between commands |
| **Security boundary** | WASM sandbox + WASI syscall interception + configurable policies (tool allowlist, output limits, memory limits, hard-kill) | Browser sandbox only — "not for high-security sandboxing" per their docs |
| **Server-side** | Yes (Deno/Node.js with Worker-based hard-kill) | Browser-only |
| **Python** | Full Python 3 via RustPython WASI | None |
| **Persistence** | In-memory VFS with snapshot/restore/fork, export/import, and auto-persist to IndexedDB or filesystem | IndexedDB-backed VFS |
| **Networking** | Opt-in with domain allowlist, sync bridge for WASI | Browser fetch (no policy layer) |

lifo is a good fit for lightweight browser-side demos and prototyping where the browser sandbox is sufficient. codepod is designed for the harder problem: running untrusted LLM-generated code in production on both server and browser, where you need real process isolation, configurable security policies, and hard-kill guarantees.

codepod has adopted several ideas from lifo's design — a package manager concept, persistence modes, and shell ergonomics for long autonomous runs — adapted to work within the WASM security boundary rather than as bare JS.

## Origin

This project was written entirely by Claude (Anthropic's AI assistant) as an experiment in AI-driven software engineering. Every line of code — the Rust shell parser, the TypeScript orchestrator, the Python SDK, the WASM coreutils integration, and the build tooling — was generated by Claude across a series of collaborative sessions with a human directing the design.

## License

[BSD 3-Clause](LICENSE)
