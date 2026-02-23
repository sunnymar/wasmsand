# Python SDK Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `wasmsand` Python SDK (PyPI package) that lets AI agents create sandboxes, run commands, pass files, and capture outputs via a JSON-RPC bridge to the existing TypeScript Sandbox.

**Architecture:** Python SDK spawns a Node.js child process running a JSON-RPC server (`packages/sdk-server/`). The server imports `Sandbox` from `@wasmsand/orchestrator` and dispatches JSON-RPC 2.0 calls over stdin/stdout (newline-delimited JSON). The Python SDK wraps these RPC calls in `Sandbox`, `Commands`, and `Files` classes.

**Tech Stack:** TypeScript (sdk-server: tsup + vitest), Python 3.10+ (python-sdk: pytest), JSON-RPC 2.0

**Design Doc:** `docs/plans/2026-02-22-python-sdk-design.md`

---

### Task 1: SDK Server — Package scaffold and JSON-RPC dispatcher

**Context:** The SDK server is a Node.js process that imports `Sandbox` from `@wasmsand/orchestrator` and exposes it via JSON-RPC. This task creates the package and the dispatcher that maps RPC method names to Sandbox method calls. We test the dispatcher in isolation using a mock sandbox.

**Files:**
- Create: `packages/sdk-server/package.json`
- Create: `packages/sdk-server/tsconfig.json`
- Create: `packages/sdk-server/src/dispatcher.ts`
- Create: `packages/sdk-server/src/dispatcher.test.ts`

**Step 1: Create package scaffold**

Create `packages/sdk-server/package.json`:
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
    "test": "vitest run",
    "build": "tsup src/server.ts --format esm --dts"
  },
  "dependencies": {
    "@wasmsand/orchestrator": "*"
  },
  "devDependencies": {
    "tsup": "^8.0",
    "typescript": "^5.7",
    "vitest": "^3.0"
  }
}
```

Create `packages/sdk-server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Run: `npm install` (from repo root — workspace will link `@wasmsand/orchestrator`)
Expected: Success. `packages/sdk-server/node_modules` has workspace link.

**Step 2: Write failing dispatcher tests**

Create `packages/sdk-server/src/dispatcher.test.ts` with tests for every RPC method:
- `run` — calls `sandbox.run()`, returns `{exitCode, stdout, stderr, executionTimeMs}`
- `files.write` — decodes base64 `data` param, calls `sandbox.writeFile()`, returns `{ok:true}`
- `files.read` — calls `sandbox.readFile()`, encodes to base64, returns `{data: "..."}`
- `files.list` — calls `sandbox.readDir()`, enriches with size via `sandbox.stat()`, returns `{entries: [...]}`
- `files.mkdir` — calls `sandbox.mkdir()`, returns `{ok:true}`
- `files.rm` — calls `sandbox.rm()`, returns `{ok:true}`
- `files.stat` — calls `sandbox.stat()`, returns `{name, type, size}`
- `env.set` — calls `sandbox.setEnv()`, returns `{ok:true}`
- `env.get` — calls `sandbox.getEnv()`, returns `{value: "..." | null}`
- `kill` — calls `sandbox.destroy()`, returns `{ok:true}`
- Error: unknown method → rejects with `{code: -32601}`
- Error: missing required param → rejects with `{code: -32602}`
- Error: sandbox VfsError → rejects with `{code: 1, message: "ENOENT: ..."}`

Use a mock sandbox object that mimics the `Sandbox` interface. Construct `Dispatcher` with it.

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { Dispatcher } from './dispatcher.js';

function createMockSandbox() {
  return {
    run: async (cmd: string) => ({
      exitCode: 0, stdout: 'hello\n', stderr: '', executionTimeMs: 5,
    }),
    readFile: (path: string) => new TextEncoder().encode('file content'),
    writeFile: (path: string, data: Uint8Array) => {},
    readDir: (path: string) => [
      { name: 'a.txt', type: 'file' as const },
      { name: 'sub', type: 'dir' as const },
    ],
    mkdir: (path: string) => {},
    stat: (path: string) => ({
      type: 'file' as const, size: 12, permissions: 0o644,
      mtime: new Date(), ctime: new Date(), atime: new Date(),
    }),
    rm: (path: string) => {},
    setEnv: (name: string, value: string) => {},
    getEnv: (name: string) => name === 'FOO' ? 'bar' : undefined,
    destroy: () => {},
  };
}

