//! JSON-RPC method dispatcher.
//!
//! Mirrors the TypeScript `dispatcher.ts` interface.  Phase 1 wires `create`
//! to the real SandboxManager; all other methods return a typed "not yet
//! implemented" error so the Python SDK gets a meaningful response.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::rpc::{codes, RequestId, Response};
use crate::sandbox::SandboxManager;
use crate::vfs::VfsError;

/// All methods that will eventually be implemented, listed so the dispatcher
/// returns the right error code (INTERNAL_ERROR vs METHOD_NOT_FOUND).
const KNOWN_METHODS: &[&str] = &[
    "run",
    "files.read",
    "files.write",
    "files.list",
    "files.mkdir",
    "files.rm",
    "files.stat",
    "env.set",
    "env.get",
    "mount",
    "snapshot.create",
    "snapshot.restore",
    "persistence.export",
    "persistence.import",
    "sandbox.fork",
    "sandbox.destroy",
    "sandbox.create",
    "sandbox.list",
    "sandbox.remove",
    "shell.history.list",
    "shell.history.clear",
    "offload",
    "rehydrate",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s).map_err(|e| format!("base64 decode: {e}"))
}

fn b64_encode(b: &[u8]) -> String {
    B64.encode(b)
}

/// Application-level error code (mirrors TypeScript dispatcher's `rpcError(1, ...)`).
/// Used for VFS/filesystem errors.
fn vfs_err(id: Option<RequestId>, e: VfsError) -> Response {
    Response::err(id, 1, e.to_string())
}

fn require_str<'a>(
    id: &Option<RequestId>,
    params: &'a Value,
    key: &str,
) -> Result<&'a str, Response> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| Response::err(id.clone(), codes::INVALID_PARAMS, format!("missing: {key}")))
}

