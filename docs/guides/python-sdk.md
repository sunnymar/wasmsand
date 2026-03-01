# Python SDK

## Install

```bash
pip install codepod
```

The Python wheel is self-contained — it bundles the Bun runtime, the RPC server, and all WASM binaries. No extra dependencies needed.

## Quick start

```python
from codepod import Sandbox

with Sandbox() as sb:
    result = sb.commands.run("ls -la /home/user")
    print(result.stdout)

    sb.files.write("/home/user/data.csv", b"name,score\nalice,95\nbob,87\n")
    result = sb.commands.run("cat /home/user/data.csv | sort -t, -k2 -rn")
    print(result.stdout)
```

## Constructor options

```python
sb = Sandbox(
    timeout_ms=60_000,               # per-command timeout (default 30s)
    fs_limit_bytes=512 * 1024 * 1024, # VFS size limit (default 256 MB)
    mounts=[("/mnt/data", {"f.txt": b"hello"})],
    python_path=["/mnt/libs"],
    extensions=[Extension(name="mytool", command=my_handler)],
)
```

## Running commands

The `run()` method returns a `CommandResult`:

```python
result = sb.commands.run("echo hello")
result.stdout        # "hello\n"
result.stderr        # ""
result.exit_code     # 0
result.execution_time_ms  # e.g. 12.5
```

## File operations

```python
# Write (bytes or str)
sb.files.write("/tmp/msg.txt", "hello world")
sb.files.write("/tmp/data.bin", b"\x00\x01\x02")

# Read (always returns bytes)
data = sb.files.read("/tmp/msg.txt")  # b"hello world"

# List directory
entries = sb.files.list("/tmp")
for entry in entries:
    print(entry.name, entry.type, entry.size)  # "msg.txt" "file" 11

# Stat
info = sb.files.stat("/tmp/msg.txt")
info.name   # "msg.txt"
info.type   # "file"
info.size   # 11

# Create directory
sb.files.mkdir("/tmp/subdir")

# Remove file
sb.files.rm("/tmp/msg.txt")
```

## Error handling

File operations raise `RpcError` on failure:

```python
from codepod._rpc import RpcError

try:
    sb.files.read("/nonexistent")
except RpcError as e:
    print(e.code)     # 1
    print(e.message)  # "ENOENT: ..."
```

## Host mounts

Mount host-provided files into the sandbox:

```python
from codepod import Sandbox, MemoryFS

# At creation time
with Sandbox(
    mounts=[("/mnt/tools", {"hello.sh": b"#!/bin/sh\necho hi"})],
    python_path=["/mnt/libs"],
) as sb:
    sb.commands.run("cat /mnt/tools/hello.sh")

# At runtime
sb.mount("/mnt/uploads", {"data.csv": b"a,b,c\n1,2,3\n"})
```

For structured file trees, use `MemoryFS`:

```python
from codepod import Sandbox, MemoryFS

fs = MemoryFS({
    "mylib/__init__.py": b"",
    "mylib/utils.py": b"def greet(): return 'hello'",
})

with Sandbox(mounts=[("/mnt/pkg", fs)], python_path=["/mnt/pkg"]) as sb:
    sb.commands.run("ls /mnt/pkg/mylib")
```

You can also subclass `VirtualFileSystem` to implement custom file sources (local disk, database, HTTP):

```python
from codepod import VirtualFileSystem, FileStat, DirEntry

class LocalDirFS(VirtualFileSystem):
    def __init__(self, root: str):
        self.root = root

    def read_file(self, path: str) -> bytes:
        return open(f"{self.root}/{path}", "rb").read()

    def exists(self, path: str) -> bool:
        return os.path.exists(f"{self.root}/{path}")

    def stat(self, path: str) -> FileStat:
        p = f"{self.root}/{path}"
        return FileStat(
            type="dir" if os.path.isdir(p) else "file",
            size=os.path.getsize(p) if os.path.isfile(p) else 0,
        )

    def readdir(self, path: str) -> list[DirEntry]:
        p = f"{self.root}/{path}" if path else self.root
        return [
            DirEntry(name=e, type="dir" if os.path.isdir(f"{p}/{e}") else "file")
            for e in os.listdir(p)
        ]

    def write_file(self, path: str, data: bytes) -> None:
        raise PermissionError("read-only")
```

When mounted, the VFS is walked and serialized to the sandbox. Files are snapshotted at mount time — changes to the source after mounting are not reflected.

See [Mounting Files](mounting-files.md) for detailed examples and patterns.

## API reference

### `Sandbox`

| Method / Property | Description |
|---|---|
| `Sandbox(*, timeout_ms, fs_limit_bytes, mounts, python_path, extensions)` | Create a new sandbox. Use as a context manager. |
| `sb.commands.run(command) -> CommandResult` | Execute a shell command. |
| `sb.files.read(path) -> bytes` | Read file contents. |
| `sb.files.write(path, data)` | Write `bytes` or `str` to a file. |
| `sb.files.list(path) -> list[FileInfo]` | List directory entries. |
| `sb.files.stat(path) -> FileInfo` | Get file/directory metadata. |
| `sb.files.mkdir(path)` | Create a directory. |
| `sb.files.rm(path)` | Remove a file. |
| `sb.mount(path, files)` | Mount host files at runtime. Accepts `dict` or `VirtualFileSystem`. |
| `sb.snapshot() -> str` | Save VFS + env state. Returns snapshot ID. |
| `sb.restore(snapshot_id)` | Restore to a previous snapshot. |
| `sb.export_state() -> bytes` | Export full state as a binary blob. |
| `sb.import_state(blob)` | Import a previously exported state. |
| `sb.fork() -> Sandbox` | Create an independent forked sandbox. |
| `sb.destroy()` | Destroy a forked sandbox. |
| `sb.kill()` | Shut down the RPC server (root sandbox only). |

### Data types

```python
from codepod import CommandResult, FileInfo, MemoryFS, VirtualFileSystem, FileStat, DirEntry, Extension, PythonPackage

# CommandResult (returned by commands.run)
result.stdout: str
result.stderr: str
result.exit_code: int
result.execution_time_ms: float

# FileInfo (returned by files.list, files.stat)
info.name: str       # filename
info.type: str       # "file" or "dir"
info.size: int       # bytes (files) or entry count (dirs)

# FileStat (used by VirtualFileSystem.stat)
stat.type: str       # "file" or "dir"
stat.size: int

# DirEntry (used by VirtualFileSystem.readdir)
entry.name: str
entry.type: str      # "file" or "dir"
```

### `VirtualFileSystem`

Subclass to implement custom file sources. All paths are relative to the mount point.

| Method | Description |
|---|---|
| `read_file(path) -> bytes` | Read file. Raise `FileNotFoundError` if missing. |
| `write_file(path, data)` | Write file. Raise `PermissionError` if read-only. |
| `exists(path) -> bool` | Check existence. |
| `stat(path) -> FileStat` | Return type and size. |
| `readdir(path) -> list[DirEntry]` | List directory entries. |

`MemoryFS` is a built-in implementation backed by a flat dict — see [Host mounts](#host-mounts) for examples.
