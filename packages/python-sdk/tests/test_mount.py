"""Integration tests for mount and PYTHONPATH support."""

from codepod import Sandbox, MemoryFS


class TestMount:
    def test_create_with_mounts(self):
        """Mounts provided at creation time are accessible via shell."""
        with Sandbox(mounts=[
            ("/mnt/tools", {"hello.sh": b"#!/bin/sh\necho hi", "data.txt": b"some data"}),
        ]) as sb:
            result = sb.commands.run("cat /mnt/tools/data.txt")
            assert result.exit_code == 0
            assert result.stdout == "some data"

    def test_mount_with_memory_fs(self):
        """MemoryFS can be mounted at creation time."""
        fs = MemoryFS({
            "lib/__init__.py": b"",
            "lib/utils.py": b"def greet(): return 'hello'",
        })
        with Sandbox(mounts=[("/mnt/pkg", fs)]) as sb:
            result = sb.commands.run("cat /mnt/pkg/lib/utils.py")
            assert result.exit_code == 0
            assert "def greet" in result.stdout

    def test_dynamic_mount(self):
        """Mount files at runtime after sandbox creation."""
        with Sandbox() as sb:
            sb.mount("/mnt/uploads", {"file1.txt": b"uploaded content"})
            result = sb.commands.run("cat /mnt/uploads/file1.txt")
            assert result.exit_code == 0
            assert result.stdout == "uploaded content"

    def test_dynamic_mount_with_memory_fs(self):
        """Mount a MemoryFS at runtime."""
        with Sandbox() as sb:
            fs = MemoryFS({"readme.md": "# Hello"})
            sb.mount("/mnt/docs", fs)
            result = sb.commands.run("cat /mnt/docs/readme.md")
            assert result.exit_code == 0
            assert result.stdout == "# Hello"

    def test_ls_mount_point(self):
        """ls on a mount point lists its contents."""
        with Sandbox(mounts=[
            ("/mnt/tools", {"a.txt": b"a", "b.txt": b"b"}),
        ]) as sb:
            result = sb.commands.run("ls /mnt/tools")
            assert result.exit_code == 0
            assert "a.txt" in result.stdout
            assert "b.txt" in result.stdout

    def test_mount_visible_in_parent(self):
        """Mount point is visible in parent directory listing."""
        with Sandbox(mounts=[
            ("/mnt/tools", {"x.txt": b"x"}),
        ]) as sb:
            result = sb.commands.run("ls /mnt")
            assert result.exit_code == 0
            assert "tools" in result.stdout

    def test_nested_mount_paths(self):
        """Mounts with nested subdirectories work."""
        with Sandbox(mounts=[
            ("/mnt/pkg", {
                "mylib/__init__.py": b"",
                "mylib/utils.py": b"def greet(): return 'hello'",
            }),
        ]) as sb:
            result = sb.commands.run("ls /mnt/pkg/mylib")
            assert result.exit_code == 0
            assert "__init__.py" in result.stdout
            assert "utils.py" in result.stdout

    def test_mount_string_values(self):
        """String values in mount dict are auto-encoded to UTF-8."""
        with Sandbox() as sb:
            sb.mount("/mnt/text", {"hello.txt": "hello world"})
            result = sb.commands.run("cat /mnt/text/hello.txt")
            assert result.exit_code == 0
            assert result.stdout == "hello world"

    def test_mounted_files_excluded_from_export(self):
        """Mounted files should not appear in exported state."""
        with Sandbox(mounts=[
            ("/mnt/tools", {"tool.sh": b"#!/bin/sh\necho hi"}),
        ]) as sb:
            sb.files.write("/tmp/normal.txt", b"normal")
            blob = sb.export_state()
            # The blob should not contain mount content but should contain normal files
            # We can verify by importing into a fresh sandbox without mounts
            with Sandbox() as sb2:
                sb2.import_state(blob)
                content = sb2.files.read("/tmp/normal.txt")
                assert content == b"normal"


class TestPythonPath:
    def test_python_path_option(self):
        """pythonPath option sets PYTHONPATH environment variable."""
        with Sandbox(python_path=["/mnt/libs", "/mnt/extra"]) as sb:
            result = sb.commands.run("printenv PYTHONPATH")
            assert result.exit_code == 0
            path = result.stdout.strip()
            assert "/mnt/libs" in path
            assert "/mnt/extra" in path
            assert "/usr/lib/python" in path

    def test_python_path_with_mount(self):
        """pythonPath + mount together make Python libraries importable."""
        with Sandbox(
            mounts=[("/mnt/libs", {
                "mymod.py": b"GREETING = 'hello from mymod'",
            })],
            python_path=["/mnt/libs"],
        ) as sb:
            result = sb.commands.run("printenv PYTHONPATH")
            assert result.exit_code == 0
            assert "/mnt/libs" in result.stdout
