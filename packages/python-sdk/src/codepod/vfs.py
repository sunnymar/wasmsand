"""
Virtual filesystem abstractions for host-side VFS mounts.

Provides a VirtualFileSystem ABC that mirrors the TypeScript VirtualProvider
interface, plus a MemoryFS convenience class for in-memory file trees.

Usage::

    from codepod import Sandbox, MemoryFS

    fs = MemoryFS({
        "lib/__init__.py": b"",
        "lib/utils.py": b"def greet(): return 'hello'",
    })

    with Sandbox() as sb:
        sb.mount("/mnt/pkg", fs)
        result = sb.commands.run("cat /mnt/pkg/lib/utils.py")
"""

from __future__ import annotations

import base64
from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class FileStat:
    """File or directory metadata."""
    type: str  # "file" or "dir"
    size: int


@dataclass
class DirEntry:
    """A single entry in a directory listing."""
    name: str
    type: str  # "file" or "dir"


class VirtualFileSystem(ABC):
    """Abstract base class for host-side virtual filesystem providers.

    Mirrors the TypeScript VirtualProvider interface. Subclass this to
    implement custom file sources (local disk, database, HTTP, etc.).

    All paths are relative to the mount point (no leading slash).
    An empty string means the root of the mount.
    """

    @abstractmethod
    def read_file(self, path: str) -> bytes:
        """Read the contents of a file. Raise FileNotFoundError if missing."""
        ...

    @abstractmethod
    def write_file(self, path: str, data: bytes) -> None:
        """Write data to a file. Raise PermissionError if read-only."""
        ...

    @abstractmethod
    def exists(self, path: str) -> bool:
        """Check whether a file or directory exists."""
        ...

    @abstractmethod
    def stat(self, path: str) -> FileStat:
        """Return type and size for the given path."""
        ...

    @abstractmethod
    def readdir(self, path: str) -> list[DirEntry]:
        """List entries in a directory."""
        ...

    def _to_flat_files(self) -> dict[str, bytes]:
        """Walk the tree and return a flat {subpath: bytes} dict.

        Used internally to serialize the VFS for transport over RPC.
        Walks directories recursively starting from the root.
        """
        result: dict[str, bytes] = {}
        self._walk("", result)
        return result

    def _walk(self, prefix: str, out: dict[str, bytes]) -> None:
        entries = self.readdir(prefix)
        for entry in entries:
            subpath = f"{prefix}/{entry.name}" if prefix else entry.name
            if entry.type == "dir":
                self._walk(subpath, out)
            else:
                out[subpath] = self.read_file(subpath)


class MemoryFS(VirtualFileSystem):
    """In-memory VFS backed by a flat dict of files.

    Flat keys like ``'lib/__init__.py'`` auto-create intermediate
    directory structure for readdir/stat operations.

    Args:
        files: Mapping of relative paths to file contents.
            Values can be ``bytes`` or ``str`` (auto-encoded to UTF-8).
        writable: Allow writes. Default False.
    """

    def __init__(self, files: dict[str, bytes | str] | None = None, *, writable: bool = False):
        self._files: dict[str, bytes] = {}
        self._writable = writable
        if files:
            for path, data in files.items():
                if isinstance(data, str):
                    data = data.encode("utf-8")
                self._files[_normalize(path)] = data

    def read_file(self, path: str) -> bytes:
        path = _normalize(path)
        if path in self._files:
            return self._files[path]
        # Check if it's a directory
        if self._is_dir(path):
            raise IsADirectoryError(path)
        raise FileNotFoundError(path)

    def write_file(self, path: str, data: bytes) -> None:
        if not self._writable:
            raise PermissionError("read-only filesystem")
        path = _normalize(path)
        if isinstance(data, str):
            data = data.encode("utf-8")
        self._files[path] = data

    def exists(self, path: str) -> bool:
        path = _normalize(path)
        if path == "":
            return True
        if path in self._files:
            return True
        return self._is_dir(path)

    def stat(self, path: str) -> FileStat:
        path = _normalize(path)
        if path == "":
            return FileStat(type="dir", size=len(self.readdir("")))
        if path in self._files:
            return FileStat(type="file", size=len(self._files[path]))
        if self._is_dir(path):
            return FileStat(type="dir", size=len(self.readdir(path)))
        raise FileNotFoundError(path)

    def readdir(self, path: str) -> list[DirEntry]:
        path = _normalize(path)
        prefix = f"{path}/" if path else ""
        seen: dict[str, str] = {}  # name -> type

        for fpath in self._files:
            if not fpath.startswith(prefix):
                continue
            rest = fpath[len(prefix):]
            if not rest:
                continue
            parts = rest.split("/")
            name = parts[0]
            if name not in seen:
                seen[name] = "dir" if len(parts) > 1 else "file"
            elif len(parts) > 1:
                # If we see a deeper path, it must be a directory
                pass  # already "dir" or "file" — if "file" then there's a conflict, prefer dir
            # A name that appears both as file and prefix of deeper paths: treat as dir

        return [DirEntry(name=n, type=t) for n, t in seen.items()]

    def _is_dir(self, path: str) -> bool:
        """Check if path is an implicit directory (prefix of any file)."""
        prefix = f"{path}/"
        return any(f.startswith(prefix) for f in self._files)

    def _to_flat_files(self) -> dict[str, bytes]:
        """Optimized: we already have the flat dict."""
        return dict(self._files)


def _normalize(path: str) -> str:
    """Normalize a relative path: strip leading/trailing slashes, collapse dots."""
    parts = [p for p in path.split("/") if p and p != "."]
    return "/".join(parts)


def _encode_files_for_rpc(files: dict[str, bytes]) -> dict[str, str]:
    """Encode a flat file dict to base64 for JSON-RPC transport."""
    return {k: base64.b64encode(v).decode("ascii") for k, v in files.items()}
