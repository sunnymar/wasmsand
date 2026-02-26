import pytest
from codepod import Sandbox


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
        result = sandbox.commands.run("ls /nonexistent_path")
        assert result.exit_code != 0
        assert "No such file or directory" in result.stderr
