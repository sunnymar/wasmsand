from wasmsand._rpc import RpcClient
from wasmsand._types import CommandResult


class Commands:
    def __init__(self, client: RpcClient):
        self._client = client

    def run(self, command: str) -> CommandResult:
        result = self._client.call("run", {"command": command})
        return CommandResult(
            stdout=result["stdout"],
            stderr=result["stderr"],
            exit_code=result["exitCode"],
            execution_time_ms=result["executionTimeMs"],
        )
