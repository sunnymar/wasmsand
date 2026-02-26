"""Unit tests for the VFS module (no sandbox needed)."""

from codepod.vfs import VirtualFileSystem, MemoryFS, FileStat, DirEntry


class TestMemoryFS:
    def test_read_file(self):
        fs = MemoryFS({"hello.txt": b"hello world"})
        assert fs.read_file("hello.txt") == b"hello world"

    def test_read_file_str_auto_encodes(self):
        fs = MemoryFS({"msg.txt": "utf8 text"})
        assert fs.read_file("msg.txt") == b"utf8 text"

    def test_read_file_missing_raises(self):
        fs = MemoryFS({})
        try:
            fs.read_file("nope.txt")
            assert False, "should have raised"
        except FileNotFoundError:
            pass

    def test_exists(self):
        fs = MemoryFS({"dir/file.txt": b"x"})
        assert fs.exists("") is True
        assert fs.exists("dir") is True
        assert fs.exists("dir/file.txt") is True
        assert fs.exists("nope") is False

    def test_stat_file(self):
        fs = MemoryFS({"data.bin": b"12345"})
        s = fs.stat("data.bin")
        assert s.type == "file"
        assert s.size == 5

    def test_stat_dir(self):
        fs = MemoryFS({"dir/a.txt": b"a", "dir/b.txt": b"b"})
        s = fs.stat("dir")
        assert s.type == "dir"
        assert s.size == 2

    def test_stat_root(self):
        fs = MemoryFS({"a.txt": b"a"})
        s = fs.stat("")
        assert s.type == "dir"
        assert s.size == 1

    def test_stat_missing_raises(self):
        fs = MemoryFS({})
        try:
            fs.stat("nope")
            assert False, "should have raised"
        except FileNotFoundError:
            pass

    def test_readdir_root(self):
        fs = MemoryFS({"a.txt": b"a", "b.txt": b"b", "sub/c.txt": b"c"})
        entries = fs.readdir("")
        names = {e.name for e in entries}
        assert names == {"a.txt", "b.txt", "sub"}
        types = {e.name: e.type for e in entries}
        assert types["a.txt"] == "file"
        assert types["sub"] == "dir"

    def test_readdir_subdir(self):
        fs = MemoryFS({"lib/__init__.py": b"", "lib/utils.py": b"x"})
        entries = fs.readdir("lib")
        names = sorted(e.name for e in entries)
        assert names == ["__init__.py", "utils.py"]

    def test_write_file_writable(self):
        fs = MemoryFS({}, writable=True)
        fs.write_file("new.txt", b"hello")
        assert fs.read_file("new.txt") == b"hello"

    def test_write_file_readonly_raises(self):
        fs = MemoryFS({})
        try:
            fs.write_file("test.txt", b"x")
            assert False, "should have raised"
        except PermissionError:
            pass

    def test_to_flat_files(self):
        fs = MemoryFS({"a.txt": b"a", "dir/b.txt": b"b"})
        flat = fs._to_flat_files()
        assert flat == {"a.txt": b"a", "dir/b.txt": b"b"}

    def test_path_normalization(self):
        """Leading slashes and dots are stripped."""
        fs = MemoryFS({"./dir/file.txt": b"x"})
        assert fs.read_file("dir/file.txt") == b"x"
        assert fs.exists("dir/file.txt") is True


class TestVirtualFileSystemABC:
    """Test that VFS subclasses work correctly with _to_flat_files."""

    def test_custom_vfs_walk(self):
        class DictFS(VirtualFileSystem):
            def __init__(self):
                self._data = {"a.txt": b"aaa", "sub/b.txt": b"bbb"}

            def read_file(self, path):
                if path in self._data:
                    return self._data[path]
                raise FileNotFoundError(path)

            def write_file(self, path, data):
                raise PermissionError("read-only")

            def exists(self, path):
                if path == "":
                    return True
                return path in self._data or any(
                    f.startswith(path + "/") for f in self._data
                )

            def stat(self, path):
                if path in self._data:
                    return FileStat(type="file", size=len(self._data[path]))
                if self.exists(path):
                    return FileStat(type="dir", size=0)
                raise FileNotFoundError(path)

            def readdir(self, path):
                prefix = f"{path}/" if path else ""
                seen = {}
                for fpath in self._data:
                    if not fpath.startswith(prefix):
                        continue
                    rest = fpath[len(prefix):]
                    if not rest:
                        continue
                    parts = rest.split("/")
                    name = parts[0]
                    if name not in seen:
                        seen[name] = "dir" if len(parts) > 1 else "file"
                return [DirEntry(name=n, type=t) for n, t in seen.items()]

        fs = DictFS()
        flat = fs._to_flat_files()
        assert flat == {"a.txt": b"aaa", "sub/b.txt": b"bbb"}
