# Python SDK — Design

**Goal:** Ship a `wasmsand` Python package (PyPI) that lets AI agents create sandboxes, run commands, pass files, and capture outputs. One `pip install`, no manual Node/wasm setup.

**Approach:** Python SDK spawns a Node.js child process running a JSON-RPC server. The server imports the existing TypeScript `Sandbox` class. Communication is JSON-RPC 2.0 over stdin/stdout. The same server binary can be reused by a future Rust SDK.

**Future:** Rust SDK wraps the same JSON-RPC server (separate phase).

---

## Public API

```python
from wasmsand import Sandbox, CommandResult, FileInfo

# Create sandbox — spawns Node subprocess, discovers bundled wasm tools
sandbox = Sandbox()

# Or with options
sandbox = Sandbox(timeout_ms=60_000, fs_limit_bytes=512 * 1024 * 1024)

# Context manager for automatic cleanup
with Sandbox() as sbx:
    result = sbx.commands.run("echo hello")

# Run commands, capture output
result = sandbox.commands.run("echo hello | tr a-z A-Z")
result.stdout       # "HELLO\n"
result.stderr       # ""
result.exit_code    # 0
result.execution_time_ms  # 12.3

# File I/O
sandbox.files.write("/tmp/input.txt", b"some data")
sandbox.files.write("/tmp/msg.txt", "hello")  # str auto-encoded to UTF-8
content = sandbox.files.read("/tmp/input.txt")  # bytes
entries = sandbox.files.list("/tmp")             # list[FileInfo]
sandbox.files.mkdir("/tmp/subdir")
info = sandbox.files.stat("/tmp/input.txt")      # FileInfo
sandbox.files.rm("/tmp/input.txt")

# Cleanup
sandbox.kill()
```

### Classes

```python
class Sandbox:
    def __init__(self, *, timeout_ms: int = 30_000, fs_limit_bytes: int = 256 * 1024 * 1024):
        """Spawns Node subprocess, creates sandbox with bundled wasm tools."""

    commands: Commands
    files: Files

    def kill(self) -> None:
        """Sends shutdown RPC, terminates subprocess."""

    def __enter__(self) -> "Sandbox": ...
    def __exit__(self, *exc) -> None: ...  # calls kill()

class Commands:
    def run(self, command: str) -> CommandResult:
        """Run a shell command. Blocks until completion."""

class Files:
    def read(self, path: str) -> bytes:
    def write(self, path: str, data: bytes | str) -> None:
    def list(self, path: str) -> list[FileInfo]:
    def mkdir(self, path: str) -> None:
    def rm(self, path: str) -> None:
    def stat(self, path: str) -> FileInfo:

@dataclass
class CommandResult:
    stdout: str
    stderr: str
    exit_code: int
    execution_time_ms: float

@dataclass
class FileInfo:
    name: str
    type: str   # "file" or "dir"
    size: int
```

Key decisions:
- `Sandbox()` constructor takes no `wasm_dir` — the package bundles everything.
- `files.write()` accepts `str` (auto-encoded to UTF-8) for AI agent convenience.
- `files.read()` returns `bytes` — no encoding assumptions.
- Context manager ensures cleanup even on exceptions.
- Node path found via `shutil.which("node")`. Clear error if missing.

---

## Architecture

```
Python process                    Node.js child process
┌─────────────┐                  ┌──────────────────────┐
│ wasmsand SDK │ ── stdin ──►    │ sdk-server            │
│  (PyPI pkg)  │ ◄── stdout ──  │  imports Sandbox      │
│              │                  │  JSON-RPC dispatcher  │
└─────────────┘                  └──────────────────────┘
     │                                     │
     │  subprocess.Popen(                  │  Sandbox.create()
     │    ["node", "server.js"],           │  sandbox.run()
     │    stdin=PIPE, stdout=PIPE)         │  sandbox.readFile()
     │                                     │
```

### Packages

