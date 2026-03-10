# Codepod Development

## Environment Setup

Deno is the primary runtime. It may not be on PATH — source the init script:

```bash
source scripts/dev-init.sh
```

This adds `~/.deno/bin` and `~/.cargo/bin` to PATH and verifies tools are available.

## Key Commands

```bash
# Type-check
deno check packages/mcp-server/src/index.ts

# Run all unit tests (pre-push hook runs these)
deno test -A --no-check packages/orchestrator/src/**/*.test.ts packages/sdk-server/src/*.test.ts

# Run Python SDK tests
cd packages/python-sdk && pip install -e . && pytest

# Build MCP server binary
bash scripts/build-mcp.sh

# Build Python wheel
bash scripts/build-wheel.sh
```

## Architecture

- **`packages/orchestrator/`** — Core sandbox: VFS, shell executor, process manager, networking
- **`packages/shell-exec/`** — Rust POSIX shell compiled to WASM (`codepod-shell-exec.wasm`)
- **`packages/coreutils/`** — Rust coreutils compiled to WASM
- **`packages/mcp-server/`** — MCP server exposing sandboxes via Model Context Protocol
- **`packages/sdk-server/`** — JSON-RPC server for Python SDK
- **`packages/python-sdk/`** — Python client (`codepod` package)

## WASM Binaries

- `codepod-shell-exec.wasm` (1.3MB) — Full shell executor with `__alloc`/`__dealloc`/`__run_command` exports.
- `packages/shell/` is the parser library (Rust crate `codepod_shell`) used by `codepod-shell-exec`. It has no standalone binary.

Test fixtures live at `packages/orchestrator/src/platform/__tests__/fixtures/`.

## MCP Server

Multi-sandbox server with lifecycle management. Tools:
- `create_sandbox` / `destroy_sandbox` / `list_sandboxes` — sandbox lifecycle
- `export_state` / `import_state` — serialize/restore sandbox state as binary blobs
- `run_command` / `read_file` / `write_file` / `list_directory` — per-sandbox operations
- `snapshot` / `restore` — in-memory CoW snapshots (fast, ephemeral)

Config: `.mcp.json` at repo root. Build: `bash scripts/build-mcp.sh` → `dist/codepod-mcp`.

## Conventions

- Runtime: Deno (not Node). Deno supports JSPI (2.4.0+).
- `Sandbox.sessionId` is a `crypto.randomUUID()` — use it as the canonical sandbox identifier.
- `private` → `readonly` for fields that need external read access (no getters).
- Pre-commit hook runs: Rust fmt, clippy, TypeScript type-check.
- Pre-push hook runs: all unit tests.
