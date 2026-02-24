# wasmsand

A portable WebAssembly sandbox that gives LLMs access to a POSIX shell, 45+ coreutils, and a Python runtime — no containers, no kernel, no hardware emulation.

**[Try it in your browser](https://sunnymar.github.io/wasmsand/)**

LLMs are trained on enormous amounts of shell and Python usage. Rather than inventing a new API for code execution, wasmsand speaks the language they already know: bash, coreutils, and Python 3.

## What it does

- **Shell execution** — pipes, redirects, variables, globbing, control flow (`if`/`for`/`while`), command substitution, subshells
- **45+ coreutils** — cat, grep, sed, awk, find, sort, jq, and more, compiled to WebAssembly
- **Python 3** via RustPython compiled to WASI — standard library available
- **In-memory virtual filesystem** — POSIX semantics with inodes, file descriptors, and pipes
- **Virtual `/dev` and `/proc`** — `/dev/null`, `/dev/zero`, `/dev/random`, `/proc/uptime`, `/proc/cpuinfo`, and more
- **Package manager** — install WASI binaries into the sandbox at runtime with `pkg install`
- **State persistence** — export/import full sandbox state (files + env) for long-running agent workflows
- **Command history** — `history list` and `history clear` for agent session tracking
- **Runs everywhere** — same code works server-side ([Bun](https://bun.sh) or Node.js) and in the browser

## Install

**TypeScript (npm):**

```bash
npm install @wasmsand/sandbox
```

**Python (PyPI):**

```bash
pip install wasmsand
```

The Python wheel is self-contained — it bundles the Bun runtime, the RPC server, and all WASM binaries. No extra dependencies needed.

## Usage

### TypeScript

```typescript
import { Sandbox } from '@wasmsand/sandbox';
import { NodeAdapter } from '@wasmsand/sandbox/node';

const sandbox = await Sandbox.create({
  adapter: new NodeAdapter(),
  wasmDir: './node_modules/@wasmsand/sandbox/wasm',
});

const result = await sandbox.run('echo hello world | wc -w');
console.log(result.stdout); // "3\n"

sandbox.destroy();
```

In the browser, use `BrowserAdapter` instead:

```typescript
import { Sandbox } from '@wasmsand/sandbox';
import { BrowserAdapter } from '@wasmsand/sandbox/browser';

const sandbox = await Sandbox.create({
  adapter: new BrowserAdapter(),
  wasmDir: '/wasm',
});
```

### Python

```python
from wasmsand import Sandbox

with Sandbox() as sb:
    result = sb.commands.run("ls -la /home/user")
    print(result.stdout)

    sb.files.write("/home/user/data.csv", b"name,score\nalice,95\nbob,87\n")
    result = sb.commands.run("cat /home/user/data.csv | sort -t, -k2 -rn")
    print(result.stdout)
```

## Available tools

| Category | Tools |
|----------|-------|
| File operations | cat, cp, mv, rm, mkdir, rmdir, ls, touch, ln, chmod |
| Text processing | grep, sort, uniq, wc, head, tail, cut, tr, tac, tee |
| Advanced text | sed, awk, diff |
| Search | find, xargs |
| Data formats | jq |
| Path utilities | basename, dirname, readlink, realpath |
| Environment | env, printenv, export, uname, whoami, id |
| Scripting | echo, printf, test, expr, seq, sleep, yes, true, false, mktemp |
| Python | python3 (RustPython, standard library) |

## Shell features

Pipes (`|`), redirects (`>`, `>>`, `<`, `2>&1`), boolean operators (`&&`, `||`), semicolons, single/double quotes, escape sequences, variable expansion (`$VAR`, `${VAR:-default}`), command substitution (`$(...)`), globbing (`*`, `?`, `**/*.txt`), subshells (`(...)`), and control flow (`if`/`elif`/`else`/`fi`, `for`/`do`/`done`, `while`/`do`/`done`).

## Virtual filesystems

The sandbox provides virtual `/dev` and `/proc` filesystems:

| Path | Behavior |
|------|----------|
| `/dev/null` | Discards writes, returns empty on read |
| `/dev/zero` | Returns zero-filled bytes |
| `/dev/random`, `/dev/urandom` | Cryptographically random bytes |
| `/proc/uptime` | Seconds since sandbox creation |
| `/proc/version` | Sandbox version string |
| `/proc/cpuinfo` | Processor information |
| `/proc/meminfo` | Memory information |

These work transparently with coreutils: `cat /dev/null`, `head -c 16 /dev/random | xxd`, `cat /proc/uptime`.

## Package manager

Install WASI binaries into the sandbox at runtime. Packages run inside the WASM sandbox with the same security boundary as built-in coreutils.

```typescript
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  security: {
    packagePolicy: {
      enabled: true,
      allowedHosts: ['trusted-registry.example.com'],
      maxPackageBytes: 5 * 1024 * 1024,
      maxInstalledPackages: 50,
    },
  },
});

await sandbox.run('pkg install https://trusted-registry.example.com/mytool.wasm');
await sandbox.run('mytool --help');  // immediately available
await sandbox.run('pkg list');        // show installed packages
await sandbox.run('pkg remove mytool');
```

The package manager is disabled by default. Enable it with `packagePolicy.enabled: true`.

## State persistence

Export and import the full sandbox state (filesystem + environment variables) as an opaque binary blob. Useful for long-running agent workflows that need to survive restarts.

**TypeScript:**

```typescript
// Save state
const blob = sandbox.exportState();

// Later, restore into a new sandbox
const sandbox2 = await Sandbox.create({ wasmDir: './wasm' });
sandbox2.importState(blob);
```

**Python:**

```python
# Save state
blob = sb.export_state()

# Later, restore
sb2 = Sandbox()
sb2.import_state(blob)
```

Virtual filesystems (`/dev`, `/proc`) are excluded from exports — they are regenerated automatically.

## Command history

The shell tracks command history for agent session introspection:

```bash
echo hello
echo world
history list    # shows all executed commands with indices
history clear   # resets history
```

Also available via the RPC API: `shell.history.list`, `shell.history.clear`.

## Architecture

```
Host Application / LLM
        │
        ▼
TypeScript Orchestrator ─── VFS (in-memory) ── Process Manager
        │
        ▼
   WASI P1 Host
   ┌────┴────┐
   │         │
Shell    Coreutils    Python
(Rust)   (Rust)      (RustPython)
   └────┬────┘
   WebAssembly
```

The shell parser is written in Rust and compiled to WASI. It emits a JSON AST that the TypeScript orchestrator executes, managing the virtual filesystem, process lifecycle, and I/O plumbing. Coreutils are individual Rust binaries compiled to WASM. Python runs via RustPython (also compiled to WASI) sharing the same VFS.

## Limitations

- **No networking by default.** Network access is off and must be explicitly enabled with a domain allowlist.
- **In-memory filesystem.** The VFS is in-memory (256 MB default, configurable). Use `exportState`/`importState` to persist across sessions.
- **Sequential pipeline execution.** Pipeline stages run one at a time with buffered I/O rather than in parallel. This is correct but slower than a real shell for streaming workloads.
- **Bash subset, not full POSIX.** No function definitions, aliases, `eval`, job control, or advanced file descriptor manipulation (e.g., `>&3`).
- **WASI packages only.** The `pkg` command installs WASI binaries. There is no `pip install` at runtime — only the Python standard library is available.
- **Security hardening is in progress.** Timeout enforcement, capability policies, output truncation, and session isolation are defined but not all fully implemented yet. Do not use for adversarial untrusted input in production without reviewing the [security spec](docs/plans/2026-02-23-security-mvp-spec.md).

## Development

Requires [Bun](https://bun.sh) (runtime, bundler, and test runner) and a Rust toolchain with the `wasm32-wasip1` target.

```bash
# Install dependencies
bun install

# Build everything (Rust WASM + TypeScript)
make build

# Run tests (338 tests)
make test

# Package for npm
make npm

# Package Python wheel (for current platform)
make wheel
```

## Related projects

wasmsand occupies a specific point in the design space: a lightweight WASM-based sandbox with real POSIX semantics, designed for LLM code execution on both server and browser. Here's how it compares to related projects.

### RustPython

[RustPython](https://github.com/RustPython/RustPython) (21k+ stars) is a Python 3 interpreter written in Rust. wasmsand uses RustPython compiled to WASI as its Python runtime — it runs as a standard WASI binary through the same process manager as coreutils, sharing the virtual filesystem and I/O plumbing with no special-case integration.

RustPython gives wasmsand near-complete Python 3 coverage (classes, generators, decorators, context managers, and stdlib modules like `json`, `re`, `math`, `collections`) in a single ~12MB WASM binary. The tradeoff is startup latency (hundreds of milliseconds for the first invocation, cached after) and no C extension support — `numpy`, `pandas`, and anything requiring native code won't work. For LLM use cases this is rarely a limitation since agents primarily use the standard library.

### Monty (Pydantic)

[Monty](https://github.com/pydantic/monty) (5.7k stars) is a minimal Python interpreter from the Pydantic team, explicitly targeting LLM-generated code. It prioritizes microsecond startup (~0.06ms), tiny footprint, and strict isolation via a controlled external-function model — filesystem, network, and environment access only happen through developer-approved callbacks.

wasmsand initially used Monty but switched to RustPython because Monty's Python subset was too restrictive for practical agent use: no classes, limited stdlib (only `sys`, `typing`, `asyncio`), and no modules like `json` or `re` that LLMs reach for constantly. Monty is the right choice if you need sub-millisecond startup and can constrain your agent to simple procedural scripts. wasmsand chose broader Python coverage at the cost of higher startup latency, since commands are typically batched and the WASM module is cached after first load.

Monty is still early and actively developing — classes and `json` support are on their roadmap. It's worth watching.

### lifo

[lifo](https://github.com/lifo-sh/lifo) is a browser-native Unix environment — 60+ commands, a bash-like shell, a virtual filesystem with IndexedDB persistence, and Node.js compatibility shims. It positions itself as [zero-cost AI sandboxing](https://lifo.sh/): no server, no VM, instant boot.

The key architectural difference: lifo implements commands in JavaScript against browser APIs, while wasmsand compiles real Rust coreutils and a Rust shell parser to WebAssembly running under WASI. This has significant implications:

| | wasmsand | lifo |
|---|---|---|
| **Execution model** | WASM binaries under WASI host | JS functions against browser APIs |
| **Process isolation** | Each command is an isolated WASM instance with its own linear memory | Shared JS thread, no memory isolation between commands |
| **Security boundary** | WASM sandbox + WASI syscall interception + configurable policies (tool allowlist, output limits, memory limits, hard-kill) | Browser sandbox only — "not for high-security sandboxing" per their docs |
| **Server-side** | Yes (Bun/Node.js with Worker-based hard-kill) | Browser-only |
| **Python** | Full Python 3 via RustPython WASI | None |
| **Persistence** | In-memory VFS with snapshot/restore/fork + export/import | IndexedDB-backed VFS |
| **Networking** | Opt-in with domain allowlist, sync bridge for WASI | Browser fetch (no policy layer) |

lifo is a good fit for lightweight browser-side demos and prototyping where the browser sandbox is sufficient. wasmsand is designed for the harder problem: running untrusted LLM-generated code in production on both server and browser, where you need real process isolation, configurable security policies, and hard-kill guarantees.

wasmsand has adopted several ideas from lifo's design — a package manager concept, persistence modes, and shell ergonomics for long autonomous runs — adapted to work within the WASM security boundary rather than as bare JS.

## Origin

This project was written entirely by Claude (Anthropic's AI assistant) as an experiment in AI-driven software engineering. Every line of code — the Rust shell parser, the TypeScript orchestrator, the Python SDK, the WASM coreutils integration, and the build tooling — was generated by Claude across a series of collaborative sessions with a human directing the design.

## License

[BSD 3-Clause](LICENSE)
