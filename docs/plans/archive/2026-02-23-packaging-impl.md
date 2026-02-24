# Packaging & Distribution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create distributable packages (PyPI wheel + npm tarball) and migrate dev tooling from Node.js/tsx to Bun.

**Architecture:** Five tasks: (1) update root configs for Bun, (2) migrate 14 test files from vitest to bun:test, (3) restructure orchestrator as publishable npm package, (4) update Python SDK for Bun + bundled resource discovery, (5) create Makefile build scripts.

**Tech Stack:** Bun (runtime + test runner + bundler), tsup (library builds), setuptools (Python wheel), cargo (Rust/WASM)

---

## Context

**Monorepo layout:**
```
wasmsand/
├── packages/orchestrator/   → becomes @wasmsand/sandbox (npm)
├── packages/sdk-server/     → internal, bundled into Python wheel
├── packages/python-sdk/     → becomes wasmsand (PyPI)
├── packages/web/            → unchanged (private)
├── packages/coreutils/      → Rust → WASM
├── packages/shell/          → Rust → WASM
└── packages/python/         → Rust → WASM
```

**WASM binaries** live in test fixtures:
- `packages/orchestrator/src/platform/__tests__/fixtures/*.wasm` (44 coreutils + python3)
- `packages/orchestrator/src/shell/__tests__/fixtures/wasmsand-shell.wasm`

**14 test files** all import from `vitest`. Only `packages/sdk-server/src/dispatcher.test.ts` uses `vi.fn()` mocking — the other 13 use only `describe/it/expect/beforeEach/afterEach`.

---

### Task 1: Bun Setup and Config Migration

**Files:**
- Modify: `package.json` (root)
- Modify: `packages/orchestrator/package.json`
- Modify: `packages/sdk-server/package.json`

**Step 1: Verify Bun is installed**

Run: `bun --version`
Expected: A version string like `1.x.x`. If not installed, run `curl -fsSL https://bun.sh/install | bash` first.

**Step 2: Update root package.json**

Replace the contents of `package.json` with:

```json
{
  "name": "wasmsand",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "test": "bun test",
    "build": "bun run build:rust && bun run build:ts",
    "build:ts": "tsup --config packages/orchestrator/tsup.config.ts",
    "build:rust": "cargo build --target wasm32-wasip1 --release"
  }
}
```

Key changes: removed `tsx` devDependency, `vitest run` → `bun test`.

**Step 3: Update orchestrator package.json**

Replace the contents of `packages/orchestrator/package.json` with:

```json
{
  "name": "@wasmsand/orchestrator",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "test": "bun test",
    "build": "tsup"
  },
  "devDependencies": {
    "tsup": "^8.0",
    "typescript": "^5.7"
  },
  "dependencies": {}
}
```

Key changes: removed `vitest` devDependency, `vitest run` → `bun test`.

**Step 4: Update sdk-server package.json**

Replace the contents of `packages/sdk-server/package.json` with:

```json
{
  "name": "@wasmsand/sdk-server",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/server.js",
  "bin": {
    "wasmsand-server": "dist/server.js"
  },
  "scripts": {
    "test": "bun test",
    "build": "tsup src/server.ts --format esm --dts"
  },
  "dependencies": {
    "@wasmsand/orchestrator": "*"
  },
  "devDependencies": {
    "tsup": "^8.0",
    "typescript": "^5.7"
  }
}
```

Key changes: removed `vitest` and `tsx` devDependencies, `vitest run` → `bun test`.

**Step 5: Install dependencies**

Run: `cd /Users/sunny/work/wasmsand && bun install`
Expected: Clean install with no errors. This regenerates the lockfile for Bun.

**Step 6: Commit**

```bash
git add package.json packages/orchestrator/package.json packages/sdk-server/package.json bun.lockb
git commit -m "chore: migrate to Bun, remove vitest and tsx dependencies"
```

---

### Task 2: Migrate Test Files from vitest to bun:test

**Files:**
- Modify: all 14 `.test.ts` files listed below
- Modify: `packages/python-sdk/tests/conftest.py`

There are two categories:

**Category A (13 files — simple import swap):** These only import `describe`, `it`, `expect`, `beforeEach`, and/or `afterEach` from vitest. The fix is a one-line import change.

