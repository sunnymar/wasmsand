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