// ... test cases as listed above
```

Run: `cd packages/sdk-server && npx vitest run`
Expected: FAIL — cannot resolve `./dispatcher.js`

**Step 3: Implement dispatcher**

Create `packages/sdk-server/src/dispatcher.ts`:

```typescript
import type { Sandbox } from '@wasmsand/orchestrator';

export interface RpcError {
  code: number;
  message: string;
}

export class Dispatcher {
  private sandbox: Sandbox;
  private killed = false;

  constructor(sandbox: Sandbox) { this.sandbox = sandbox; }

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      switch (method) {
        case 'run':           return this.run(params);
        case 'files.write':   return this.filesWrite(params);
        case 'files.read':    return this.filesRead(params);
        case 'files.list':    return this.filesList(params);
        case 'files.mkdir':   return this.filesMkdir(params);
        case 'files.rm':      return this.filesRm(params);
        case 'files.stat':    return this.filesStat(params);
        case 'env.set':       return this.envSet(params);
        case 'env.get':       return this.envGet(params);
        case 'kill':          return this.kill();
        default:
          throw this.rpcError(-32601, `Method not found: ${method}`);
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err) throw err;
      throw this.rpcError(1, (err as Error).message);
    }
  }

  isKilled(): boolean { return this.killed; }

  // ... private methods: requireString(), run(), filesWrite(), filesRead(), etc.
  // Each method validates params, calls sandbox, and returns the response shape
  // from the JSON-RPC protocol spec in the design doc.
  //
  // Key details:
  // - files.write: decode base64 → Uint8Array via Buffer.from(data, 'base64')
  // - files.read: encode Uint8Array → base64 via Buffer.from(content).toString('base64')
  // - files.list: map DirEntry[] and enrich each with size from stat()
  // - files.stat: extract basename from path for the "name" field
  // - env.get: return null (not undefined) when variable is unset
  // - kill: call sandbox.destroy(), set killed flag
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/sdk-server && npx vitest run`
Expected: All PASS

**Step 5: Commit**

```bash
git add packages/sdk-server/
git commit -m "feat(sdk-server): add JSON-RPC dispatcher with tests"
```

---

### Task 2: SDK Server — Stdio transport and `create` lifecycle

**Context:** The server entry point reads newline-delimited JSON from stdin, parses as JSON-RPC 2.0, and routes to the dispatcher. The first RPC call must be `create` (which creates the Sandbox). After `kill`, the process exits. The integration test spawns the server as a child process and sends real JSON-RPC messages.

**Files:**
- Create: `packages/sdk-server/src/server.ts`
- Create: `packages/sdk-server/src/server.test.ts`

**Step 1: Write failing integration test**

Create `packages/sdk-server/src/server.test.ts`. The test:
1. Spawns `node --import tsx packages/sdk-server/src/server.ts` as child process
2. Sends `create` RPC with `wasmDir` pointing to test fixtures
3. Sends `run` RPC with `echo hello`
4. Asserts stdout = `"hello\n"`
5. Sends `kill` RPC
6. Asserts process exits

Key: each RPC message is one JSON line terminated by `\n`. Responses come back the same way. The test must handle the async reading of stdout.

```typescript
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const SERVER_PATH = resolve(import.meta.dirname, 'server.ts');
const WASM_DIR = resolve(import.meta.dirname, '../../../orchestrator/src/platform/__tests__/fixtures');
const SHELL_WASM = resolve(import.meta.dirname, '../../../orchestrator/src/shell/__tests__/fixtures/wasmsand-shell.wasm');