fn sandbox_id(params: &Value) -> Option<&str> {
    params.get("sandboxId").and_then(|v| v.as_str())
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

pub struct Dispatcher {
    initialized: bool,
    pub manager: SandboxManager,
    #[allow(dead_code)]
    stdout_tx: mpsc::Sender<String>,
    #[allow(dead_code)]
    cb_rx: mpsc::Receiver<String>,
}

impl Dispatcher {
    pub fn new(stdout_tx: mpsc::Sender<String>, cb_rx: mpsc::Receiver<String>) -> Self {
        Self {
            initialized: false,
            manager: SandboxManager::new(),
            stdout_tx,
            cb_rx,
        }
    }

    /// Route an incoming RPC request to the appropriate handler.
    ///
    /// Returns the response to send, plus a bool indicating whether the server
    /// should shut down after sending it (`kill` method).
    pub async fn dispatch(
        &mut self,
        id: Option<RequestId>,
        method: &str,
        params: Value,
    ) -> (Response, bool) {
        let resp = match method {
            "create" => self.handle_create(id, params).await,
            "kill" => return (self.kill(id).await, true),
            _ if !self.initialized => Response::err(
                id,
                codes::INVALID_REQUEST,
                "sandbox not initialized: call 'create' first",
            ),
            _ => self.dispatch_initialized(id, method, params).await,
        };
        (resp, false)
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    async fn handle_create(&mut self, id: Option<RequestId>, params: Value) -> Response {
        if self.initialized {
            return Response::err(id, codes::INVALID_REQUEST, "already initialized");
        }

        // Required: shellWasmPath
        let wasm_path = match params.get("shellWasmPath").and_then(|v| v.as_str()) {
            Some(p) => p.to_owned(),
            None => {
                return Response::err(
                    id,
                    codes::INVALID_PARAMS,
                    "missing required param: shellWasmPath",
                );
            }
        };

        // Read WASM bytes from disk.
        let wasm_bytes = match std::fs::read(&wasm_path) {
            Ok(b) => b,
            Err(e) => {
                return Response::err(
                    id,
                    codes::INTERNAL_ERROR,
                    format!("failed to read shellWasmPath '{wasm_path}': {e}"),
                );
            }
        };

        // Optional params.
        let fs_limit_bytes = params
            .get("fsLimitBytes")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);
        let timeout_ms = params.get("timeoutMs").and_then(|v| v.as_u64());

        // Create the root sandbox.
        if let Err(e) = self
            .manager
            .create(wasm_bytes, fs_limit_bytes, timeout_ms, None)
            .await
        {
            return Response::err(id, codes::INTERNAL_ERROR, format!("create failed: {e}"));
        }

        // Handle mounts: array of { path, files: { rel_path: base64 } }
        if let Some(mounts) = params.get("mounts").and_then(|v| v.as_array()) {
            let sandbox = match self.manager.root.as_mut() {
                Some(s) => s,
                None => {
                    return Response::err(
                        id,
                        codes::INTERNAL_ERROR,
                        "root sandbox missing after create",
                    );
                }
            };
            for mount in mounts {
                let base_path = mount.get("path").and_then(|v| v.as_str()).unwrap_or("/");
                if let Some(files) = mount.get("files").and_then(|v| v.as_object()) {
                    for (rel_path, b64_val) in files {
                        let b64 = match b64_val.as_str() {
                            Some(s) => s,
                            None => continue,
                        };
                        let data = match B64.decode(b64) {
                            Ok(d) => d,
                            Err(e) => {
                                return Response::err(
                                    id,
                                    codes::INVALID_PARAMS,
                                    format!("base64 decode error for '{rel_path}': {e}"),
                                );
                            }
                        };
                        // Build full path: base_path + "/" + rel_path.
                        let full_path = if base_path.ends_with('/') {
                            format!("{base_path}{rel_path}")
                        } else {
                            format!("{base_path}/{rel_path}")
                        };
                        // Ensure parent directory exists.
                        if let Some(parent) = std::path::Path::new(&full_path).parent() {
                            let parent_str = parent.to_string_lossy();
                            if !parent_str.is_empty() && parent_str != "/" {
                                let _ = sandbox.shell.vfs_mut().mkdirp(&parent_str);
                            }
                        }
                        if let Err(e) =
                            sandbox.shell.vfs_mut().write_file(&full_path, &data, false)
                        {
                            return Response::err(
                                id,
                                codes::INTERNAL_ERROR,
                                format!("write_file '{full_path}' failed: {e}"),
                            );
                        }
                    }
                }
            }
        }

        self.initialized = true;
        tracing::info!("sandbox initialized (wasmtime backend)");
        Response::ok(id, json!({ "ok": true }))
    }

    async fn kill(&mut self, id: Option<RequestId>) -> Response {
        tracing::info!("kill received, shutting down");
        Response::ok(id, json!({ "ok": true }))
    }

    // ── Initialized methods ──────────────────────────────────────────────────

    async fn dispatch_initialized(
        &mut self,
        id: Option<RequestId>,
        method: &str,
        params: Value,
    ) -> Response {
        let sid = sandbox_id(&params).map(str::to_owned);
        match method {
            "run" => self.handle_run(id, &params, sid.as_deref()).await,
            "env.set" => self.handle_env_set(id, &params, sid.as_deref()).await,
            "env.get" => self.handle_env_get(id, &params, sid.as_deref()),
            "files.read" => self.handle_files_read(id, &params, sid.as_deref()),
            "files.write" => self.handle_files_write(id, &params, sid.as_deref()),
            "files.list" => self.handle_files_list(id, &params, sid.as_deref()),
            "files.mkdir" => self.handle_files_mkdir(id, &params, sid.as_deref()),
            "files.rm" => self.handle_files_rm(id, &params, sid.as_deref()),
            "files.stat" => self.handle_files_stat(id, &params, sid.as_deref()),
            // remaining methods still not_implemented (done in later tasks)
            _ if KNOWN_METHODS.contains(&method) => Response::not_implemented(id, method),
            _ => Response::method_not_found(id, method),
        }
    }

    // ── run + env ─────────────────────────────────────────────────────────────

    async fn handle_run(&mut self, id: Option<RequestId>, params: &Value, sid: Option<&str>) -> Response {
        let cmd = match require_str(&id, params, "command") {
            Ok(c) => c.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.run(&cmd).await {
            Ok(result) => Response::ok(id, result),
            Err(e) => Response::err(id, codes::INTERNAL_ERROR, e.to_string()),
        }
    }

    async fn handle_env_set(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let name = match require_str(&id, &params, "name") {
            Ok(n) => n.to_owned(),
            Err(r) => return r,
        };
        let value = match require_str(&id, &params, "value") {
            Ok(v) => v.to_owned(),
            Err(r) => return r,
        };

        // Validate name: must be a valid shell identifier
        if name.is_empty()
            || !name
                .chars()
                .next()
                .map(|c| c.is_ascii_alphabetic() || c == '_')
                .unwrap_or(false)
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Response::err(id, codes::INVALID_PARAMS, "invalid env var name");
        }

        // POSIX single-quote escape: replace ' with '\''
        let quoted = format!("'{}'", value.replace('\'', "'\\''"));
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.run(&format!("export {name}={quoted}")).await {
            Ok(_) => Response::ok(id, json!({"ok": true})),
            Err(e) => Response::err(id, codes::INTERNAL_ERROR, e.to_string()),
        }
    }

    fn handle_env_get(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let name = match require_str(&id, params, "name") {
            Ok(n) => n.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        let value = sb.env.get(&name).cloned();
        Response::ok(id, json!({"value": value}))
    }

    // ── File operations ───────────────────────────────────────────────────────

    fn handle_files_read(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.shell.vfs().read_file(&path) {
            Ok(bytes) => Response::ok(id, json!({"data": b64_encode(&bytes)})),
            Err(e) => vfs_err(id, e),
        }
    }

    fn handle_files_write(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        let data_b64 = match require_str(&id, params, "data") {
            Ok(d) => d.to_owned(),
            Err(r) => return r,
        };
        let bytes = match b64_decode(&data_b64) {
            Ok(b) => b,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e),
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        // Ensure parent directory exists.
        if let Some(parent) =
            std::path::Path::new(&path).parent().and_then(|p| p.to_str())
        {
            if !parent.is_empty() && parent != "/" {
                let _ = sb.shell.vfs_mut().mkdirp(parent);
            }
        }
        match sb.shell.vfs_mut().write_file(&path, &bytes, false) {
            Ok(_) => Response::ok(id, json!({"ok": true})),
            Err(e) => vfs_err(id, e),
        }
    }

    fn handle_files_list(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.shell.vfs().readdir(&path) {
            Ok(entries) => {
                let enriched: Vec<_> = entries
                    .iter()
                    .map(|e| {
                        let full =
                            format!("{}/{}", path.trim_end_matches('/'), e.name);
                        let size =
                            sb.shell.vfs().stat(&full).map(|s| s.size).unwrap_or(0);
                        let kind = if e.is_dir { "dir" } else { "file" };
                        json!({"name": e.name, "type": kind, "size": size})
                    })
                    .collect();
                Response::ok(id, json!({"entries": enriched}))
            }
            Err(e) => vfs_err(id, e),
        }
    }

    fn handle_files_mkdir(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.shell.vfs_mut().mkdir(&path) {
            Ok(_) => Response::ok(id, json!({"ok": true})),
            Err(e) => vfs_err(id, e),
        }
    }

    fn handle_files_rm(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        let vfs = sb.shell.vfs_mut();
        // Try stat to decide whether to unlink or remove_recursive.
        let result = match vfs.stat(&path) {
            Ok(st) if st.is_dir => vfs.remove_recursive(&path),
            _ => vfs.unlink(&path),
        };
        match result {
            Ok(_) => Response::ok(id, json!({"ok": true})),
            Err(e) => vfs_err(id, e),
        }
    }

    fn handle_files_stat(
        &mut self,
        id: Option<RequestId>,
        params: &Value,
        sid: Option<&str>,
    ) -> Response {
        let path = match require_str(&id, params, "path") {
            Ok(p) => p.to_owned(),
            Err(r) => return r,
        };
        let sb = match self.manager.resolve(sid) {
            Ok(s) => s,
            Err(e) => return Response::err(id, codes::INVALID_PARAMS, e.to_string()),
        };
        match sb.shell.vfs().stat(&path) {
            Ok(st) => {
                let kind = if st.is_dir { "dir" } else { "file" };
                let name = std::path::Path::new(&path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&path);
                Response::ok(id, json!({"name": name, "type": kind, "size": st.size}))
            }
            Err(e) => vfs_err(id, e),
        }
    }
}
