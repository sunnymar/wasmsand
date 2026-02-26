from __future__ import annotations

import base64
import os
import shutil
from codepod._rpc import RpcClient
from codepod.commands import Commands
from codepod.extension import Extension
from codepod.files import Files
from codepod.vfs import VirtualFileSystem, _encode_files_for_rpc

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
    shell_wasm = os.path.join(wasm_dir, "codepod-shell.wasm")
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
        "codepod-shell.wasm",
    )
    return runtime_path, server, wasm_dir, shell_wasm


MountSpec = dict[str, bytes | str]
"""A flat mapping of relative paths to file contents for mounting."""


class Sandbox:
    """Isolated sandbox with a POSIX shell, virtual filesystem, and Python runtime.

    Args:
        timeout_ms: Per-command wall-clock timeout in milliseconds.
        fs_limit_bytes: Maximum VFS size in bytes.
        mounts: List of ``(path, files)`` tuples to mount at creation time.
            Each ``files`` can be a ``dict[str, bytes|str]`` or a
            :class:`~codepod.vfs.VirtualFileSystem` instance.
        python_path: Directories to add to PYTHONPATH (in addition to /usr/lib/python).
        extensions: List of :class:`~codepod.Extension` instances to register.
    """

    def __init__(
        self,
        *,
        timeout_ms: int = 30_000,
        fs_limit_bytes: int = 256 * 1024 * 1024,
        mounts: list[tuple[str, MountSpec | VirtualFileSystem]] | None = None,
        python_path: list[str] | None = None,
        extensions: list[Extension] | None = None,
        _sandbox_id: str | None = None,
        _client: RpcClient | None = None,
    ):
        if _client is not None:
            # Internal constructor for forked sandboxes
            self._client = _client
            self._sandbox_id = _sandbox_id
            self.commands = Commands(self._client, self._sandbox_id)
            self.files = Files(self._client, self._sandbox_id)
            return

        if _is_bundled():
            runtime, server, wasm_dir, shell_wasm = _bundled_paths()
        else:
            runtime, server, wasm_dir, shell_wasm = _dev_paths()

        self._client = RpcClient(runtime, server)
        self._client.start()
        self._sandbox_id = None

        create_params: dict = {
            "wasmDir": wasm_dir,
            "shellWasmPath": shell_wasm,
            "timeoutMs": timeout_ms,
            "fsLimitBytes": fs_limit_bytes,
        }

        # Encode mounts for create-time mounting
        if mounts:
            create_params["mounts"] = [
                _serialize_mount(path, files) for path, files in mounts
            ]

        if python_path:
            create_params["pythonPath"] = python_path

        # Serialize extensions for RPC and register callback handlers
        if extensions:
            ext_specs = []
            for ext in extensions:
                spec: dict = {
                    "name": ext.name,
                    "description": ext.description,
                    "hasCommand": ext.command is not None,
                }
                if ext.python_package is not None:
                    spec["pythonPackage"] = {
                        "version": ext.python_package.version,
                        "summary": ext.python_package.summary,
                        "files": ext.python_package.files,
                    }
                ext_specs.append(spec)

                # Register the command handler for bidirectional callbacks
                if ext.command is not None:
                    self._client.register_extension_handler(ext.name, ext.command)

            create_params["extensions"] = ext_specs

        self._client.call("create", create_params)

        self.commands = Commands(self._client)
        self.files = Files(self._client)

    def _with_id(self, params: dict) -> dict:
        if self._sandbox_id is not None:
            params["sandboxId"] = self._sandbox_id
        return params

    def mount(self, path: str, files: MountSpec | VirtualFileSystem) -> None:
        """Mount host-provided files into the sandbox at the given path.

        Args:
            path: Absolute mount path (e.g. ``'/mnt/tools'``).
            files: Either a ``dict[str, bytes|str]`` mapping relative paths
                to file contents, or a :class:`~codepod.vfs.VirtualFileSystem`
                instance.

        Example::

            # Simple dict mount
            sb.mount("/mnt/tools", {"hello.sh": b"#!/bin/sh\\necho hi"})

            # VirtualFileSystem mount
            from codepod import MemoryFS
            fs = MemoryFS({"lib/utils.py": b"def greet(): return 'hello'"})
            sb.mount("/mnt/pkg", fs)
        """
        flat = _extract_flat_files(files)
        encoded = _encode_files_for_rpc(flat)
        self._client.call("mount", self._with_id({"path": path, "files": encoded}))

    def snapshot(self) -> str:
        """Save current VFS + env state. Returns snapshot ID."""
        result = self._client.call("snapshot.create", self._with_id({}))
        return result["id"]

    def restore(self, snapshot_id: str) -> None:
        """Restore to a previous snapshot."""
        self._client.call("snapshot.restore", self._with_id({"id": snapshot_id}))

    def export_state(self) -> bytes:
        """Export the full sandbox state (VFS + env) as an opaque blob."""
        result = self._client.call("persistence.export", self._with_id({}))
        return base64.b64decode(result["data"])

    def import_state(self, blob: bytes) -> None:
        """Import a previously exported sandbox state, replacing current state."""
        data = base64.b64encode(blob).decode("ascii")
        self._client.call("persistence.import", self._with_id({"data": data}))

    def fork(self) -> "Sandbox":
        """Create an independent forked sandbox."""
        result = self._client.call("sandbox.fork", self._with_id({}))
        return Sandbox(
            _sandbox_id=result["sandboxId"],
            _client=self._client,
        )

    def destroy(self) -> None:
        """Destroy this forked sandbox. Only valid on forked instances."""
        if self._sandbox_id is None:
            raise RuntimeError("Cannot destroy root sandbox; use kill() instead")
        self._client.call("sandbox.destroy", {"sandboxId": self._sandbox_id})

    def kill(self) -> None:
        try:
            self._client.call("kill", {})
        except Exception:
            pass
        self._client.stop()

    def __enter__(self) -> "Sandbox":
        return self

    def __exit__(self, *exc) -> None:
        if self._sandbox_id is not None:
            try:
                self.destroy()
            except Exception:
                pass
        else:
            self.kill()


def _extract_flat_files(files: MountSpec | VirtualFileSystem) -> dict[str, bytes]:
    """Convert a mount spec or VFS to a flat {path: bytes} dict."""
    if isinstance(files, VirtualFileSystem):
        return files._to_flat_files()
    result: dict[str, bytes] = {}
    for k, v in files.items():
        if isinstance(v, str):
            v = v.encode("utf-8")
        result[k] = v
    return result


def _serialize_mount(path: str, files: MountSpec | VirtualFileSystem) -> dict:
    """Serialize a mount for the create RPC."""
    flat = _extract_flat_files(files)
    encoded = _encode_files_for_rpc(flat)
    return {"path": path, "files": encoded}