function startServer() {
  const proc = spawn('node', ['--import', 'tsx', SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = createInterface({ input: proc.stdout! });
  const responses: string[] = [];
  rl.on('line', (line) => responses.push(line));

  function send(obj: unknown): void {
    proc.stdin!.write(JSON.stringify(obj) + '\n');
  }

  async function recv(): Promise<unknown> {
    // Wait for next response with polling
    const start = responses.length;
    for (let i = 0; i < 100; i++) {
      if (responses.length > start) return JSON.parse(responses[start]);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out waiting for response');
  }

  return { proc, send, recv };
}

describe('SDK Server (integration)', () => {
  it('create → run → kill lifecycle', async () => {
    const { proc, send, recv } = startServer();
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'create', params: { wasmDir: WASM_DIR, shellWasmPath: SHELL_WASM } });
      const createResp = await recv();
      expect(createResp).toMatchObject({ jsonrpc: '2.0', id: 1, result: { ok: true } });

      send({ jsonrpc: '2.0', id: 2, method: 'run', params: { command: 'echo hello' } });
      const runResp = await recv();
      expect(runResp).toMatchObject({ jsonrpc: '2.0', id: 2, result: { exitCode: 0 } });
      expect((runResp as any).result.stdout.trim()).toBe('hello');

      send({ jsonrpc: '2.0', id: 3, method: 'kill', params: {} });
      const killResp = await recv();
      expect(killResp).toMatchObject({ jsonrpc: '2.0', id: 3, result: { ok: true } });
    } finally {
      proc.kill();
    }
  }, 30_000);
});
```

Run: `cd packages/sdk-server && npx vitest run`
Expected: FAIL — `server.ts` doesn't exist yet (or imports fail)

**Step 2: Implement server.ts**

Create `packages/sdk-server/src/server.ts`:

The server:
1. Reads stdin line by line via `readline.createInterface`
2. Parses each line as JSON-RPC request
3. First RPC must be `create` — uses params to call `Sandbox.create()` from `@wasmsand/orchestrator`
4. Constructs `Dispatcher` with the created sandbox
5. Subsequent RPCs go through `dispatcher.dispatch()`
6. Writes JSON-RPC response + `\n` to stdout
7. After `kill` → `process.exit(0)`
8. All logs/errors go to stderr, never stdout

```typescript
import { createInterface } from 'node:readline';
import { Sandbox } from '@wasmsand/orchestrator';
import { NodeAdapter } from '@wasmsand/orchestrator/dist/platform/node-adapter.js';
import { Dispatcher } from './dispatcher.js';

// ... readline loop, parse JSON-RPC, handle create, dispatch, write response
```

Key implementation notes:
- Import `NodeAdapter` directly (not from index.ts, since it's excluded from barrel export)
- For `create`: extract `wasmDir`, `timeoutMs`, `fsLimitBytes`, `shellWasmPath` from params. Call `Sandbox.create({ wasmDir, adapter: new NodeAdapter(), timeoutMs, fsLimitBytes, shellWasmPath })`.
- For all other methods: `dispatcher.dispatch(method, params)`
- Wrap errors: if dispatch rejects with `{code, message}`, return JSON-RPC error. Otherwise return `{code: -32603, message: "Internal error"}`.
- After `kill` response is written, call `process.exit(0)`.
- Never `console.log()` — use `process.stderr.write()` for debug output.

**Step 3: Run tests**

Run: `cd packages/sdk-server && npx vitest run`
Expected: All PASS (both dispatcher unit tests and server integration test)

**Step 4: Commit**

```bash
git add packages/sdk-server/src/server.ts packages/sdk-server/src/server.test.ts
git commit -m "feat(sdk-server): add stdio JSON-RPC server with integration test"
```

---

### Task 3: Python SDK — Package scaffold and RPC client

**Context:** The Python SDK needs a JSON-RPC client that spawns a Node child process, sends requests, and reads responses. This is the transport layer. We test it by actually spawning the SDK server from Task 2.

**Files:**
- Create: `packages/python-sdk/pyproject.toml`
- Create: `packages/python-sdk/src/wasmsand/__init__.py`
- Create: `packages/python-sdk/src/wasmsand/_rpc.py`
- Create: `packages/python-sdk/tests/conftest.py`
- Create: `packages/python-sdk/tests/test_rpc.py`

**Step 1: Create Python package scaffold**

Create `packages/python-sdk/pyproject.toml`:
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

[tool.pytest.ini_options]
testpaths = ["tests"]
```

Create `packages/python-sdk/src/wasmsand/__init__.py`:
```python
from wasmsand.sandbox import Sandbox
from wasmsand._types import CommandResult, FileInfo

__all__ = ["Sandbox", "CommandResult", "FileInfo"]
```

Note: this will fail to import initially — that's expected. We implement `_types.py` in Step 2 and `sandbox.py` in Task 4.

**Step 2: Write the RPC client**