| Package | Language | Purpose |
|---------|----------|---------|
| `packages/sdk-server/` | TypeScript | JSON-RPC server over stdio. Imports `Sandbox`, dispatches RPC calls. Reusable by any language SDK. |
| `packages/python-sdk/` | Python | PyPI package `wasmsand`. Spawns Node subprocess, sends JSON-RPC, parses responses. |
| `packages/orchestrator/` | TypeScript | Unchanged. The core `Sandbox` class. |

### Bundling

The Python wheel bundles:
- `sdk-server/` — the compiled Node server JS
- `wasm/` — all `.wasm` binaries (~48MB)

This makes `pip install wasmsand` self-contained (only requires Node on PATH).

### Lifecycle

1. `Sandbox()` → `shutil.which("node")` → `subprocess.Popen(["node", "server.js"], stdin=PIPE, stdout=PIPE)`
2. Constructor sends `create` RPC, blocks until sandbox is ready
3. Each method call → JSON-RPC request → blocks → parse response
4. `sandbox.kill()` → sends `kill` RPC → `proc.terminate()` → `proc.wait()`
5. If Python process dies → Node gets SIGPIPE → exits

---

## JSON-RPC Protocol Specification

**Transport:** Newline-delimited JSON over stdin (requests) and stdout (responses). One JSON object per line. The server MUST NOT write anything else to stdout (logs go to stderr).

**Protocol:** JSON-RPC 2.0. No notifications. No batch requests.

### Methods

#### `create`

Initialize the sandbox. Must be the first call.

```
→ {"jsonrpc":"2.0","id":1,"method":"create","params":{"wasmDir":"/path/to/wasm","timeoutMs":30000,"fsLimitBytes":268435456}}
← {"jsonrpc":"2.0","id":1,"result":{"ok":true}}
```

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `wasmDir` | string | yes | — | Directory containing .wasm tool binaries |
| `timeoutMs` | number | no | 30000 | Per-command wall-clock timeout in ms |
| `fsLimitBytes` | number | no | 268435456 | Max VFS size in bytes (256MB) |

#### `run`

Execute a shell command. Blocks until completion or timeout.

```
→ {"jsonrpc":"2.0","id":2,"method":"run","params":{"command":"echo hello | wc -c"}}
← {"jsonrpc":"2.0","id":2,"result":{"exitCode":0,"stdout":"6\n","stderr":"","executionTimeMs":15}}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | yes | Shell command to execute |

| Result field | Type | Description |
|--------------|------|-------------|
| `exitCode` | number | Process exit code. 124 = timeout. |
| `stdout` | string | Standard output |
| `stderr` | string | Standard error |
| `executionTimeMs` | number | Wall-clock execution time |

#### `files.write`

Write a file to the sandbox VFS. Creates parent directories as needed.

```
→ {"jsonrpc":"2.0","id":3,"method":"files.write","params":{"path":"/tmp/data.txt","data":"aGVsbG8gd29ybGQ="}}
← {"jsonrpc":"2.0","id":3,"result":{"ok":true}}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | yes | Absolute path in VFS |
| `data` | string | yes | File contents, base64-encoded |

#### `files.read`

Read a file from the sandbox VFS.

```
→ {"jsonrpc":"2.0","id":4,"method":"files.read","params":{"path":"/tmp/data.txt"}}
← {"jsonrpc":"2.0","id":4,"result":{"data":"aGVsbG8gd29ybGQ="}}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | yes | Absolute path in VFS |

| Result field | Type | Description |
|--------------|------|-------------|
| `data` | string | File contents, base64-encoded |

#### `files.list`

List entries in a directory.

```
→ {"jsonrpc":"2.0","id":5,"method":"files.list","params":{"path":"/tmp"}}
← {"jsonrpc":"2.0","id":5,"result":{"entries":[{"name":"data.txt","type":"file","size":11},{"name":"subdir","type":"dir","size":0}]}}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | yes | Absolute directory path |

| Result field | Type | Description |
|--------------|------|-------------|
| `entries` | array | Array of `{name: string, type: "file"|"dir", size: number}` |

#### `files.mkdir`

