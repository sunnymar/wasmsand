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
deno test -A --no-check packages/kernel/src/**/*.test.ts packages/kernel/src/pool/__tests__/*.test.ts packages/sdk-server/src/*.test.ts

# Run Python SDK tests
cd packages/python-sdk && pip install -e . && pytest

# Build MCP server binary
bash scripts/build-mcp.sh

# Build Python wheel
bash scripts/build-wheel.sh
```

## Architecture

- **`packages/kernel/`** — Core sandbox kernel: VFS, process manager, host imports, networking, pool. (Renamed from `packages/orchestrator/` in the kernel/userland separation refactor — see `docs/superpowers/specs/2026-04-27-kernel-userland-separation-design.md`.)
- **`packages/shell-exec/`** — Rust POSIX shell compiled to WASM (`codepod-shell-exec.wasm`)
- **`packages/coreutils/`** — Rust coreutils compiled to WASM
- **`packages/mcp-server/`** — MCP server exposing sandboxes via Model Context Protocol
- **`packages/sdk-server/`** — JSON-RPC server for Python SDK
- **`packages/python-sdk/`** — Python client (`codepod` package)

## Backend Engines

The sandbox server ships two engines:

- **wasmtime** (default, production): `dist/codepod-server` — Rust binary using wasmtime. No Deno dependency. Build: `bash scripts/build-sdk-server.sh`
- **deno** (dev/debug): `dist/codepod-server-deno` — TypeScript server via Deno. Build: `bash scripts/build-sdk-server.sh --engine deno`

The Python SDK auto-detects the engine: uses `codepod-server` if found on PATH or adjacent to the wheel, otherwise falls back to Deno. Explicit: `Sandbox(engine='wasmtime')` or `Sandbox(engine='deno')`.

## WASM Binaries

- `codepod-shell-exec.wasm` — plain WASM32-WASI binary (for wasmtime + Deno/JSPI)
- `codepod-shell-exec-asyncify.wasm` — asyncified variant (for Safari/WebKit, built via `wasm-opt --asyncify`)
- `packages/shell/` is the parser library (Rust crate `codepod_shell`) used by `codepod-shell-exec`. It has no standalone binary.

Browser sandbox auto-selects: JSPI binary on Chromium, asyncify binary on Safari.

Test fixtures live at `packages/kernel/src/platform/__tests__/fixtures/`.

## MCP Server

Multi-sandbox server with lifecycle management. Tools:
- `create_sandbox` / `destroy_sandbox` / `list_sandboxes` — sandbox lifecycle
- `export_state` / `import_state` — serialize/restore sandbox state as binary blobs
- `run_command` / `read_file` / `write_file` / `list_directory` — per-sandbox operations
- `snapshot` / `restore` — in-memory CoW snapshots (fast, ephemeral)

Config: `.mcp.json` at repo root. Build: `bash scripts/build-mcp.sh` → `dist/codepod-mcp`.

Pool support: `--pool-min N --pool-max M` CLI args or `"pool": { "minSize": N, "maxSize": M }` in `.mcp.json`.

## SDK Server

JSON-RPC server for the Python SDK. Supports multi-sandbox management:
- `sandbox.create` / `sandbox.list` / `sandbox.remove` — create/list/remove top-level sandboxes
- `sandbox.fork` / `sandbox.destroy` — fork and destroy child sandboxes
- Pool support: pass `pool: { minSize, maxSize }` in the `create` RPC params.

## Python SDK

Multi-sandbox via `sb.sandboxes`:
- `sb.sandboxes.create(label=...)` → `SandboxRef` with `.commands` and `.files`
- `sb.sandboxes.list()` → `list[SandboxInfo]`
- `sb.sandboxes.remove(sandbox_id)` — release a sandbox

## Conventions

- Runtime: Deno (not Node). Deno supports JSPI (2.4.0+).
- `Sandbox.sessionId` is a `crypto.randomUUID()` — use it as the canonical sandbox identifier.
- `private` → `readonly` for fields that need external read access (no getters).
- Pre-commit hook runs: Rust fmt, clippy, TypeScript type-check.
- Pre-push hook runs: all unit tests.
