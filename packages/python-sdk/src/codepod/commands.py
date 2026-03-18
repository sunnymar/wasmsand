from typing import Callable

from codepod._rpc import RpcClient
from codepod._types import CommandResult


class Commands:
    def __init__(self, client: RpcClient, sandbox_id: str | None = None):
        self._client = client
        self._sandbox_id = sandbox_id

    def run(
        self,
        command: str,
        *,
        stream: bool = False,
        on_stdout: "Callable[[str], None] | None" = None,
        on_stderr: "Callable[[str], None] | None" = None,
    ) -> CommandResult:
        params: dict = {"command": command}
        if self._sandbox_id is not None:
            params["sandboxId"] = self._sandbox_id
        if stream:
            params["stream"] = True

        # Register output handlers before the RPC call
        req_id = self._client._next_id  # peek at the next request ID
        if stream and (on_stdout or on_stderr):
            self._client.register_output_handler(req_id, on_stdout, on_stderr)

        try:
            result = self._client.call("run", params)
        finally:
            if stream:
                self._client.unregister_output_handler(req_id)

        return CommandResult(
            stdout=result["stdout"],
            stderr=result["stderr"],
            exit_code=result["exitCode"],
            execution_time_ms=result["executionTimeMs"],
            truncated=result.get("truncated"),
            error_class=result.get("errorClass"),
        )
