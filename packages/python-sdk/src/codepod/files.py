import base64
from codepod._rpc import RpcClient
from codepod._types import FileInfo


class Files:
    def __init__(self, client: RpcClient, sandbox_id: str | None = None):
        self._client = client
        self._sandbox_id = sandbox_id

    def _params(self, **kwargs) -> dict:
        if self._sandbox_id is not None:
            kwargs["sandboxId"] = self._sandbox_id
        return kwargs

    def read(self, path: str) -> bytes:
        result = self._client.call("files.read", self._params(path=path))
        return base64.b64decode(result["data"])

    def write(self, path: str, data: bytes | str) -> None:
        if isinstance(data, str):
            data = data.encode("utf-8")
        encoded = base64.b64encode(data).decode("ascii")
        self._client.call("files.write", self._params(path=path, data=encoded))

    def list(self, path: str) -> list[FileInfo]:
        result = self._client.call("files.list", self._params(path=path))
        return [FileInfo(name=e["name"], type=e["type"], size=e["size"]) for e in result["entries"]]

    def mkdir(self, path: str) -> None:
        self._client.call("files.mkdir", self._params(path=path))

    def rm(self, path: str) -> None:
        self._client.call("files.rm", self._params(path=path))

    def stat(self, path: str) -> FileInfo:
        result = self._client.call("files.stat", self._params(path=path))
        return FileInfo(name=result["name"], type=result["type"], size=result["size"])