```
packages/orchestrator/src/__tests__/sandbox.test.ts
packages/orchestrator/src/platform/__tests__/node-adapter.test.ts
packages/orchestrator/src/process/__tests__/pipeline.test.ts
packages/orchestrator/src/process/__tests__/process.test.ts
packages/orchestrator/src/python/__tests__/python-runner.test.ts
packages/orchestrator/src/python/__tests__/python-shell-integration.test.ts
packages/orchestrator/src/shell/__tests__/coreutils.test.ts
packages/orchestrator/src/shell/__tests__/shell-runner.test.ts
packages/orchestrator/src/vfs/__tests__/fd.test.ts
packages/orchestrator/src/vfs/__tests__/snapshot.test.ts
packages/orchestrator/src/vfs/__tests__/vfs.test.ts
packages/orchestrator/src/wasi/__tests__/wasi-host.test.ts
packages/sdk-server/src/server.test.ts
```

**Category B (1 file — mock migration):**

```
packages/sdk-server/src/dispatcher.test.ts
```

**Step 1: Migrate Category A files**

For each of the 13 files, change the vitest import to bun:test. The named imports stay the same — `describe`, `it`, `expect`, `beforeEach`, `afterEach` are all available from `bun:test`.

Example — before:
```typescript
import { describe, it, expect } from 'vitest';
```

After:
```typescript
import { describe, it, expect } from 'bun:test';
```

For files that also import `beforeEach` or `afterEach`, include those in the bun:test import too.

Note: some tests pass a timeout as a second argument to `it()`, e.g. `it('name', async () => { ... }, 30_000)`. Bun:test supports this syntax.

**Step 2: Migrate server.test.ts spawn call**

In `packages/sdk-server/src/server.test.ts`, in addition to the import change, update the `startServer()` function to spawn Bun instead of Node:

Before (line 11):
```typescript
const proc = spawn('node', ['--import', 'tsx', SERVER_PATH], {
```

After:
```typescript
const proc = spawn('bun', [SERVER_PATH], {
```

**Step 3: Migrate dispatcher.test.ts (Category B)**

This file uses `vi` from vitest for mocking. In bun:test, mock functions are created with `mock()` from `bun:test`.

Change the import line (line 1) from:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
```
To:
```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test';
```

Then replace all `vi.fn(...)` calls with `mock(...)`. The `mock()` function from bun:test returns a jest-compatible mock with `.mock.calls`, `.mock.results`, `.mockImplementation()`, `.mockRejectedValue()`, etc.

The `createMockSandbox()` function (lines 5-33) becomes:
```typescript
function createMockSandbox(): SandboxLike {
  return {
    run: mock(async (_cmd: string) => ({
      exitCode: 0,
      stdout: 'hello\n',
      stderr: '',
      executionTimeMs: 5,
    })),
    readFile: mock((_path: string) => new TextEncoder().encode('file content')),
    writeFile: mock((_path: string, _data: Uint8Array) => {}),
    readDir: mock((_path: string) => [
      { name: 'a.txt', type: 'file' as const },
      { name: 'sub', type: 'dir' as const },
    ]),
    mkdir: mock((_path: string) => {}),
    stat: mock((path: string) => ({
      type: 'file' as const,
      size: 12,
      permissions: 0o644,
      mtime: new Date('2025-01-01'),
      ctime: new Date('2025-01-01'),
      atime: new Date('2025-01-01'),
    })),
    rm: mock((_path: string) => {}),
    setEnv: mock((_name: string, _value: string) => {}),
    getEnv: mock((name: string) => (name === 'FOO' ? 'bar' : undefined)),
    destroy: mock(() => {}),
  };
}
```

For the error handling tests that use `.mockImplementation()` and `.mockRejectedValue()` (lines 254 and 267), update the type cast:

Before:
```typescript
(sandbox.readFile as ReturnType<typeof vi.fn>).mockImplementation(() => {
  throw err;
});
```

After:
```typescript
(sandbox.readFile as ReturnType<typeof mock>).mockImplementation(() => {
  throw err;
});
```

Before:
```typescript
(sandbox.run as ReturnType<typeof vi.fn>).mockRejectedValue(
  new Error('something went wrong'),
);
```

After:
```typescript
(sandbox.run as ReturnType<typeof mock>).mockRejectedValue(
  new Error('something went wrong'),
);
```

**Step 4: Update Python conftest.py**

Change `packages/python-sdk/tests/conftest.py` to check for Bun instead of Node:

```python
import shutil


