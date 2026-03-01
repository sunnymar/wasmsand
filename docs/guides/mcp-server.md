# MCP Server

codepod includes an MCP (Model Context Protocol) server, so AI assistants like Claude can use the sandbox directly as a tool.

## Setup

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "sandbox": {
      "command": "deno",
      "args": ["run", "-A", "--unstable-sloppy-imports", "/path/to/codepod/packages/mcp-server/src/index.ts"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sandbox": {
      "command": "deno",
      "args": ["run", "-A", "--unstable-sloppy-imports", "/path/to/codepod/packages/mcp-server/src/index.ts"]
    }
  }
}
```

## Tools

The server exposes 4 tools over stdio:

| Tool | Description |
|------|-------------|
| `run_command` | Execute a shell command (95+ coreutils, pipes, redirects, variables) |
| `read_file` | Read a file from the sandbox filesystem |
| `write_file` | Write a file to the sandbox filesystem |
| `list_directory` | List files and directories |

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEPOD_TIMEOUT_MS` | 30000 | Per-command timeout |
| `CODEPOD_FS_LIMIT_BYTES` | 268435456 | VFS size limit (256 MB) |
| `CODEPOD_WASM_DIR` | auto | Path to WASM binaries |
