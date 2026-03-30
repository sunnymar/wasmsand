//! SandboxState and SandboxManager — high-level sandbox abstractions over
//! WasmEngine + ShellInstance.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{bail, Result};
use serde_json::Value;

use crate::vfs::MemVfs;
use crate::wasm::{ShellInstance, WasmEngine};

// ── SandboxState ─────────────────────────────────────────────────────────────

/// One live sandbox: a WASM shell instance plus its environment state.
pub struct SandboxState {
    pub engine: Arc<WasmEngine>,
    pub wasm_bytes: Arc<Vec<u8>>,
    pub shell: ShellInstance,
    /// Env table — synced from `__run_command` output after each call.
    pub env: HashMap<String, String>,
}

impl SandboxState {
    pub async fn new(
        engine: Arc<WasmEngine>,
        wasm_bytes: Arc<Vec<u8>>,
        fs_limit_bytes: Option<usize>,
        initial_env: Vec<(String, String)>,
    ) -> Result<Self> {
        let vfs = MemVfs::new(fs_limit_bytes, None);
        let shell = ShellInstance::new(&engine, &wasm_bytes, vfs, &initial_env).await?;
        let env: HashMap<_, _> = initial_env.into_iter().collect();
        Ok(Self { engine, wasm_bytes, shell, env })
    }

    /// Run a shell command; sync env from the WASM output.
    pub async fn run(&mut self, cmd: &str) -> Result<Value> {
        let result = self.shell.run_command(cmd).await?;
        // Sync env returned by the WASM shell.
        if let Some(env_map) = result.get("env").and_then(|v| v.as_object()) {
            self.env.clear();
            for (k, v) in env_map {
                if let Some(s) = v.as_str() {
                    self.env.insert(k.clone(), s.to_owned());
                }
            }
        }
        // Collect stdout/stderr from the pipe captures.
        let stdout = String::from_utf8_lossy(&self.shell.take_stdout()).into_owned();
        let stderr = String::from_utf8_lossy(&self.shell.take_stderr()).into_owned();
        Ok(serde_json::json!({
            "exitCode": result["exit_code"].as_i64().unwrap_or(1),
            "stdout": stdout,
            "stderr": stderr,
            "executionTimeMs": result["execution_time_ms"].as_u64().unwrap_or(0),
        }))
    }

    /// Fork this sandbox: CoW VFS clone + fresh shell instance with same env.
    pub async fn fork(&self) -> Result<Self> {
        let forked_vfs = self.shell.vfs().cow_clone();
        let env_vec: Vec<_> = self.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let shell =
            ShellInstance::new(&self.engine, &self.wasm_bytes, forked_vfs, &env_vec).await?;
        Ok(Self {
            engine: self.engine.clone(),
            wasm_bytes: self.wasm_bytes.clone(),
            shell,
            env: self.env.clone(),
        })
    }
}

// ── SandboxManager ───────────────────────────────────────────────────────────

/// Manages the root sandbox plus any named or numbered fork sandboxes.
pub struct SandboxManager {
    pub root: Option<SandboxState>,
    pub forks: HashMap<String, SandboxState>,
    pub next_fork_id: u32,
    pub named: HashMap<String, SandboxState>,
    pub next_named_id: u32,
}

#[allow(clippy::new_without_default)]
impl SandboxManager {
    pub fn new() -> Self {
        Self {
            root: None,
            forks: HashMap::new(),
            next_fork_id: 1,
            named: HashMap::new(),
            next_named_id: 1,
        }
    }

    /// Initialize the root sandbox from raw WASM bytes.
    pub async fn create(
        &mut self,
        wasm_bytes: Vec<u8>,
        fs_limit_bytes: Option<usize>,
        timeout_ms: Option<u64>,
        initial_env: Option<Vec<(String, String)>>,
    ) -> Result<()> {
        let _ = timeout_ms; // Phase 6: fuel limits
        let engine = Arc::new(WasmEngine::new()?);
        let wasm = Arc::new(wasm_bytes);
        let env = initial_env.unwrap_or_default();
        self.root = Some(SandboxState::new(engine, wasm, fs_limit_bytes, env).await?);
        Ok(())
    }

    /// Resolve a sandbox by id (None / "" → root).
    pub fn resolve(&mut self, sandbox_id: Option<&str>) -> Result<&mut SandboxState> {
        match sandbox_id {
            None | Some("") => {
                self.root.as_mut().ok_or_else(|| anyhow::anyhow!("no root sandbox"))
            }
            Some(id) => {
                if let Some(sb) = self.named.get_mut(id) {
                    return Ok(sb);
                }
                if let Some(sb) = self.forks.get_mut(id) {
                    return Ok(sb);
                }
                bail!("unknown sandboxId: {id}")
            }
        }
    }

    /// Run a command on the root sandbox.
    pub async fn root_run(&mut self, cmd: &str) -> Result<Value> {
        self.root
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("no root sandbox"))?
            .run(cmd)
            .await
    }
}
