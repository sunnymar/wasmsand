//! codepod-mcp-rust — MCP server (wasmtime backend).
//!
//! Implements MCP protocol over stdio (JSON-RPC 2.0).
//! Tools mirror the TypeScript MCP server.

mod tools;

use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;
use clap::Parser;
use serde_json::{json, Value};
use sdk_server_wasmtime::sandbox::SandboxManager;

#[derive(Parser)]
#[command(about = "Codepod MCP server (wasmtime backend)")]
struct Args {
    /// Path to codepod-shell-exec.wasm
    #[arg(long)]
    shell_wasm: String,

    /// Directory containing coreutil WASMs (optional)
    #[arg(long)]
    wasm_dir: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    tracing::info!("codepod-mcp-rust starting");

    let wasm_bytes = Arc::new(std::fs::read(&args.shell_wasm)?);
    let mgr = Arc::new(Mutex::new(SandboxManager::new()));

    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::BufWriter::new(tokio::io::stdout());

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("parse error: {e}");
                continue;
            }
        };

        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");

        let response = match method {
            "initialize" => tools::handle_initialize(&msg),
            "tools/list" => tools::handle_tools_list(id),
            "tools/call" => tools::handle_tool_call(id, &msg, &wasm_bytes, &mgr).await,
            _ => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":format!("Unknown method: {method}")}}),
        };

        let serialized = serde_json::to_string(&response)?;
        stdout.write_all(serialized.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }

    Ok(())
}