def pytest_collection_modifyitems(config, items):
    """Skip all tests if Bun is not available."""
    if shutil.which("bun") is None:
        import pytest

        skip = pytest.mark.skip(reason="Bun not found on PATH")
        for item in items:
            item.add_marker(skip)
```

**Step 5: Run all TypeScript tests**

Run: `cd /Users/sunny/work/wasmsand && bun test`
Expected: All tests pass (338 orchestrator + 27 sdk-server = 365 tests).

If any tests fail, read the error output carefully. Common issues:
- `toMatchObject` works the same in bun:test, no changes needed
- `rejects.toMatchObject` works the same
- `toHaveBeenCalledWith` works the same on mock functions

**Step 6: Run Python tests**

Run: `cd /Users/sunny/work/wasmsand/packages/python-sdk && python -m pytest tests/ -v`
Expected: All 27 tests pass. The Python SDK still uses dev-mode paths — this is tested in Task 4.

Note: Python tests will fail if the Python SDK's `sandbox.py` still references `node`. That update happens in Task 4. For now, skip this step if Python tests fail due to node/bun — they'll be fixed in Task 4.

**Step 7: Commit**

```bash
git add -A packages/orchestrator/src packages/sdk-server/src packages/python-sdk/tests
git commit -m "chore: migrate all test files from vitest to bun:test"
```

---

### Task 3: Create @wasmsand/sandbox npm Package

**Files:**
- Modify: `packages/orchestrator/package.json`
- Modify: `packages/orchestrator/src/index.ts`
- Create: `packages/orchestrator/tsup.config.ts`
- Modify: `packages/sdk-server/package.json`
- Modify: `packages/sdk-server/src/server.ts`

**Step 1: Rename package and add exports map**

Update `packages/orchestrator/package.json`:

```json
{
  "name": "@wasmsand/sandbox",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./node": {
      "types": "./dist/node-adapter.d.ts",
      "default": "./dist/node-adapter.js"
    },
    "./browser": {
      "types": "./dist/browser-adapter.d.ts",
      "default": "./dist/browser-adapter.js"
    }
  },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist",
    "wasm"
  ],
  "scripts": {
    "test": "bun test",
    "build": "tsup"
  },
  "devDependencies": {
    "tsup": "^8.0",
    "typescript": "^5.7"
  },
  "dependencies": {}
}
```

Key additions: `exports` map with three entry points, `files` array includes `wasm/` directory.

**Step 2: Create separate entry point files for subpath exports**

The current `src/index.ts` already exports everything except NodeAdapter. We need the node and browser adapter entry points to be separate files that tsup can build.

Create `packages/orchestrator/src/node-adapter.ts`:

```typescript
export { NodeAdapter } from './platform/node-adapter.js';
export type { PlatformAdapter } from './platform/adapter.js';
```

Create `packages/orchestrator/src/browser-adapter.ts`:

```typescript
export { BrowserAdapter } from './platform/browser-adapter.js';
export type { PlatformAdapter } from './platform/adapter.js';
```

**Step 3: Create tsup.config.ts**

Create `packages/orchestrator/tsup.config.ts`:

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'node-adapter': 'src/node-adapter.ts',
    'browser-adapter': 'src/browser-adapter.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: true,
  clean: true,
  target: 'es2022',
});
```

**Step 4: Update sdk-server references**

In `packages/sdk-server/package.json`, change the dependency:

```json
"dependencies": {
  "@wasmsand/sandbox": "*"
}
```

In `packages/sdk-server/src/server.ts`, update the imports (lines 12-13):

Before:
```typescript
import { Sandbox } from '@wasmsand/orchestrator';
import { NodeAdapter } from '@wasmsand/orchestrator/dist/platform/node-adapter.js';
```

After:
```typescript
import { Sandbox } from '@wasmsand/sandbox';
import { NodeAdapter } from '@wasmsand/sandbox/node';
```

**Step 5: Update root build:ts script**

In root `package.json`, update the build:ts script:

```json
"build:ts": "cd packages/orchestrator && tsup"
```

**Step 6: Install deps and verify build**

Run: `cd /Users/sunny/work/wasmsand && bun install`
Expected: Clean install.

Run: `cd /Users/sunny/work/wasmsand/packages/orchestrator && bunx tsup`
Expected: Build produces `dist/index.js`, `dist/index.d.ts`, `dist/node-adapter.js`, `dist/node-adapter.d.ts`, `dist/browser-adapter.js`, `dist/browser-adapter.d.ts`.