Create `packages/python-sdk/src/wasmsand/_types.py`:
```python
from dataclasses import dataclass

@dataclass
class CommandResult:
    stdout: str
    stderr: str
    exit_code: int
    execution_time_ms: float

@dataclass
class FileInfo:
    name: str
    type: str  # "file" or "dir"
    size: int
```

Create `packages/python-sdk/src/wasmsand/_rpc.py`:

This module provides `RpcClient`:
- `__init__(self, node_path: str, server_script: str)` — stores paths, does not spawn yet
- `start(self)` — spawns Node subprocess with `subprocess.Popen([node_path, server_script], stdin=PIPE, stdout=PIPE, stderr=PIPE)`
- `call(self, method: str, params: dict) -> Any` — sends JSON-RPC request, reads one line response, parses. Raises `RpcError` on error responses.
- `stop(self)` — terminates subprocess, waits for exit

Implementation details:
- Auto-increment `id` counter for each request
- Serialize request: `json.dumps({"jsonrpc": "2.0", "id": N, "method": method, "params": params}) + "\n"`
- Write to `proc.stdin`, flush
- Read one line from `proc.stdout`
- Parse as JSON. If `"error"` key present, raise `RpcError(code, message)`.
- Otherwise return `result` value.
- Thread safety: not required (single-threaded use per design doc)

Also create `RpcError(Exception)` with `code` and `message` attributes.

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
    def __init__(self, node_path: str, server_script: str):
        self._node_path = node_path
        self._server_script = server_script
        self._proc: subprocess.Popen | None = None
        self._next_id = 1

    def start(self) -> None:
        self._proc = subprocess.Popen(
            [self._node_path, self._server_script],
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
            self._proc.terminate()
            self._proc.wait(timeout=5)
            self._proc = None
```

**Step 3: Write RPC client test**

Create `packages/python-sdk/tests/conftest.py`:
```python
import shutil
import os

def pytest_collection_modifyitems(config, items):
    """Skip all tests if Node.js is not available."""
    if shutil.which("node") is None:
        import pytest
        skip = pytest.mark.skip(reason="Node.js not found on PATH")
        for item in items:
            item.add_marker(skip)
```

Create `packages/python-sdk/tests/test_rpc.py`:
```python
import os
import pytest
from wasmsand._rpc import RpcClient, RpcError

# Path to the compiled SDK server (tsx for dev, dist/server.js for prod)
SERVER_SCRIPT = os.path.join(
    os.path.dirname(__file__), "..", "..", "sdk-server", "src", "server.ts"
)
WASM_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "orchestrator", "src", "platform", "__tests__", "fixtures"
)
SHELL_WASM = os.path.join(
    os.path.dirname(__file__), "..", "..", "orchestrator", "src", "shell", "__tests__", "fixtures", "wasmsand-shell.wasm"
)

# Use tsx to run TypeScript directly in dev
NODE_PATH = "node"
NODE_ARGS = ["--import", "tsx"]


