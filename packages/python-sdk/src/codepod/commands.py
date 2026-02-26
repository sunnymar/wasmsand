from codepod._rpc import RpcClient
from codepod._types import CommandResult


class Commands:
    def __init__(self, client: RpcClient, sandbox_id: str | None = None):
        self._client = client
        self._sandbox_id = sandbox_id

    def run(self, command: str) -> CommandResult:
        params: dict = {"command": command}
        if self._sandbox_id is not None:
            params["sandboxId"] = self._sandbox_id
        result = self._client.call("run", params)
        return CommandResult(
            stdout=result["stdout"],
            stderr=result["stderr"],
            exit_code=result["exitCode"],
            execution_time_ms=result["executionTimeMs"],
            truncated=result.get("truncated"),
            error_class=result.get("errorClass"),
        )