**Step 7: Run tests to verify nothing broke**

Run: `cd /Users/sunny/work/wasmsand && bun test`
Expected: All tests pass.

**Step 8: Commit**

```bash
git add packages/orchestrator packages/sdk-server package.json bun.lockb
git commit -m "feat: restructure orchestrator as @wasmsand/sandbox npm package"
```

---

### Task 4: Update Python SDK for Bun + Bundled Resources

**Files:**
- Modify: `packages/python-sdk/src/wasmsand/sandbox.py`
- Modify: `packages/python-sdk/src/wasmsand/_rpc.py`
- Modify: `packages/python-sdk/pyproject.toml`

**Step 1: Update sandbox.py for dual-mode resource discovery**

Replace `packages/python-sdk/src/wasmsand/sandbox.py` with:

```python
import os
import shutil
from wasmsand._rpc import RpcClient
from wasmsand.commands import Commands
from wasmsand.files import Files

_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
_BUNDLED_DIR = os.path.join(_PKG_DIR, "_bundled")


def _is_bundled() -> bool:
    """Check if we're running from an installed wheel with bundled assets."""
    return os.path.isdir(_BUNDLED_DIR)


def _bundled_paths() -> tuple[str, str, str, str]:
    """Return (runtime, server_script, wasm_dir, shell_wasm) for installed mode."""
    runtime = os.path.join(_BUNDLED_DIR, "bun")
    server = os.path.join(_BUNDLED_DIR, "server.js")
    wasm_dir = os.path.join(_BUNDLED_DIR, "wasm")
    shell_wasm = os.path.join(wasm_dir, "wasmsand-shell.wasm")
    return runtime, server, wasm_dir, shell_wasm


def _dev_paths() -> tuple[str, str, str, str]:
    """Return (runtime, server_script, wasm_dir, shell_wasm) for dev mode."""
    runtime_path = shutil.which("bun")
    if runtime_path is None:
        raise RuntimeError("Bun not found on PATH (required for dev mode)")

    repo_root = os.path.abspath(os.path.join(_PKG_DIR, "..", "..", "..", ".."))
    server = os.path.join(repo_root, "packages", "sdk-server", "src", "server.ts")
    wasm_dir = os.path.join(
        repo_root, "packages", "orchestrator", "src", "platform", "__tests__", "fixtures"
    )
    shell_wasm = os.path.join(
        repo_root, "packages", "orchestrator", "src", "shell", "__tests__", "fixtures",
        "wasmsand-shell.wasm",
    )
    return runtime_path, server, wasm_dir, shell_wasm


class Sandbox:
    def __init__(self, *, timeout_ms: int = 30_000, fs_limit_bytes: int = 256 * 1024 * 1024):
        if _is_bundled():
            runtime, server, wasm_dir, shell_wasm = _bundled_paths()
        else:
            runtime, server, wasm_dir, shell_wasm = _dev_paths()

        self._client = RpcClient(runtime, server)
        self._client.start()

        self._client.call("create", {
            "wasmDir": wasm_dir,
            "shellWasmPath": shell_wasm,
            "timeoutMs": timeout_ms,
            "fsLimitBytes": fs_limit_bytes,
        })

        self.commands = Commands(self._client)
        self.files = Files(self._client)

    def kill(self) -> None:
        try:
            self._client.call("kill", {})
        except Exception:
            pass
        self._client.stop()

    def __enter__(self) -> "Sandbox":
        return self

    def __exit__(self, *exc) -> None:
        self.kill()
```

Key changes:
- Dual-mode: `_is_bundled()` checks for `_bundled/` directory
- Bundled mode: uses embedded Bun binary and pre-built server.js
- Dev mode: finds `bun` on PATH, uses repo-relative paths to server.ts
- No more `node_args=["--import", "tsx"]` — Bun handles TypeScript natively

**Step 2: Update _rpc.py to remove node_args**

In `packages/python-sdk/src/wasmsand/_rpc.py`, simplify the constructor since Bun doesn't need extra args:

