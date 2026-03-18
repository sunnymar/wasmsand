from codepod import Sandbox


class TestSandboxManager:
    """End-to-end tests for SandboxManager / SandboxRef.

    These spawn a real Deno subprocess and exercise the sandbox.create,
    sandbox.list, and sandbox.remove RPC methods added in Tasks 7-8.
    """

    def test_create_and_list(self):
        """Create a sandbox via SandboxManager and verify it appears in list."""
        with Sandbox() as sbx:
            ref = sbx.sandboxes.create(label="test-list")
            try:
                sandboxes = sbx.sandboxes.list()
                ids = [s.sandbox_id for s in sandboxes]
                assert ref.sandbox_id in ids
            finally:
                sbx.sandboxes.remove(ref.sandbox_id)

    def test_create_and_remove(self):
        """Create a sandbox then remove it, verify it's gone from the list."""
        with Sandbox() as sbx:
            ref = sbx.sandboxes.create(label="test-remove")
            sbx.sandboxes.remove(ref.sandbox_id)
            sandboxes = sbx.sandboxes.list()
            ids = [s.sandbox_id for s in sandboxes]
            assert ref.sandbox_id not in ids

    def test_sandbox_ref_commands(self):
        """Create a sandbox via SandboxManager and run a command in it."""
        with Sandbox() as sbx:
            ref = sbx.sandboxes.create()
            try:
                result = ref.commands.run("echo hello")
                assert result.exit_code == 0
                assert "hello" in result.stdout
            finally:
                sbx.sandboxes.remove(ref.sandbox_id)

    def test_sandbox_ref_files(self):
        """Create a sandbox via SandboxManager and write/read a file in it."""
        with Sandbox() as sbx:
            ref = sbx.sandboxes.create()
            try:
                ref.files.write("/tmp/test.txt", "sandbox manager file")
                content = ref.files.read("/tmp/test.txt")
                assert content == b"sandbox manager file"
            finally:
                sbx.sandboxes.remove(ref.sandbox_id)
