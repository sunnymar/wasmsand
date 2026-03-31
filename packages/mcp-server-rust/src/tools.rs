use std::sync::Arc;
use tokio::sync::Mutex;
use serde_json::{json, Value};
use sdk_server_wasmtime::sandbox::SandboxManager;
use base64::Engine as B64Engine;

pub fn handle_initialize(msg: &Value) -> Value {
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "codepod-mcp-rust", "version": "0.1.0"}
        }
    })
}

pub fn handle_tools_list(id: Value) -> Value {
    let tools = vec![
        tool("create_sandbox", "Create a new sandbox", json!({"type":"object","properties":{}})),
        tool("destroy_sandbox", "Destroy a sandbox", json!({"type":"object","properties":{"sandboxId":{"type":"string"}}})),
        tool("list_sandboxes", "List active sandboxes", json!({"type":"object","properties":{}})),
        tool("run_command", "Run a shell command", json!({"type":"object","properties":{"command":{"type":"string"},"sandboxId":{"type":"string"}},"required":["command"]})),
        tool("read_file", "Read a file", json!({"type":"object","properties":{"path":{"type":"string"},"sandboxId":{"type":"string"}},"required":["path"]})),
        tool("write_file", "Write a file (data must be base64-encoded)", json!({"type":"object","properties":{"path":{"type":"string"},"data":{"type":"string","description":"Base64-encoded file content"},"sandboxId":{"type":"string"}},"required":["path","data"]})),
        tool("list_directory", "List a directory", json!({"type":"object","properties":{"path":{"type":"string"},"sandboxId":{"type":"string"}},"required":["path"]})),
        tool("snapshot", "Create a VFS snapshot", json!({"type":"object","properties":{"sandboxId":{"type":"string"}}})),
        tool("restore", "Restore a VFS snapshot", json!({"type":"object","properties":{"id":{"type":"string"},"sandboxId":{"type":"string"}},"required":["id"]})),
        tool("export_state", "Export sandbox state as base64", json!({"type":"object","properties":{"sandboxId":{"type":"string"}}})),
        tool("import_state", "Import sandbox state from base64", json!({"type":"object","properties":{"data":{"type":"string"},"sandboxId":{"type":"string"}},"required":["data"]})),
    ];
    json!({"jsonrpc":"2.0","id":id,"result":{"tools":tools}})
}

fn tool(name: &str, description: &str, schema: Value) -> Value {
    json!({"name":name,"description":description,"inputSchema":schema})
}

pub async fn handle_tool_call(
    id: Value,
    msg: &Value,
    wasm_bytes: &Arc<Vec<u8>>,
    mgr: &Arc<Mutex<SandboxManager>>,
) -> Value {
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or(json!({}));

    match dispatch_tool(tool_name, args, wasm_bytes, mgr).await {
        Ok(text) => json!({
            "jsonrpc": "2.0", "id": id,
            "result": {"content": [{"type":"text","text":text}]}
        }),
        Err(e) => json!({
            "jsonrpc": "2.0", "id": id,
            "error": {"code": 1, "message": e.to_string()}
        }),
    }
}