```python
import json
import subprocess
from typing import Any


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class RpcClient:
    def __init__(self, runtime_path: str, server_script: str):
        self._runtime_path = runtime_path
        self._server_script = server_script
        self._proc: subprocess.Popen | None = None
        self._next_id = 1

    def start(self) -> None:
        self._proc = subprocess.Popen(
            [self._runtime_path, self._server_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def call(self, method: str, params: dict | None = None) -> Any:
        if self._proc is None or self._proc.stdin is None or self._proc.stdout is None:
            raise RuntimeError("RPC client not started")
        req_id = self._next_id
        self._next_id += 1
        request = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}}
        line = json.dumps(request) + "\n"
        self._proc.stdin.write(line.encode())
        self._proc.stdin.flush()
        resp_line = self._proc.stdout.readline()
        if not resp_line:
            raise RuntimeError("Server closed connection")
        resp = json.loads(resp_line)
        if "error" in resp:
            raise RpcError(resp["error"]["code"], resp["error"]["message"])
        return resp["result"]

    def stop(self) -> None:
        if self._proc is not None:
            proc, self._proc = self._proc, None
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
```

Key changes: removed `node_args` parameter, command is now `[runtime_path, server_script]` (2 args instead of 3+).

**Step 3: Update pyproject.toml for package_data**

Replace `packages/python-sdk/pyproject.toml` with:

```toml
[project]
name = "wasmsand"
version = "0.0.1"
description = "WASM sandbox for AI agents"
requires-python = ">=3.10"

[project.optional-dependencies]
dev = ["pytest>=7.0"]

[build-system]
requires = ["setuptools>=68.0"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]

[tool.setuptools.package-data]
wasmsand = ["_bundled/**/*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

Key addition: `package-data` entry tells setuptools to include everything under `_bundled/` when building the wheel.

**Step 4: Update Python tests that reference RpcClient constructor**

Check `packages/python-sdk/tests/test_rpc.py` for any tests that pass `node_args` to `RpcClient`. Update them to use the new 2-arg constructor:

Before:
```python
RpcClient(node_path, server_script, node_args=["--import", "tsx"])
```

After:
```python
RpcClient(runtime_path, server_script)
```

**Step 5: Run Python tests in dev mode**

Run: `cd /Users/sunny/work/wasmsand/packages/python-sdk && python -m pytest tests/ -v`
Expected: All 27 tests pass. Dev mode uses `bun` from PATH + repo-relative server.ts.

**Step 6: Run TypeScript tests to verify nothing broke**

Run: `cd /Users/sunny/work/wasmsand && bun test`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add packages/python-sdk
git commit -m "feat(python-sdk): update for Bun runtime and bundled resource discovery"
```

---

### Task 5: Build Scripts and E2E Verification

**Files:**
- Create: `Makefile`
- Create: `scripts/build-wheel.sh`
- Create: `scripts/copy-wasm.sh`

**Step 1: Create WASM copy script**

Create `scripts/copy-wasm.sh`:

```bash
#!/bin/bash
# Copy WASM binaries from fixture directories to a target directory.
# Usage: scripts/copy-wasm.sh <target-dir>
set -euo pipefail

TARGET="${1:?Usage: copy-wasm.sh <target-dir>}"
FIXTURES="packages/orchestrator/src/platform/__tests__/fixtures"
SHELL_FIXTURES="packages/orchestrator/src/shell/__tests__/fixtures"

mkdir -p "$TARGET"

# Shell parser
cp "$SHELL_FIXTURES/wasmsand-shell.wasm" "$TARGET/"

# Python
cp "$FIXTURES/python3.wasm" "$TARGET/"

# Coreutils
for tool in cat echo head tail wc sort uniq grep ls mkdir rm cp mv touch tee tr cut \
    basename dirname env printf find sed awk jq uname whoami id printenv yes rmdir \
    sleep seq ln readlink realpath mktemp tac xargs expr diff; do
  cp "$FIXTURES/${tool}.wasm" "$TARGET/"
done

# true/false have special filenames
cp "$FIXTURES/true-cmd.wasm" "$TARGET/"
cp "$FIXTURES/false-cmd.wasm" "$TARGET/"

echo "Copied $(ls "$TARGET"/*.wasm | wc -l | tr -d ' ') WASM binaries to $TARGET/"
```

Run: `chmod +x scripts/copy-wasm.sh`

**Step 2: Create wheel build script**

Create `scripts/build-wheel.sh`:

