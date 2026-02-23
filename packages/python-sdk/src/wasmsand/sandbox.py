import os
import shutil
from wasmsand._rpc import RpcClient
from wasmsand.commands import Commands
from wasmsand.files import Files

_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_PKG_DIR, "..", "..", "..", ".."))
_SERVER_SCRIPT = os.path.join(_REPO_ROOT, "packages", "sdk-server", "src", "server.ts")
_WASM_DIR = os.path.join(_REPO_ROOT, "packages", "orchestrator", "src", "platform", "__tests__", "fixtures")
_SHELL_WASM = os.path.join(_REPO_ROOT, "packages", "orchestrator", "src", "shell", "__tests__", "fixtures", "wasmsand-shell.wasm")


class Sandbox:
    def __init__(self, *, timeout_ms: int = 30_000, fs_limit_bytes: int = 256 * 1024 * 1024):
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("Node.js not found on PATH")

        self._client = RpcClient(node, _SERVER_SCRIPT, node_args=["--import", "tsx"])
        self._client.start()

        self._client.call("create", {
            "wasmDir": _WASM_DIR,
            "shellWasmPath": _SHELL_WASM,
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