Create a directory.

```
→ {"jsonrpc":"2.0","id":6,"method":"files.mkdir","params":{"path":"/tmp/subdir"}}
← {"jsonrpc":"2.0","id":6,"result":{"ok":true}}
```

#### `files.rm`

Remove a file.

```
→ {"jsonrpc":"2.0","id":7,"method":"files.rm","params":{"path":"/tmp/data.txt"}}
← {"jsonrpc":"2.0","id":7,"result":{"ok":true}}
```

#### `files.stat`

Get file/directory metadata.

```
→ {"jsonrpc":"2.0","id":8,"method":"files.stat","params":{"path":"/tmp"}}
← {"jsonrpc":"2.0","id":8,"result":{"name":"tmp","type":"dir","size":0}}
```

| Result field | Type | Description |
|--------------|------|-------------|
| `name` | string | Entry name |
| `type` | string | `"file"` or `"dir"` |
| `size` | number | Size in bytes (0 for directories) |

#### `env.set`

Set an environment variable for subsequent commands.

```
→ {"jsonrpc":"2.0","id":9,"method":"env.set","params":{"name":"FOO","value":"bar"}}
← {"jsonrpc":"2.0","id":9,"result":{"ok":true}}
```

#### `env.get`

Get an environment variable.

```
→ {"jsonrpc":"2.0","id":10,"method":"env.get","params":{"name":"FOO"}}
← {"jsonrpc":"2.0","id":10,"result":{"value":"bar"}}
```

| Result field | Type | Description |
|--------------|------|-------------|
| `value` | string or null | Variable value, or null if unset |

#### `kill`

Destroy the sandbox and shut down the server process.

```
→ {"jsonrpc":"2.0","id":11,"method":"kill","params":{}}
← {"jsonrpc":"2.0","id":11,"result":{"ok":true}}
```

The server MUST exit after responding to `kill`.

### Error Responses

```
← {"jsonrpc":"2.0","id":3,"error":{"code":1,"message":"ENOENT: file not found: /tmp/nonexistent"}}
```

| Code | Meaning |
|------|---------|
| `-32601` | Method not found |
| `-32602` | Invalid params (missing required field, wrong type) |
| `1` | Sandbox error (ENOENT, ENOSPC, ENOTDIR, EEXIST, etc.) |

The `message` field contains a human-readable description. For sandbox errors, it is prefixed with the errno (e.g. `"ENOSPC: filesystem full"`).

---

## Files

**New:**
- `packages/sdk-server/src/server.ts` — JSON-RPC server entry point
- `packages/sdk-server/src/dispatcher.ts` — Method dispatch table
- `packages/sdk-server/package.json` — Package config
- `packages/sdk-server/tsconfig.json`
- `packages/python-sdk/pyproject.toml` — Python package config
- `packages/python-sdk/src/wasmsand/__init__.py`
- `packages/python-sdk/src/wasmsand/sandbox.py`
- `packages/python-sdk/src/wasmsand/commands.py`
- `packages/python-sdk/src/wasmsand/files.py`
- `packages/python-sdk/src/wasmsand/_rpc.py` — JSON-RPC client over subprocess
- `packages/python-sdk/tests/test_sandbox.py`
- `packages/python-sdk/tests/test_commands.py`
- `packages/python-sdk/tests/test_files.py`

**Unchanged:** `packages/orchestrator/`, `packages/web/`, `packages/coreutils/`

---

## Testing

**SDK Server** (vitest):
- Each RPC method returns correct response shape
- Error cases: unknown method, missing params, ENOENT, ENOSPC
- Server exits after `kill`

**Python SDK** (pytest):
- `test_sandbox.py`: create/kill lifecycle, context manager, missing Node raises RuntimeError
- `test_commands.py`: echo, pipeline, exit code, timeout (exitCode=124)
- `test_files.py`: write bytes + read round-trip, write str + read round-trip, list, mkdir, rm, stat, ENOENT error

Tests require Node on PATH. Skip with clear message if not available.