```bash
#!/bin/bash
# Build a platform-specific Python wheel with bundled Bun and WASM binaries.
# Usage: scripts/build-wheel.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG="$ROOT/packages/python-sdk"
BUNDLED="$PKG/src/wasmsand/_bundled"

# Detect platform for Bun download
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux)  BUN_OS="linux" ;;
  darwin) BUN_OS="darwin" ;;
  *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) BUN_ARCH="x64" ;;
  aarch64|arm64) BUN_ARCH="aarch64" ;;
  *)             echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

BUN_ZIP="bun-${BUN_OS}-${BUN_ARCH}.zip"
BUN_VERSION="1.2.4"
BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ZIP}"

echo "=== Building server.js bundle ==="
bun build "$ROOT/packages/sdk-server/src/server.ts" \
  --bundle \
  --target=bun \
  --outfile="$BUNDLED/server.js"

echo "=== Copying WASM binaries ==="
"$SCRIPT_DIR/copy-wasm.sh" "$BUNDLED/wasm"

echo "=== Downloading Bun ${BUN_VERSION} for ${BUN_OS}-${BUN_ARCH} ==="
TMPDIR="$(mktemp -d)"
curl -fsSL "$BUN_URL" -o "$TMPDIR/$BUN_ZIP"
unzip -q "$TMPDIR/$BUN_ZIP" -d "$TMPDIR"
cp "$TMPDIR/bun-${BUN_OS}-${BUN_ARCH}/bun" "$BUNDLED/bun"
chmod +x "$BUNDLED/bun"
rm -rf "$TMPDIR"

echo "=== Building wheel ==="
cd "$PKG"
python -m build --wheel

echo "=== Done ==="
ls -lh "$PKG/dist/"*.whl
```

Run: `chmod +x scripts/build-wheel.sh`

Note: this script requires `python -m build` (`pip install build`).

**Step 3: Create Makefile**

Create `Makefile` at the repo root:

```makefile
.PHONY: test build build-rust build-ts npm wheel clean

# Development
test:
	bun test

build: build-rust build-ts

build-rust:
	cargo build --target wasm32-wasip1 --release

build-ts:
	cd packages/orchestrator && bunx tsup

# npm package
npm: build-ts
	scripts/copy-wasm.sh packages/orchestrator/wasm
	cd packages/orchestrator && npm pack

# Python wheel (for current platform)
wheel:
	scripts/build-wheel.sh

# Cleanup
clean:
	rm -rf packages/orchestrator/dist packages/orchestrator/wasm
	rm -rf packages/python-sdk/src/wasmsand/_bundled
	rm -rf packages/python-sdk/dist packages/python-sdk/build
	rm -f packages/orchestrator/*.tgz
```

**Step 4: Add _bundled to .gitignore**

Append to `.gitignore` (create if it doesn't exist):

```
packages/python-sdk/src/wasmsand/_bundled/
packages/orchestrator/wasm/
```

**Step 5: Test npm package build**

Run: `cd /Users/sunny/work/wasmsand && make npm`
Expected: Produces `packages/orchestrator/wasmsand-sandbox-0.0.1.tgz` with `dist/` and `wasm/` directories.

Verify contents: `tar tzf packages/orchestrator/*.tgz | head -20`
Expected: Should list files under `package/dist/` and `package/wasm/`.

**Step 6: Test wheel build**

Run: `cd /Users/sunny/work/wasmsand && make wheel`
Expected: Produces `packages/python-sdk/dist/wasmsand-0.0.1-*.whl`.

Verify contents: `unzip -l packages/python-sdk/dist/*.whl | head -20`
Expected: Should list files under `wasmsand/` and `wasmsand/_bundled/`.

**Step 7: E2E — install wheel in a venv and test**

```bash
cd /tmp
python -m venv test-wasmsand
source test-wasmsand/bin/activate
pip install /Users/sunny/work/wasmsand/packages/python-sdk/dist/wasmsand-0.0.1-*.whl
python -c "
from wasmsand import Sandbox
with Sandbox() as sb:
    result = sb.commands.run('echo hello from wheel')
    print(result.stdout)
    assert 'hello from wheel' in result.stdout
    print('SUCCESS: wheel works')
"
deactivate
rm -rf test-wasmsand
```

Expected: Prints "hello from wheel" and "SUCCESS: wheel works".

**Step 8: Run all tests to verify nothing is broken**

Run: `cd /Users/sunny/work/wasmsand && bun test`
Expected: All tests pass.

Run: `cd /Users/sunny/work/wasmsand/packages/python-sdk && python -m pytest tests/ -v`
Expected: All tests pass.

**Step 9: Commit**

```bash
git add Makefile scripts/ .gitignore
git commit -m "feat: add Makefile and build scripts for npm and wheel packaging"
```
