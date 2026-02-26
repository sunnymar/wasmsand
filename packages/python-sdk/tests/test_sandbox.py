import pytest
from codepod import Sandbox


class TestSandbox:
    def test_create_and_kill(self):
        sandbox = Sandbox()
        sandbox.kill()

    def test_context_manager(self):
        with Sandbox() as sbx:
            result = sbx.commands.run("echo hello")
            assert result.exit_code == 0

    def test_missing_bun_raises(self, monkeypatch):
        monkeypatch.setattr("shutil.which", lambda _: None)
        monkeypatch.setattr("codepod.sandbox._is_bundled", lambda: False)
        with pytest.raises(RuntimeError, match="Bun not found"):
            Sandbox()


class TestSandboxEndToEnd:
    """End-to-end tests exercising the full stack:
    Python SDK -> RPC client -> Bun subprocess -> SDK server -> Sandbox -> WASM tools.

    These tests focus on cross-layer integration: combining file operations
    with command execution, sequential operations, and verifying data flows
    correctly through all layers.
    """

    def test_write_file_then_cat(self):
        """Write a file via the Files API, then read it back via a shell command."""
        with Sandbox() as sbx:
            sbx.files.write("/tmp/input.txt", "hello from python")
            result = sbx.commands.run("cat /tmp/input.txt")
            assert result.exit_code == 0
            assert result.stdout == "hello from python"

    def test_command_output_to_file(self):
        """Use a shell redirect to write output, then read via Files API."""
        with Sandbox() as sbx:
            sbx.commands.run("echo generated > /tmp/out.txt")
            content = sbx.files.read("/tmp/out.txt")
            assert b"generated" in content

    def test_multiple_commands_sequential(self):
        """Run multiple commands sequentially and verify cumulative effects."""
        with Sandbox() as sbx:
            sbx.files.write("/tmp/multi.txt", "line1\n")
            sbx.commands.run("echo line2 >> /tmp/multi.txt")
            result = sbx.commands.run("cat /tmp/multi.txt")
            assert "line1" in result.stdout
            assert "line2" in result.stdout

    def test_env_variable_persistence(self):
        """Set an env variable via assignment and read it back in a later command."""
        with Sandbox() as sbx:
            sbx.commands.run("MY_VAR=hello_world")
            result = sbx.commands.run("echo $MY_VAR")
            assert result.stdout.strip() == "hello_world"

    def test_write_read_roundtrip_binary(self):
        """Write binary data via Files API and read it back, verifying full roundtrip."""
        with Sandbox() as sbx:
            data = bytes(range(256))
            sbx.files.write("/tmp/binary.bin", data)
            read_back = sbx.files.read("/tmp/binary.bin")
            assert read_back == data

    def test_mkdir_write_list_stat_rm_lifecycle(self):
        """Full file lifecycle: mkdir -> write -> list -> stat -> rm -> verify gone."""
        with Sandbox() as sbx:
            sbx.files.mkdir("/tmp/project")
            sbx.files.write("/tmp/project/data.txt", "content")

            entries = sbx.files.list("/tmp/project")
            names = [e.name for e in entries]
            assert "data.txt" in names

            info = sbx.files.stat("/tmp/project/data.txt")
            assert info.type == "file"
            assert info.size == 7  # len("content")

            sbx.files.rm("/tmp/project/data.txt")
            entries_after = sbx.files.list("/tmp/project")
            names_after = [e.name for e in entries_after]
            assert "data.txt" not in names_after

    def test_pipeline_with_file(self):
        """Write a multi-line file, then use a pipeline to process it."""
        with Sandbox() as sbx:
            sbx.files.write("/tmp/lines.txt", "aaa\nbbb\nccc\n")
            result = sbx.commands.run("cat /tmp/lines.txt | wc -l")
            assert result.exit_code == 0
            assert result.stdout.strip() == "3"

    def test_multiple_sandboxes_isolated(self):
        """Two sandboxes have completely separate file systems."""
        with Sandbox() as sbx1:
            sbx1.files.write("/tmp/only_in_1.txt", "sandbox1")

            with Sandbox() as sbx2:
                from codepod._rpc import RpcError

                with pytest.raises(RpcError) as exc_info:
                    sbx2.files.read("/tmp/only_in_1.txt")
                assert "ENOENT" in exc_info.value.message

    def test_command_after_file_operations(self):
        """Verify commands work correctly after multiple file operations."""
        with Sandbox() as sbx:
            # Perform several file operations
            sbx.files.mkdir("/tmp/workdir")
            sbx.files.write("/tmp/workdir/a.txt", "alpha")
            sbx.files.write("/tmp/workdir/b.txt", "bravo")

            # Then run a command that reads one of the files
            result = sbx.commands.run("cat /tmp/workdir/a.txt")
            assert result.stdout == "alpha"

            # List via command
            result = sbx.commands.run("ls /tmp/workdir")
            assert "a.txt" in result.stdout
            assert "b.txt" in result.stdout

    def test_export_import_roundtrip(self):
        """Export state, overwrite data, import, and verify restoration."""
        with Sandbox() as sbx:
            sbx.files.write("/tmp/persist.txt", b"persisted data")
            blob = sbx.export_state()
            assert len(blob) > 0
            sbx.files.write("/tmp/persist.txt", b"overwritten")
            sbx.import_state(blob)
            content = sbx.files.read("/tmp/persist.txt")
            assert content == b"persisted data"
