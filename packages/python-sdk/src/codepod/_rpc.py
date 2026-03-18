import json
import subprocess
from typing import Any, Callable


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class RpcClient:
    def __init__(self, runtime_path: str, server_args: list[str]):
        self._runtime_path = runtime_path
        self._server_args = server_args
        self._proc: subprocess.Popen | None = None
        self._next_id = 1
        self._extension_handlers: dict[str, Callable] = {}
        self._output_handlers: dict[int | str, dict[str, Callable]] = {}

    def start(self) -> None:
        self._proc = subprocess.Popen(
            [self._runtime_path, *self._server_args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def register_output_handler(
        self, request_id: int, on_stdout: Callable | None, on_stderr: Callable | None
    ) -> None:
        handlers: dict[str, Callable] = {}
        if on_stdout:
            handlers["stdout"] = on_stdout
        if on_stderr:
            handlers["stderr"] = on_stderr
        if handlers:
            self._output_handlers[request_id] = handlers

    def unregister_output_handler(self, request_id: int) -> None:
        self._output_handlers.pop(request_id, None)

    def register_extension_handler(self, name: str, handler: Callable) -> None:
        """Register a handler for extension callback requests from the server."""
        self._extension_handlers[name] = handler

    def call(self, method: str, params: dict | None = None) -> Any:
        if self._proc is None or self._proc.stdin is None or self._proc.stdout is None:
            raise RuntimeError("RPC client not started")
        req_id = self._next_id
        self._next_id += 1
        request = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}}
        line = json.dumps(request) + "\n"
        self._proc.stdin.write(line.encode())
        self._proc.stdin.flush()

        # Read responses, handling interleaved callback requests from the server
        while True:
            resp_line = self._proc.stdout.readline()
            if not resp_line:
                raise RuntimeError("Server closed connection")
            msg = json.loads(resp_line)

            # Output streaming notification (no id, method = "output")
            if "method" in msg and msg["method"] == "output" and "id" not in msg:
                params = msg.get("params", {})
                rid = params.get("request_id")
                handlers = self._output_handlers.get(rid, {})
                stream_type = params.get("stream")
                data = params.get("data", "")
                handler = handlers.get(stream_type)
                if handler:
                    handler(data)
                continue

            # Callback request from server? (id starts with 'cb_' and has a method)
            if (
                "method" in msg
                and isinstance(msg.get("id"), str)
                and msg["id"].startswith("cb_")
            ):
                self._handle_callback(msg)
                continue

            # Normal response to our request
            if "error" in msg and msg["error"]:
                raise RpcError(msg["error"]["code"], msg["error"]["message"])
            return msg.get("result")

    def _handle_callback(self, msg: dict) -> None:
        """Handle a callback request from the server and send back the response."""
        cb_id = msg["id"]
        method = msg["method"]
        params = msg.get("params", {})

        try:
            if method == "extension.invoke":
                name = params.get("name", "")
                handler = self._extension_handlers.get(name)
                if handler is None:
                    self._send_callback_error(cb_id, f"No handler for extension: {name}")
                    return
                result = handler(
                    args=params.get("args", []),
                    stdin=params.get("stdin", ""),
                    env=params.get("env", {}),
                    cwd=params.get("cwd", "/"),
                )
                self._send_callback_result(cb_id, result)
            else:
                self._send_callback_error(cb_id, f"Unknown callback method: {method}")
        except Exception as e:
            self._send_callback_error(cb_id, str(e))

    def _send_callback_result(self, cb_id: str, result: Any) -> None:
        resp = {"jsonrpc": "2.0", "id": cb_id, "result": result}
        line = json.dumps(resp) + "\n"
        self._proc.stdin.write(line.encode())  # type: ignore[union-attr]
        self._proc.stdin.flush()  # type: ignore[union-attr]

    def _send_callback_error(self, cb_id: str, message: str) -> None:
        resp = {"jsonrpc": "2.0", "id": cb_id, "error": {"code": -32603, "message": message}}
        line = json.dumps(resp) + "\n"
        self._proc.stdin.write(line.encode())  # type: ignore[union-attr]
        self._proc.stdin.flush()  # type: ignore[union-attr]

    def stop(self) -> None:
        if self._proc is not None:
            proc, self._proc = self._proc, None
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
