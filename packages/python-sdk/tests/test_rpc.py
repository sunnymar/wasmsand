import os
import shutil
import subprocess
import pytest
from codepod._rpc import RpcClient, RpcError

SERVER_SCRIPT = os.path.join(
    os.path.dirname(__file__), "..", "..", "sdk-server", "src", "server.ts"
)
WASM_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "orchestrator", "src", "platform", "__tests__", "fixtures"
)
SHELL_WASM = os.path.join(
    os.path.dirname(__file__), "..", "..", "orchestrator", "src", "platform", "__tests__", "fixtures", "codepod-shell-exec.wasm"
)
ORCHESTRATOR_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "orchestrator"
)
ORCHESTRATOR_NODE_ADAPTER = os.path.join(
    ORCHESTRATOR_DIR, "dist", "node-adapter.js"
)


def _ensure_orchestrator_build() -> None:
    if os.path.exists(ORCHESTRATOR_NODE_ADAPTER):
        return
    runtime = shutil.which("deno")
    assert runtime is not None, "Deno not found on PATH"
    subprocess.run([runtime, "task", "build"], cwd=ORCHESTRATOR_DIR, check=True)


@pytest.fixture
def client():
    """Start RPC client, create sandbox, yield client, kill on teardown."""
    runtime = shutil.which("deno")
    assert runtime is not None, "Deno not found on PATH"
    _ensure_orchestrator_build()
    server_args = ["run", "-A", "--no-check", "--unstable-sloppy-imports", SERVER_SCRIPT]
    c = RpcClient(runtime, server_args)
    c.start()
    result = c.call("create", {"wasmDir": WASM_DIR, "shellWasmPath": SHELL_WASM})
    assert result["ok"] is True
    yield c
    try:
        c.call("kill", {})
    except Exception:
        pass
    c.stop()


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