@pytest.fixture
def client():
    """Start RPC client, create sandbox, yield client, kill on teardown."""
    import subprocess
    proc = subprocess.Popen(
        [NODE_PATH, *NODE_ARGS, SERVER_SCRIPT],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    c = RpcClient.__new__(RpcClient)
    c._proc = proc
    c._next_id = 1
    # Create sandbox
    result = c.call("create", {"wasmDir": WASM_DIR, "shellWasmPath": SHELL_WASM})
    assert result["ok"] is True
    yield c
    try:
        c.call("kill", {})
    except Exception:
        pass
    proc.terminate()
    proc.wait(timeout=5)


class TestRpcClient:
    def test_run_echo(self, client):
        result = client.call("run", {"command": "echo hello"})
        assert result["exitCode"] == 0
        assert result["stdout"].strip() == "hello"

    def test_files_roundtrip(self, client):
        import base64
        data = base64.b64encode(b"test data").decode()
        client.call("files.write", {"path": "/tmp/test.txt", "data": data})
        result = client.call("files.read", {"path": "/tmp/test.txt"})
        assert base64.b64decode(result["data"]) == b"test data"

    def test_method_not_found(self, client):
        with pytest.raises(RpcError) as exc_info:
            client.call("nonexistent", {})
        assert exc_info.value.code == -32601

    def test_sandbox_error(self, client):
        with pytest.raises(RpcError) as exc_info:
            client.call("files.read", {"path": "/nonexistent"})
        assert exc_info.value.code == 1
        assert "ENOENT" in exc_info.value.message
```

**Step 4: Run tests**

Run: `cd packages/python-sdk && python -m pytest tests/test_rpc.py -v`
Expected: All PASS (requires `tsx` on PATH — install via `npm install -g tsx` if needed, or the monorepo may already have it)

Note: If `tsx` is not globally available, the tests may need to use `npx tsx` or reference the local `node_modules/.bin/tsx`. Adjust the spawn command in the fixture.

**Step 5: Commit**

```bash
git add packages/python-sdk/
git commit -m "feat(python-sdk): add package scaffold and RPC client with tests"
```

---

### Task 4: Python SDK — Sandbox, Commands, and Files classes

**Context:** The public API classes wrap `RpcClient` to provide the E2B-style interface: `sandbox.commands.run()`, `sandbox.files.read()`, etc. The `Sandbox` constructor spawns the Node subprocess and calls `create`. Context manager ensures cleanup.

**Files:**
- Create: `packages/python-sdk/src/wasmsand/sandbox.py`
- Create: `packages/python-sdk/src/wasmsand/commands.py`
- Create: `packages/python-sdk/src/wasmsand/files.py`
- Modify: `packages/python-sdk/src/wasmsand/__init__.py`
- Create: `packages/python-sdk/tests/test_sandbox.py`
- Create: `packages/python-sdk/tests/test_commands.py`
- Create: `packages/python-sdk/tests/test_files.py`

**Step 1: Write failing test for Sandbox lifecycle**

Create `packages/python-sdk/tests/test_sandbox.py`:
```python
import pytest
from wasmsand import Sandbox

class TestSandbox:
    def test_create_and_kill(self):
        sandbox = Sandbox()
        sandbox.kill()

    def test_context_manager(self):
        with Sandbox() as sbx:
            result = sbx.commands.run("echo hello")
            assert result.exit_code == 0

    def test_missing_node_raises(self, monkeypatch):
        monkeypatch.setattr("shutil.which", lambda _: None)
        with pytest.raises(RuntimeError, match="Node.js not found"):
            Sandbox()
```

Run: `cd packages/python-sdk && python -m pytest tests/test_sandbox.py -v`
Expected: FAIL — `Sandbox` class not implemented yet

**Step 2: Implement Sandbox class**

Create `packages/python-sdk/src/wasmsand/sandbox.py`:

The `Sandbox` class:
- `__init__(self, *, timeout_ms=30_000, fs_limit_bytes=256*1024*1024)` — finds Node via `shutil.which("node")`, locates the bundled server script, spawns RpcClient, calls `create` RPC with `wasmDir` pointing to bundled wasm directory
- For development: the `wasmDir` and `server_script` paths point to the monorepo locations. For production (PyPI), they'd point to bundled files inside the wheel. Use `importlib.resources` or `__file__`-relative paths.
- `commands` property returns `Commands` instance
- `files` property returns `Files` instance
- `kill()` — calls `kill` RPC, stops subprocess
- `__enter__` / `__exit__` — context manager, calls `kill()` on exit

**Important dev-mode path resolution:**
```python
import os
_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_PKG_DIR, "..", "..", "..", ".."))
_SERVER_SCRIPT = os.path.join(_REPO_ROOT, "packages", "sdk-server", "src", "server.ts")
_WASM_DIR = os.path.join(_REPO_ROOT, "packages", "orchestrator", "src", "platform", "__tests__", "fixtures")
_SHELL_WASM = os.path.join(_REPO_ROOT, "packages", "orchestrator", "src", "shell", "__tests__", "fixtures", "wasmsand-shell.wasm")
```

For now we hard-code dev paths. Bundling/packaging for PyPI is a separate concern (not in scope for this plan).

```python
import os
import shutil
import subprocess
from wasmsand._rpc import RpcClient
from wasmsand.commands import Commands
from wasmsand.files import Files

