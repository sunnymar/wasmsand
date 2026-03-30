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

pub struct Dispatcher {
    initialized: bool,
    manager: SandboxManager,
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
                return Response::err(id, codes::INVALID_PARAMS, "missing required param: shellWasmPath");
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
        if let Err(e) = self.manager.create(wasm_bytes, fs_limit_bytes, timeout_ms, None).await {
            return Response::err(id, codes::INTERNAL_ERROR, format!("create failed: {e}"));
        }

        // Handle mounts: array of { path, files: { rel_path: base64 } }
        if let Some(mounts) = params.get("mounts").and_then(|v| v.as_array()) {
            let sandbox = match self.manager.root.as_mut() {
                Some(s) => s,
                None => {
                    return Response::err(id, codes::INTERNAL_ERROR, "root sandbox missing after create");
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
                        if let Err(e) = sandbox.shell.vfs_mut().write_file(&full_path, &data, false) {
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

    // ── Initialized methods (Phase 2+) ──────────────────────────────────────

    async fn dispatch_initialized(
        &self,
        id: Option<RequestId>,
        method: &str,
        _params: Value,
    ) -> Response {
        if KNOWN_METHODS.contains(&method) {
            Response::not_implemented(id, method)
        } else {
            Response::method_not_found(id, method)
        }
    }
}
