# Mounting Host Files into the Sandbox

This guide covers how to inject files from the host into the codepod virtual filesystem. Common use cases:

- Providing tools or scripts for the LLM to use
- Making user-uploaded files accessible inside the sandbox
- Adding Python libraries to PYTHONPATH

## Quick start

### TypeScript

```typescript
import { Sandbox } from '@codepod/sandbox';
import { NodeAdapter } from '@codepod/sandbox/node';

const encode = (s: string) => new TextEncoder().encode(s);

const sandbox = await Sandbox.create({
  adapter: new NodeAdapter(),
  wasmDir: './wasm',
  mounts: [
    {
      path: '/mnt/tools',
      files: {
        'analyze.sh': encode('#!/bin/sh\nwc -l "$1"'),
        'transform.py': encode('import sys\nfor line in sys.stdin:\n    print(line.upper(), end="")'),
      },
    },
  ],
});

await sandbox.run('cat /mnt/tools/analyze.sh');
await sandbox.run('ls /mnt/tools');
```

### Python

```python
from codepod import Sandbox

with Sandbox(mounts=[
    ("/mnt/tools", {
        "analyze.sh": b"#!/bin/sh\nwc -l \"$1\"",
        "transform.py": b"import sys\nfor line in sys.stdin:\n    print(line.upper(), end='')",
    }),
]) as sb:
    sb.commands.run("cat /mnt/tools/analyze.sh")
    sb.commands.run("ls /mnt/tools")
```

## Creation-time vs. runtime mounts

### At creation time

Pass `mounts` to the constructor/create method. Files are available before any commands run:

**TypeScript:**
```typescript
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  mounts: [
    { path: '/mnt/data', files: { 'input.csv': csvBytes } },
  ],
});
```

**Python:**
```python
sb = Sandbox(mounts=[("/mnt/data", {"input.csv": csv_bytes})])
```

### At runtime

Call `mount()` dynamically after the sandbox is created:

**TypeScript:**
```typescript
sandbox.mount('/mnt/uploads', {
  'report.pdf': pdfBytes,
  'config.json': encode('{"key": "value"}'),
});
```

**Python:**
```python
sb.mount("/mnt/uploads", {
    "report.pdf": pdf_bytes,
    "config.json": b'{"key": "value"}',
})
```

## Nested directories

Flat keys with `/` separators automatically create intermediate directories:

```python
sb.mount("/mnt/project", {
    "src/main.py": b"print('hello')",
    "src/utils/__init__.py": b"",
    "src/utils/helpers.py": b"def add(a, b): return a + b",
    "tests/test_main.py": b"assert True",
})

# Result:
# /mnt/project/
# ├── src/
# │   ├── main.py
# │   └── utils/
# │       ├── __init__.py
# │       └── helpers.py
# └── tests/
#     └── test_main.py
```

## Using VirtualFileSystem (Python)

For structured file sources, use `MemoryFS` or subclass `VirtualFileSystem`:

### MemoryFS

`MemoryFS` wraps a flat dict with the full filesystem interface:

```python
from codepod import Sandbox, MemoryFS

fs = MemoryFS({
    "mylib/__init__.py": b"",
    "mylib/core.py": b"VERSION = '1.0'",
    "mylib/utils.py": b"def double(x): return x * 2",
})

# Inspect before mounting
print(fs.exists("mylib/core.py"))  # True
print(fs.stat("mylib"))            # FileStat(type='dir', size=3)
print(fs.readdir("mylib"))         # [DirEntry(name='__init__.py', ...), ...]
print(fs.read_file("mylib/core.py"))  # b"VERSION = '1.0'"

# Mount into sandbox
with Sandbox(mounts=[("/mnt/pkg", fs)]) as sb:
    sb.commands.run("ls /mnt/pkg/mylib")
```

String values are auto-encoded to UTF-8:

```python
fs = MemoryFS({
    "readme.txt": "Hello, world!",      # str → bytes
    "data.bin": b"\x00\x01\x02\xff",    # bytes as-is
})
```

### Custom VirtualFileSystem

Subclass `VirtualFileSystem` to serve files from any source:

```python
import os
from codepod import VirtualFileSystem, FileStat, DirEntry

class LocalDirFS(VirtualFileSystem):
    """Serve files from a local directory."""

    def __init__(self, root: str):
        self.root = os.path.abspath(root)

    def read_file(self, path: str) -> bytes:
        full = os.path.join(self.root, path)
        if not os.path.isfile(full):
            raise FileNotFoundError(path)
        with open(full, "rb") as f:
            return f.read()

    def write_file(self, path: str, data: bytes) -> None:
        raise PermissionError("read-only mount")

    def exists(self, path: str) -> bool:
        return os.path.exists(os.path.join(self.root, path or "."))

    def stat(self, path: str) -> FileStat:
        full = os.path.join(self.root, path or ".")
        if not os.path.exists(full):
            raise FileNotFoundError(path)
        if os.path.isdir(full):
            return FileStat(type="dir", size=len(os.listdir(full)))
        return FileStat(type="file", size=os.path.getsize(full))

    def readdir(self, path: str) -> list[DirEntry]:
        full = os.path.join(self.root, path or ".")
        return [
            DirEntry(
                name=entry,
                type="dir" if os.path.isdir(os.path.join(full, entry)) else "file",
            )
            for entry in os.listdir(full)
        ]

# Mount a local directory into the sandbox
fs = LocalDirFS("/path/to/my/project")
with Sandbox(mounts=[("/mnt/project", fs)]) as sb:
    result = sb.commands.run("find /mnt/project -name '*.py'")
```