class Sandbox:
    def __init__(self, *, timeout_ms: int = 30_000, fs_limit_bytes: int = 256 * 1024 * 1024):
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("Node.js not found on PATH")

        pkg_dir = os.path.dirname(os.path.abspath(__file__))
        repo_root = os.path.abspath(os.path.join(pkg_dir, "..", "..", "..", ".."))
        server_script = os.path.join(repo_root, "packages", "sdk-server", "src", "server.ts")
        wasm_dir = os.path.join(repo_root, "packages", "orchestrator", "src", "platform", "__tests__", "fixtures")
        shell_wasm = os.path.join(repo_root, "packages", "orchestrator", "src", "shell", "__tests__", "fixtures", "wasmsand-shell.wasm")

        self._client = RpcClient(node, server_script)
        # Use tsx to run TypeScript
        self._proc = subprocess.Popen(
            [node, "--import", "tsx", server_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._client._proc = self._proc
        self._client._next_id = 1

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
        if self._proc is not None:
            self._proc.terminate()
            self._proc.wait(timeout=5)

    def __enter__(self) -> "Sandbox":
        return self

    def __exit__(self, *exc) -> None:
        self.kill()
```

**Step 3: Implement Commands class**

Create `packages/python-sdk/src/wasmsand/commands.py`:
```python
from wasmsand._rpc import RpcClient
from wasmsand._types import CommandResult

class Commands:
    def __init__(self, client: RpcClient):
        self._client = client

    def run(self, command: str) -> CommandResult:
        result = self._client.call("run", {"command": command})
        return CommandResult(
            stdout=result["stdout"],
            stderr=result["stderr"],
            exit_code=result["exitCode"],
            execution_time_ms=result["executionTimeMs"],
        )
```

**Step 4: Implement Files class**

Create `packages/python-sdk/src/wasmsand/files.py`:
```python
import base64
from wasmsand._rpc import RpcClient
from wasmsand._types import FileInfo

class Files:
    def __init__(self, client: RpcClient):
        self._client = client

    def read(self, path: str) -> bytes:
        result = self._client.call("files.read", {"path": path})
        return base64.b64decode(result["data"])

    def write(self, path: str, data: bytes | str) -> None:
        if isinstance(data, str):
            data = data.encode("utf-8")
        encoded = base64.b64encode(data).decode("ascii")
        self._client.call("files.write", {"path": path, "data": encoded})

    def list(self, path: str) -> list[FileInfo]:
        result = self._client.call("files.list", {"path": path})
        return [FileInfo(name=e["name"], type=e["type"], size=e["size"]) for e in result["entries"]]

    def mkdir(self, path: str) -> None:
        self._client.call("files.mkdir", {"path": path})

    def rm(self, path: str) -> None:
        self._client.call("files.rm", {"path": path})

    def stat(self, path: str) -> FileInfo:
        result = self._client.call("files.stat", {"path": path})
        return FileInfo(name=result["name"], type=result["type"], size=result["size"])
```

**Step 5: Update `__init__.py`**

```python
from wasmsand.sandbox import Sandbox
from wasmsand._types import CommandResult, FileInfo

__all__ = ["Sandbox", "CommandResult", "FileInfo"]
```

**Step 6: Write Commands and Files tests**

Create `packages/python-sdk/tests/test_commands.py`:
```python
import pytest
from wasmsand import Sandbox

@pytest.fixture
def sandbox():
    with Sandbox() as sbx:
        yield sbx

class TestCommands:
    def test_echo(self, sandbox):
        result = sandbox.commands.run("echo hello")
        assert result.stdout.strip() == "hello"
        assert result.stderr == ""
        assert result.exit_code == 0
        assert result.execution_time_ms >= 0

    def test_pipeline(self, sandbox):
        result = sandbox.commands.run("echo hello world | wc -w")
        assert result.stdout.strip() == "2"

    def test_exit_code(self, sandbox):
        result = sandbox.commands.run("false")
        assert result.exit_code != 0

    def test_stderr(self, sandbox):
        result = sandbox.commands.run("echo err >&2")
        assert "err" in result.stderr
```

Create `packages/python-sdk/tests/test_files.py`:
```python
import pytest
from wasmsand import Sandbox, FileInfo
from wasmsand._rpc import RpcError

@pytest.fixture
def sandbox():
    with Sandbox() as sbx:
        yield sbx

class TestFiles:
    def test_write_bytes_and_read(self, sandbox):
        sandbox.files.write("/tmp/test.bin", b"\x00\x01\x02\xff")
        content = sandbox.files.read("/tmp/test.bin")
        assert content == b"\x00\x01\x02\xff"

    def test_write_str_and_read(self, sandbox):
        sandbox.files.write("/tmp/msg.txt", "hello world")
        content = sandbox.files.read("/tmp/msg.txt")
        assert content == b"hello world"

    def test_list(self, sandbox):
        sandbox.files.write("/tmp/a.txt", b"aaa")
        sandbox.files.write("/tmp/b.txt", b"bbb")
        entries = sandbox.files.list("/tmp")
        names = {e.name for e in entries}
        assert "a.txt" in names
        assert "b.txt" in names
        assert all(isinstance(e, FileInfo) for e in entries)

    def test_mkdir_and_stat(self, sandbox):
        sandbox.files.mkdir("/tmp/subdir")
        info = sandbox.files.stat("/tmp/subdir")
        assert info.type == "dir"

    def test_rm(self, sandbox):
        sandbox.files.write("/tmp/del.txt", b"gone")
        sandbox.files.rm("/tmp/del.txt")
        with pytest.raises(RpcError) as exc_info:
            sandbox.files.read("/tmp/del.txt")
        assert "ENOENT" in str(exc_info.value)

    def test_stat_file(self, sandbox):
        sandbox.files.write("/tmp/sized.txt", b"12345")
        info = sandbox.files.stat("/tmp/sized.txt")
        assert info.type == "file"
        assert info.size == 5
        assert info.name == "sized.txt"

    def test_read_nonexistent_raises(self, sandbox):
        with pytest.raises(RpcError) as exc_info:
            sandbox.files.read("/tmp/nope.txt")
        assert exc_info.value.code == 1
        assert "ENOENT" in exc_info.value.message
```

**Step 7: Run all Python tests**

Run: `cd packages/python-sdk && python -m pytest tests/ -v`
Expected: All PASS

**Step 8: Commit**

```bash
git add packages/python-sdk/
git commit -m "feat(python-sdk): add Sandbox, Commands, Files classes with tests"
```

---

### Task 5: End-to-end integration and cleanup

**Context:** Final task to verify everything works together, ensure the root workspace includes the new packages properly, and add a combined test run.

**Files:**
- Modify: `packages/python-sdk/tests/test_sandbox.py` — add comprehensive lifecycle tests
- Modify: `packages/sdk-server/package.json` — ensure `tsx` is a devDependency
- Verify: root `package.json` workspaces already covers `packages/*`

**Step 1: Add tsx as devDependency to sdk-server**

The integration tests (both vitest and pytest) spawn the server via `node --import tsx server.ts`. Ensure `tsx` is available:

```bash
cd packages/sdk-server && npm install --save-dev tsx
```

**Step 2: Comprehensive end-to-end test**

Add to `packages/python-sdk/tests/test_sandbox.py`:
```python
class TestSandboxEndToEnd:
    def test_write_file_then_cat(self):
        with Sandbox() as sbx:
            sbx.files.write("/tmp/input.txt", "hello from python")
            result = sbx.commands.run("cat /tmp/input.txt")
            assert result.stdout == "hello from python"

    def test_command_output_to_file(self):
        with Sandbox() as sbx:
            sbx.commands.run("echo generated > /tmp/out.txt")
            content = sbx.files.read("/tmp/out.txt")
            assert b"generated" in content

    def test_multiple_commands(self):
        with Sandbox() as sbx:
            sbx.commands.run("echo line1 > /tmp/multi.txt")
            sbx.commands.run("echo line2 >> /tmp/multi.txt")
            result = sbx.commands.run("cat /tmp/multi.txt")
            assert "line1" in result.stdout
            assert "line2" in result.stdout

    def test_env_via_commands(self):
        with Sandbox() as sbx:
            sbx.commands.run("export FOO=bar")
            # Note: env variables persist between commands in the shell runner
            result = sbx.commands.run("echo $FOO")
            assert result.stdout.strip() == "bar"
```

**Step 3: Run full test suite**

Run both test suites:
```bash
# TypeScript tests (vitest)
cd packages/sdk-server && npx vitest run

# Python tests (pytest)
cd packages/python-sdk && python -m pytest tests/ -v

# Existing orchestrator tests (should still pass)
npm test
```

Expected: All tests PASS. No regressions in orchestrator tests.

**Step 4: Commit**

```bash
git add packages/sdk-server/ packages/python-sdk/
git commit -m "feat: end-to-end integration tests for Python SDK"
```
