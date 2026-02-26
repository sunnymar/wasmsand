import pytest
from codepod import Sandbox, FileInfo
from codepod._rpc import RpcError


@pytest.fixture
def sandbox():
    with Sandbox() as sbx:
        yield sbx


class TestFiles:
    def test_write_bytes_and_read(self, sandbox):
        sandbox.files.write("/tmp/test.bin", b"\x00\x01\x02\xff")
        content = sandbox.files.read("/tmp/test.bin")
        assert content == b"\x00\x01\x02\xff"

    def test_write_str_and_read(self, sandbox):
        sandbox.files.write("/tmp/msg.txt", "hello world")
        content = sandbox.files.read("/tmp/msg.txt")
        assert content == b"hello world"

    def test_list(self, sandbox):
        sandbox.files.write("/tmp/a.txt", b"aaa")
        sandbox.files.write("/tmp/b.txt", b"bbb")
        entries = sandbox.files.list("/tmp")
        names = {e.name for e in entries}
        assert "a.txt" in names
        assert "b.txt" in names
        assert all(isinstance(e, FileInfo) for e in entries)

    def test_mkdir_and_stat(self, sandbox):
        sandbox.files.mkdir("/tmp/subdir")
        info = sandbox.files.stat("/tmp/subdir")
        assert info.type == "dir"

    def test_rm(self, sandbox):
        sandbox.files.write("/tmp/del.txt", b"gone")
        sandbox.files.rm("/tmp/del.txt")
        with pytest.raises(RpcError) as exc_info:
            sandbox.files.read("/tmp/del.txt")
        assert "ENOENT" in str(exc_info.value)

    def test_stat_file(self, sandbox):
        sandbox.files.write("/tmp/sized.txt", b"12345")
        info = sandbox.files.stat("/tmp/sized.txt")
        assert info.type == "file"
        assert info.size == 5
        assert info.name == "sized.txt"

    def test_read_nonexistent_raises(self, sandbox):
        with pytest.raises(RpcError) as exc_info:
            sandbox.files.read("/tmp/nope.txt")
        assert exc_info.value.code == 1
        assert "ENOENT" in exc_info.value.message
