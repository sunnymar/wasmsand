# wasmsand

A portable WebAssembly sandbox that gives LLMs access to a POSIX shell, 45+ coreutils, and a Python runtime — no containers, no kernel, no hardware emulation.

LLMs are trained on enormous amounts of shell and Python usage. Rather than inventing a new API for code execution, wasmsand speaks the language they already know: bash, coreutils, and Python 3.

## What it does

- **Shell execution** — pipes, redirects, variables, globbing, control flow (`if`/`for`/`while`), command substitution, subshells
- **45+ coreutils** — cat, grep, sed, awk, find, sort, jq, and more, compiled to WebAssembly
- **Python 3** via Pyodide — standard library plus numpy, pandas, matplotlib, beautifulsoup4
- **In-memory virtual filesystem** — POSIX semantics with inodes, file descriptors, and pipes
- **Runs everywhere** — same code works in Node.js and in the browser

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
| Python | python3 (Pyodide with numpy, pandas, matplotlib, etc.) |

## Shell features

Pipes (`|`), redirects (`>`, `>>`, `<`, `2>&1`), boolean operators (`&&`, `||`), semicolons, single/double quotes, escape sequences, variable expansion (`$VAR`, `${VAR:-default}`), command substitution (`$(...)`), globbing (`*`, `?`, `**/*.txt`), subshells (`(...)`), and control flow (`if`/`elif`/`else`/`fi`, `for`/`do`/`done`, `while`/`do`/`done`).

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
(Rust)   (Rust)      (Pyodide)
   └────┬────┘
   WebAssembly
```

The shell parser is written in Rust and compiled to WASI. It emits a JSON AST that the TypeScript orchestrator executes, managing the virtual filesystem, process lifecycle, and I/O plumbing. Coreutils are individual Rust binaries compiled to WASM. Python runs via Pyodide with its filesystem proxied through the same VFS.

## Limitations

- **No networking by default.** Network access is off and must be explicitly enabled with a domain allowlist. Fine-grained URL policies are not yet implemented.
- **No persistent storage.** The VFS is in-memory and scoped to a single session. There is no snapshot/restore across sessions yet.
- **Sequential pipeline execution.** Pipeline stages run one at a time with buffered I/O rather than in parallel. This is correct but slower than a real shell for streaming workloads.
- **Bash subset, not full POSIX.** No function definitions, aliases, `eval`, job control, or advanced file descriptor manipulation (e.g., `>&3`).
- **No dynamic package installation.** Python packages are pre-bundled with Pyodide. There is no `pip install` at runtime.
- **256 MB filesystem limit** by default. Configurable, but the VFS is always in-memory.
- **Security hardening is in progress.** Timeout enforcement, capability policies, output truncation, and session isolation are defined but not all fully implemented yet. Do not use for adversarial untrusted input in production without reviewing the [security spec](docs/plans/2026-02-23-security-mvp-spec.md).

## Development

Requires [Bun](https://bun.sh) and a Rust toolchain with the `wasm32-wasip1` target.

```bash
# Build everything
make build

# Run tests
make test

# Package for npm
make npm

# Package Python wheel (for current platform)
make wheel
```

## Origin

This project was written entirely by Claude (Anthropic's AI assistant) as an experiment in AI-driven software engineering. Every line of code — the Rust shell parser, the TypeScript orchestrator, the Python SDK, the WASM coreutils integration, and the build tooling — was generated by Claude across a series of collaborative sessions with a human directing the design.

## License

[BSD 3-Clause](LICENSE)
