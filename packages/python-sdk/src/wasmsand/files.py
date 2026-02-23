import base64
from wasmsand._rpc import RpcClient
from wasmsand._types import FileInfo


class Files:
    def __init__(self, client: RpcClient):
        self._client = client

    def read(self, path: str) -> bytes:
        result = self._client.call("files.read", {"path": path})
        return base64.b64decode(result["data"])

    def write(self, path: str, data: bytes | str) -> None:
        if isinstance(data, str):
            data = data.encode("utf-8")
        encoded = base64.b64encode(data).decode("ascii")
        self._client.call("files.write", {"path": path, "data": encoded})

    def list(self, path: str) -> list[FileInfo]:
        result = self._client.call("files.list", {"path": path})
        return [FileInfo(name=e["name"], type=e["type"], size=e["size"]) for e in result["entries"]]

    def mkdir(self, path: str) -> None:
        self._client.call("files.mkdir", {"path": path})

    def rm(self, path: str) -> None:
        self._client.call("files.rm", {"path": path})

    def stat(self, path: str) -> FileInfo:
        result = self._client.call("files.stat", {"path": path})
        return FileInfo(name=result["name"], type=result["type"], size=result["size"])