When mounted, the SDK walks the VFS via `readdir()` and `read_file()` to snapshot all files, then sends them to the sandbox. Files are captured at mount time — later changes to the source are not reflected.

## Using VirtualProvider (TypeScript)

In TypeScript, `mount()` accepts either a flat file dict or a `VirtualProvider`:

```typescript
import { HostMount } from '@codepod/sandbox';

// Using HostMount directly
const provider = new HostMount({
  'config.json': encode('{}'),
  'scripts/run.sh': encode('#!/bin/sh\necho hello'),
});
provider.addFile('scripts/extra.sh', encode('#!/bin/sh\necho extra'));

sandbox.mount('/mnt/tools', provider);

// Or any VirtualProvider implementation
const myProvider: VirtualProvider = {
  readFile(subpath) { /* ... */ },
  writeFile(subpath, data) { /* ... */ },
  exists(subpath) { /* ... */ },
  stat(subpath) { /* ... */ },
  readdir(subpath) { /* ... */ },
};
sandbox.mount('/mnt/custom', myProvider);
```

## PYTHONPATH configuration

Mount Python libraries and add their paths to PYTHONPATH:

### TypeScript

```typescript
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  mounts: [
    {
      path: '/mnt/libs',
      files: {
        'mymodule/__init__.py': encode(''),
        'mymodule/core.py': encode('GREETING = "hello from mymodule"'),
      },
    },
  ],
  pythonPath: ['/mnt/libs'],
});

await sandbox.run('python3 -c "from mymodule.core import GREETING; print(GREETING)"');
// stdout: "hello from mymodule"
```

### Python

```python
from codepod import Sandbox, MemoryFS

lib = MemoryFS({
    "mymodule/__init__.py": b"",
    "mymodule/core.py": b"GREETING = 'hello from mymodule'",
})

with Sandbox(
    mounts=[("/mnt/libs", lib)],
    python_path=["/mnt/libs"],
) as sb:
    result = sb.commands.run(
        'python3 -c "from mymodule.core import GREETING; print(GREETING)"'
    )
    print(result.stdout)  # "hello from mymodule"
```

PYTHONPATH is set to `user_paths + ['/usr/lib/python']`. The `/usr/lib/python` entry is always appended because it contains system modules (e.g. the socket shim when networking is enabled). User paths come first, so your modules take priority.

## Behavior details

### Visibility

Mount points appear in directory listings:

```bash
ls /mnt          # shows "tools" if /mnt/tools is mounted
ls /mnt/tools    # shows files in the mount
cat /mnt/tools/hello.sh  # reads from the mount provider
```

### Read-only by default

Mounts are read-only unless `writable` is set:

**TypeScript:**
```typescript
// Read-only (default)
sandbox.mount('/mnt/data', { 'file.txt': encode('read only') });

// Writable (via MountConfig at create time)
await Sandbox.create({
  wasmDir: './wasm',
  mounts: [{ path: '/mnt/scratch', files: {}, writable: true }],
});
```

Writing to a read-only mount produces `EROFS: read-only mount`.

### Persistence exclusion

Mounted files are automatically excluded from `exportState()` / `importState()`. They are host-provided resources, not sandbox-produced state. When you restore state into a new sandbox, you need to re-mount the same files.

### Fork behavior

Forked sandboxes (`sandbox.fork()`) inherit all mounts from the parent. The mount providers are shared by reference — both parent and child see the same files. This is efficient and correct for read-only mounts.

### File size considerations

All mount data is transferred in-memory (and over JSON-RPC for the Python SDK). For the Python SDK, files are base64-encoded for transport, adding ~33% overhead. Keep individual mounts under a few MB for best performance. For larger datasets, consider writing files directly via `sandbox.writeFile()` or `sb.files.write()` instead.

## API reference

### TypeScript

| API | Description |
|-----|-------------|
| `SandboxOptions.mounts` | `MountConfig[]` — mounts applied at creation time |
| `SandboxOptions.pythonPath` | `string[]` — directories added to PYTHONPATH |
| `sandbox.mount(path, files)` | Mount a `Record<string, Uint8Array>` or `VirtualProvider` at runtime |
| `MountConfig.path` | Absolute mount path (e.g. `'/mnt/tools'`) |
| `MountConfig.files` | `Record<string, Uint8Array>` — flat map of subpaths to file contents |
| `MountConfig.writable` | `boolean` — allow writes (default `false`) |
| `HostMount` | `VirtualProvider` implementation with in-memory file tree |
| `HostMount.addFile(path, data)` | Add a file after construction |

### Python

| API | Description |
|-----|-------------|
| `Sandbox(mounts=...)` | `list[tuple[str, dict \| VirtualFileSystem]]` — creation-time mounts |
| `Sandbox(python_path=...)` | `list[str]` — directories added to PYTHONPATH |
| `sandbox.mount(path, files)` | Mount a `dict[str, bytes]` or `VirtualFileSystem` at runtime |
| `VirtualFileSystem` | ABC with `read_file`, `write_file`, `exists`, `stat`, `readdir` |
| `MemoryFS(files, writable=False)` | In-memory VFS from flat dict |
| `FileStat` | Dataclass: `type` (`"file"` / `"dir"`), `size` |
| `DirEntry` | Dataclass: `name`, `type` |
