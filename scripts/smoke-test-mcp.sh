#!/usr/bin/env bash
set -euo pipefail

# Smoke test for the codepod MCP server binary.
# Uses named pipes to send JSON-RPC and read responses.

WASM_DIR="${1:-packages/orchestrator/src/platform/__tests__/fixtures}"
SHELL_WASM="${2:-$WASM_DIR/codepod-shell-exec.wasm}"
MCP_BIN="${MCP_BIN:-./dist/codepod-mcp}"

FIFO_IN=$(mktemp -u)
FIFO_OUT=$(mktemp -u)
mkfifo "$FIFO_IN" "$FIFO_OUT"

cleanup() {
  kill "$MCP_PID" 2>/dev/null || true
  rm -f "$FIFO_IN" "$FIFO_OUT"
}
trap cleanup EXIT

# Start MCP server with named pipes
"$MCP_BIN" --wasm-dir "$WASM_DIR" --shell-wasm "$SHELL_WASM" < "$FIFO_IN" > "$FIFO_OUT" 2>/dev/null &
MCP_PID=$!

# Open write fd to the server's stdin
exec 3>"$FIFO_IN"
exec 4<"$FIFO_OUT"

send() { echo "$1" >&3; }
recv() { IFS= read -r line <&4; echo "$line"; }
recv_response() {
  local expected_id="$1"
  while true; do
    local line
    line="$(recv)"
    if python3 - "$expected_id" "$line" <<'PY'
import json
import sys

expected = int(sys.argv[1])
line = sys.argv[2]
try:
    msg = json.loads(line)
except Exception:
    sys.exit(1)

sys.exit(0 if msg.get("id") == expected else 1)
PY
    then
      echo "$line"
      return 0
    fi
  done
}

# 1. Initialize
send '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.1"}}}'
INIT=$(recv_response 1)
echo "init: OK"

# 2. Notify initialized
send '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. Create sandbox
send '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_sandbox","arguments":{"label":"smoke"}}}'
CREATE=$(recv_response 2)
SANDBOX_ID=$(echo "$CREATE" | python3 -c "import sys,json; r=json.load(sys.stdin); print(json.loads(r['result']['content'][0]['text'])['sandbox_id'])")
echo "create_sandbox: $SANDBOX_ID"

# 4. Run command
send "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"run_command\",\"arguments\":{\"sandbox_id\":\"$SANDBOX_ID\",\"command\":\"echo mcp-ok\"}}}"
RUN=$(recv_response 3)
if echo "$RUN" | grep -q 'mcp-ok'; then
  echo "run_command: OK"
else
  echo "run_command: FAIL"
  echo "$RUN"
  exit 1
fi

# 5. List sandboxes
send "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"list_sandboxes\",\"arguments\":{}}}"
LIST=$(recv_response 4)
if echo "$LIST" | grep -q "$SANDBOX_ID"; then
  echo "list_sandboxes: OK"
else
  echo "list_sandboxes: FAIL"
  echo "$LIST"
  exit 1
fi

# 6. Destroy sandbox
send "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"destroy_sandbox\",\"arguments\":{\"sandbox_id\":\"$SANDBOX_ID\"}}}"
DESTROY=$(recv_response 5)
if echo "$DESTROY" | grep -q 'destroyed'; then
  echo "destroy_sandbox: OK"
else
  echo "destroy_sandbox: FAIL"
  echo "$DESTROY"
  exit 1
fi

echo "MCP smoke test passed"