async fn dispatch_tool(
    name: &str,
    args: Value,
    wasm_bytes: &Arc<Vec<u8>>,
    mgr: &Arc<Mutex<SandboxManager>>,
) -> anyhow::Result<String> {
    let sid = args.get("sandboxId").and_then(|v| v.as_str()).map(str::to_owned);

    match name {
        "create_sandbox" => {
            let mut m = mgr.lock().await;
            if m.root.is_none() {
                m.create((**wasm_bytes).clone(), None, None, None).await?;
                Ok("Sandbox created.".to_string())
            } else {
                // Fork the root to create a named sandbox
                let new_sb = m.root.as_ref().unwrap().fork().await?;
                let new_sid = m.next_named_id.to_string();
                m.next_named_id += 1;
                m.named.insert(new_sid.clone(), new_sb);
                Ok(format!("Sandbox created: {new_sid}"))
            }
        }
        "destroy_sandbox" => {
            let id_str = sid.ok_or_else(|| anyhow::anyhow!("sandboxId required"))?;
            let mut m = mgr.lock().await;
            if m.named.remove(&id_str).is_some() {
                Ok(format!("Destroyed {id_str}"))
            } else {
                anyhow::bail!("unknown sandboxId: {id_str}")
            }
        }
        "list_sandboxes" => {
            let m = mgr.lock().await;
            let ids: Vec<_> = m.named.keys().cloned().collect();
            Ok(serde_json::to_string(&ids)?)
        }
        "run_command" => {
            let cmd = args.get("command").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("command required"))?
                .to_owned();
            let mut m = mgr.lock().await;
            let sb = m.resolve(sid.as_deref())?;
            let result = sb.run(&cmd).await?;
            let exit_code = result["exitCode"].as_i64().unwrap_or(1);
            let stdout = result["stdout"].as_str().unwrap_or("").to_owned();
            let stderr = result["stderr"].as_str().unwrap_or("").to_owned();
            Ok(format!("exit={exit_code}\nstdout:\n{stdout}\nstderr:\n{stderr}"))
        }
        "read_file" => {
            let path = args.get("path").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("path required"))?.to_owned();
            let mut m = mgr.lock().await;
            let sb = m.resolve(sid.as_deref())?;
            let bytes = sb.shell.vfs().read_file(&path)?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
        "write_file" => {
            let path = args.get("path").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("path required"))?.to_owned();
            let data = args.get("data").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("data required"))?.to_owned();
            let bytes = base64::engine::general_purpose::STANDARD.decode(&data)?;
            let mut m = mgr.lock().await;
            let sb = m.resolve(sid.as_deref())?;
            if let Some(parent) = std::path::Path::new(&path).parent().and_then(|p| p.to_str()) {
                if parent != "/" && !parent.is_empty() {
                    let _ = sb.shell.vfs_mut().mkdirp(parent);
                }
            }
            sb.shell.vfs_mut().write_file(&path, &bytes, false)?;
            Ok("ok".to_string())
        }
        "list_directory" => {
            let path = args.get("path").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("path required"))?.to_owned();
            let mut m = mgr.lock().await;
            let sb = m.resolve(sid.as_deref())?;
            let entries = sb.shell.vfs().readdir(&path)?;
            let names: Vec<_> = entries.iter().map(|e| &e.name).collect();
            Ok(serde_json::to_string(&names)?)
        }
        "snapshot" => {
            let mut m = mgr.lock().await;
            let sb = m.resolve(sid.as_deref())?;
            let snap_id = sb.shell.vfs_mut().snapshot();
            Ok(format!("snapshot:{snap_id}"))
        }
        "restore" => {
            let snap_id = args.get("id").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("id required"))?.to_owned();
            let mut m = mgr.lock().await;
            let sb = m.resolve(sid.as_deref())?;
            sb.shell.vfs_mut().restore(&snap_id)?;
            Ok("restored".to_string())
        }
        "export_state" => {
            let mut m = mgr.lock().await;
            let sb = m.resolve(sid.as_deref())?;
            let blob = sb.shell.vfs().export_bytes()?;
            Ok(base64::engine::general_purpose::STANDARD.encode(&blob))
        }
        "import_state" => {
            let data = args.get("data").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("data required"))?.to_owned();
            let blob = base64::engine::general_purpose::STANDARD.decode(&data)?;
            let new_vfs = sdk_server_wasmtime::vfs::MemVfs::import_bytes(&blob)?;
            let mut m = mgr.lock().await;
            let sb = m.resolve(sid.as_deref())?;
            *sb.shell.vfs_mut() = new_vfs;
            Ok("imported".to_string())
        }
        _ => anyhow::bail!("Unknown tool: {name}"),
    }
}
